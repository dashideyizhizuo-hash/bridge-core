import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { hostPowerShell } from './host-platform.mjs';
import { BridgeError, assertBridge } from './errors.mjs';

function sameState(left,right) {
  return typeof left==='string' && Buffer.byteLength(left)===Buffer.byteLength(right) &&
    timingSafeEqual(Buffer.from(left),Buffer.from(right));
}

const callbackCopy={
  en:{
    received:{title:'Authorization received',description:'Return to the terminal to finish setting up this computer.',
      next:'Continue in your terminal',detail:'Your terminal will show the setup result. Once setup finishes, you can use this computer in Bridge.',
      footnote:'You can close this page. Your terminal will show the setup result.'},
    denied:{title:'Authorization not completed',description:'Access was not granted in the browser.',
      next:'Return to your terminal',detail:'Start the connection again when you are ready to authorize Bridge Host.',footnote:'You can close this page.'},
    inactive:{title:'This authorization is no longer pending',description:'This connection attempt has already been handled.',
      next:'Check your terminal',detail:'Your terminal has the current setup result. If needed, start a new connection there.',footnote:'You can close this page.'},
    invalid:{title:'Authorization could not be accepted',description:'This callback did not pass the connection checks.',
      next:'Return to your terminal',detail:'Use the current authorization link from Bridge Host. If it has expired, start the connection again.',footnote:'You can close this page.'},
    missing:{title:'Page not found',description:'This address is not the pending Bridge Host callback.',
      next:'Return to your terminal',detail:'Open the authorization link shown by Bridge Host to continue.',footnote:'You can close this page.'}
  },
  'zh-CN':{
    received:{title:'已收到授权',description:'请返回终端，继续完成这台电脑的配置。',
      next:'在终端中继续',detail:'配置结果会在终端显示。完成后，你就可以在 Bridge 中使用这台电脑。',
      footnote:'你可以关闭此页面，配置结果会在终端显示。'},
    denied:{title:'授权未完成',description:'浏览器中的访问授权未通过。',
      next:'请返回终端',detail:'准备好授权 Bridge Host 时，请重新发起连接。',footnote:'你可以关闭此页面。'},
    inactive:{title:'此授权已结束',description:'这次连接请求已经处理。',
      next:'查看终端中的结果',detail:'终端会显示当前配置结果。如需重试，请从终端重新发起连接。',footnote:'你可以关闭此页面。'},
    invalid:{title:'未能接收授权',description:'此回调未通过连接安全检查。',
      next:'请返回终端',detail:'请使用 Bridge Host 当前显示的授权链接。如果链接已过期，请重新发起连接。',footnote:'你可以关闭此页面。'},
    missing:{title:'找不到此页面',description:'此地址不是当前等待中的 Bridge Host 回调。',
      next:'请返回终端',detail:'打开 Bridge Host 显示的授权链接，继续连接。',footnote:'你可以关闭此页面。'}
  }
};

// Only a fixed copy key and a selected language enter this document. Never
// interpolate callback parameters, account information or authorization codes.
function callbackLanguage(header) {
  const supported=String(header??'').split(',').map((part,index)=>{
    const [tag,...parameters]=part.trim().toLowerCase().split(';');
    const quality=parameters.find(value=>value.trim().startsWith('q='));
    const weight=quality===undefined ? 1 : Number(quality.trim().slice(2));
    return {language:/^zh(?:-|$)/.test(tag) ? 'zh-CN' : /^en(?:-|$)/.test(tag) ? 'en' : null,
      weight:Number.isFinite(weight) && weight>0 && weight<=1 ? weight : 0,index};
  }).filter(value=>value.language && value.weight>0);
  supported.sort((a,b)=>b.weight-a.weight || a.index-b.index);
  return supported[0]?.language??'en';
}

