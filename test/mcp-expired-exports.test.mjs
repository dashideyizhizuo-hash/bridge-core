import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {D1DirectAssetStore} from '../src/cloudflare/d1-direct-asset-store.mjs';
import {D1DirectExecStore} from '../src/cloudflare/d1-direct-exec-store.mjs';
import {DirectAssetService} from '../src/cloudflare/direct-asset-service.mjs';
import {createBridgeMcpHandler} from '../src/mcp-server.mjs';
import {BridgeError} from '../src/errors.mjs';

const principal={bridgeUserId:'u',externalProvider:'test',externalSubject:'u'};
const runId='dx1:host-test:request-1234';
async function fixture(t) {
  const sql=new DatabaseSync(':memory:');let now=100000;
  const clock=()=>now;
  sql.exec("CREATE TABLE bridge_users(id TEXT PRIMARY KEY);INSERT INTO bridge_users VALUES('u')");
  for(const file of ['0009_direct_exec.sql','0010_direct_exec_hardening.sql','0039_direct_run_progress.sql','0011_direct_assets.sql','0012_persistent_direct_assets.sql','0021_direct_asset_object_retirements.sql'])
    sql.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  const db={prepare(q){return{bind(...args){return{
    run:async()=>sql.prepare(q).run(...args),first:async()=>sql.prepare(q).get(...args)??null,
    all:async()=>({results:sql.prepare(q).all(...args)})};}}},batch:async()=>{throw Error('unused');}};
  const store=new D1DirectAssetStore({db,clock}),runs=new D1DirectExecStore({db,clock});
  const create=(suffix,options={})=>store.createReady({principal,assetId:'asset-'+suffix,objectKey:'direct-assets/'+suffix,fileName:'输出.txt',mimeType:'text/plain',sizeBytes:3,sha256:'a'.repeat(64),...options});
  const short=await create('short-file',{ttlMs:60000}),long=await create('long-file'),legacy=await create('legacy-file',{persistent:true,ttlMs:60000});
  sql.prepare('INSERT INTO direct_hosts(host_id,bridge_user_id,runner_token_sha256,enabled,created_at,updated_at)VALUES(?,?,?,1,?,?)').run('host-test','u','b'.repeat(64),now,now);
  const result={status:'SUCCEEDED',execution:{exitCode:0},evidence:{stdout:'仍应可读的运行证据',stderr:''},exports:[short,long,legacy]};
  sql.prepare("INSERT INTO direct_runs(request_id,run_id,bridge_user_id,host_id,request_json,status,result_json,created_at,updated_at,completed_at)VALUES(?,?,?,?,?,'SUCCEEDED',?,?,?,?)").run('request-1234',runId,'u','host-test','{}',JSON.stringify(result),now,now,now);
  const issued=[];
  const service=new DirectAssetService({store,resourceCodec:{verify(){},issue:async({assetId})=>({token:assetId,expiresAt:now+10000})},publicUrl:'https://bridge.example'});
  let denied,beforeIssue;
  const handler=createBridgeMcpHandler({clock,gateway:{discover(){},run(){},getRun:({runId})=>runs.getRun({principal,runId}),getResult:({runId})=>runs.getResult({principal,runId}),publish(){},issueAssetResource:({assetId})=>{
    issued.push(assetId);beforeIssue?.(assetId);if(denied===assetId)throw new BridgeError('DIRECT_ASSET_DENIED','permission revoked');
    return service.issueResource({principal,assetId});
  }}});
  t.after(async()=>{await handler.close();sql.close();});
  const read=async(id=runId)=>{
    const response=await handler.fetch(new Request('https://bridge.example/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'bridge.get_result',arguments:{runId:id}}})}));
    const body=await response.text();return JSON.parse(body.slice(body.indexOf('data: ')+6).trim()).result;
  };
  return {sql,store,runs,short,long,legacy,result,issued,read,set:value=>{now=value;},deny:id=>{denied=id;},onIssue:callback=>{beforeIssue=callback;}};
}

test('MCP preserves command evidence and mixed receipts after expiry and metadata pruning',async t=>{
  const f=await fixture(t);
  const before=await f.read();assert.equal(before.isError,undefined);
  assert.equal(before.content.filter(item=>item.type==='resource_link').length,3);
  assert.deepEqual(f.issued,[f.short.assetId,f.long.assetId,f.legacy.assetId]);
  f.issued.length=0;f.set(f.short.expiresAt);
  const after=await f.read();assert.equal(after.isError,undefined);
  assert.equal(after.structuredContent.evidence.stdout,f.result.evidence.stdout);
  assert.deepEqual(after.structuredContent.exports[0],{...f.short,availability:'expired'});
  assert.deepEqual(after.structuredContent.exports.slice(1),[f.long,f.legacy].map(item=>({...item,downloadExpiresAt:f.short.expiresAt+10000})));
  assert.equal(after.content.filter(item=>item.type==='resource_link').length,2);
  assert.deepEqual(f.issued,[f.long.assetId,f.legacy.assetId]);
  assert.equal(after.content.filter(item=>item.type==='text').length,2);
  assert.match(after.content[1].text,/expired/);
  assert.deepEqual((await f.runs.getResult({principal,runId})).exports,f.result.exports,'MCP annotation never mutates stored historical receipts');

  // Seven-day asset metadata pruning must not hide a fourteen-day run result.
  f.set(f.long.expiresAt+8*86400000);
  f.sql.exec("UPDATE direct_assets SET status='EXPIRED' WHERE persistent=0");
  assert.equal((await f.store.pruneExpiredMetadata()).removed,2);
  f.issued.length=0;
  const pruned=await f.read();assert.equal(pruned.isError,undefined);
  assert.equal(pruned.structuredContent.evidence.stdout,f.result.evidence.stdout);
  assert.deepEqual(pruned.structuredContent.exports.slice(0,2).map(item=>item.availability),['expired','expired']);
  assert.deepEqual(f.issued,[f.legacy.assetId]);
  assert.equal(pruned.content.filter(item=>item.type==='resource_link').length,1);
});

test('MCP does not downgrade live export denial or an unauthorized run into expiry',async t=>{
  const f=await fixture(t);f.set(f.short.expiresAt);f.deny(f.long.assetId);
  const denied=await f.read();assert.equal(denied.isError,true);
  assert.equal(denied.structuredContent.error.code,'DIRECT_ASSET_DENIED');
  f.sql.exec("INSERT INTO bridge_users VALUES('other');UPDATE direct_runs SET bridge_user_id='other'");
  const foreign=await f.read();assert.equal(foreign.isError,true);
  assert.equal(foreign.structuredContent.error.code,'RUN_NOT_FOUND');
});

test('MCP requires explicit temporary expiry evidence and keeps legacy permanent authorization checks',async t=>{
  const f=await fixture(t);f.set(f.long.expiresAt+1);
  for(const receipt of [
    {...f.short,expiresAt:undefined},
    {...f.short,expiresAt:String(f.short.expiresAt)},
    {...f.short,expiresAt:null},
    {...f.short,persistent:undefined},
    f.legacy
  ]) {
    f.sql.prepare('UPDATE direct_runs SET result_json=?').run(JSON.stringify({...f.result,exports:[receipt]}));
    f.deny(receipt.assetId);f.issued.length=0;
    const result=await f.read();assert.equal(result.isError,true);
    assert.equal(result.structuredContent.error.code,'DIRECT_ASSET_DENIED');
    assert.deepEqual(f.issued,[receipt.assetId]);
  }
});

test('TTL crossing during resource authorization preserves output using receipt evidence',async t=>{
  const f=await fixture(t);f.set(f.short.expiresAt-1);
  f.onIssue(assetId=>{if(assetId===f.short.assetId)f.set(f.short.expiresAt);});
  const result=await f.read();assert.equal(result.isError,undefined);
  assert.equal(result.structuredContent.evidence.stdout,f.result.evidence.stdout);
  assert.equal(result.structuredContent.exports[0].availability,'expired');
  assert.equal(result.content.filter(item=>item.type==='resource_link').length,2);
  assert.deepEqual(f.issued,[f.short.assetId,f.long.assetId,f.legacy.assetId]);
});

test('TTL crossing never downgrades unexpected or authorization-service failures',async t=>{
  const f=await fixture(t);
  for(const error of [new TypeError('unexpected fixture failure'),new BridgeError('AUTH_SERVICE_UNAVAILABLE','authorization service unavailable')]) {
    f.set(f.short.expiresAt-1);f.issued.length=0;
    f.onIssue(assetId=>{
      if(assetId===f.short.assetId){f.set(f.short.expiresAt);throw error;}
    });
    const result=await f.read();assert.equal(result.isError,true);
    assert.equal(result.structuredContent.error.code,error.code ?? 'INTERNAL_ERROR');
    assert.deepEqual(f.issued,[f.short.assetId]);
    assert.equal(result.content.some(item=>item.type==='resource_link'),false);
  }
});
