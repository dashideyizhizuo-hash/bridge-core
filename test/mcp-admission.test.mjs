import test from 'node:test';
import assert from 'node:assert/strict';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createBridgeMcpHandler} from '../src/mcp-server.mjs';

const MAX_BODY=2*1024*1024,MAX_ELEMENTS=10_000;
async function fixture(t,{owner='owner-a',gateway,handler}={}){
  const counts={calls:0};
  const read=async()=>{counts.calls++;return {owner};};
  const active=handler??createBridgeMcpHandler({gateway:gateway??{discover:read,run:read,getRun:read,getResult:read,publish:read}});
  const client=new Client({name:owner,version:'1'});
  t.after(async()=>{await client.close();if(!handler)await active.close();});
  await client.connect(new StreamableHTTPClientTransport(new URL('https://bounded.example/mcp'),{fetch:(input,init)=>active.fetch(new Request(input,init),{authInfo:{clientId:owner}})}));
  return {client,handler:active,counts};
}

test('MCP rejects excessive argument elements before reaching any gateway',async t=>{
  const f=await fixture(t);
  for(const parameters of [{items:Array(MAX_ELEMENTS+1).fill(0)},Object.fromEntries(Array.from({length:MAX_ELEMENTS+1},(_,i)=>['k'+i,0]))]){
    const result=await f.client.callTool({name:'bridge.run',arguments:{mode:'capability',parameters}});
    assert.equal(result.isError,true);assert.equal(f.counts.calls,0);
  }
  const ordinary=await f.client.callTool({name:'bridge.discover',arguments:{}});
  assert.notEqual(ordinary.isError,true);assert.equal(f.counts.calls,1);
});

test('MCP accepts the advertised maximum ASCII argv and a large bounded parameter value',async t=>{
  const f=await fixture(t);
  for(const arguments_ of [{mode:'direct',waitSeconds:0,argv:Array(64).fill('x'.repeat(8192))},{mode:'capability',parameters:{value:'中'.repeat(300_000)}}]){
    const result=await f.client.callTool({name:'bridge.run',arguments:arguments_});
    assert.notEqual(result.isError,true);
  }
  assert.equal(f.counts.calls,2);
});

test('MCP declared and chunked HTTP bodies above two MiB are denied before JSON parsing or gateway execution',async t=>{
  const f=await fixture(t);
  for(const declared of ['oversized','chunked','underreported']){
    let canceled=false;
    let emitted=false;
    const body=new ReadableStream({pull(controller){if(emitted)controller.close();else{emitted=true;controller.enqueue(new Uint8Array(MAX_BODY+1));}},cancel(){canceled=true;}},{highWaterMark:0});
    const response=await f.handler.fetch(new Request('https://bounded.example/mcp',{method:'POST',headers:{'content-type':'application/json','accept':'application/json, text/event-stream',...(declared==='chunked'?{}:{'content-length':declared==='oversized'?String(MAX_BODY+1):'1'})},body,duplex:'half'}));
    assert.equal(response.status,413);await response.body?.cancel();
    assert.equal(canceled,true);assert.equal(f.counts.calls,0);
  }
});

test('concurrent clients with colliding JSON-RPC IDs retain independent gateway identities',async t=>{
  let calls=0,release;const gate=new Promise(resolve=>{release=resolve;});
  const handler=createBridgeMcpHandler({gatewayForRequest:({authInfo})=>{
    const read=async()=>{if(++calls===2)release();await gate;return {owner:authInfo.clientId};};
    return {discover:read,run:read,getRun:read,getResult:read,publish:read};
  }});
  t.after(()=>handler.close());
  const [a,b]=await Promise.all([fixture(t,{owner:'principal-a',handler}),fixture(t,{owner:'principal-b',handler})]);
  const [ar,br]=await Promise.all([a.client.callTool({name:'bridge.discover',arguments:{}}),b.client.callTool({name:'bridge.discover',arguments:{}})]);
  assert.equal(ar.structuredContent.owner,'principal-a');assert.equal(br.structuredContent.owner,'principal-b');
});
