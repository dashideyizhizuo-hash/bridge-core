import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir,userInfo} from 'node:os';
import {join} from 'node:path';
import {runDirectRunnerLoop} from '../src/direct-runner-client.mjs';
import {markDirectJournalStarted,markDirectJournalCompleted} from '../src/direct-runner-journal.mjs';
const TOKEN='runner_token_abcdefghijklmnopqrstuvwxyz123456';
const flush=async()=>{for(let i=0;i<15;i++)await new Promise(resolve=>setImmediate(resolve));};
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'bridge-polling-'));
  t.after(()=>{assert.ok(root.startsWith(join(tmpdir(),'bridge-polling-')));rmSync(root,{recursive:true,force:true});});
  const hostPolicyPath=join(root,'host.json');
  const policy={version:1,host:{id:'host-polling'},repositories:{},directExec:{enabled:true,
    serviceUser:userInfo().username,root,stateDir:join(root,'state'),maxSeconds:10,stdoutBytes:4096,stderrBytes:4096,resultBytes:4096}};
  writeFileSync(hostPolicyPath,JSON.stringify(policy));
  const request={schemaVersion:1,requestId:'polling-replay-1',hostId:policy.host.id,argv:['unused-replay-command']};
  markDirectJournalStarted({hostPolicy:policy,request});
  markDirectJournalCompleted({hostPolicy:policy,request,result:{schemaVersion:1,hostId:request.hostId,
    requestId:request.requestId,status:'SUCCEEDED',evidence:{stdout:'saved result',stderr:''}}});
  return {hostPolicyPath,request};
}
function start(t,steps,{pollMs=5000}={}){
  const f=fixture(t),controller=new AbortController(),events=[];let claims=0;
  t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});
  const running=runDirectRunnerLoop({endpoint:'https://bridge.example',token:TOKEN,hostPolicyPath:f.hostPolicyPath,
    pollMs,signal:controller.signal,onError:()=>{},fetchImpl:async(url,init)=>{
      const path=new URL(url).pathname;events.push({path,time:Date.now()});
      assert.equal(init.headers.authorization,'Bearer '+TOKEN);
      if(path.endsWith('/complete'))return Response.json({ok:true});
      assert.ok(path.endsWith('/claim'),'idle optimization must not change active heartbeat protocol');
      const step=steps[claims++]??'idle';
      if(step==='error')return Response.json({error:{code:'TEMPORARY_FAILURE'}},{status:503});
      if(step==='run')return Response.json({runId:'dx1:host-polling:'+f.request.requestId,request:f.request,leaseOwner:'owner-fixture',leaseExpiresAt:Date.now()+90000});
      return new Response(null,{status:204});
    }});
  t.after(async()=>{controller.abort();await running;t.mock.timers.reset();});
  return {events,controller,running,claims:()=>claims,async tick(ms){t.mock.timers.tick(ms);await flush();}};
}

test('idle claims wait 5, 10, 15 seconds then stay capped; abort interrupts the wait',async t=>{
  const f=start(t,[]);await flush();assert.equal(f.claims(),1);
  for(const [wait,count]of [[5000,2],[10000,3],[15000,4],[15000,5]]){
    await f.tick(wait-1);assert.equal(f.claims(),count-1);await f.tick(1);assert.equal(f.claims(),count);
  }
  f.controller.abort();assert.equal((await f.running).status,'STOPPED');
  await f.tick(60000);assert.equal(f.claims(),5);
});

test('finished work claims immediately and resets the next idle wait',async t=>{
  const f=start(t,['idle','idle','run','idle']);await flush();
  await f.tick(5000);await f.tick(10000);
  assert.equal(f.claims(),4);
  const complete=f.events.findIndex(event=>event.path.endsWith('/complete'));
  assert.ok(complete>=0);assert.equal(f.events[complete+1].time,f.events[complete].time);
  await f.tick(4999);assert.equal(f.claims(),4);await f.tick(1);assert.equal(f.claims(),5);
});

test('network error retry backoff is separate and a successful retry restarts idle pacing',async t=>{
  const f=start(t,['idle','idle','error','error','idle']);await flush();
  await f.tick(5000);await f.tick(10000);assert.equal(f.claims(),3);
  await f.tick(999);assert.equal(f.claims(),3);await f.tick(1);assert.equal(f.claims(),4);
  await f.tick(1999);assert.equal(f.claims(),4);await f.tick(1);assert.equal(f.claims(),5);
  await f.tick(4999);assert.equal(f.claims(),5);await f.tick(1);assert.equal(f.claims(),6);
});

test('an explicit slower poll interval is preserved rather than silently increased in frequency',async t=>{
  const f=start(t,[],{pollMs:30000});await flush();
  await f.tick(29999);assert.equal(f.claims(),1);await f.tick(1);assert.equal(f.claims(),2);
  await f.tick(30000);assert.equal(f.claims(),3);
});
