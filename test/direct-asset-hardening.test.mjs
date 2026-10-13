import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {D1DirectAssetStore} from '../src/cloudflare/d1-direct-asset-store.mjs';
import {DirectAssetService} from '../src/cloudflare/direct-asset-service.mjs';
import {createDirectAssetHandler,cleanupDirectAssets} from '../src/cloudflare/direct-asset-api.mjs';
import {withDirectAssetBufferSlot} from '../src/cloudflare/direct-asset-memory.mjs';
import {readBoundedBody} from '../src/cloudflare/request-body.mjs';
import {createBridgeMcpHandler} from '../src/mcp-server.mjs';

const principal={bridgeUserId:'u',externalProvider:'x',externalSubject:'y'};
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const busy=()=>withDirectAssetBufferSlot(async()=>true);
function database(){
  const sql=new DatabaseSync(':memory:');
  sql.exec(`CREATE TABLE bridge_users(id TEXT PRIMARY KEY);INSERT INTO bridge_users VALUES ('u');
    CREATE TABLE direct_hosts(host_id TEXT,bridge_user_id TEXT,runner_token_sha256 TEXT,enabled INTEGER);
    CREATE TABLE direct_runs(run_id TEXT,host_id TEXT,bridge_user_id TEXT,status TEXT,lease_owner TEXT,lease_expires_at INTEGER,request_json TEXT DEFAULT '{}',created_at INTEGER DEFAULT 0,expires_at INTEGER);`);
  for(const name of ['0011_direct_assets.sql','0012_persistent_direct_assets.sql','0021_direct_asset_object_retirements.sql'])sql.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  const db={batch:async statements=>{sql.exec("BEGIN");try{const results=[];for(const statement of statements)results.push(await statement.all());sql.exec("COMMIT");return results;}catch(error){sql.exec("ROLLBACK");throw error;}},prepare(text){return {bind(...args){assert.ok(args.length<=100,'Cloudflare D1 permits at most 100 bound parameters');return {
    run:async()=>sql.prepare(text).run(...args),first:async()=>sql.prepare(text).get(...args)??null,
    all:async()=>({results:sql.prepare(text).all(...args)})};}}}};
  return {sql,db};
}
function source(suffix='12345678'){return {principal,assetId:'asset-'+suffix,objectKey:'direct-assets/'+suffix,
  fileName:'报告.txt',mimeType:'text/plain',sizeBytes:33,sha256:'a'.repeat(64),sourceKind:'openai-file',sourceRef:'source-1'};}

test('real SQL fences READY against revoked host, stale lease, generation and expiry',async t=>{
  const {sql,db}=database();t.after(()=>sql.close());let now=100000;
  const store=new D1DirectAssetStore({db,clock:()=>now});const prepared=await store.prepareReady(source());
  const authorization={hostId:'host-a',runnerTokenSha256:'b'.repeat(64),leaseOwner:'owner-1234',runId:'dx1:host-a:request-1234'};
  sql.prepare('INSERT INTO direct_hosts VALUES (?,?,?,1)').run('host-a','u',authorization.runnerTokenSha256);
  sql.prepare('INSERT INTO direct_runs(run_id,host_id,bridge_user_id,status,lease_owner,lease_expires_at) VALUES (?,?,?,?,?,?)').run(authorization.runId,'host-a','u','RUNNING',authorization.leaseOwner,now+1000);
  const input={principal,assetId:prepared.assetId,objectKey:prepared.objectKey,exportAuthorization:authorization};
  sql.exec('UPDATE direct_hosts SET enabled=0');
  await assert.rejects(store.finalizePreparedReady(input),e=>e.code==='DIRECT_RUN_STALE');
  sql.exec('UPDATE direct_hosts SET enabled=1');
  now+=1001;
  await assert.rejects(store.finalizePreparedReady(input),e=>e.code==='DIRECT_RUN_STALE');
  sql.exec('UPDATE direct_runs SET lease_expires_at=999999999');
  await assert.rejects(store.finalizePreparedReady({...input,objectKey:'other-generation'}),e=>e.code==='DIRECT_RUN_STALE');
  assert.equal((await store.finalizePreparedReady(input)).status,'READY');
  sql.exec('UPDATE direct_hosts SET enabled=0');
  await assert.rejects(store.finalizePreparedReady(input),e=>e.code==='DIRECT_RUN_STALE');
});

