import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { request } from 'node:http';
import { runInNewContext } from 'node:vm';
import { hostEndpoint, boundedHostFetch } from '../src/host-http.mjs';
import { createHostCallback, openHostBrowser } from '../src/host-loopback.mjs';

const endpoint='https://bridge.example/mcp';
const issuer='https://bridge.example';
const code=value=>error=>error.code===value;

for(const value of ['http://bridge.example/mcp','https://bridge.example','https://user:pass@bridge.example/mcp',
  'https://bridge.example/mcp?token=secret','https://bridge.example/mcp#secret','not-a-url']) {
  test(`host endpoint rejects unsafe input ${value.split('?')[0]}`,()=>{
    assert.throws(()=>hostEndpoint(value),code('HOST_ENDPOINT_INVALID'));
  });
}
test('host HTTP pins even credential-free discovery to selected origin',async()=>{
  let called=false;
  const fetchFn=boundedHostFetch(endpoint,{fetchImpl:async()=>{called=true;return Response.json({});}});
  await assert.rejects(fetchFn('https://attacker.example/oauth/token'),code('HOST_ORIGIN_DENIED'));
  assert.equal(called,false);
});
test('host HTTP refuses redirects rather than forwarding credentials',async()=>{
  const fetchFn=boundedHostFetch(endpoint,{fetchImpl:async (_url,init)=>{
    assert.equal(init.redirect,'manual');
    return new Response(null,{status:302,headers:{location:'https://attacker.example/'}});
  }});
  await assert.rejects(fetchFn(issuer+'/oauth/token'),code('HOST_REDIRECT_DENIED'));
});
test('host HTTP bounds both declared and streamed bodies',async()=>{
  for(const response of [new Response('x',{headers:{'content-length':'999'}}),new Response('12345')]) {
    await assert.rejects(boundedHostFetch(endpoint,{maxBytes:4,fetchImpl:async()=>response})(endpoint),
      code('HOST_RESPONSE_TOO_LARGE'));
  }
});
test('host HTTP retains statuses/headers and never reflects remote failure material',async()=>{
  const good=await boundedHostFetch(endpoint,{fetchImpl:async()=>new Response(null,{status:204})})(endpoint);
  assert.equal(good.status,204);assert.equal(await good.text(),'');
  const failed=boundedHostFetch(endpoint,{fetchImpl:async()=>{throw new Error('secret-raw-token');}});
  await assert.rejects(failed(endpoint),error=>error.code==='HOST_NETWORK_FAILED' && !error.message.includes('secret'));
});
test('host HTTP times out its real transport signal',async()=>{
  const fetchFn=boundedHostFetch(endpoint,{timeoutMs:20,fetchImpl:async (_url,init)=>new Promise((resolve,reject)=>{
    const keepAlive=setTimeout(()=>resolve(Response.json({})),500);
    init.signal.addEventListener('abort',()=>{clearTimeout(keepAlive);reject(init.signal.reason);},{once:true});
  })});
  await assert.rejects(fetchFn(endpoint),code('HOST_NETWORK_FAILED'));
});
function callbackUrl(callback,parameters={}) {
  const url=new URL(callback.redirectUrl);
  for(const [key,value] of Object.entries({state:callback.state,iss:issuer,code:'test-code',...parameters})) {
    url.searchParams.set(key,value);
  }
  return url;
}
test('real loopback callback checks state/path, is one-use, and does not echo secrets',async t=>{
  const cb=await createHostCallback({issuer,timeoutMs:2000});t.after(()=>cb.close());
  assert.equal(new URL(cb.redirectUrl).hostname,'127.0.0.1');
  assert.equal((await fetch(callbackUrl(cb,{state:'wrong'}))).status,400);
  const duplicate=callbackUrl(cb);duplicate.searchParams.append('state',cb.state);
  assert.equal((await fetch(duplicate)).status,400);
  assert.equal((await fetch(new URL('/wrong',cb.redirectUrl))).status,404);
  const response=await fetch(callbackUrl(cb,{code:'secret-authorization-code'}));
  assert.equal(response.status,200);
  const html=await response.text();
  assert.equal(html.includes('secret-authorization-code'),false);
  assert.equal(html.includes(cb.state),false);
  assert.match(html,/<html lang="en">/);
  assert.match(html,/<h1 id="callback-title">Authorization received<\/h1>/);
  assert.match(html,/Your terminal will show the setup result\. Once setup finishes,/);
  assert.doesNotMatch(html,/Your computer is connected|Setup complete|Connection complete/);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(await cb.result,{authorizationCode:'secret-authorization-code',iss:issuer});
  assert.equal((await fetch(callbackUrl(cb))).status,409);
});

