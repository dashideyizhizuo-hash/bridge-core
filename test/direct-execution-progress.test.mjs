import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,userInfo} from 'node:os';
import {createHash} from 'node:crypto';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {performance} from 'node:perf_hooks';
import {createServer} from 'node:http';
import {makeTestDirectory} from './helpers/canonical-temp.mjs';
import {D1DirectExecStore} from '../src/cloudflare/d1-direct-exec-store.mjs';
import {createDirectRunnerHandler} from '../src/cloudflare/direct-runner-api.mjs';
import {runDirectRunnerOnce} from '../src/direct-runner-client.mjs';
import {runBounded} from '../src/execute.mjs';

const principal={bridgeUserId:'user-a',externalProvider:'test',externalSubject:'a'};
const hash='a'.repeat(64),hostId='host-main',leaseOwner='runner-owner';
function fixture(t){
  const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
  sql.exec("PRAGMA foreign_keys=ON; CREATE TABLE bridge_users(id TEXT PRIMARY KEY); INSERT INTO bridge_users VALUES('user-a'),('user-b')");
  for(const file of ['0009_direct_exec.sql','0010_direct_exec_hardening.sql','0039_direct_run_progress.sql'])
    sql.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
  let now=1000,hook=null;
  const db={prepare(q){return {bind(...args){return {
    async first(){const row=sql.prepare(q).get(...args)??null;if(hook)await hook(q,row);return row;},
    async run(){return {meta:{changes:Number(sql.prepare(q).run(...args).changes)}};},
    async all(){return {results:sql.prepare(q).all(...args)};}
  };}};},async batch(statements){sql.exec('BEGIN');try{const out=[];for(const s of statements)out.push(await s.run());sql.exec('COMMIT');return out;}catch(e){sql.exec('ROLLBACK');throw e;}}};
  return {sql,store:new D1DirectExecStore({db,clock:()=>now}),setNow:value=>{now=value;},setHook:value=>{hook=value;}};
}
async function seed(f){
  await f.store.registerHost({principal,hostId,runnerTokenSha256:hash});
  const run=await f.store.submit({principal,hostId,request:{schemaVersion:1,requestId:'progress-1234',argv:['node','--version']}});
  const input={hostId,runnerTokenSha256:hash,leaseOwner,runId:run.runId};
  const claimed=await f.store.claimNext(input);assert.equal(claimed.progressVersion,1);
  return input;
}

