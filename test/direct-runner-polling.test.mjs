import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, realpathSync, rmSync } from 'node:fs';
import {makeTestDirectory as mkdtempSync} from './helpers/canonical-temp.mjs';
import {tmpdir,userInfo} from 'node:os';
import {join} from 'node:path';
import {runDirectRunnerLoop} from '../src/direct-runner-client.mjs';
import {markDirectJournalStarted,markDirectJournalCompleted} from '../src/direct-runner-journal.mjs';
const TOKEN='runner_token_abcdefghijklmnopqrstuvwxyz123456';
const flush=async()=>{for(let i=0;i<15;i++)await new Promise(resolve=>setImmediate(resolve));};
function fixture(t){
  const root=mkdtempSync(join(tmpdir(),'bridge-polling-'));
  t.after(()=>{assert.ok(root.startsWith(join(realpathSync.native(tmpdir()),'bridge-polling-')));rmSync(root,{recursive:true,force:true});});
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
function start(t,steps,{pollMs}={}){
  const f=fixture(t),controller=new AbortController(),events=[],errors=[];let claims=0,contacts=0;
  t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});
  const running=runDirectRunnerLoop({endpoint:'https://bridge.example',token:TOKEN,hostPolicyPath:f.hostPolicyPath,
    pollMs,signal:controller.signal,onError:error=>errors.push(error),onContact:()=>{contacts++;},fetchImpl:async(url,init)=>{
      const path=new URL(url).pathname;events.push({path,time:Date.now()});
      assert.equal(init.headers.authorization,'Bearer '+TOKEN);
      if(path.endsWith('/complete'))return Response.json({ok:true});
      assert.ok(path.endsWith('/claim'),'idle optimization must not change active heartbeat protocol');
      const step=steps[claims++]??'idle';
      if(step==='paused')return Response.json({error:{code:'DIRECT_HOST_PAUSED'}},{status:423});
      if(step==='denied')return Response.json({error:{code:'DIRECT_RUNNER_DENIED'}},{status:403});
      if(step==='error')return Response.json({error:{code:'TEMPORARY_FAILURE'}},{status:503});
      if(step==='payment')return Response.json({error:{code:'BILLING_PAYMENT_REQUIRED'}},{status:402});
      if(step==='unknown402')return Response.json({error:{code:'UNKNOWN_PAYMENT_FAILURE'}},{status:402});
      if(step==='storage402')return Response.json({error:{code:'BILLING_STORAGE_LIMIT'}},{status:402});
      if(step==='wrong-status-payment')return Response.json({error:{code:'BILLING_PAYMENT_REQUIRED'}},{status:503});
      if(step==='run')return Response.json({runId:'dx1:host-polling:'+f.request.requestId,request:f.request,leaseOwner:'owner-fixture',leaseExpiresAt:Date.now()+90000});
      return new Response(null,{status:204});
    }});
  t.after(async()=>{controller.abort();await running.catch(()=>{});t.mock.timers.reset();});
  return {events,errors,controller,running,claims:()=>claims,contacts:()=>contacts,async tick(ms){t.mock.timers.tick(ms);await flush();}};
}

test('idle stays hot for five minutes, doubles at both activity boundaries and caps at sixty claims per hour',async t=>{
  const f=start(t,[]);await flush();assert.equal(f.claims(),1);
  for(let n=1;n<=20;n++){
    await f.tick(14999);assert.equal(f.claims(),n);await f.tick(1);assert.equal(f.claims(),n+1);
  }
  for(let n=1;n<=10;n++){
    await f.tick(29999);assert.equal(f.claims(),20+n);await f.tick(1);assert.equal(f.claims(),21+n);
  }
  await f.tick(59999);assert.equal(f.claims(),31);await f.tick(1);assert.equal(f.claims(),32);
  for(let minute=0;minute<60;minute++)await f.tick(60000);
  assert.equal(f.claims(),92,'steady idle performs sixty claims per simulated hour');
  f.controller.abort();assert.equal((await f.running).status,'STOPPED');
  await f.tick(60000);assert.equal(f.claims(),92);
});

test('work after long inactivity immediately claims again and resets the entire five-minute hot window',async t=>{
  const steps=[],f=start(t,steps);await flush();
  for(let n=0;n<20;n++)await f.tick(15000);for(let n=0;n<10;n++)await f.tick(30000);
  steps[f.claims()]='run';await f.tick(60000);
  assert.equal(f.claims(),33);
  const complete=f.events.findIndex(event=>event.path.endsWith('/complete'));
  assert.ok(complete>=0);assert.equal(f.events[complete+1].time,f.events[complete].time);
  for(let n=0;n<20;n++){await f.tick(14999);assert.equal(f.claims(),33+n);await f.tick(1);assert.equal(f.claims(),34+n);}
  await f.tick(29999);assert.equal(f.claims(),53);await f.tick(1);assert.equal(f.claims(),54);
});

test('network retries use separate exponential delays without resetting the long-idle activity clock',async t=>{
  const steps=[],f=start(t,steps);await flush();
  for(let n=0;n<20;n++)await f.tick(15000);for(let n=0;n<10;n++)await f.tick(30000);
  steps[f.claims()]='error';steps[f.claims()+1]='error';steps[f.claims()+2]='error';
  await f.tick(60000);assert.equal(f.claims(),32);
  for(const [wait,count]of [[1000,33],[2000,34],[4000,35]]){await f.tick(wait-1);assert.equal(f.claims(),count-1);await f.tick(1);assert.equal(f.claims(),count);}
  await f.tick(59999);assert.equal(f.claims(),35);await f.tick(1);assert.equal(f.claims(),36);
});