function callbackPage(kind,language,nonce) {
  const copy=callbackCopy[language][kind];
  const symbol=kind==='received' ? '<path d="m5 12 4 4L19 6"/>' :
    '<circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/>';
  return `<!doctype html>
<html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${copy.title} · Bridge Host</title>
<script nonce="${nonce}">try{history.replaceState(null,'',location.pathname)}catch{}</script>
<style nonce="${nonce}">
:root{color-scheme:light;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#24252a;background:#fff;font-synthesis:none}
*{box-sizing:border-box}body{margin:0;min-height:100vh;min-height:100dvh;display:flex;flex-direction:column;-webkit-font-smoothing:antialiased;line-height:1.65}
::selection{background:#dfe3fc;color:#24252a}header{padding:24px 32px;display:flex;align-items:center;gap:10px;font-size:1rem;font-weight:650;letter-spacing:-.025em}
.brand-mark{width:26px;height:26px;color:#535fc5;flex:none}main{flex:1;display:grid;align-content:center;width:100%;max-width:520px;margin:0 auto;padding:48px 28px 104px}
.status-icon{width:44px;height:44px;display:grid;place-items:center;border-radius:12px;background:#eeeffa;color:#535fc5;margin-bottom:25px}.status-icon svg{width:24px;height:24px}
h1{font-size:1.625rem;font-weight:600;line-height:1.35;letter-spacing:-.025em;text-wrap:balance;margin:0 0 12px}p{margin:0;font-size:14px;color:#626672;overflow-wrap:anywhere}
.next{margin-top:32px;padding-top:24px;border-top:1px solid #e6e7eb;display:flex;align-items:flex-start;gap:12px}.terminal-icon{width:20px;height:20px;flex:none;margin-top:2px;color:#626672}
h2{margin:0 0 6px;font-size:14px;line-height:1.5;font-weight:600;letter-spacing:-.01em}.next p{font-size:13px}.footnote{margin-top:30px;font-size:.8125rem;color:#626672}
@media(max-width:480px){header{padding:22px 24px}main{align-content:start;padding:64px 24px 64px}h1{font-size:1.5rem}.status-icon{margin-bottom:23px}}
</style></head><body>
<header><svg class="brand-mark" viewBox="0 0 32 32" fill="none" aria-hidden="true"><path d="M5 25V7h8v18M19 25V7h8v18M5 15h22" stroke="currentColor" stroke-width="3"/></svg><span>Bridge</span></header>
<main aria-labelledby="callback-title"><div class="status-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${symbol}</svg></div>
<h1 id="callback-title">${copy.title}</h1><p>${copy.description}</p>
<section class="next" aria-labelledby="next-title"><svg class="terminal-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 17 6-5-6-5m8 12h8"/></svg><div><h2 id="next-title">${copy.next}</h2><p>${copy.detail}</p></div></section>
<p class="footnote">${copy.footnote}</p></main></body></html>`;
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
    const nonce=randomBytes(18).toString('base64');
    response.setHeader('Cache-Control','no-store');
    response.setHeader('Referrer-Policy','no-referrer');
    response.setHeader('Content-Type','text/html; charset=utf-8');
    response.setHeader('Content-Security-Policy',`default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'`);
    response.setHeader('X-Content-Type-Options','nosniff');
    const reply=(code,kind)=>{response.writeHead(code);response.end(callbackPage(kind,callbackLanguage(request.headers['accept-language']),nonce));};
    if(settled) return reply(409,'inactive');
    if(request.method!=='GET' || !request.url?.startsWith('/') || request.url.startsWith('//') ||
      request.url.length>8192 || request.headers.host!==new URL(redirectUrl).host) {
      return reply(400,'invalid');
    }
    const url=new URL(request.url,redirectUrl);
    if(url.pathname!==path) return reply(404,'missing');
    const params=url.searchParams;
    if(['state','code','error','iss'].some(key=>params.getAll(key).length>1) ||
      !sameState(params.get('state'),state)) return reply(400,'invalid');
    const fail=(code,message)=>{
      settled=true;clearTimeout(timer);reply(400,code==='HOST_LOGIN_DENIED' ? 'denied' : 'invalid');rejectResult(new BridgeError(code,message));
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
    reply(200,'received');
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
