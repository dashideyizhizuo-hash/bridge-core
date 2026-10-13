import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {D1DirectExecStore} from '../src/cloudflare/d1-direct-exec-store.mjs';
import {createDirectRunnerHandler} from '../src/cloudflare/direct-runner-api.mjs';

const principal={bridgeUserId:'user-a',externalProvider:'test',externalSubject:'a'};
const token='a'.repeat(40),hash=createHash('sha256').update(token).digest('hex');
const hostId='host-main',leaseOwner='runner-owner';
function fixture(t){
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  sql.exec("PRAGMA foreign_keys=ON; CREATE TABLE bridge_users(id TEXT PRIMARY KEY); INSERT INTO bridge_users VALUES('user-a'),('user-b')");
  for(const name of ['0009_direct_exec.sql','0010_direct_exec_hardening.sql'])
    sql.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  let hook=null,tail=Promise.resolve();
  const db={prepare(q){return {bind(...args){return {
    async first(){const row=sql.prepare(q).get(...args)??null;if(hook)await hook(q,row);return row;},
    async run(){return {meta:{changes:Number(sql.prepare(q).run(...args).changes)}};},
    async all(){return {results:sql.prepare(q).all(...args)};}
  };}};},batch(statements){
    // D1 batch transactions serialize; independent preflight reads may overlap.
    const work=tail.then(async()=>{sql.exec('BEGIN');try{
      const out=[];for(const statement of statements)out.push(await statement.run());sql.exec('COMMIT');return out;
    }catch(error){sql.exec('ROLLBACK');throw error;}});
    tail=work.catch(()=>{});return work;
  }};
  return {sql,store:new D1DirectExecStore({db,clock:()=>1000}),setHook:value=>{hook=value;}};
}
async function seed(f){
  await f.store.registerHost({principal,hostId,runnerTokenSha256:hash});
  return f.store.submit({principal,hostId,request:{schemaVersion:1,requestId:'request-1234',argv:['node','--version'],exports:[{fileName:'out.txt',mimeType:'text/plain',maxBytes:100}]}});
}

test('rotation during HTTP claim never exposes queued command to revoked credential',async t=>{
  const f=fixture(t),run=await seed(f);
  f.setHook(async q=>{if(q.includes('SELECT host_id, last_seen_at')){
    f.setHook(null);await f.store.registerHost({principal,hostId,runnerTokenSha256:'b'.repeat(64)});
  }});
  const handler=createDirectRunnerHandler({store:f.store});
  const response=await handler.fetch(new Request('https://example.test/direct/runner/claim',{
    method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({hostId,leaseOwner})
  }));
  assert.equal(response.status,204);assert.equal(await response.text(),'');
  assert.equal((await f.store.getRun({principal,runId:run.runId})).status,'QUEUED');
  await assert.rejects(f.store.assertRunner({hostId,runnerTokenSha256:hash}),{code:'DIRECT_RUNNER_DENIED'});
  const allowed=await f.store.claimNext({hostId,runnerTokenSha256:'b'.repeat(64),leaseOwner});
  assert.equal(allowed.runId,run.runId);
});

for(const operation of ['claimNext','renewLease','authorizeExportUpload','complete'])
for(const revocation of ['rotate','disable'])
test(operation+' atomically rechecks '+revocation+' after authentication',async t=>{
  const f=fixture(t),run=await seed(f),input={hostId,runnerTokenSha256:hash,leaseOwner,runId:run.runId,
    exportIndex:0,result:{requestId:'request-1234',hostId,status:'SUCCEEDED'}};
  if(operation!=='claimNext')await f.store.claimNext(input);
  const before=f.sql.prepare('SELECT * FROM direct_runs').get();
  f.setHook(async q=>{if(q.includes('SELECT host_id, last_seen_at')){
    f.setHook(null);
    // Isolate credential/enable fencing from the separate run cancellation.
    if(revocation==='rotate')f.sql.prepare('UPDATE direct_hosts SET runner_token_sha256=?').run('b'.repeat(64));
    else f.sql.exec('UPDATE direct_hosts SET enabled=0');
  }});
  if(operation==='claimNext')assert.equal(await f.store[operation](input),null);
  else await assert.rejects(f.store[operation](input),{code:'DIRECT_RUN_STALE'});
  assert.deepEqual(f.sql.prepare('SELECT * FROM direct_runs').get(),before);
});

test('current runner retains claim, renewal, export and completion authority',async t=>{
  const f=fixture(t),run=await seed(f);
  const input={hostId,runnerTokenSha256:hash,leaseOwner,runId:run.runId};
  assert.equal((await f.store.claimNext(input)).runId,run.runId);
  assert.equal((await f.store.renewLease(input)).continue,true);
  assert.equal((await f.store.authorizeExportUpload({...input,exportIndex:0})).bridgeUserId,principal.bridgeUserId);
  assert.equal((await f.store.complete({...input,result:{requestId:'request-1234',hostId,status:'SUCCEEDED'}})).status,'SUCCEEDED');
  assert.equal((await f.store.getResult({principal,runId:run.runId})).status,'SUCCEEDED');
});

for(const foreign of [false,true])test('concurrent no-rotate enrollment has exactly one winner (foreign principal '+foreign+')',async t=>{
  const f=fixture(t);let reads=0,release;
  const paused=new Promise(resolve=>{release=resolve;});
  f.setHook(async(q,row)=>{if(q.includes('SELECT bridge_user_id, runner_token_sha256')&&!row){
    if(++reads===1)await paused;else{f.setHook(null);release();}
  }});
  const results=await Promise.allSettled(['c','d'].map((value,index)=>f.store.registerHost({
    principal:foreign&&index===1?{...principal,bridgeUserId:'user-b',externalSubject:'b'}:principal,
    hostId,runnerTokenSha256:value.repeat(64),allowRotate:false
  })));
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(results.find(result=>result.status==='rejected').reason.code,'DIRECT_HOST_EXISTS');
  const winner=results.findIndex(result=>result.status==='fulfilled');
  const row=f.sql.prepare('SELECT * FROM direct_hosts').get();
  assert.equal(row.runner_token_sha256,['c','d'][winner].repeat(64));
  assert.equal(row.bridge_user_id,foreign&&winner===1?'user-b':'user-a');
  await assert.rejects(f.store.registerHost({principal:{...principal,bridgeUserId:row.bridge_user_id},hostId,
    runnerTokenSha256:'e'.repeat(64),allowRotate:false}),{code:'DIRECT_HOST_EXISTS'});
});