test('cleanup old snapshot cannot delete or expire a reactivated generation',async t=>{
  const {sql,db}=database();t.after(()=>sql.close());let now=100000;
  const store=new D1DirectAssetStore({db,clock:()=>now});const first=await store.prepareReady(source());
  now+=3600001;const snapshot=await store.listExpired();assert.equal(snapshot.length,1);
  const replacement=await store.prepareReady(source('87654321'));
  assert.equal(replacement.assetId,first.assetId);assert.notEqual(replacement.objectKey,first.objectKey);
  assert.deepEqual((await store.listRetiredObjects()).map(item=>item.objectKey),[first.objectKey]);
  await assert.rejects(store.finalizePreparedReady({principal,assetId:first.assetId,objectKey:first.objectKey}),e=>e.code==='DIRECT_ASSET_CONFLICT');
  await store.finalizePreparedReady({principal,assetId:replacement.assetId,objectKey:replacement.objectKey});
  const objects=new Set([first.objectKey,replacement.objectKey]);
  const result=await cleanupDirectAssets({store:{listExpired:async()=>snapshot,markExpired:args=>store.markExpired(args)},bucket:{delete:async keys=>keys.forEach(key=>objects.delete(key))}});
  assert.equal(result.expired,0);assert.equal(objects.has(replacement.objectKey),true);
  assert.equal((await store.getOwnedReady({principal,assetId:first.assetId})).objectKey,replacement.objectKey);
  await assert.rejects(cleanupDirectAssets({store,bucket:{delete:async()=>{throw Error('R2 unavailable');}}}));
  assert.deepEqual((await store.listRetiredObjects()).map(item=>item.objectKey),[first.objectKey]);
  await cleanupDirectAssets({store,bucket:{delete:async keys=>keys.forEach(key=>objects.delete(key))}});
  assert.deepEqual(await store.listRetiredObjects(),[]);
  assert.equal(objects.has(replacement.objectKey),true);
});

test('full cleanup batches stay within D1 parameter limits',async t=>{
  const {sql,db}=database();t.after(()=>sql.close());let now=100000;
  const store=new D1DirectAssetStore({db,clock:()=>now});
  for(let n=0;n<100;n++) await store.prepareReady({...source(String(n).padStart(8,'0')),sourceRef:'source-'+n});
  now+=3600001;
  assert.equal((await cleanupDirectAssets({store,bucket:{delete:async()=>{}}})).expired,100);
  const keys=Array.from({length:150},(_,n)=>'direct-assets/retired-'+n);
  for(const key of keys) sql.prepare('INSERT INTO direct_asset_object_retirements VALUES (?,?,lower(hex(randomblob(16))))').run(key,now);
  await store.acknowledgeRetiredObjects({objects:await store.listRetiredObjects({limit:500})});
  assert.equal((await store.listRetiredObjects({limit:500})).length,0);
});

function serviceFixture(bytes){
  const asset={...source(),assetId:'asset-12345678',objectKey:'k',sizeBytes:bytes.length,sha256:digest(bytes)};
  const store={create(){},createReady(){},prepareReady(){},finalizePreparedReady(){},findReadyBySource:async()=>null,getOwnedReady:async()=>asset,assertReady(){},getRun(){},getResult(){}};
  const bucket={put:async()=>{},delete:async()=>{},get:async()=>({body:new Response(bytes).body})};
  const service=new DirectAssetService({store,bucket,resourceCodec:{issue(){},verify:async()=>({assetId:asset.assetId,expiresAt:Date.now()+10000})},publicUrl:'https://bridge.example/mcp'});
  return {service,asset,bucket};
}

test('resource read cancels corrupt oversized R2 stream before consuming its tail',async()=>{
  const f=serviceFixture(Buffer.from('中文'));let chunks=0,cancelled=false;
  f.bucket.get=async()=>({body:new ReadableStream({pull(c){chunks++;c.enqueue(new Uint8Array(1024));},cancel(){cancelled=true;}},{highWaterMark:0})});
  await assert.rejects(f.service.readResource({principal,token:'test'}),e=>e.code==='DIRECT_ASSET_INTEGRITY');
  assert.equal(chunks,1);assert.equal(cancelled,true);assert.equal(await busy(),true);
});

test('deadline cancels stalled body and does not release slot until cancel settles',async()=>{
  let cancellationStarted=false,finishCancel;
  const response=new Response(new ReadableStream({pull(){},cancel(){cancellationStarted=true;return new Promise(resolve=>{finishCancel=resolve;});}}));
  const operation=withDirectAssetBufferSlot(signal=>readBoundedBody(response,{maxBytes:100,code:'BOUNDED',signal}),{timeoutMs:20});
  const rejected=assert.rejects(operation,e=>e.code==='DIRECT_ASSET_TIMEOUT');
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(cancellationStarted,true);await assert.rejects(busy(),e=>e.code==='DIRECT_ASSET_BUSY');
  finishCancel();await rejected;assert.equal(await busy(),true);
});

