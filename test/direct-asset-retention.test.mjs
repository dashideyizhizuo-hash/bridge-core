import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {D1DirectAssetStore} from '../src/cloudflare/d1-direct-asset-store.mjs';
import {D1DirectExecStore} from '../src/cloudflare/d1-direct-exec-store.mjs';
import {DirectAssetService} from '../src/cloudflare/direct-asset-service.mjs';
import {cleanupDirectAssets} from '../src/cloudflare/direct-asset-api.mjs';

const principal={bridgeUserId:'u',externalProvider:'test',externalSubject:'u'};
const DAY=86400000;
function fixture(t) {
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  sql.exec("CREATE TABLE bridge_users(id TEXT PRIMARY KEY); INSERT INTO bridge_users VALUES ('u')");
  for(const file of ['0009_direct_exec.sql','0010_direct_exec_hardening.sql','0011_direct_assets.sql','0012_persistent_direct_assets.sql','0021_direct_asset_object_retirements.sql'])
    sql.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  const db={prepare(query){return {bind(...args){assert.ok(args.length<=100);return {
    run:async()=>sql.prepare(query).run(...args),first:async()=>sql.prepare(query).get(...args)??null,
    all:async()=>({results:sql.prepare(query).all(...args)})};}}},
    async batch(statements){sql.exec('BEGIN');try {const result=[];for(const statement of statements)result.push(await statement.all());sql.exec('COMMIT');return result;}catch(error){sql.exec('ROLLBACK');throw error;}}};
  let now=100000;const clock=()=>now;
  sql.prepare('INSERT INTO direct_hosts VALUES (?,?,?,1,?,?,NULL)').run('host-test','u','b'.repeat(64),now,now);
  const store=new D1DirectAssetStore({db,clock}),runs=new D1DirectExecStore({db,clock});
  const input={principal,assetId:'asset-12345678',objectKey:'direct-assets/12345678',fileName:'test.txt',mimeType:'text/plain',sizeBytes:3,sha256:'a'.repeat(64),sourceKind:'openai-file',sourceRef:'f'};
  const asset=async options=>{const prepared=await store.prepareReady(input);return store.finalizePreparedReady({...prepared,principal,...options});};
  const submit=(value,id='request-1234')=>runs.submit({principal,hostId:'host-test',request:{schemaVersion:1,requestId:id,argv:['echo','{asset:0}'],assets:[{assetId:value.assetId,fileName:value.fileName,mimeType:value.mimeType,sizeBytes:value.sizeBytes,sha256:value.sha256}]}});
  const objects=new Set([input.objectKey]),bucket={delete:async keys=>{for(const key of keys)objects.delete(key);}};
  return {sql,db,store,runs,input,asset,submit,objects,bucket,clock,set:value=>{now=value;}};
}

test('new READY lifetime starts at finalization, reads are retryable, legacy permanent rows are unchanged',async t=>{
  const f=fixture(t);const prepared=await f.store.prepareReady(f.input);
  assert.equal(prepared.expiresAt,f.clock()+3600000);
  f.set(f.clock()+60000);const ready=await f.store.finalizePreparedReady({...prepared,principal});
  assert.equal(ready.persistent,false);assert.equal(ready.expiresAt,f.clock()+DAY);
  assert.deepEqual(await f.store.getResult({principal,runId:ready.runId}),await f.store.getResult({principal,runId:ready.runId}));
  f.set(ready.expiresAt);
  await assert.rejects(f.store.getResult({principal,runId:ready.runId}),{code:'DIRECT_ASSET_EXPIRED'});
  await assert.rejects(f.submit(ready),{code:'DIRECT_ASSET_DENIED'});
  f.sql.exec('UPDATE direct_assets SET persistent=1');
  assert.equal((await f.store.getResult({principal,runId:ready.runId})).persistent,true);
  assert.deepEqual(await f.store.listExpired(),[]);
  assert.equal(await f.store.rememberRetiredObject(prepared),false);
});

