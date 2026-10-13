import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {D1DirectAssetStore} from '../src/cloudflare/d1-direct-asset-store.mjs';
import {D1DirectExecStore} from '../src/cloudflare/d1-direct-exec-store.mjs';
import {DirectAssetService} from '../src/cloudflare/direct-asset-service.mjs';
import {createDirectAssetHandler,cleanupDirectAssets} from '../src/cloudflare/direct-asset-api.mjs';

const principal={bridgeUserId:'u',externalProvider:'x',externalSubject:'y'};
const bytes=Buffer.from('late bytes'),token='a'.repeat(40);
const digest=value=>createHash('sha256').update(value).digest('hex');
const source={principal,assetId:'asset-12345678',objectKey:'direct-assets/12345678',
  fileName:'x.txt',mimeType:'text/plain',sizeBytes:bytes.length,sha256:digest(bytes),sourceKind:'openai-file',sourceRef:'file-1'};
function fixture(t){
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  sql.exec(`CREATE TABLE bridge_users(id TEXT PRIMARY KEY);INSERT INTO bridge_users VALUES ('u');
    CREATE TABLE direct_hosts(host_id TEXT,bridge_user_id TEXT,runner_token_sha256 TEXT,enabled INTEGER,last_seen_at INTEGER);
    CREATE TABLE direct_runs(run_id TEXT,host_id TEXT,bridge_user_id TEXT,status TEXT,lease_owner TEXT,lease_expires_at INTEGER,request_json TEXT,created_at INTEGER DEFAULT 0,expires_at INTEGER);`);
  for(const name of ['0011_direct_assets.sql','0012_persistent_direct_assets.sql','0021_direct_asset_object_retirements.sql'])
    sql.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  const db={batch:async statements=>{sql.exec("BEGIN");try{const results=[];for(const statement of statements)results.push(await statement.all());sql.exec("COMMIT");return results;}catch(error){sql.exec("ROLLBACK");throw error;}},prepare(q){return {bind(...args){assert.ok(args.length<=100);return {
    run:async()=>sql.prepare(q).run(...args),first:async()=>sql.prepare(q).get(...args)??null,
    all:async()=>({results:sql.prepare(q).all(...args)})};}}}};
  let now=100000;const clock=()=>now,store=new D1DirectAssetStore({db,clock});
  const objects=new Set();
  const bucket={get:async()=>null,put:async key=>objects.add(key),delete:async keys=>{
    for(const key of Array.isArray(keys)?keys:[keys])objects.delete(key);
  }};
  return {sql,db,clock,store,bucket,objects,expire(){now+=3600001;}};
}

test('cleanup acknowledgement cannot erase a late writer retirement or an ABA replacement',async t=>{
  const f=fixture(t),first=await f.store.prepareReady(source);f.expire();
  await f.store.prepareReady({...source,assetId:'asset-87654321',objectKey:'direct-assets/87654321'});
  const snapshot=await f.store.listRetiredObjects();
  await f.store.rememberRetiredObject({assetId:first.assetId,objectKey:first.objectKey});
  await f.store.acknowledgeRetiredObjects({objects:snapshot});
  assert.equal((await f.store.listRetiredObjects()).length,1,'late writer retry must survive older ACK');
  const beforeDelete=await f.store.listRetiredObjects();
  await f.store.acknowledgeRetiredObjects({objects:beforeDelete});
  await f.store.rememberRetiredObject({assetId:first.assetId,objectKey:first.objectKey});
  await f.store.acknowledgeRetiredObjects({objects:beforeDelete});
  assert.equal((await f.store.listRetiredObjects()).length,1,'delete/reinsert must not reuse retirement identity');
});

test('actual import late writer survives a concurrent cleanup ACK after its own delete fails',async t=>{
  const f=fixture(t);let releaseCleanup,cleanup,oldKey,deleted;
  const deletionStarted=new Promise(resolve=>{deleted=resolve;});
  const cleanupBlocked=new Promise(resolve=>{releaseCleanup=resolve;});
  const originalDelete=f.bucket.delete;
  f.bucket.delete=async keys=>{
    if(Array.isArray(keys)) {await originalDelete(keys);deleted();await cleanupBlocked;}
    else throw Error('late writer R2 delete failed');
  };
  f.bucket.put=async key=>{
    oldKey=key;f.expire();
    const replacement=await f.store.prepareReady({...source,assetId:'asset-87654321',objectKey:'direct-assets/87654321'});
    await f.store.finalizePreparedReady({...replacement,principal});
    cleanup=cleanupDirectAssets(f);await deletionStarted;
    f.objects.add(key);
  };
  const service=new DirectAssetService({store:f.store,bucket:f.bucket,publicUrl:'https://bridge.example',
    fetchImpl:async()=>new Response(bytes,{headers:{'content-type':'text/plain'}})});
  await assert.rejects(service.importFile({principal,file:{file_id:'file-1',file_name:'x.txt',mime_type:'text/plain',download_url:'https://files.oaiusercontent.com/file'}}),/late writer R2 delete failed/);
  releaseCleanup();await cleanup;
  assert.equal(f.objects.has(oldKey),true);
  assert.deepEqual((await f.store.listRetiredObjects()).map(item=>item.objectKey),[oldKey]);
  f.bucket.delete=originalDelete;await cleanupDirectAssets(f);assert.equal(f.objects.size,0);
});

