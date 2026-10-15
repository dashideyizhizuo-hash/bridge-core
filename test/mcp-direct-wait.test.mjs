import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createBridgeMcpHandler } from '../src/mcp-server.mjs';

const receipt={runId:'dx1:host-a:direct-wait-0001',hostId:'host-a',kind:'direct',transport:'direct',status:'QUEUED'};
const result={...receipt,status:'SUCCEEDED',evidence:{stdout:'中文 whoami\n',stderr:''}};
async function clientFor(t,gateway) {
  const handler=createBridgeMcpHandler({gateway});
  const transport=new StreamableHTTPClientTransport(new URL('https://bridge.test/mcp'),{
    fetch:(input,init)=>handler.fetch(new Request(input,init))
  });
  const client=new Client({name:'wait-test',version:'1'});
  t.after(async()=>{await client.close();await handler.close();});
  await client.connect(transport);return client;
}
function fixture() {
  const calls={submit:0,state:0,result:0},inputs=[];
  return {calls,inputs,gateway:{
    async discover(){return {};},async publish(){throw Error('not publishable');},
    async run(args){calls.submit++;inputs.push(args);return receipt;},
    async getRun({runId}){assert.equal(runId,receipt.runId);calls.state++;return {...receipt,status:'SUCCEEDED'};},
    async getResult({runId}){assert.equal(runId,receipt.runId);calls.result++;return result;}
  }};
}
test('Direct MCP wait returns completed bounded output after exactly one submission',async t=>{
  const f=fixture(),client=await clientFor(t,f.gateway);
  const response=await client.callTool({name:'bridge.run',arguments:{mode:'direct',argv:['whoami'],waitSeconds:10}});
  assert.equal(response.isError,undefined);assert.deepEqual(response.structuredContent,result);
  assert.deepEqual(f.calls,{submit:1,state:1,result:1});
  assert.deepEqual(f.inputs,[{mode:'direct',argv:['whoami']}],'wait is not an execution/billing identity parameter');
});
test('omitted Direct wait returns completed output for clients with older tool schemas',async t=>{
  const f=fixture(),client=await clientFor(t,f.gateway);
  const response=await client.callTool({name:'bridge.run',arguments:{mode:'direct',argv:['whoami']}});
  assert.equal(response.isError,undefined);assert.deepEqual(response.structuredContent,result);
  assert.deepEqual(f.calls,{submit:1,state:1,result:1});
  assert.deepEqual(f.inputs,[{mode:'direct',argv:['whoami']}]);
});
test('explicit zero wait preserves immediate async receipt without polling',async t=>{
  const f=fixture(),client=await clientFor(t,f.gateway);
  const response=await client.callTool({name:'bridge.run',arguments:{mode:'direct',argv:['whoami'],waitSeconds:0}});
  assert.deepEqual(response.structuredContent,receipt);
  assert.deepEqual(f.calls,{submit:1,state:0,result:0});
});
test('non-Direct calls without wait keep their original behavior',async t=>{
  const f=fixture(),client=await clientFor(t,f.gateway);
  for(const mode of ['host','connect','asset','capability','edit','batch']) {
    const response=await client.callTool({name:'bridge.run',arguments:{mode}});
    assert.equal(response.isError,undefined);assert.deepEqual(response.structuredContent,receipt);
  }
  assert.deepEqual(f.calls,{submit:6,state:0,result:0});
});
test('wait timeout returns the same running ID; a later result read never submits again',async t=>{
  const f=fixture();f.gateway.getRun=async()=>{f.calls.state++;return {...receipt,status:'RUNNING'};};
  const client=await clientFor(t,f.gateway);
  const response=await client.callTool({name:'bridge.run',arguments:{mode:'direct',argv:['sleep','20'],waitSeconds:1}});
  assert.equal(response.isError,undefined);assert.equal(response.structuredContent.runId,receipt.runId);
  assert.equal(response.structuredContent.status,'RUNNING');assert.ok(f.calls.state>=1&&f.calls.state<=2);
  const later=await client.callTool({name:'bridge.get_result',arguments:{runId:receipt.runId}});
  assert.deepEqual(later.structuredContent,result);assert.equal(f.calls.submit,1);
});
test('invalid or non-Direct waits reject before any execution side effect',async t=>{
  const f=fixture(),client=await clientFor(t,f.gateway);
  for(const args of [
    {mode:'direct',waitSeconds:11},{mode:'direct',waitSeconds:-1},{mode:'direct',waitSeconds:0.5},
    {mode:'host',host:'host-a',enabled:false,waitSeconds:1},{mode:'asset',waitSeconds:0}
  ]) {
    const response=await client.callTool({name:'bridge.run',arguments:args});
    assert.equal(response.isError,true);
  }
  assert.equal(f.calls.submit,0);
});
test('waited file exports return metadata; links remain an explicit get_result read',async t=>{
  const f=fixture(),exported={kind:'asset',transport:'direct-asset',status:'READY',assetId:'asset-12345678',fileName:'中文.txt',mimeType:'text/plain',sizeBytes:4,persistent:false,expiresAt:Date.now()+60000};
  f.gateway.getResult=async()=>({...result,exports:[exported]});
  let links=0;f.gateway.issueAssetResource=async()=>{links++;return {uri:'bridge-file:///access/test-token'};};
  const client=await clientFor(t,f.gateway);
  const response=await client.callTool({name:'bridge.run',arguments:{mode:'direct',argv:['whoami'],waitSeconds:10}});
  assert.equal(response.isError,undefined);assert.equal(response.structuredContent.exports[0].assetId,exported.assetId);
  assert.equal(response.content.some(item=>item.type==='resource_link'),false);assert.equal(links,0);
  const explicit=await client.callTool({name:'bridge.get_result',arguments:{runId:receipt.runId}});
  assert.equal(explicit.content.some(item=>item.type==='resource_link'),true);assert.equal(links,1);
});