function assertCallbackDocument(response,html) {
  assert.equal(response.headers.get('content-type'),'text/html; charset=utf-8');
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(response.headers.get('referrer-policy'),'no-referrer');
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
  assert.match(html,/^<!doctype html>/);
  assert.match(html,/<meta name="viewport" content="width=device-width,initial-scale=1">/);
  assert.match(html,/<main aria-labelledby="callback-title">/);
  assert.doesNotMatch(html,/<(?:link|iframe|form|img)\b|\b(?:src|href)=/);
  const policy=response.headers.get('content-security-policy');
  assert.match(policy,/default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'/);
  assert.doesNotMatch(policy,/unsafe-inline|https?:|\*/);
  const nonce=policy.match(/script-src 'nonce-([A-Za-z0-9+/=]+)'/)?.[1];
  assert.ok(nonce);
  assert.ok(policy.includes(`style-src 'nonce-${nonce}'`));
  assert.ok(html.includes(`<style nonce="${nonce}">`));
  assert.ok(html.includes(`<script nonce="${nonce}">`));
  return {nonce,script:html.match(/<script nonce="[^"]+">([^]*?)<\/script>/)?.[1]};
}

test('callback document is self-contained, nonce protected, and clears only its sensitive query',async t=>{
  const cb=await createHostCallback({issuer,timeoutMs:2000});t.after(()=>cb.close());
  const secret='private-authorization-code';
  const url=callbackUrl(cb,{code:secret});
  const response=await fetch(url);
  const html=await response.text();
  const {nonce,script}=assertCallbackDocument(response,html);
  assert.doesNotMatch(html,new RegExp(`${secret}|${cb.state}|${issuer}`));
  const replaced=[];
  runInNewContext(script,{location:{pathname:url.pathname,href:url.href},
    history:{replaceState:(state,title,path)=>replaced.push({state,title,path})}});
  assert.deepEqual(replaced,[{state:null,title:'',path:url.pathname}]);
  // Browsers that prohibit history changes still display the result.
  assert.doesNotThrow(()=>runInNewContext(script,{location:{pathname:url.pathname},
    history:{replaceState:()=>{throw new Error('unavailable');}}}));
  assert.deepEqual(await cb.result,{authorizationCode:secret,iss:issuer});
  const repeated=await fetch(url);
  assert.equal(repeated.status,409);
  const repeatHtml=await repeated.text();
  const repeatDocument=assertCallbackDocument(repeated,repeatHtml);
  assert.notEqual(nonce,repeatDocument.nonce);
  assert.match(repeatHtml,/This authorization is no longer pending/);
  assert.doesNotMatch(repeatHtml,/Authorization received/);
});

for(const [language,expected] of [
  ['zh-CN,zh;q=0.9,en;q=0.8','zh-CN'],
  ['en-US;q=0.5,zh-Hans;q=0.9','zh-CN'],
  ['zh;q=0,en-US;q=1','en'],
  ['en-GB,zh;q=0.5','en'],
  ['fr,zh;q=invalid','en']
]) test(`callback chooses supported language from ${language}`,async t=>{
  const cb=await createHostCallback({issuer,timeoutMs:2000});t.after(()=>cb.close());
  const response=await fetch(callbackUrl(cb),{headers:{'accept-language':language}});
  const html=await response.text();
  assert.equal(response.status,200);
  assert.match(html,new RegExp(`<html lang="${expected}">`));
  assert.ok(html.includes(expected==='zh-CN' ? '配置结果会在终端显示。完成后' : 'Your terminal will show the setup result. Once setup finishes'));
  assert.doesNotMatch(html,/主机已连接|配置已完成|Your computer is connected|Setup complete|Connection complete/);
  await cb.result;
});

test('invalid callback renders localized recovery without reflecting untrusted input or ending pending login',async t=>{
  const cb=await createHostCallback({issuer,timeoutMs:2000});t.after(()=>cb.close());
  const injected='<script>untrusted-callback-value</script>';
  const response=await fetch(callbackUrl(cb,{state:injected,error_description:injected}),{
    headers:{'accept-language':'zh-CN,<script>untrusted-language</script>'}});
  assert.equal(response.status,400);
  const html=await response.text();
  assertCallbackDocument(response,html);
  assert.match(html,/<html lang="zh-CN">/);
  assert.match(html,/未能接收授权/);
  assert.doesNotMatch(html,/untrusted-callback-value|untrusted-language|已收到授权/);
  assert.equal((await fetch(callbackUrl(cb))).status,200);
  await cb.result;
});
for(const [parameters,expected] of [
  [{iss:'https://attacker.example'},'HOST_ISSUER_DENIED'],
  [{error:'access_denied',error_description:'SECRET'},'HOST_LOGIN_DENIED'],
  [{code:''},'HOST_CALLBACK_INVALID']
]) test(`loopback rejects ${expected}`,async t=>{
  const cb=await createHostCallback({issuer,timeoutMs:2000});t.after(()=>cb.close());
  const response=await fetch(callbackUrl(cb,parameters));
  assert.equal(response.status,400);
  const html=await response.text();
  assertCallbackDocument(response,html);
  assert.equal(html.includes('SECRET'),false);
  assert.doesNotMatch(html,/Authorization received/);
  await assert.rejects(cb.result,code(expected));
});
test('loopback rejects foreign Host and POST requests before accepting state',async t=>{
  const cb=await createHostCallback({issuer,timeoutMs:2000});t.after(()=>cb.close());
  const url=callbackUrl(cb);
  const status=await new Promise((resolve,reject)=>{
    const req=request(url,{headers:{host:'attacker.example'}},res=>{res.resume();resolve(res.statusCode);});
    req.on('error',reject);req.end();
  });
  assert.equal(status,400);
  assert.equal((await fetch(url,{method:'POST'})).status,400);
  assert.equal((await fetch(url)).status,200);await cb.result;
});
test('loopback timeout terminates the pending flow',async t=>{
  const cb=await createHostCallback({issuer,timeoutMs:20});t.after(()=>cb.close());
  await assert.rejects(cb.result,code('HOST_LOGIN_TIMEOUT'));
});
test('browser launch uses argv and falls back without shell interpolation',async()=>{
  const calls=[];
  const ok=await openHostBrowser(issuer+'/authorize?state=abc&code_challenge=def',{
    platform:'linux',wsl:true,spawnImpl:(command,args,options)=>{
      calls.push({command,args,options});const child=new EventEmitter();child.kill=()=>{};
      queueMicrotask(()=>child.emit('exit',command==='wslview' ? 1 : 0));return child;
    }
  });
  assert.equal(ok,true);assert.deepEqual(calls.map(x=>x.command),['wslview','xdg-open']);
  assert.equal(calls[0].args.length,1);assert.equal(calls[0].options.shell,false);
  await assert.rejects(openHostBrowser('http://attacker.example'),code('HOST_BROWSER_INVALID'));
});
