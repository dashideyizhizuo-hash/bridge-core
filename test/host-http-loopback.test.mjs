import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { request } from 'node:http';
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
  assert.equal((await response.text()).includes('secret-authorization-code'),false);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(await cb.result,{authorizationCode:'secret-authorization-code',iss:issuer});
  assert.equal((await fetch(callbackUrl(cb))).status,409);
});
for(const [parameters,expected] of [
  [{iss:'https://attacker.example'},'HOST_ISSUER_DENIED'],
  [{error:'access_denied',error_description:'SECRET'},'HOST_LOGIN_DENIED'],
  [{code:''},'HOST_CALLBACK_INVALID']
]) test(`loopback rejects ${expected}`,async t=>{
  const cb=await createHostCallback({issuer,timeoutMs:2000});t.after(()=>cb.close());
  const response=await fetch(callbackUrl(cb,parameters));
  assert.equal(response.status,400);assert.equal((await response.text()).includes('SECRET'),false);
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