test('new permanent requests fail before downloading or creating upload metadata',async t=>{
  const f=fixture(t);let calls=0;
  const service=new DirectAssetService({store:f.store,bucket:{put(){calls++;},get(){},delete(){}},publicUrl:'https://bridge.example',fetchImpl:async()=>{calls++;throw Error('must not fetch');}});
  await assert.rejects(service.importFile({principal,persistent:true,file:{file_id:'file-1',download_url:'https://files.oaiusercontent.com/a'}}),{code:'DIRECT_ASSET_IMPORT_DENIED'});
  await assert.rejects(service.createUpload({...f.input,persistent:true}),{code:'DIRECT_ASSET_INVALID'});
  assert.equal(calls,0);assert.equal(f.sql.prepare('SELECT count(*) n FROM direct_assets').get().n,0);
});

test('queued reference protects bytes after public expiry but not beyond its bounded queue deadline',async t=>{
  const f=fixture(t),ready=await f.asset({ttlMs:60000});
  f.set(ready.expiresAt-1);const run=await f.submit(ready);
  f.set(ready.expiresAt+1);
  assert.equal((await cleanupDirectAssets(f)).expired,0);assert.equal(f.objects.size,1);
  f.sql.prepare('INSERT INTO direct_asset_object_retirements VALUES (?,?,?)').run(f.input.objectKey,f.clock(),'d'.repeat(32));
  assert.deepEqual(await f.store.listRetiredObjects(),[],'a stale retirement cannot expose a held live object to deletion');
  await assert.rejects(f.submit(ready,'request-later'),{code:'DIRECT_ASSET_DENIED'});
  await assert.rejects(f.store.prepareReady({...f.input,assetId:'asset-87654321',objectKey:'direct-assets/87654321'}),{code:'DIRECT_ASSET_CONFLICT'});
  assert.equal(await f.store.rememberRetiredObject(f.input),false);
  f.set(run.expiresAt);assert.equal((await cleanupDirectAssets(f)).expired,1);assert.equal(f.objects.size,0);
});

test('running lease protects its own staging; stale leases and unlimited renewals cannot retain bytes',async t=>{
  const f=fixture(t),ready=await f.asset({ttlMs:60000});f.set(ready.expiresAt-1);const run=await f.submit(ready);
  f.sql.prepare("UPDATE direct_runs SET status='RUNNING',lease_owner='owner-1234',lease_expires_at=?").run(run.expiresAt+99999999);
  f.set(ready.expiresAt+1);assert.equal((await cleanupDirectAssets(f)).expired,0);
  assert.equal((await f.store.authorizeRunnerDownload({hostId:'host-test',runnerTokenSha256:'b'.repeat(64),assetId:ready.assetId,runId:run.runId,leaseOwner:'owner-1234'})).assetId,ready.assetId);
  await assert.rejects(f.store.getOwnedReady({principal,assetId:ready.assetId}),{code:'DIRECT_ASSET_DENIED'});
  f.set(run.expiresAt+3700000);assert.equal((await cleanupDirectAssets(f)).expired,1);
  await assert.rejects(f.store.authorizeRunnerDownload({hostId:'host-test',runnerTokenSha256:'b'.repeat(64),assetId:ready.assetId,runId:run.runId,leaseOwner:'owner-1234'}),{code:'DIRECT_ASSET_DENIED'});
});

test('admission rejects bytes GC already claimed; deletion failure retains a durable retry',async t=>{
  const f=fixture(t),ready=await f.asset({ttlMs:60000});f.set(ready.expiresAt);
  const snapshot=await f.store.listExpired();
  await assert.rejects(cleanupDirectAssets({...f,bucket:{delete:async()=>{throw Error('R2 offline');}}}),/R2 offline/);
  assert.equal(f.sql.prepare('SELECT status FROM direct_assets').get().status,'EXPIRED');
  assert.equal((await f.store.listRetiredObjects()).length,1);
  await assert.rejects(f.submit(ready),{code:'DIRECT_ASSET_DENIED'});
  assert.equal((await f.store.markExpired({assetIds:snapshot.map(x=>x.assetId),objects:snapshot})).length,0);
  await cleanupDirectAssets(f);assert.equal(f.objects.size,0);assert.deepEqual(await f.store.listRetiredObjects(),[]);
});