function resourceRequest(){return new Request('https://bridge.example/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'resources/read',params:{uri:'bridge-file:///access/test-token'}})});}
function mcp(service){return createBridgeMcpHandler({gateway:{discover(){},run(){},getRun(){},getResult(){},publish(){},readAssetResource:args=>service.readResource({...args,principal})}});}

test('MCP retains 25 MiB resource slot through serialization and unread response; cancellation unlocks',async t=>{
  const bytes=Buffer.alloc(25*1024*1024,65);const {service}=serviceFixture(bytes);const handler=mcp(service);t.after(()=>handler.close());
  let materialized=false;const original=service.readResource.bind(service);
  service.readResource=async args=>{const result=await original(args);materialized=true;return result;};
  const response=await handler.fetch(resourceRequest());
  for(let n=0;n<1000 && !materialized;n++)await new Promise(resolve=>setTimeout(resolve,2));
  assert.equal(materialized,true);
  await assert.rejects(busy(),e=>e.code==='DIRECT_ASSET_BUSY');
  await response.body.cancel();assert.equal(await busy(),true);
});

test('MCP returns exact Chinese file contents and releases only after body consumption',async t=>{
  const bytes=Buffer.from('中文文件内容：原样返回');const {service}=serviceFixture(bytes);const handler=mcp(service);t.after(()=>handler.close());
  const response=await handler.fetch(resourceRequest());const text=await response.text();
  const json=JSON.parse(text.slice(text.indexOf('data: ')+6).trim());
  assert.deepEqual(Buffer.from(json.result.contents[0].blob,'base64'),bytes);assert.equal(await busy(),true);
});

test('export revoked while body arrives is denied before any R2 persistence',async()=>{
  const bytes=Buffer.from('导出内容');let revoked=false,checks=0,release,puts=0;
  const slot={bridgeUserId:'u',runId:'dx1:host-a:request-12345',exportIndex:0,fileName:'报告.txt',mimeType:'text/plain',maxBytes:1024};
  const handler=createDirectAssetHandler({store:{authorizeUpload(){},markReady(){},authorizeRunnerDownload(){},findReadyBySource:async()=>null,prepareReady(){throw Error('must not prepare');},finalizePreparedReady(){throw Error('must not publish');}},
    bucket:{get(){},delete(){},put(){puts++;}},directExecStore:{async authorizeExportUpload(){checks++;if(revoked){const e=Error('stale');e.code='DIRECT_RUN_STALE';throw e;}return slot;}}});
  const body=new ReadableStream({start(c){release=()=>{revoked=true;c.enqueue(bytes);c.close();};}});
  const request=new Request('https://bridge.example/direct/runner/exports/'+encodeURIComponent(slot.runId)+'/0',{method:'PUT',duplex:'half',body,headers:{authorization:'Bearer '+('a'.repeat(40)),'x-bridge-host-id':'host-a','x-bridge-lease-owner':'owner-1234','content-length':String(bytes.length),'x-bridge-sha256':digest(bytes)}});
  const pending=handler.fetch(request);while(checks===0)await new Promise(r=>setTimeout(r,1));release();
  assert.equal((await pending).status,409);assert.equal(checks,2);assert.equal(puts,0);
});

test('export HTTP handler publishes through real SQL and fences revocation during R2 put',async t=>{
  for(const revoke of [false,true]) {
    const {sql,db}=database();t.after(()=>sql.close());
    const now=100000,token='a'.repeat(40),bytes=Buffer.from('双向文件内容🙂');
    const store=new D1DirectAssetStore({db,clock:()=>now});
    const slot={bridgeUserId:'u',runId:'dx1:host-a:request-12345',exportIndex:0,fileName:'报告.txt',mimeType:'text/plain',maxBytes:1024};
    sql.prepare('INSERT INTO direct_hosts VALUES (?,?,?,1)').run('host-a','u',digest(token));
    sql.prepare('INSERT INTO direct_runs(run_id,host_id,bridge_user_id,status,lease_owner,lease_expires_at) VALUES (?,?,?,?,?,?)').run(slot.runId,'host-a','u','RUNNING','owner-1234',now+1000);
    const handler=createDirectAssetHandler({store,
      directExecStore:{authorizeExportUpload:async()=>slot},
      bucket:{get(){},delete(){},async put(){if(revoke)sql.exec('UPDATE direct_hosts SET enabled=0');}}
    });
    const response=await handler.fetch(new Request('https://bridge.example/direct/runner/exports/'+encodeURIComponent(slot.runId)+'/0',{
      method:'PUT',body:bytes,headers:{authorization:'Bearer '+token,'x-bridge-host-id':'host-a',
        'x-bridge-lease-owner':'owner-1234','content-length':String(bytes.length),'x-bridge-sha256':digest(bytes)}
    }));
    const result=await response.json();
    assert.equal(response.status,revoke?409:200,JSON.stringify(result));
    assert.equal(sql.prepare("SELECT count(*) AS n FROM direct_assets WHERE status='READY'").get().n,revoke?0:1);
    if(!revoke) assert.equal(result.fileName,'报告.txt');
  }
});

test('25 MiB MCP round trip preserves the exact declared maximum and digest',async t=>{
  const bytes=Buffer.alloc(25*1024*1024,67);const {service}=serviceFixture(bytes);const handler=mcp(service);t.after(()=>handler.close());
  const response=await handler.fetch(resourceRequest());const text=await response.text();
  const json=JSON.parse(text.slice(text.indexOf('data: ')+6).trim());
  const returned=Buffer.from(json.result.contents[0].blob,'base64');
  assert.equal(returned.length,bytes.length);assert.equal(digest(returned),digest(bytes));assert.equal(await busy(),true);
});