test('progress is absent for old Hosts and never inferred from claim or lease renewal',async t=>{
  const f=fixture(t),input=await seed(f);
  assert.equal((await f.store.getRun({principal,runId:input.runId})).progress,undefined);
  await f.store.renewLease(input);
  assert.equal((await f.store.getRun({principal,runId:input.runId})).progress,undefined);
});
test('actual phases retain start anchors and elapsed across duplicate reports and new claims',async t=>{
  const f=fixture(t),input=await seed(f);
  const send=progress=>f.store.renewLease({...input,progress});
  await send({phase:'PREPARING',executionElapsedMs:0});
  f.setNow(1200);await send({phase:'PREPARING',executionElapsedMs:0});
  let progress=(await f.store.getRun({principal,runId:input.runId})).progress;
  assert.deepEqual(progress,{phase:'PREPARING',executionElapsedMs:0,phaseStartedAt:1000,reportedAt:1000});
  f.setNow(2000);await send({phase:'EXECUTING',executionElapsedMs:0});
  f.setNow(3000);await send({phase:'EXECUTING',executionElapsedMs:1000});
  f.setNow(3500);await send({phase:'EXECUTING',executionElapsedMs:1000});
  progress=(await f.store.getRun({principal,runId:input.runId})).progress;
  assert.deepEqual(progress,{phase:'EXECUTING',executionElapsedMs:1000,phaseStartedAt:2000,reportedAt:3000});
  // Core reclaims an expired lease; commercial admission rollback is private.
  f.setNow(70_000);
  const reclaimed=await f.store.claimNext({...input,leaseOwner:'new-owner'});
  assert.deepEqual(reclaimed.progress,progress,'reclaim must not erase the original execution start');
  f.setNow(71_000);await f.store.renewLease({...input,leaseOwner:'new-owner',progress:{phase:'RETURNING_RESULT',executionElapsedMs:1200}});
  const returned=(await f.store.getRun({principal,runId:input.runId})).progress;
  assert.deepEqual(returned,{phase:'RETURNING_RESULT',executionElapsedMs:1200,phaseStartedAt:71_000,reportedAt:71_000});
  await assert.rejects(f.store.getRun({principal:{...principal,bridgeUserId:'user-b'},runId:input.runId}),{code:'RUN_NOT_FOUND'});
});
test('malformed, backwards, foreign and stale progress cannot renew a lease',async t=>{
  const f=fixture(t),input=await seed(f);
  for(const progress of [null,{},[],{phase:'STARTING',executionElapsedMs:0},{phase:'PREPARING',executionElapsedMs:1},
    {phase:'EXECUTING',executionElapsedMs:-1},{phase:'EXECUTING',executionElapsedMs:0.5},
    {phase:'EXECUTING',executionElapsedMs:Infinity},{phase:'EXECUTING',executionElapsedMs:0,reportedAt:1}])
    await assert.rejects(f.store.renewLease({...input,progress}),{code:'DIRECT_RUN_PROGRESS_INVALID'});
  await f.store.renewLease({...input,progress:{phase:'EXECUTING',executionElapsedMs:100}});
  for(const progress of [{phase:'PREPARING',executionElapsedMs:0},{phase:'EXECUTING',executionElapsedMs:99}])
    await assert.rejects(f.store.renewLease({...input,progress}),{code:'DIRECT_RUN_STALE'});
  await assert.rejects(f.store.renewLease({...input,leaseOwner:'wrong-owner',progress:{phase:'RETURNING_RESULT',executionElapsedMs:100}}),{code:'DIRECT_RUN_STALE'});
  await f.store.renewLease({...input,progress:{phase:'RETURNING_RESULT',executionElapsedMs:100}});
  await assert.rejects(f.store.renewLease({...input,progress:{phase:'RETURNING_RESULT',executionElapsedMs:101}}),{code:'DIRECT_RUN_STALE'});
  f.setNow(100000);await assert.rejects(f.store.renewLease({...input,progress:{phase:'RETURNING_RESULT',executionElapsedMs:100}}),{code:'DIRECT_RUN_STALE'});
});
for(const revocation of ['rotate','disable'])test('progress update atomically fences concurrent '+revocation,async t=>{
  const f=fixture(t),input=await seed(f),before=f.sql.prepare('SELECT * FROM direct_runs').get();
  f.setHook(async q=>{if(q.includes('SELECT h.host_id, h.bridge_user_id')){f.setHook(null);
    if(revocation==='rotate')f.sql.prepare('UPDATE direct_hosts SET runner_token_sha256=?').run('b'.repeat(64));
    else f.sql.exec('UPDATE direct_hosts SET enabled=0');}});
  await assert.rejects(f.store.renewLease({...input,progress:{phase:'EXECUTING',executionElapsedMs:0}}),{code:'DIRECT_RUN_STALE'});
  assert.deepEqual(f.sql.prepare('SELECT * FROM direct_runs').get(),before);
});
test('heartbeat API passes only validated progress and returns client error for malformed progress',async()=>{
  let seen;
  const handler=createDirectRunnerHandler({store:{async claimNext(){},async complete(){},async renewLease(input){seen=input.progress;return {continue:true};}}});
  const body={hostId,leaseOwner,runId:'dx1:host-main:progress-1234',progress:{phase:'EXECUTING',executionElapsedMs:0}};
  const request=()=>new Request('https://bridge.example/direct/runner/heartbeat',{method:'POST',headers:{authorization:'Bearer '+'a'.repeat(40),'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await handler.fetch(request())).status,200);assert.deepEqual(seen,body.progress);
  body.progress={phase:'EXECUTING',executionElapsedMs:0,phaseStartedAt:1};
  assert.equal((await handler.fetch(request())).status,400);
});
test('native process emits execution only after successful spawn and freezes it before returning',async t=>{
  const root=makeTestDirectory(join(tmpdir(),'bridge-native-progress-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const gate=join(root,'spawn-observed');
  const phases=[];
  // The child can run before a busy parent receives its spawn event. Start
  // the measured delay after that event, so scheduling is not the assertion.
  const script='const fs=require("fs");const gate='+JSON.stringify(gate)+';function wait(){if(fs.existsSync(gate))setTimeout(()=>console.log("done"),120);else setTimeout(wait,5)}wait();';
  const result=await runBounded({cwd:process.cwd(),argv:[process.execPath,'-e',script],env:process.env,
    timeoutSeconds:5,stdoutBytes:1024,stderrBytes:1024,onProgress:value=>{phases.push(value);if(value.phase==='EXECUTING')writeFileSync(gate,'ready');}});
  assert.equal(result.exitCode,0);assert.equal(result.stdout.trim(),'done');
  assert.deepEqual(phases.map(x=>x.phase),['EXECUTING','RETURNING_RESULT']);
  assert.equal(phases[0].executionElapsedMs,0);assert.equal(phases[1].executionElapsedMs,result.durationMs);
  assert.ok(result.durationMs>=100);assert.ok(Date.parse(result.startedAt)<=Date.parse(result.completedAt));
  const failed=[];
  await assert.rejects(runBounded({cwd:process.cwd(),argv:['bridge-nonexistent-command-123456'],env:process.env,
    timeoutSeconds:5,stdoutBytes:1024,stderrBytes:1024,onProgress:value=>failed.push(value)}),{code:'EXECUTION_FAILED'});
  assert.equal(failed.some(x=>x.phase==='EXECUTING'),false);
});
test('OS spawn delay is excluded from actual command duration and never emits early execution',async t=>{
  const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  child.kill=()=>{};
  let monotonic=0;const phases=[];
  const spawn=t.mock.method(childProcess,'spawn',()=>child);
  t.mock.method(performance,'now',()=>monotonic);syncBuiltinESMExports();
  t.after(()=>{spawn.mock.restore();syncBuiltinESMExports();});
  const running=runBounded({cwd:'.',argv:['test-child'],env:{},timeoutSeconds:5,stdoutBytes:1024,stderrBytes:1024,
    onProgress:p=>phases.push(p)});
  monotonic=1250;assert.deepEqual(phases,[]);
  child.emit('spawn');monotonic=2000;child.emit('close',0,null);
  const result=await running;assert.equal(result.durationMs,750);
  assert.deepEqual(phases,[{phase:'EXECUTING',executionElapsedMs:0},{phase:'RETURNING_RESULT',executionElapsedMs:750}]);
});
test('runner serializes actual progress, freezes upload elapsed and replays without respawning',async t=>{
  const root=makeTestDirectory(join(tmpdir(),'bridge-progress-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const hostPolicyPath=join(root,'host.json');writeFileSync(hostPolicyPath,JSON.stringify({version:1,host:{id:hostId},repositories:{},
    directExec:{enabled:true,serviceUser:userInfo().username,root,stateDir:join(root,'state'),maxSeconds:5,stdoutBytes:4096,stderrBytes:4096}}));
  const bytes=Buffer.from('progress file'),sha256=createHash('sha256').update(bytes).digest('hex');
  const marker=join(root,'executions'),request={schemaVersion:1,requestId:'progress-1234',hostId,argv:[process.execPath,'-e',
    'const fs=require("fs");fs.appendFileSync('+JSON.stringify(marker)+',"x");fs.writeFileSync(process.env.BRIDGE_EXPORT_0,fs.readFileSync(process.env.BRIDGE_ASSET_0));setTimeout(()=>console.log("done"),100)'],
    assets:[{assetId:'asset-progress-input',fileName:'input.txt',mimeType:'text/plain',sizeBytes:bytes.length,sha256}],
    exports:[{fileName:'output.txt',mimeType:'text/plain',maxBytes:100}]};
  let inFlight=0,maxInFlight=0,completion,storedProgress,downloadFinished,uploadStarted,downloads=0;const progress=[];
  const fetchImpl=async(url,init)=>{const path=new URL(url).pathname;
    if(path.endsWith('/claim'))return Response.json({runId:'dx1:host-main:progress-1234',request,leaseOwner,progressVersion:1,...(storedProgress?{progress:storedProgress}:{})});
    if(path.endsWith('/heartbeat')){const item=JSON.parse(init.body).progress;maxInFlight=Math.max(maxInFlight,++inFlight);
      await new Promise(resolve=>setTimeout(resolve,40));inFlight--;progress.push(item);storedProgress={...item,reportedAt:Date.now(),phaseStartedAt:Date.now()};return Response.json({continue:true});}
    if(path.includes('/assets/')){downloads++;assert.equal(progress.some(p=>p.phase==='EXECUTING'),false);
      await new Promise(resolve=>setTimeout(resolve,250));downloadFinished=Date.now();return new Response(bytes);}
    if(path.includes('/exports/')){uploadStarted=Date.now();assert.equal(progress.at(-1).phase,'RETURNING_RESULT');
      assert.deepEqual(Buffer.from(init.body),bytes);await new Promise(resolve=>setTimeout(resolve,200));
      return Response.json({assetId:'asset-progress-output',fileName:'output.txt',mimeType:'text/plain',sizeBytes:bytes.length,sha256});}
    if(path.endsWith('/complete')){completion=JSON.parse(init.body).result;return Response.json({status:completion.status});}
    throw Error('unexpected route');};
  assert.equal((await runDirectRunnerOnce({endpoint:'https://bridge.example',token:'a'.repeat(40),hostPolicyPath,fetchImpl})).status,'SUCCEEDED');
  assert.equal(maxInFlight,1);assert.deepEqual(progress.map(p=>p.phase),['PREPARING','EXECUTING','RETURNING_RESULT']);
  assert.equal(progress[0].executionElapsedMs,0);
  assert.ok(progress[1].executionElapsedMs>=0 && progress[1].executionElapsedMs<=completion.execution.durationMs);
  assert.equal(progress[2].executionElapsedMs,completion.execution.durationMs);
  assert.ok(Date.parse(completion.startedAt)>=downloadFinished,'input transfer precedes the actual process start');
  assert.ok(Date.parse(completion.completedAt)<=uploadStarted,'output transfer follows bounded process completion');
  const count=progress.length;
  assert.equal((await runDirectRunnerOnce({endpoint:'https://bridge.example',token:'a'.repeat(40),hostPolicyPath,fetchImpl})).replayed,true);
  assert.equal(readFileSync(marker,'utf8'),'x');assert.ok(progress.slice(count).every(p=>p.phase==='RETURNING_RESULT'));
  assert.equal(downloads,1,'durable replay does not download input or execute again');
});
test('negotiated progress never reports execution for spawn failure',async t=>{
  const root=makeTestDirectory(join(tmpdir(),'bridge-progress-fail-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const hostPolicyPath=join(root,'host.json');writeFileSync(hostPolicyPath,JSON.stringify({version:1,host:{id:hostId},repositories:{},
    directExec:{enabled:true,serviceUser:userInfo().username,root,stateDir:join(root,'state'),maxSeconds:5,stdoutBytes:4096,stderrBytes:4096}}));
  const progress=[];let result;
  const outcome=await runDirectRunnerOnce({endpoint:'https://bridge.example',token:'a'.repeat(40),hostPolicyPath,
    fetchImpl:async(url,init)=>{const path=new URL(url).pathname;
      if(path.endsWith('/claim'))return Response.json({runId:'dx1:host-main:progress-1234',leaseOwner,progressVersion:1,
        request:{schemaVersion:1,requestId:'progress-1234',hostId,argv:['bridge-missing-command-123456']}});
      if(path.endsWith('/heartbeat')){progress.push(JSON.parse(init.body).progress);return Response.json({continue:true});}
      result=JSON.parse(init.body).result;return Response.json({status:result.status});}});
  assert.equal(outcome.status,'FAILED');assert.equal(result.error.code,'EXECUTION_FAILED');
  assert.deepEqual(progress,[{phase:'RETURNING_RESULT',executionElapsedMs:0}]);
});
test('revocation during immediate execution progress aborts child and prevents output return',async t=>{
  const root=makeTestDirectory(join(tmpdir(),'bridge-progress-cancel-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const marker=join(root,'must-not-write'),pidFile=join(root,'child.pid'),hostPolicyPath=join(root,'host.json');
  writeFileSync(hostPolicyPath,JSON.stringify({version:1,host:{id:hostId},repositories:{},
    directExec:{enabled:true,serviceUser:userInfo().username,root,stateDir:join(root,'state'),maxSeconds:30,stdoutBytes:4096,stderrBytes:4096}}));
  const progress=[];let completed=false;
  await assert.rejects(runDirectRunnerOnce({endpoint:'https://bridge.example',token:'a'.repeat(40),hostPolicyPath,
    fetchImpl:async(url,init)=>{const path=new URL(url).pathname;
      if(path.endsWith('/claim'))return Response.json({runId:'dx1:host-main:progress-1234',leaseOwner,progressVersion:1,
        request:{schemaVersion:1,requestId:'progress-1234',hostId,argv:[process.execPath,'-e',
          'require("fs").writeFileSync('+JSON.stringify(pidFile)+',String(process.pid));setTimeout(()=>require("fs").writeFileSync('+JSON.stringify(marker)+',"bad"),12000)']}});
      if(path.endsWith('/heartbeat')){const p=JSON.parse(init.body).progress;progress.push(p);
        if(p.phase==='EXECUTING'){
          // Observe a real child first. The synthetic effect is beyond the
          // existing Windows taskkill eight-second cleanup cap, not a claim
          // that overloaded Windows always kills a process within2.5seconds.
          const deadline=Date.now()+5000;
          while(!existsSync(pidFile)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
          assert.equal(existsSync(pidFile),true);
          return Response.json({error:{code:'DIRECT_RUNNER_DENIED'}},{status:403});
        }
        return Response.json({continue:true});}
      completed=true;throw Error('revoked result must not be returned');}}),e=>e.status===403);
  assert.equal(completed,false);assert.equal(progress.some(p=>p.phase==='EXECUTING'),true);
  assert.throws(()=>readFileSync(marker),{code:'ENOENT'});
  assert.throws(()=>process.kill(Number(readFileSync(pidFile,'utf8')),0),{code:'ESRCH'},'the real child must be terminated, not merely disconnected');
});
for(const finished of [false,true])test('slow input progress keeps live execution timing but coalesces obsolete execution HTTP (finished '+finished+')',async t=>{
  const root=makeTestDirectory(join(tmpdir(),'bridge-progress-slow-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const marker=join(root,'spawned'),hostPolicyPath=join(root,'host.json'),stateDir=join(root,'state');
  const journal=join(stateDir,hostId,'progress-1234','result.json');
  writeFileSync(hostPolicyPath,JSON.stringify({version:1,host:{id:hostId},repositories:{},
    directExec:{enabled:true,serviceUser:userInfo().username,root,stateDir,maxSeconds:5,stdoutBytes:4096,stderrBytes:4096}}));
  const bytes=Buffer.from('input'),sha256=createHash('sha256').update(bytes).digest('hex');
  const reports=[],calls=[];let completed;
  await runDirectRunnerOnce({endpoint:'https://bridge.example',token:'a'.repeat(40),hostPolicyPath,
    fetchImpl:async(url,init)=>{const path=new URL(url).pathname;calls.push(path);
      if(path.endsWith('/claim'))return Response.json({runId:'dx1:host-main:progress-1234',leaseOwner,progressVersion:1,
        request:{schemaVersion:1,requestId:'progress-1234',hostId,argv:[process.execPath,'-e',
          'require("fs").writeFileSync('+JSON.stringify(marker)+',"spawned");setTimeout(()=>console.log("done"),'+(finished?100:1200)+')'],
          assets:[{assetId:'asset-slow-input',fileName:'input.txt',mimeType:'text/plain',sizeBytes:bytes.length,sha256}]}});
      if(path.includes('/assets/'))return new Response(bytes);
      if(path.endsWith('/heartbeat')){const p=JSON.parse(init.body).progress;reports.push(p);
        if(p.phase==='PREPARING'){
          const target=finished?journal:marker,deadline=Date.now()+5000;
          while(!existsSync(target)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
          assert.equal(existsSync(target),true);await new Promise(resolve=>setTimeout(resolve,150));
        }
        if(p.phase==='EXECUTING')await new Promise(resolve=>setTimeout(resolve,200));
        return Response.json({continue:true});}
      completed=JSON.parse(init.body).result;return Response.json({status:completed.status});}});
  const execution=reports.find(p=>p.phase==='EXECUTING'),returned=reports.find(p=>p.phase==='RETURNING_RESULT');
  assert.equal(returned.executionElapsedMs,completed.execution.durationMs);
  if(finished){
    assert.equal(execution,undefined,'already finished execution must not send an obsolete EXECUTING HTTP request');
    assert.deepEqual(reports.map(p=>p.phase),['PREPARING','RETURNING_RESULT']);
    assert.equal(calls.length,5,'claim, real input phase, asset GET, result phase and completion only');
  }else{
    assert.ok(execution.executionElapsedMs>=100,'elapsed must include time queued behind the PREPARING report');
    assert.ok(execution.executionElapsedMs<completed.execution.durationMs);
    assert.deepEqual(reports.map(p=>p.phase),['PREPARING','EXECUTING','RETURNING_RESULT']);
    assert.equal(calls.length,6);
  }
});

test('ordinary short command skips input phase, returns final phase, and replays without another execution',async t=>{
  const root=makeTestDirectory(join(tmpdir(),'bridge-progress-cost-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const marker=join(root,'executions'),hostPolicyPath=join(root,'host.json');
  writeFileSync(hostPolicyPath,JSON.stringify({version:1,host:{id:hostId},repositories:{},
    directExec:{enabled:true,serviceUser:userInfo().username,root,stateDir:join(root,'state'),maxSeconds:5,stdoutBytes:4096,stderrBytes:4096}}));
  const request={schemaVersion:1,requestId:'progress-cost-1234',hostId,argv:[process.execPath,'-e',
    'require("fs").appendFileSync('+JSON.stringify(marker)+',"x");console.log("done")']};
  const calls=[],reports=[];let progress,result;
  const fetchImpl=async(url,init)=>{const path=new URL(url).pathname;calls.push(path);
    if(path.endsWith('/claim'))return Response.json({runId:'dx1:host-main:progress-cost-1234',leaseOwner,progressVersion:1,request,...(progress?{progress}:{})});
    if(path.endsWith('/heartbeat')){const value=JSON.parse(init.body).progress;reports.push(value);
      await new Promise(resolve=>setTimeout(resolve,100));progress={...value,phaseStartedAt:Date.now(),reportedAt:Date.now()};return Response.json({continue:true});}
    if(path.endsWith('/complete')){result=JSON.parse(init.body).result;return Response.json({status:result.status});}
    throw Error('ordinary command must not download or upload');};
  assert.equal((await runDirectRunnerOnce({endpoint:'https://bridge.example',token:'a'.repeat(40),hostPolicyPath,fetchImpl})).status,'SUCCEEDED');
  assert.deepEqual(reports.map(p=>p.phase),['EXECUTING','RETURNING_RESULT']);
  assert.equal(calls.length,4,'one claim, two necessary phase updates and one complete; no PREPARING RTT');
  assert.equal(reports.at(-1).executionElapsedMs,result.execution.durationMs);
  const previousCalls=calls.length,previousReports=reports.length;
  assert.equal((await runDirectRunnerOnce({endpoint:'https://bridge.example',token:'a'.repeat(40),hostPolicyPath,fetchImpl})).replayed,true);
  assert.equal(readFileSync(marker,'utf8'),'x');
  assert.equal(calls.length-previousCalls,2,'known RETURNING_RESULT replay needs only claim and authenticated complete');
  assert.equal(reports.length,previousReports,'replay never regresses to input preparation or another execution');
  progress=null;
  const beforeLegacyReplayCalls=calls.length,beforeLegacyReplayReports=reports.length;
  assert.equal((await runDirectRunnerOnce({endpoint:'https://bridge.example',token:'a'.repeat(40),hostPolicyPath,fetchImpl})).replayed,true);
  assert.equal(calls.length-beforeLegacyReplayCalls,3,'a replay without persisted progress needs one result-phase notification, no preparing/execute');
  assert.deepEqual(reports.slice(beforeLegacyReplayReports).map(p=>p.phase),['RETURNING_RESULT']);
  assert.equal(readFileSync(marker,'utf8'),'x');
});

test('negotiated command retains the twenty-second heartbeat and revocation cancellation',async t=>{
  const root=makeTestDirectory(join(tmpdir(),'bridge-progress-periodic-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const pidFile=join(root,'child.pid'),hostPolicyPath=join(root,'host.json');
  writeFileSync(hostPolicyPath,JSON.stringify({version:1,host:{id:hostId},repositories:{},
    directExec:{enabled:true,serviceUser:userInfo().username,root,stateDir:join(root,'state'),maxSeconds:60,stdoutBytes:4096,stderrBytes:4096}}));
  let count=0,firstAck=false,completed=false;const reports=[];
  t.mock.timers.enable({apis:['setInterval']});
  try{
    const running=runDirectRunnerOnce({endpoint:'https://bridge.example',token:'a'.repeat(40),hostPolicyPath,
      fetchImpl:async(url,init)=>{const path=new URL(url).pathname;
        if(path.endsWith('/claim'))return Response.json({runId:'dx1:host-main:progress-periodic-1234',leaseOwner,progressVersion:1,
          request:{schemaVersion:1,requestId:'progress-periodic-1234',hostId,argv:[process.execPath,'-e',
            'require("fs").writeFileSync('+JSON.stringify(pidFile)+',String(process.pid));setInterval(()=>{},1000)']}});
        if(path.endsWith('/heartbeat')){reports.push(JSON.parse(init.body).progress);count++;
          if(count===1){firstAck=true;return Response.json({continue:true});}
          return Response.json({error:{code:'DIRECT_RUN_STALE'}},{status:409});}
        completed=true;throw Error('revoked command must not complete');}});
    const rejected=assert.rejects(running,e=>e.status===409);
    const deadline=Date.now()+5000;
    while((!existsSync(pidFile)||!firstAck)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(existsSync(pidFile),true);assert.equal(firstAck,true);
    t.mock.timers.tick(19_999);for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(count,1,'no periodic heartbeat before the original20s interval');
    t.mock.timers.tick(1);await rejected;
    assert.equal(count,2);assert.deepEqual(reports.map(p=>p.phase),['EXECUTING','EXECUTING']);
    assert.equal(completed,false);assert.throws(()=>process.kill(Number(readFileSync(pidFile,'utf8')),0),{code:'ESRCH'});
  }finally{t.mock.timers.reset();}
});

for(const withInput of [false,true])test('real loopback HTTP slow responses preserve one execution with fewer requests (input '+withInput+')',async t=>{
  const root=makeTestDirectory(join(tmpdir(),'bridge-progress-http-')),stateDir=join(root,'state');
  const hostPolicyPath=join(root,'host.json'),marker=join(root,'executions'),journal=join(stateDir,hostId,'progress-http-1234','result.json');
  writeFileSync(hostPolicyPath,JSON.stringify({version:1,host:{id:hostId},repositories:{},
    directExec:{enabled:true,serviceUser:userInfo().username,root,stateDir,maxSeconds:5,stdoutBytes:4096,stderrBytes:4096}}));
  const bytes=Buffer.from('real HTTP input'),sha256=createHash('sha256').update(bytes).digest('hex');
  const request={schemaVersion:1,requestId:'progress-http-1234',hostId,argv:[process.execPath,'-e',
    'require("fs").appendFileSync('+JSON.stringify(marker)+',"x");console.log("done")'],
    ...(withInput?{assets:[{assetId:'asset-http-input',fileName:'input.txt',mimeType:'text/plain',sizeBytes:bytes.length,sha256}]}:{})};
  const calls=[],reports=[],serverErrors=[];let completed;
  const server=createServer(async(req,res)=>{
    try{
      calls.push(req.url);assert.equal(req.headers.authorization,'Bearer '+'a'.repeat(40));
      const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;assert.ok(size<=16384);chunks.push(chunk);}
      const body=size?JSON.parse(Buffer.concat(chunks)):null;
      const json=value=>{res.writeHead(200,{'content-type':'application/json','connection':'close'});res.end(JSON.stringify(value));};
      if(req.url.endsWith('/claim'))return json({runId:'dx1:host-main:progress-http-1234',request,leaseOwner,progressVersion:1});
      if(req.url.includes('/assets/')){res.writeHead(200,{'content-type':'text/plain','content-length':bytes.length,'connection':'close'});res.end(bytes);return;}
      if(req.url.endsWith('/heartbeat')){
        reports.push(body.progress);
        if(body.progress.phase==='PREPARING'){
          const deadline=Date.now()+5000;
          while(!existsSync(journal)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
          assert.equal(existsSync(journal),true);
        }
        await new Promise(resolve=>setTimeout(resolve,100));return json({continue:true});
      }
      if(req.url.endsWith('/complete')){completed=body.result;return json({status:completed.status});}
      throw Error('unexpected local HTTP route');
    }catch(error){serverErrors.push(error.name);if(!res.headersSent)res.writeHead(500);res.end('fixture failure');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));rmSync(root,{recursive:true,force:true});});
  const result=await runDirectRunnerOnce({endpoint:'http://127.0.0.1:'+server.address().port,token:'a'.repeat(40),hostPolicyPath});
  assert.equal(result.status,'SUCCEEDED');assert.deepEqual(serverErrors,[]);assert.equal(readFileSync(marker,'utf8'),'x');
  assert.deepEqual(reports.map(p=>p.phase),withInput?['PREPARING','RETURNING_RESULT']:['EXECUTING','RETURNING_RESULT']);
  assert.equal(calls.length,withInput?5:4,'actual HTTP server request counts include claim, phase updates, optional asset GET and complete');
  assert.equal(reports.at(-1).executionElapsedMs,completed.execution.durationMs);
});
