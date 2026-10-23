import test from 'node:test';
import assert from 'node:assert/strict';
import {directWaitSeconds,waitForDirectResult} from '../src/direct-run-wait.mjs';

const EPOCH=1_790_000_000_000;
const receipt={runId:'dx1:host-a:direct-stage-wait',hostId:'host-a',kind:'direct',transport:'direct',status:'QUEUED'};
function fixture(stateAt){
  let now=0,reads=0,results=0;
  return {get now(){return now;},get reads(){return reads;},get results(){return results;},
    options:{clock:()=>now,wallClock:()=>EPOCH+now,delay:async ms=>{now+=ms;}},
    gateway:{getRun:async()=>{reads++;return {...receipt,...stateAt(now)};},getResult:async()=>{results++;return {...receipt,status:'SUCCEEDED',evidence:{stdout:'stage-complete',stderr:''}};}}};
}
const progress=(phase,now,elapsed=0)=>({phase,executionElapsedMs:elapsed,reportedAt:EPOCH+now,phaseStartedAt:EPOCH+now});

test('execution response wait defaults to twenty seconds',()=>{
  assert.equal(directWaitSeconds({mode:'direct'}),20);
  assert.equal(directWaitSeconds({mode:'direct',waitSeconds:20}),20);
  assert.equal(directWaitSeconds({mode:'direct',waitSeconds:0}),0);
  assert.throws(()=>directWaitSeconds({mode:'direct',waitSeconds:21}));
});

test('queue and input transfer do not consume the execution response window',async()=>{
  const f=fixture(now=>now<35_000?{status:'QUEUED'}:
    now<47_000?{status:'RUNNING',progress:progress('PREPARING',now)}:
    now<49_000?{status:'RUNNING',progress:progress('EXECUTING',now,now-47_000)}:
    now<55_000?{status:'RUNNING',progress:progress('RETURNING_RESULT',now,2_000)}:{status:'SUCCEEDED'});
  const result=await waitForDirectResult(f.gateway,receipt,20,f.options);
  assert.equal(result.status,'SUCCEEDED');assert.equal(result.evidence.stdout,'stage-complete');
  assert.equal(f.now,55_000);assert.equal(f.results,1);
});

test('a long command returns only after twenty execution seconds, not twenty queue seconds',async()=>{
  const f=fixture(now=>now<30_000?{status:'QUEUED'}:
    {status:'RUNNING',progress:progress('EXECUTING',now,now-30_000)});
  const result=await waitForDirectResult(f.gateway,receipt,20,f.options);
  assert.equal(result.status,'RUNNING');assert.equal(result.waitStatus,'timed_out');
  assert.equal(result.waitPhase,'execution');assert.equal(f.now,50_000);assert.equal(f.results,0);
});

test('queue timeout is independent and preserves the original task',async()=>{
  const f=fixture(()=>({status:'QUEUED'}));
  const result=await waitForDirectResult(f.gateway,receipt,20,{...f.options,queueWaitSeconds:2});
  assert.equal(result.runId,receipt.runId);assert.equal(result.waitStatus,'timed_out');
  assert.equal(result.waitPhase,'queue');assert.equal(f.now,2_000);assert.equal(f.results,0);
});

test('fractional timer delays do not add an early poll before the final boundary read',async()=>{
  let now=0;const reads=[],delays=[];
  const result=await waitForDirectResult({
    async getRun(){
      reads.push(now);
      if(reads.length===1)now+=0.25;
      return {...receipt,status:'RUNNING'};
    },
    async getResult(){throw Error('Pending execution has no result');}
  },receipt,1,{
    queueWaitSeconds:1,clock:()=>now,wallClock:()=>EPOCH+now,
    // Node truncates fractional timer delays and clamps zero to one millisecond.
    delay:async ms=>{delays.push(ms);now+=Math.max(1,Math.floor(ms));}
  });
  assert.equal(result.runId,receipt.runId);assert.equal(result.status,'RUNNING');
  assert.equal(result.waitStatus,'timed_out');assert.equal(result.waitPhase,'awaiting_start');
  assert.equal(reads.length,2,JSON.stringify({reads,delays}));
  assert.ok(reads[1]-reads[0]>=1000,'only the initial and final boundary reads are needed');
});

test('input preparation has its own response wait budget',async()=>{
  const f=fixture(now=>now<1_000?{status:'QUEUED'}:{status:'RUNNING',progress:progress('PREPARING',now)});
  const result=await waitForDirectResult(f.gateway,receipt,20,{...f.options,transferWaitSeconds:2});
  assert.equal(result.waitPhase,'input_transfer');assert.equal(f.now,3_000);assert.equal(f.results,0);
});

test('completed short execution may return a file after a longer output transfer',async()=>{
  const f=fixture(now=>now<1_000?{status:'QUEUED'}:
    now<2_000?{status:'RUNNING',progress:progress('EXECUTING',now,now-1_000)}:
    now<32_000?{status:'RUNNING',progress:progress('RETURNING_RESULT',now,1_000)}:{status:'SUCCEEDED'});
  const result=await waitForDirectResult(f.gateway,receipt,20,f.options);
  assert.equal(result.status,'SUCCEEDED');assert.equal(f.now,32_000);assert.equal(f.results,1);
});

test('repeated phase reports cannot restart the execution clock',async()=>{
  const f=fixture(now=>({status:'RUNNING',progress:progress('EXECUTING',now,0)}));
  const result=await waitForDirectResult(f.gateway,receipt,20,f.options);
  assert.equal(result.waitPhase,'execution');assert.equal(f.now,20_000);assert.equal(f.results,0);
});

test('a total response limit bounds several individually valid stages',async()=>{
  const f=fixture(now=>now<70_000?{status:'QUEUED'}:{status:'RUNNING',progress:progress('PREPARING',now)});
  const result=await waitForDirectResult(f.gateway,receipt,20,f.options);
  assert.equal(result.waitStatus,'timed_out');assert.equal(result.waitPhase,'total');
  assert.equal(f.now,120_000);assert.equal(f.results,0);
});

test('legacy RUNNING without progress never fabricates actual execution start',async()=>{
  const f=fixture(()=>({status:'RUNNING'}));
  const result=await waitForDirectResult(f.gateway,receipt,20,{...f.options,queueWaitSeconds:3});
  assert.equal(result.waitPhase,'awaiting_start');assert.equal(f.now,3_000);
  assert.equal(f.results,0);
});

test('pickup in the final half-second receives its full execution budget',async()=>{
  const f=fixture(now=>now<74_500?{status:'QUEUED'}:now<76_000?{status:'RUNNING',progress:progress('EXECUTING',now,now-74_500)}:{status:'SUCCEEDED'});
  const result=await waitForDirectResult(f.gateway,receipt,20,f.options);
  assert.equal(result.status,'SUCCEEDED');assert.equal(f.now,76_000);assert.equal(f.results,1);
});

test('completion in the final execution half-second receives a separate transfer budget',async()=>{
  const f=fixture(now=>now<19_500?{status:'RUNNING',progress:progress('EXECUTING',now,now)}:
    now<22_000?{status:'RUNNING',progress:progress('RETURNING_RESULT',now,19_500)}:{status:'SUCCEEDED'});
  const result=await waitForDirectResult(f.gateway,receipt,20,f.options);
  assert.equal(result.status,'SUCCEEDED');assert.equal(f.now,22_000);assert.equal(f.results,1);
});
