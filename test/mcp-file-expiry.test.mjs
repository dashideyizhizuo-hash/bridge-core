import test from 'node:test';
import assert from 'node:assert/strict';
import {Client,StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
import {createBridgeMcpHandler} from '../src/mcp-server.mjs';
import {DirectAssetResourceCodec} from '../src/cloudflare/direct-asset-resource-codec.mjs';

const NOW=2_100_000_000_000,DAY=86400_000;
const principal={bridgeUserId:'expiry-owner',externalProvider:'fixture',externalSubject:'expiry-owner'};
async function fixture(t,options={}) {
  const {topLevel=false,assetExpiry=NOW+DAY,persistent=false,onIssue,secondAsset=false,duplicateFirstAsset=false}=options;
  const accessExpiry=Object.hasOwn(options,'accessExpiry')?options.accessExpiry:'codec';
  let now=NOW,issued=0;
  const asset=Object.freeze({kind:'asset',transport:'direct-asset',status:'READY',assetId:'asset-expiry-12345678',fileName:'hello.txt',mimeType:'text/plain',sizeBytes:11,persistent,...(assetExpiry===undefined?{}:{expiresAt:assetExpiry})});
  const assets=[asset,...(duplicateFirstAsset?[Object.freeze({...asset})]:[]),...(secondAsset?[Object.freeze({...asset,assetId:'asset-expiry-second-12345678',fileName:'second.txt',expiresAt:NOW+DAY})]:[])];
  const receipt=topLevel?Object.freeze({runId:'da1:asset-expiry-12345678',...asset}):Object.freeze({runId:'dx1:host-expiry:request-12345678',kind:'direct',transport:'direct',status:'SUCCEEDED',evidence:{stdout:'complete',stderr:''},exports:Object.freeze(assets)});
  const codec=new DirectAssetResourceCodec({secret:'synthetic-expiry-secret-abcdefghijklmnopqrstuvwxyz',clock:()=>now});
  const gateway={discover:async()=>({}),run:async()=>receipt,getRun:async()=>receipt,getResult:async()=>receipt,publish:async()=>{throw Error('not used');},issueAssetResource:async({assetId})=>{
    issued++;assert.ok(assets.some(item=>item.assetId===assetId));let result;
    if(accessExpiry==='codec'){const value=await codec.issue({principal,assetId});result={uri:'bridge-file:///access/'+value.token,expiresAt:value.expiresAt};}
    else result={uri:'bridge-file:///access/synthetic-expiry-fixture',...(accessExpiry===undefined?{}:{expiresAt:accessExpiry})};
    onIssue?.({assetId,set:value=>{now=value;}});return result;
  }};
  const handler=createBridgeMcpHandler({gateway,clock:()=>now}),client=new Client({name:'expiry-fixture',version:'1'});
  t.after(async()=>{await client.close();await handler.close();});
  await client.connect(new StreamableHTTPClientTransport(new URL('https://expiry-fixture.test/mcp'),{fetch:(input,init)=>handler.fetch(new Request(input,init))}));
  return {asset,receipt,client,issued:()=>issued,set:value=>{now=value;},read:()=>client.callTool({name:'bridge.get_result',arguments:{runId:receipt.runId}})};
}

test('MCP distinguishes the actual fifteen-minute download expiry from one-day file retention',async t=>{
  const f=await fixture(t),result=await f.read();assert.equal(result.isError,undefined);
  const item=result.structuredContent.exports[0],link=result.content.find(value=>value.type==='resource_link');
  assert.equal(item.expiresAt,NOW+DAY);assert.equal(item.downloadExpiresAt,NOW+900_000);
  assert.match(link.description,/download access expires at/i);assert.ok(link.description.includes(new Date(item.downloadExpiresAt).toISOString()));
  assert.match(link.description,/file retention expires at/i);assert.ok(link.description.includes(new Date(item.expiresAt).toISOString()));
  assert.equal(Object.hasOwn(f.asset,'downloadExpiresAt'),false,'historical receipts are not mutated');
  assert.equal(JSON.stringify(result.structuredContent).includes('bridge-file:'),false,'signed access remains only in resource links');
  const polled=await f.client.callTool({name:'bridge.get_run',arguments:{runId:f.receipt.runId}});assert.deepEqual(polled.structuredContent,f.receipt);assert.equal(f.issued(),1);
  f.set(NOW+1000);const refreshed=await f.read();assert.equal(refreshed.structuredContent.exports[0].downloadExpiresAt,NOW+901_000);assert.equal(refreshed.structuredContent.exports[0].expiresAt,NOW+DAY);
});

test('MCP standalone transferred-file results carry the same distinct download metadata',async t=>{
  const f=await fixture(t,{topLevel:true}),result=await f.read();
  assert.equal(result.structuredContent.expiresAt,NOW+DAY);assert.equal(result.structuredContent.downloadExpiresAt,NOW+900_000);
  assert.equal(Object.hasOwn(f.receipt,'downloadExpiresAt'),false);
});

test('MCP reports earlier file retention separately without promising access until the capability deadline',async t=>{
  const f=await fixture(t,{assetExpiry:NOW+60_000}),result=await f.read(),item=result.structuredContent.exports[0];
  assert.equal(item.expiresAt,NOW+60_000);assert.equal(item.downloadExpiresAt,NOW+900_000);
  const link=result.content.find(value=>value.type==='resource_link');assert.ok(link.description.includes(new Date(NOW+60_000).toISOString()));
  assert.match(link.description,/earlier file expiry, deletion or revoked access can prevent download/i);
});

test('MCP never guesses access expiry from retention or a default when the issuer does not provide a valid instant',async t=>{
  for(const accessExpiry of [undefined,null,'2100000900000',NaN,Infinity,-1,8_640_000_000_000_001]) {
    await t.test(String(accessExpiry),async t=>{
      const f=await fixture(t,{accessExpiry}),result=await f.read();assert.equal(result.isError,undefined);
      assert.equal(Object.hasOwn(result.structuredContent.exports[0],'downloadExpiresAt'),false);
      const link=result.content.find(value=>value.type==='resource_link');assert.ok(link);assert.match(link.description,/download access expiry (?:is )?(?:unavailable|not provided)/i);
      assert.equal(link.description.includes(new Date(NOW+900_000).toISOString()),false,'no invented default deadline');
      assert.equal(result.structuredContent.exports[0].expiresAt,NOW+DAY);
    });
  }
});

test('MCP does not advertise an already expired access link as a retained file expiring',async t=>{
  const f=await fixture(t,{accessExpiry:NOW}),result=await f.read();assert.equal(result.isError,undefined);
  assert.equal(result.content.some(value=>value.type==='resource_link'),false);
  assert.equal(result.structuredContent.exports[0].expiresAt,NOW+DAY);
  assert.equal(result.structuredContent.exports[0].downloadExpiresAt,NOW);
  assert.equal(result.structuredContent.exports[0].downloadAvailability,'expired');
  assert.equal(Object.hasOwn(result.structuredContent.exports[0],'availability'),false,'the file itself has not expired');
  assert.ok(result.content.some(value=>value.type==='text'&&/download access.*expired/i.test(value.text)));
});

test('MCP catches access expiry while awaiting issue without reissuing or discarding command evidence',async t=>{
  const f=await fixture(t,{onIssue:({set})=>set(NOW+900_000)}),result=await f.read();
  assert.equal(result.content.some(value=>value.type==='resource_link'),false);assert.equal(f.issued(),1);
  assert.equal(result.structuredContent.evidence.stdout,'complete');assert.equal(result.structuredContent.exports[0].downloadAvailability,'expired');
});

test('MCP finalizes all files after later authorization awaits cross the first retention deadline',async t=>{
  const f=await fixture(t,{assetExpiry:NOW+1,secondAsset:true,onIssue:({assetId,set})=>{if(assetId!== 'asset-expiry-12345678')set(NOW+2);}}),result=await f.read();
  assert.equal(result.isError,undefined);assert.equal(f.issued(),2,'one authorization per file, no reissue');
  assert.deepEqual(result.structuredContent.exports[0],{...f.asset,availability:'expired'});
  const links=result.content.filter(item=>item.type==='resource_link');assert.deepEqual(links.map(item=>item.name),['second.txt']);
  assert.equal(result.structuredContent.exports[1].downloadExpiresAt,NOW+900_000);
  assert.equal(result.structuredContent.evidence.stdout,'complete');assert.equal(Object.hasOwn(f.asset,'availability'),false);
});

test('MCP finalizes all access links after later authorization awaits cross the first access deadline',async t=>{
  const f=await fixture(t,{secondAsset:true,onIssue:({assetId,set})=>{if(assetId!== 'asset-expiry-12345678')set(NOW+900_001);}}),result=await f.read();
  assert.equal(result.isError,undefined);assert.equal(f.issued(),2,'one authorization per file, no reissue');
  assert.equal(result.content.some(item=>item.type==='resource_link'),false);
  for(const item of result.structuredContent.exports){assert.equal(item.downloadExpiresAt,NOW+900_000);assert.equal(item.downloadAvailability,'expired');assert.equal(Object.hasOwn(item,'availability'),false);}
  assert.equal(result.structuredContent.evidence.stdout,'complete');assert.equal(Object.hasOwn(f.asset,'downloadAvailability'),false);
});

test('MCP marks duplicate file receipts expired consistently after a later authorization await',async t=>{
  const f=await fixture(t,{assetExpiry:NOW+1,duplicateFirstAsset:true,secondAsset:true,onIssue:({assetId,set})=>{if(assetId!=='asset-expiry-12345678')set(NOW+2);}}),result=await f.read();
  assert.equal(result.isError,undefined);assert.equal(f.issued(),2,'one issue per unique asset ID');
  assert.deepEqual(result.structuredContent.exports.slice(0,2),[{...f.asset,availability:'expired'},{...f.asset,availability:'expired'}]);
  assert.deepEqual(result.content.filter(item=>item.type==='resource_link').map(item=>item.name),['second.txt']);
  assert.equal(result.structuredContent.exports[2].downloadExpiresAt,NOW+900_000);
  assert.notEqual(f.receipt.exports[0],f.receipt.exports[1]);assert.ok(f.receipt.exports.slice(0,2).every(item=>!Object.hasOwn(item,'availability')));
});

test('MCP finalizes standalone file retention without confusing it with access expiry',async t=>{
  const f=await fixture(t,{topLevel:true,assetExpiry:NOW+1,onIssue:({set})=>set(NOW+2)}),result=await f.read();
  assert.equal(result.isError,undefined);assert.equal(f.issued(),1);assert.equal(result.content.some(item=>item.type==='resource_link'),false);
  assert.deepEqual(result.structuredContent,{...f.receipt,availability:'expired'});
  assert.equal(Object.hasOwn(f.receipt,'availability'),false);
});

test('MCP finalizing after later awaits does not invent or expire unknown access metadata',async t=>{
  const f=await fixture(t,{accessExpiry:undefined,secondAsset:true,onIssue:({assetId,set})=>{if(assetId!=='asset-expiry-12345678')set(NOW+900_001);}}),result=await f.read();
  assert.equal(result.isError,undefined);assert.equal(f.issued(),2);assert.deepEqual(result.structuredContent,f.receipt);
  assert.equal(result.content.filter(item=>item.type==='resource_link').length,2);
});

test('MCP does not label legacy persistent storage as expiring at its obsolete retention timestamp',async t=>{
  const f=await fixture(t,{persistent:true,assetExpiry:NOW-1}),result=await f.read();
  assert.ok(result.content.find(value=>value.type==='resource_link'));
  assert.doesNotMatch(result.content.find(value=>value.type==='resource_link').description,/file retention expires at/i);
  assert.equal(result.structuredContent.exports[0].expiresAt,NOW-1);assert.equal(result.structuredContent.exports[0].downloadExpiresAt,NOW+900_000);
});
