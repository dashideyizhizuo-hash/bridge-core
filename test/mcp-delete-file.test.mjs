import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {D1DirectAssetStore} from '../src/cloudflare/d1-direct-asset-store.mjs';
import {DirectAssetService} from '../src/cloudflare/direct-asset-service.mjs';
import {BridgeGateway} from '../src/gateway.mjs';
import {invokePublicTool} from '../src/mcp-public-api.mjs';

const principal=id=>({bridgeUserId:id,externalProvider:'test',externalSubject:id});
async function fixture(t,{persistent=true}={}){
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  sql.exec(`CREATE TABLE bridge_users(id TEXT PRIMARY KEY);INSERT INTO bridge_users VALUES('alice'),('bob');
    CREATE TABLE direct_hosts(host_id TEXT,bridge_user_id TEXT,runner_token_sha256 TEXT,enabled INTEGER);
    CREATE TABLE direct_runs(run_id TEXT,host_id TEXT,bridge_user_id TEXT,status TEXT,lease_owner TEXT,lease_expires_at INTEGER,request_json TEXT DEFAULT '{}',created_at INTEGER DEFAULT 0,expires_at INTEGER);`);
  for(const name of ['0011_direct_assets.sql','0012_persistent_direct_assets.sql','0021_direct_asset_object_retirements.sql'])sql.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  const db={batch:async statements=>{sql.exec('BEGIN');try{const result=[];for(const statement of statements)result.push(await statement.all());sql.exec('COMMIT');return result;}catch(error){sql.exec('ROLLBACK');throw error;}},prepare(query){return {bind(...args){return {run:async()=>sql.prepare(query).run(...args),first:async()=>sql.prepare(query).get(...args)??null,all:async()=>({results:sql.prepare(query).all(...args)})};}}}};
  let now=1_000_000;const store=new D1DirectAssetStore({db,clock:()=>now});
  const prepared=await store.prepareReady({principal:principal('alice'),assetId:'asset-delete-1234',objectKey:'direct-assets/delete-1234',fileName:'报告.txt',mimeType:'text/plain',sizeBytes:3,sha256:'a'.repeat(64),sourceKind:'openai-file',sourceRef:'legacy-source'});
  await store.finalizePreparedReady({principal:principal('alice'),assetId:prepared.assetId,objectKey:prepared.objectKey});
  // Seed a legacy record directly. No public tool creates permanent storage.
  if(persistent)sql.prepare('UPDATE direct_assets SET persistent=1 WHERE asset_id=?').run(prepared.assetId);
  const objects=new Set([prepared.objectKey]),deleted=[];
  const bucket={put:async()=>{},get:async()=>{throw Error('deleted resources must be denied before storage reads');},delete:async key=>{deleted.push(key);objects.delete(key);}};
  const service=new DirectAssetService({store,bucket,resourceCodec:{issue(){},verify:async()=>({assetId:prepared.assetId,expiresAt:now+1000})},publicUrl:'https://core.example/mcp'});
  return {sql,store,service,bucket,objects,deleted,assetId:prepared.assetId,objectKey:prepared.objectKey,tick:ms=>{now+=ms;}};
}

test('owned legacy permanent deletion removes exact object and invalidates cached capabilities/host asset reads',async t=>{
  const f=await fixture(t);const reply=await f.service.deletePersistent({principal:principal('alice'),assetId:f.assetId});
  assert.equal(reply.deleted,true);assert.equal(reply.status,'EXPIRED');assert.equal(f.objects.has(f.objectKey),false);assert.deepEqual(f.deleted,[f.objectKey]);
  const row=f.sql.prepare('SELECT status,source_kind,source_ref,upload_token_sha256 FROM direct_assets WHERE asset_id=?').get(f.assetId);
  assert.deepEqual({...row},{status:'EXPIRED',source_kind:null,source_ref:null,upload_token_sha256:null});
  await assert.rejects(f.service.readResource({principal:principal('alice'),token:'previously-issued-token'}),error=>error?.code==='DIRECT_ASSET_DENIED');
  await assert.rejects(f.store.assertReady({principal:principal('alice'),assetIds:[f.assetId]}),error=>error?.code==='DIRECT_ASSET_DENIED');
  assert.equal(await f.store.findReadyBySource({bridgeUserId:'alice',sourceKind:'openai-file',sourceRef:'legacy-source'}),null);
  f.tick(8*24*60*60*1000);assert.deepEqual(await f.store.pruneExpiredMetadata(),{removed:1});
});

test('foreign, temporary and non-READY objects cannot reach physical deletion',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.service.deletePersistent({principal:principal('bob'),assetId:f.assetId}),error=>error?.code==='DIRECT_ASSET_DENIED');
  f.sql.prepare('UPDATE direct_assets SET persistent=0 WHERE asset_id=?').run(f.assetId);
  await assert.rejects(f.service.deletePersistent({principal:principal('alice'),assetId:f.assetId}),error=>error?.code==='DIRECT_ASSET_DENIED');
  f.sql.prepare("UPDATE direct_assets SET persistent=1,status='EXPIRED' WHERE asset_id=?").run(f.assetId);
  await assert.rejects(f.service.deletePersistent({principal:principal('alice'),assetId:f.assetId}),error=>error?.code==='DIRECT_ASSET_DENIED');
  assert.deepEqual(f.deleted,[]);assert.equal(f.objects.has(f.objectKey),true);
});

test('storage deletion failure leaves READY identity intact and a later explicit retry can finish',async t=>{
  const f=await fixture(t),remove=f.bucket.delete;f.bucket.delete=async()=>{throw Error('R2 temporarily unavailable');};
  await assert.rejects(f.service.deletePersistent({principal:principal('alice'),assetId:f.assetId}),/temporarily unavailable/);
  assert.equal((await f.store.getOwnedReady({principal:principal('alice'),assetId:f.assetId})).status,'READY');assert.equal(f.objects.has(f.objectKey),true);
  f.bucket.delete=remove;assert.equal((await f.service.deletePersistent({principal:principal('alice'),assetId:f.assetId})).deleted,true);
});

test('store-level delete is owner/READY/permanent fenced even when invoked directly',async t=>{
  const f=await fixture(t,{persistent:false});
  await assert.rejects(f.store.markDeletedOwned({principal:principal('bob'),assetId:f.assetId}),error=>error?.code==='DIRECT_ASSET_DENIED');
  await assert.rejects(f.store.markDeletedOwned({principal:principal('alice'),assetId:f.assetId}),error=>error?.code==='DIRECT_ASSET_DENIED');
  assert.equal(f.sql.prepare('SELECT status FROM direct_assets WHERE asset_id=?').get(f.assetId).status,'READY');
});

test('public delete_file reaches the core service without GitHub or new permanent storage authority',async t=>{
  const f=await fixture(t);const transport=Object.fromEntries(['resolveRepository','resolveTarget','readProjectPolicy','submitCapabilityRequest','submitEditRequest','getRun','getResult','publishVerified'].map(name=>[name,async()=>{throw Error('GitHub must not be accessed');}]));
  const gateway=new BridgeGateway({transport,directAssets:f.service,principal:principal('alice')});
  const result=await invokePublicTool(gateway,'bridge.delete_file',{assetId:f.assetId});assert.equal(result.deleted,true);assert.deepEqual(f.deleted,[f.objectKey]);
  await assert.rejects(invokePublicTool(gateway,'bridge.import_file',{file:{download_url:'https://files.example/input',file_id:'input'},persistent:true}),error=>error?.code==='INVALID_MCP_ARGUMENTS');
});
