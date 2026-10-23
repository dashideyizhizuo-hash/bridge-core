import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { directWaitSeconds, waitForDirectResult } from '../src/direct-run-wait.mjs';
import { D1DirectExecStore } from '../src/cloudflare/d1-direct-exec-store.mjs';

const receipt={runId:'dx1:host-a:direct-wait-0001',hostId:'host-a',kind:'direct',transport:'direct',status:'QUEUED'};
const result={...receipt,status:'SUCCEEDED',evidence:{stdout:'中文\n',stderr:''}};
function timing() {let now=0;return {clock:()=>now,delay:async ms=>{now+=ms;}};}
test('only Direct calls default to twenty seconds; explicit zero opts out',()=>{
  assert.equal(directWaitSeconds({mode:'direct'}),20);
  assert.equal(directWaitSeconds({mode:'direct',waitSeconds:0}),0);
  assert.equal(directWaitSeconds({mode:'direct',waitSeconds:3}),3);
  for(const mode of ['host','connect','asset','capability','edit','batch','billing'])
    assert.equal(directWaitSeconds({mode}),0);
});
test('bounded polling returns a late result, including failures and cancellation evidence',async()=>{
  for(const status of ['SUCCEEDED','FAILED','CANCELED']) {
    let reads=0,results=0;
    const gateway={getRun:async()=>({...receipt,status:++reads<3?'RUNNING':status}),getResult:async()=>{results++;return {...result,status};}};
    const response=await waitForDirectResult(gateway,receipt,10,timing());
    assert.equal(response.status,status);assert.equal(response.evidence.stdout,'中文\n');
    assert.equal(reads,3);assert.equal(results,1);
  }
});
for(const [name,advance] of [['stalled',0],['backwards',-1],['barely advancing',0.01]])
test(`a ${name} clock ends waiting without repeated state reads`,async()=>{
  let now=0,reads=0,sleeps=0;const gateway={getRun:async()=>{reads++;return receipt;},getResult:async()=>{throw Error('must not read');}};
  assert.deepEqual(await waitForDirectResult(gateway,receipt,10,{clock:()=>now,delay:async()=>{sleeps++;now+=advance;}}),{...receipt,waitStatus:'timed_out',waitPhase:'queue'});
  assert.equal(reads,1);assert.ok(sleeps>=1&&sleeps<=64,'clock failure must not create an unbounded sleep loop');
});
for(const phase of ['state','result'])for(const abort of [false,true])
test(`in-flight ${phase} read is bounded by ${abort?'disconnect':'deadline'} with no late output`,async t=>{
  // Assert the timer contract, not wall-clock scheduling on a shared CI host.
  t.mock.timers.enable({apis:['setTimeout']});
  const cancellation=new AbortController();let rejectRead,entered,now=0,reads=0,settled=false;
  const inFlight=new Promise(resolve=>{entered=resolve;});
  const pending=new Promise((resolve,reject)=>{rejectRead=reject;});
  const blockedRead=()=>{reads++;entered();return pending;};
  const gateway={getRun:async()=>phase==='state'?blockedRead():{...receipt,status:'SUCCEEDED'},getResult:blockedRead};
  const waiting=waitForDirectResult(gateway,receipt,1,{signal:cancellation.signal,clock:()=>now,queueWaitSeconds:1,transferWaitSeconds:1})
    .then(value=>{settled=true;return value;});
  await inFlight;
  if(abort) {
    now=20;cancellation.abort();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(settled,true,'abort must end an in-flight wait before its deadline');
  } else {
    now=999;t.mock.timers.tick(999);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(settled,false,'the one-second deadline must not fire early');
    now=1000;t.mock.timers.tick(1);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(settled,true,'the deadline must end an in-flight wait at one second');
  }
  const response=await waiting;
  assert.equal(response.waitStatus,abort?'interrupted':'timed_out');
  assert.equal(response.runId,receipt.runId);assert.equal(response.evidence,undefined);
  rejectRead(Error('late provider failure'));await new Promise(resolve=>setImmediate(resolve));
  now=20000;t.mock.timers.tick(20000);
  assert.equal(reads,1,'a completed wait must not issue another backend read');
});
test('disconnect stops waiting without cancelling or changing the durable Run',async()=>{
  const cancellation=new AbortController();let reads=0;
  const gateway={getRun:async()=>{reads++;return receipt;},getResult:async()=>{throw Error('must not read');}};
  const response=await waitForDirectResult(gateway,receipt,10,{...timing(),signal:cancellation.signal,delay:async()=>cancellation.abort()});
  assert.equal(response.runId,receipt.runId);assert.equal(response.waitStatus,'interrupted');assert.equal(reads,1);
  const aborted=await waitForDirectResult(gateway,receipt,10,{signal:cancellation.signal});
  assert.equal(aborted.waitStatus,'interrupted');assert.equal(reads,1);
});
test('read errors and inconsistent identities retain admitted receipt without exposing output',async()=>{
  for(const gateway of [
    {getRun:async()=>{throw Error('database secret detail');}},
    {getRun:async()=>({...receipt,runId:'foreign-run',status:'SUCCEEDED'})},
    {getRun:async()=>({...receipt,status:'SUCCEEDED'}),getResult:async()=>({...result,runId:'foreign-run'})}
  ]) {
    const response=await waitForDirectResult(gateway,receipt,10,timing());
    assert.equal(response.runId,receipt.runId);assert.equal(response.waitStatus,'unavailable');
    assert.equal(response.evidence,undefined);assert.equal(JSON.stringify(response).includes('secret'),false);
  }
});
test('each wait read uses actual SQLite owner isolation; no foreign result is returned',async t=>{
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  sql.exec("PRAGMA foreign_keys=ON;CREATE TABLE bridge_users(id TEXT PRIMARY KEY);INSERT INTO bridge_users VALUES('a'),('b');");
  for(const name of ['0009_direct_exec.sql','0010_direct_exec_hardening.sql','0039_direct_run_progress.sql'])sql.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
  const db={batch:async()=>{throw Error('read-only fixture');},prepare(query){return {bind(...args){return {first:async()=>sql.prepare(query).get(...args)??null};}};}};
  sql.prepare('INSERT INTO direct_hosts(host_id,bridge_user_id,runner_token_sha256,created_at,updated_at) VALUES(?,?,?,?,?)').run('host-a','a','a'.repeat(64),1,1);
  sql.prepare('INSERT INTO direct_runs(request_id,run_id,bridge_user_id,host_id,request_json,status,result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('direct-wait-0001',receipt.runId,'a','host-a','{}','SUCCEEDED',JSON.stringify(result),1,1);
  const store=new D1DirectExecStore({db}),principal=id=>({bridgeUserId:id,externalProvider:'test',externalSubject:id});
  const scoped=id=>({getRun:args=>store.getRun({...args,principal:principal(id)}),getResult:args=>store.getResult({...args,principal:principal(id)})});
  const foreign=await waitForDirectResult(scoped('b'),receipt,10,timing());
  assert.equal(foreign.waitStatus,'unavailable');assert.equal(foreign.evidence,undefined);
  assert.equal((await waitForDirectResult(scoped('a'),receipt,10,timing())).evidence.stdout,'中文\n');
});