test('atomic expiry rechecks a reference admitted after an earlier cleanup snapshot',async t=>{
  const f=fixture(t),ready=await f.asset({ttlMs:60000});
  // A stale scanner snapshot is not authority to delete the object.
  const snapshot=[{assetId:ready.assetId,objectKey:f.input.objectKey}];
  f.set(ready.expiresAt-1);await f.submit(ready);f.set(ready.expiresAt+1);
  assert.deepEqual(await f.store.markExpired({assetIds:[ready.assetId],objects:snapshot}),[]);
  assert.deepEqual(await f.store.listRetiredObjects(),[]);assert.equal(f.objects.size,1);
});

test('stale RUNNING lease retains input while queue TTL permits reclaim; old owner cannot stage',async t=>{
  const f=fixture(t),ready=await f.asset({ttlMs:60000});f.set(ready.expiresAt-1);const run=await f.submit(ready);
  const runnerTokenSha256='b'.repeat(64),hostId='host-test';
  await f.runs.claimNext({hostId,runnerTokenSha256,leaseOwner:'old-owner',leaseMs:5000});
  f.set(ready.expiresAt+6000);
  assert.equal((await cleanupDirectAssets(f)).expired,0);assert.equal(f.objects.size,1);
  await assert.rejects(f.store.authorizeRunnerDownload({hostId,runnerTokenSha256,assetId:ready.assetId,runId:run.runId,leaseOwner:'old-owner'}),{code:'DIRECT_ASSET_DENIED'});
  const reclaimed=await f.runs.claimNext({hostId,runnerTokenSha256,leaseOwner:'new-owner',leaseMs:5000});
  assert.equal(reclaimed.runId,run.runId);
  assert.equal((await f.store.authorizeRunnerDownload({hostId,runnerTokenSha256,assetId:ready.assetId,runId:run.runId,leaseOwner:'new-owner'})).assetId,ready.assetId);
  f.set(run.expiresAt);assert.equal((await cleanupDirectAssets(f)).expired,1);assert.equal(f.objects.size,0);
});

test('compatibility upload preserves its explicit ticket lifetime through READY and retry',async t=>{
  const f=fixture(t),uploadTokenSha256='c'.repeat(64);
  const waiting=await f.store.create({...f.input,uploadTokenSha256,ttlMs:120000});assert.equal(waiting.expiresAt,f.clock()+120000);
  f.set(f.clock()+1234);
  const finalize={assetId:waiting.assetId,uploadTokenSha256,actualSizeBytes:f.input.sizeBytes,actualSha256:f.input.sha256};
  const ready=await f.store.markReady(finalize);assert.equal(ready.expiresAt,waiting.expiresAt);assert.equal(ready.persistent,false);
  f.set(f.clock()+60000);assert.equal((await f.store.markReady(finalize)).expiresAt,ready.expiresAt);
});

test('failed expiry transaction cannot publish a retirement receipt for still-bindable bytes',async t=>{
  const f=fixture(t),ready=await f.asset({ttlMs:60000});f.set(ready.expiresAt);
  f.sql.exec("CREATE TRIGGER fail_expiry BEFORE UPDATE OF status ON direct_assets WHEN NEW.status='EXPIRED' BEGIN SELECT RAISE(ABORT,'injected expiry failure'); END");
  await assert.rejects(cleanupDirectAssets(f),/injected expiry failure/);
  assert.equal(f.sql.prepare('SELECT status FROM direct_assets').get().status,'READY');
  assert.equal(f.sql.prepare('SELECT count(*) n FROM direct_asset_object_retirements').get().n,0);
  assert.equal(f.objects.size,1);
});