for(const kind of ['ticket','import','export']) for(const rejectedPut of [false,true])
test(kind+' late R2 put after expiry cleanup remains recoverable (put rejects: '+rejectedPut+')',async t=>{
  const f=fixture(t);let cleanupRan=false;
  f.bucket.put=async key=>{
    f.expire();await cleanupDirectAssets(f);cleanupRan=true;
    f.objects.add(key); // Completion after cleanup deleted the old key and marked EXPIRED.
    if(rejectedPut) throw Error('R2 response lost after storing bytes');
  };
  const originalDelete=f.bucket.delete;
  f.bucket.delete=async keys=>{if(cleanupRan)throw Error('R2 unavailable');return originalDelete(keys);};
  const service=new DirectAssetService({store:f.store,bucket:f.bucket,publicUrl:'https://bridge.example',
    fetchImpl:async()=>new Response(bytes,{headers:{'content-type':'text/plain'}})});
  if(kind==='import') {
    await assert.rejects(service.importFile({principal,file:{file_id:'file-1',file_name:'x.txt',mime_type:'text/plain',download_url:'https://files.oaiusercontent.com/file'}}));
  } else {
    let url,headers;
    if(kind==='ticket') {
      const ticket=await service.createUpload({...source});url=ticket.upload.url;
      headers={authorization:'Bearer '+ticket.upload.token,'content-length':String(bytes.length)};
    } else {
      const runId='dx1:host-a:request-1234';
      const request={schemaVersion:1,requestId:'request-1234',hostId:'host-a',argv:['echo','hi'],
        exports:[{fileName:'x.txt',mimeType:'text/plain',maxBytes:1024}]};
      f.sql.prepare('INSERT INTO direct_hosts VALUES (?,?,?,1,?)').run('host-a','u',digest(token),f.clock());
      f.sql.prepare('INSERT INTO direct_runs(run_id,host_id,bridge_user_id,status,lease_owner,lease_expires_at,request_json) VALUES (?,?,?,?,?,?,?)').run(runId,'host-a','u','RUNNING','owner-1234',999999999,JSON.stringify(request));
      url='https://bridge.example/direct/runner/exports/'+encodeURIComponent(runId)+'/0';
      headers={authorization:'Bearer '+token,'x-bridge-host-id':'host-a','x-bridge-lease-owner':'owner-1234',
        'content-length':String(bytes.length),'x-bridge-sha256':digest(bytes)};
    }
    const api=createDirectAssetHandler({store:f.store,bucket:f.bucket,directExecStore:new D1DirectExecStore({db:f.db,clock:f.clock})});
    const response=await api.fetch(new Request(url,{method:'PUT',headers,body:bytes}));
    assert.ok(response.status>=400,await response.text());
  }
  assert.equal(cleanupRan,true,'must reach actual R2 write');
  assert.equal(f.sql.prepare('SELECT status FROM direct_assets').get().status,'EXPIRED');
  assert.equal(f.objects.size,1);
  assert.equal((await f.store.listRetiredObjects()).length,1,'failed cleanup must retain late object');
  f.bucket.delete=originalDelete;await cleanupDirectAssets(f);
  assert.equal(f.objects.size,0);assert.deepEqual(await f.store.listRetiredObjects(),[]);
});

test('retirement rejects the current live READY and WAITING generations',async t=>{
  const f=fixture(t),prepared=await f.store.prepareReady(source);
  assert.equal(await f.store.rememberRetiredObject(prepared),false);
  await f.store.finalizePreparedReady({...prepared,principal});
  assert.equal(await f.store.rememberRetiredObject(prepared),false);
  assert.deepEqual(await f.store.listRetiredObjects(),[]);
});
