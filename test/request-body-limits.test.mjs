import test from 'node:test';
import assert from 'node:assert/strict';
import { readBoundedBody, readBoundedText } from '../src/cloudflare/request-body.mjs';
import { createDirectRunnerHandler } from '../src/cloudflare/direct-runner-api.mjs';
import { createDirectAssetHandler } from '../src/cloudflare/direct-asset-api.mjs';

function streamingRequest({chunks=4,chunkBytes=40000,headers={}}={}) {
  let pulls=0,canceled=false;
  const body=new ReadableStream({
    pull(controller) {pulls++;controller.enqueue(new Uint8Array(chunkBytes));if(pulls===chunks) controller.close();},
    cancel(){canceled=true;}
  },{highWaterMark:0});
  return {request:new Request('https://bridge.example/direct/runner/claim',{
    method:'POST',headers,body,duplex:'half'}),stats:()=>({pulls,canceled})};
}
for(const declared of ['999999999','-1','broken','9007199254740992']) {
  test(`request reader rejects invalid declared length ${declared} without consuming bytes`,async()=>{
    const f=streamingRequest({headers:{'content-length':declared}});
    await assert.rejects(readBoundedBody(f.request,{maxBytes:1024,code:'TEST_LIMIT'}),e=>e.code==='TEST_LIMIT');
    assert.deepEqual(f.stats(),{pulls:0,canceled:true});
  });
}
test('request reader stops on the first excessive chunk and cancels the stream',async()=>{
  const f=streamingRequest();
  await assert.rejects(readBoundedBody(f.request,{maxBytes:65536,code:'TEST_LIMIT'}),e=>e.code==='TEST_LIMIT');
  assert.deepEqual(f.stats(),{pulls:2,canceled:true});
});

test('already-aborted read waits for a late upstream body cancellation without pulling bytes',async()=>{
  const abort=new AbortController();const reason=new Error('request canceled');abort.abort(reason);
  let pulls=0,canceled=false,finishCancel,settled=false;
  const response=new Response(new ReadableStream({pull(){pulls++;},cancel(){canceled=true;return new Promise(resolve=>{finishCancel=resolve;});}},{highWaterMark:0}));
  const operation=readBoundedBody(response,{maxBytes:1024,code:'TEST_LIMIT',signal:abort.signal});
  const check=assert.rejects(operation,error=>error===reason).then(()=>{settled=true;});
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(canceled,true);assert.equal(pulls,0);assert.equal(settled,false);
  finishCancel();await check;
});
test('request reader preserves UTF-8 spanning chunks and accepts exact limit',async()=>{
  const bytes=new TextEncoder().encode('你好吗');
  const body=new ReadableStream({start(c){c.enqueue(bytes.subarray(0,2));c.enqueue(bytes.subarray(2));c.close();}});
  const request=new Request('https://bridge.example',{method:'POST',body,duplex:'half'});
  assert.equal(await readBoundedText(request,{maxBytes:bytes.length,code:'TEST_LIMIT'}),'你好吗');
});
test('request reader preallocates declared bytes and enforces exact declared length',async()=>{
  const bytes=new Uint8Array([1,2,3,4,5,6]);
  const okBody=new ReadableStream({start(c){c.enqueue(bytes.subarray(0,2));c.enqueue(bytes.subarray(2));c.close();}});
  const ok=new Request('https://bridge.example',{method:'POST',headers:{'content-length':String(bytes.length)},body:okBody,duplex:'half'});
  assert.deepEqual(await readBoundedBody(ok,{maxBytes:64,code:'TEST_LIMIT'}),bytes);

  const shortBody=new ReadableStream({start(c){c.enqueue(bytes.subarray(0,4));c.close();}});
  const short=new Request('https://bridge.example',{method:'POST',headers:{'content-length':String(bytes.length)},body:shortBody,duplex:'half'});
  await assert.rejects(readBoundedBody(short,{maxBytes:64,code:'TEST_LIMIT'}),e=>e.code==='TEST_LIMIT');

  let canceled=false;
  const longBody=new ReadableStream({
    start(c){c.enqueue(bytes);c.enqueue(new Uint8Array([7]));},
    cancel(){canceled=true;}
  });
  const long=new Request('https://bridge.example',{method:'POST',headers:{'content-length':String(bytes.length)},body:longBody,duplex:'half'});
  await assert.rejects(readBoundedBody(long,{maxBytes:64,code:'TEST_LIMIT'}),e=>e.code==='TEST_LIMIT');
  assert.equal(canceled,true);
});

test('request reader handles absent bodies and preserves stream failures',async()=>{
  assert.equal((await readBoundedBody(new Request('https://bridge.example'),{maxBytes:10,code:'TEST_LIMIT'})).length,0);
  const failure=new Error('test stream interrupted');
  const body=new ReadableStream({pull(c){c.error(failure);}});
  const request=new Request('https://bridge.example',{method:'POST',body,duplex:'half'});
  await assert.rejects(readBoundedBody(request,{maxBytes:10,code:'TEST_LIMIT'}),error=>error===failure);
});
test('runner endpoint rejects chunked excess before store access with a stable public error',async()=>{
  let called=false;
  const handler=createDirectRunnerHandler({store:{async claimNext(){called=true;},async renewLease(){},async complete(){}}});
  const f=streamingRequest({headers:{authorization:`Bearer ${'r'.repeat(43)}`}});
  const response=await handler.fetch(f.request);
  assert.equal(response.status,400);assert.equal((await response.json()).error.code,'DIRECT_RUN_INVALID');
  assert.equal(called,false);assert.deepEqual(f.stats(),{pulls:2,canceled:true});
});
test('asset upload rejects chunked excess before private object persistence',async()=>{
  let put=false,marked=false;
  const handler=createDirectAssetHandler({store:{
    async authorizeUpload(){return {sizeBytes:65536,sha256:'a'.repeat(64)};},
    async markReady(){marked=true;},async authorizeRunnerDownload(){}
  },bucket:{async put(){put=true;},async get(){},async delete(){}}});
  const f=streamingRequest({headers:{authorization:`Bearer ${'u'.repeat(43)}`}});
  const request=new Request('https://bridge.example/direct/assets/upload/asset-12345678',{
    method:'PUT',headers:f.request.headers,body:f.request.body,duplex:'half'});
  const response=await handler.fetch(request);
  assert.equal(response.status,403);assert.equal(put,false);assert.equal(marked,false);
  assert.deepEqual(f.stats(),{pulls:2,canceled:true});
});
