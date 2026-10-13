import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { hostPowerShell } from './host-platform.mjs';
import { BridgeError, assertBridge } from './errors.mjs';

function sameState(left,right) {
  return typeof left==='string' && Buffer.byteLength(left)===Buffer.byteLength(right) &&
    timingSafeEqual(Buffer.from(left),Buffer.from(right));
}

export async function createHostCallback({issuer,timeoutMs=300_000}={}) {
  assertBridge(Number.isSafeInteger(timeoutMs) && timeoutMs>=1 && timeoutMs<=600_000,
    'HOST_LOGIN_INVALID','Login timeout must be at most ten minutes');
  const state=randomBytes(32).toString('base64url');
  const path=`/callback/${randomBytes(16).toString('hex')}`;
  let resolveResult,rejectResult,timer,settled=false;
  let redirectUrl;
  const result=new Promise((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;});
  // Timeout/denial can happen while SDK discovery or browser opening is in flight.
  result.catch(()=>{});
  const server=createServer({maxHeaderSize:8192},(request,response)=>{
    response.setHeader('Cache-Control','no-store');
    response.setHeader('Referrer-Policy','no-referrer');
    response.setHeader('Content-Type','text/plain; charset=utf-8');
    response.setHeader('Content-Security-Policy',"default-src 'none'; frame-ancestors 'none'");
    response.setHeader('X-Content-Type-Options','nosniff');
    const reply=(code,text)=>{response.writeHead(code);response.end(text);};
    if(settled) return reply(409,'Login is no longer pending.');
    if(request.method!=='GET' || !request.url?.startsWith('/') || request.url.startsWith('//') ||
      request.url.length>8192 || request.headers.host!==new URL(redirectUrl).host) {
      return reply(400,'Invalid callback request.');
    }
    const url=new URL(request.url,redirectUrl);
    if(url.pathname!==path) return reply(404,'Not found.');
    const params=url.searchParams;
    if(['state','code','error','iss'].some(key=>params.getAll(key).length>1) ||
      !sameState(params.get('state'),state)) return reply(400,'Invalid callback state.');
    const fail=(code,message)=>{
      settled=true;clearTimeout(timer);reply(400,message);rejectResult(new BridgeError(code,message));
    };
    // Our existing provider supports RFC 9207. Require its issuer instead of
    // accepting a code from a different authorization server.
    if(params.get('iss')!==issuer) return fail('HOST_ISSUER_DENIED','Authorization issuer did not match Bridge.');
    if(params.has('error')) return fail('HOST_LOGIN_DENIED','Browser authorization was not completed.');
    const code=params.get('code');
    if(typeof code!=='string' || code.length<1 || code.length>4096 || /[\x00-\x20\x7f]/.test(code)) {
      return fail('HOST_CALLBACK_INVALID','Invalid authorization response.');
    }
    settled=true;clearTimeout(timer);
    reply(200,'Authorization received. Return to the terminal to finish connecting this computer.');
    resolveResult({authorizationCode:code,iss:issuer});
  });
  server.requestTimeout=10_000;
  server.headersTimeout=10_000;
  server.keepAliveTimeout=1000;
  await new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>{server.removeListener('error',reject);resolve();});
  });
  redirectUrl=`http://127.0.0.1:${server.address().port}${path}`;
  timer=setTimeout(()=>{
    settled=true;
    rejectResult(new BridgeError('HOST_LOGIN_TIMEOUT','Browser authorization timed out; rerun the command to try again'));
    server.close();server.closeAllConnections();
  },timeoutMs);
  return {
    state,redirectUrl,result,
    async close() {
      clearTimeout(timer);
      if(!settled) {
        settled=true;
        rejectResult(new BridgeError('HOST_LOGIN_CANCELED','Host login was canceled'));
      }
      await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
    }
  };
}

// No shell, eval, cmd.exe interpolation, or secret arguments. Failure leaves the
// already displayed HTTPS authorization URL as a manual browser fallback.
export async function openHostBrowser(url,{platform=process.platform,wsl=!!process.env.WSL_DISTRO_NAME,
  spawnImpl=spawn,nativeOpen=hostPowerShell}={}) {
  const parsed=new URL(url);
  assertBridge(parsed.protocol==='https:' && !parsed.username && !parsed.password,
    'HOST_BROWSER_INVALID','Browser authorization requires HTTPS');
  if(platform==='win32') {
    try {
      return nativeOpen(`$p=[Diagnostics.ProcessStartInfo]::new(); $p.FileName=$d.url; $p.UseShellExecute=$true; [void][Diagnostics.Process]::Start($p); @{opened=$true}|ConvertTo-Json -Compress`,{url:parsed.href}).opened===true;
    } catch {return false;}
  }
  const candidates=platform==='darwin' ? [['open',[parsed.href]]] :
    wsl ? [['wslview',[parsed.href]],['xdg-open',[parsed.href]]] :
      platform==='linux' ? [['xdg-open',[parsed.href]]] : [];
  for(const [command,args] of candidates) {
    const ok=await new Promise(resolve=>{
      let done=false,timer;
      const finish=value=>{if(!done){done=true;clearTimeout(timer);resolve(value);}};
      let child;
      try {child=spawnImpl(command,args,{stdio:'ignore',shell:false});}
      catch {finish(false);return;}
      timer=setTimeout(()=>{child.kill();finish(false);},5000);
      child.once('error',()=>finish(false));
      child.once('exit',code=>finish(code===0));
    });
    if(ok) return true;
  }
  return false;
}
