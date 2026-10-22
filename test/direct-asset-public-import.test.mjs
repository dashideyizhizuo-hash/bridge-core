import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DirectAssetService} from '../src/cloudflare/direct-asset-service.mjs';

const principal={bridgeUserId:'demo',externalProvider:'test',externalSubject:'demo'};
const data=Buffer.from('Bridge demo');
const digest=createHash('sha256').update(data).digest('hex');

function fixture(fetchImpl) {
  const fetched=[],writes=[],prepared=[];
  const unused=async()=>{throw Error('unused');};
  const service=new DirectAssetService({publicUrl:'https://bridge.example/mcp',
    randomUUID:()=> 'public-import',fetchImpl:async(url,init)=>{
      fetched.push({hostname:url.hostname,init});return fetchImpl(url,init);
    },
    bucket:{async put(key,bytes){writes.push({key,bytes:Buffer.from(bytes)});},async get(){return null;},async delete(){}},
    store:{create:unused,createReady:unused,getOwnedReady:unused,assertReady:unused,getRun:unused,getResult:unused,
      async findReadyBySource(){return null;},
      async prepareReady(input){prepared.push(input);return {...input,status:'WAITING_UPLOAD'};},
      async finalizePreparedReady(input){return {...input,status:'READY'};}}
  });
  return {fetched,writes,prepared,service,run:(url)=>service.importFile({principal,file:{
    download_url:url,file_id:'file-synthetic',file_name:'hello.txt',mime_type:'text/plain'
  }})};
}

for(const host of ['oaisdmntprnortheu.blob.core.windows.net','a-different-customer-cdn.example','files.openai.com']) {
  test('native import accepts public HTTPS without per-domain setup: '+host,async()=>{
    const f=fixture(async()=>new Response(data,{headers:{'content-length':String(data.length)}}));
    const result=await f.run('https://'+host+'/attachment?sig=synthetic-secret');
    assert.equal(result.status,'READY');assert.equal(f.fetched.length,1);
    assert.equal(f.prepared[0].sizeBytes,11);assert.equal(f.prepared[0].sha256,digest);
    assert.deepEqual(f.writes[0].bytes,data);
    const init=f.fetched[0].init;
    assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');
    assert.deepEqual(init.headers,{accept:'application/octet-stream'});
    assert.ok(init.signal instanceof AbortSignal);
  });
}

test('public cross-domain redirect works without forwarding caller credentials',async()=>{
  const f=fixture(async(url,init)=>url.hostname==='first.example'
    ?new Response(null,{status:302,headers:{location:'https://second.example/hello?sig=synthetic-secret'}})
    :new Response(data,{headers:{'content-length':'11'}}));
  assert.equal((await f.run('https://first.example/hello')).status,'READY');
  assert.deepEqual(f.fetched.map(x=>x.hostname),['first.example','second.example']);
  for(const {init} of f.fetched)assert.deepEqual(init.headers,{accept:'application/octet-stream'});
});

for(const url of [
  'http://public.example/file','file:///etc/passwd','https://user:secret@public.example/file',
  'https://public.example:8443/file','https://public.example/file#fragment',
  'https://localhost/file','https://a.localhost/file','https://printer.local/file',
  'https://metadata.google.internal/file','https://server.internal/file','https://home.arpa/file',
  'https://a.home.arpa/file','https://intranet/file','https://127.0.0.1/file',
  'https://2130706433/file','https://0x7f000001/file','https://0177.0.0.1/file',
  'https://10.1.2.3/file','https://169.254.169.254/file','https://100.100.100.200/file',
  'https://[::1]/file','https://[::ffff:127.0.0.1]/file','https://[fd00::1]/file'
])test('native import refuses non-public/unsafe target before fetch: '+url,async()=>{
  const f=fixture(async()=>{throw Error('must not fetch');});
  await assert.rejects(f.run(url),{code:'DIRECT_ASSET_IMPORT_DENIED'});
  assert.equal(f.fetched.length,0);assert.equal(f.writes.length,0);assert.equal(f.prepared.length,0);
});

for(const target of ['https://localhost/file','https://metadata.internal/file','https://169.254.169.254/file','http://second.example/file']) {
  test('native import checks every redirect before following: '+target,async()=>{
    const f=fixture(async()=>new Response(null,{status:302,headers:{location:target}}));
    await assert.rejects(f.run('https://first.example/file'),{code:'DIRECT_ASSET_IMPORT_DENIED'});
    assert.equal(f.fetched.length,1);assert.equal(f.writes.length,0);assert.equal(f.prepared.length,0);
  });
}

test('public redirect loop remains bounded with no persistence',async()=>{
  const f=fixture(async()=>new Response(null,{status:302,headers:{location:'https://another.example/file'}}));
  await assert.rejects(f.run('https://first.example/file'),{code:'DIRECT_ASSET_IMPORT_DENIED'});
  assert.equal(f.fetched.length,4);assert.equal(f.writes.length,0);assert.equal(f.prepared.length,0);
});