test('an explicit slower poll interval is preserved rather than silently increased in frequency',async t=>{
  const f=start(t,[],{pollMs:30000});await flush();
  await f.tick(29999);assert.equal(f.claims(),1);await f.tick(1);assert.equal(f.claims(),2);
  for(let n=0;n<9;n++)await f.tick(30000);assert.equal(f.claims(),11);
  await f.tick(59999);assert.equal(f.claims(),11);await f.tick(1);assert.equal(f.claims(),12);
});

test('owner pause stays in the foreground loop, contacts once a minute and resumes new work',async t=>{
  const f=start(t,['paused','paused','run','idle']);await flush();assert.equal(f.claims(),1);
  await f.tick(59999);assert.equal(f.claims(),1);await f.tick(1);assert.equal(f.claims(),2);
  await f.tick(60000);assert.equal(f.claims(),4);
  assert.equal(f.events.filter(e=>e.path.endsWith('/complete')).length,1);
  await f.tick(14999);assert.equal(f.claims(),4);await f.tick(1);assert.equal(f.claims(),5);
});

test('bad or revoked credentials still terminate the loop after a healthy owner pause',async t=>{
  const f=start(t,['paused','denied']);const rejected=assert.rejects(f.running,e=>e.status===403&&e.code==='DIRECT_RUNNER_DENIED');
  await flush();await f.tick(60000);await rejected;await f.tick(120000);assert.equal(f.claims(),2);
});

test('explicit payment hold performs sixty authenticated claims per steady hour without exiting',async t=>{
  const f=start(t,Array(62).fill('payment'));await flush();assert.equal(f.claims(),1);assert.equal(f.contacts(),1);assert.equal(f.errors[0].code,'BILLING_PAYMENT_REQUIRED','a healthy contact must still report the billing action needed');
  await f.tick(59_999);assert.equal(f.claims(),1);await f.tick(1);assert.equal(f.claims(),2);
  const before=f.claims();for(let minute=0;minute<60;minute++)await f.tick(60_000);
  assert.equal(f.claims()-before,60,'billing hold has sixty probes per steady hour instead of the network cap of120');
  assert.equal(f.contacts(),f.claims());assert.ok(f.events.every(event=>event.path.endsWith('/claim')));
  f.controller.abort();assert.equal((await f.running).status,'STOPPED');
});

test('payment or tariff recovery resumes the original queued request within one minute',async t=>{
  const f=start(t,['payment','payment','run','idle']);await flush();assert.equal(f.claims(),1);
  await f.tick(59_999);assert.equal(f.claims(),1);await f.tick(1);assert.equal(f.claims(),2);
  await f.tick(60_000);assert.equal(f.claims(),4);
  assert.equal(f.events.filter(event=>event.path.endsWith('/complete')).length,1,'same stored request completes only once');
  await f.tick(14_999);assert.equal(f.claims(),4);await f.tick(1);assert.equal(f.claims(),5,'completed work restores the original fifteen-second hot interval');
});

for(const response of ['unknown402','storage402','wrong-status-payment'])test(response+' retains genuine error backoff instead of granting a business hold',async t=>{
  const f=start(t,[response,response,'idle']);await flush();assert.equal(f.claims(),1);
  await f.tick(999);assert.equal(f.claims(),1);await f.tick(1);assert.equal(f.claims(),2);
  await f.tick(1999);assert.equal(f.claims(),2);await f.tick(1);assert.equal(f.claims(),3);
});

test('unknown402 keeps the original120 retries per steady hour rather than the payment hold',async t=>{
  const f=start(t,Array(140).fill('unknown402'));await flush();
  for(const seconds of [1,2,4,8,16,30])await f.tick(seconds*1000);
  const before=f.claims();for(let halfMinute=0;halfMinute<120;halfMinute++)await f.tick(30_000);
  assert.equal(f.claims()-before,120,'genuine or unknown errors retain the original thirty-second retry cap');
  assert.equal(f.contacts(),0,'unknown402 cannot claim an authenticated payment-hold contact');
});

test('an authenticated payment hold does not hide subsequently revoked credentials',async t=>{
  const f=start(t,['payment','denied']);const rejected=assert.rejects(f.running,e=>e.status===403&&e.code==='DIRECT_RUNNER_DENIED');
  await flush();await f.tick(60_000);await rejected;await f.tick(120_000);assert.equal(f.claims(),2);
});

test('payment hold resets only network retry delay, not the long-idle pickup clock',async t=>{
  const steps=[],f=start(t,steps);await flush();
  for(let n=0;n<20;n++)await f.tick(15_000);for(let n=0;n<10;n++)await f.tick(30_000);
  steps[f.claims()]='payment';steps[f.claims()+1]='error';
  await f.tick(60_000);assert.equal(f.claims(),32);
  await f.tick(60_000);assert.equal(f.claims(),33);
  await f.tick(999);assert.equal(f.claims(),33);await f.tick(1);assert.equal(f.claims(),34);
  await f.tick(59_999);assert.equal(f.claims(),34);await f.tick(1);assert.equal(f.claims(),35,'payment state does not reset the sixty-second idle window');
});

test('one-shot invocation preserves the explicit billing failure without automatic retry',async t=>{
  const f=fixture(t);let claims=0;
  await assert.rejects(runDirectRunnerLoop({endpoint:'https://bridge.example',token:TOKEN,hostPolicyPath:f.hostPolicyPath,once:true,onError:()=>{},
    fetchImpl:async()=>{claims++;return Response.json({error:{code:'BILLING_PAYMENT_REQUIRED'}},{status:402});}}),
  e=>e.status===402&&e.code==='BILLING_PAYMENT_REQUIRED');
  assert.equal(claims,1);
});
