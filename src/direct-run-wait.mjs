import {assertBridge} from './errors.mjs';

export const MAX_DIRECT_WAIT_SECONDS=20;
export const MAX_DIRECT_RESPONSE_SECONDS=120;
const DEFAULT_DIRECT_WAIT_SECONDS=20;
const DEFAULT_QUEUE_WAIT_SECONDS=75;
const DEFAULT_TRANSFER_WAIT_SECONDS=60;
const TERMINAL=new Set(['SUCCEEDED','FAILED','CANCELED']);
const PHASES={PREPARING:'input_transfer',EXECUTING:'execution',RETURNING_RESULT:'output_transfer'};
const POLL_INTERVAL_MS=1000;

function budget(value,fallback,max,name) {
  const seconds=value===undefined?fallback:value;
  assertBridge(Number.isInteger(seconds)&&seconds>=0&&seconds<=max,
    'INVALID_GATEWAY_REQUEST',`${name} must be an integer from 0 to ${max}`);
  return seconds;
}

export function directWaitSettings(args) {
  const fields=['waitSeconds','queueWaitSeconds','transferWaitSeconds'];
  assertBridge(args?.mode==='direct'||fields.every(key=>args?.[key]===undefined),
    'INVALID_GATEWAY_REQUEST','Response wait options are supported only for Direct Exec');
  return {
    seconds:budget(args?.waitSeconds,args?.mode==='direct'?DEFAULT_DIRECT_WAIT_SECONDS:0,MAX_DIRECT_WAIT_SECONDS,'waitSeconds'),
    queueWaitSeconds:budget(args?.queueWaitSeconds,DEFAULT_QUEUE_WAIT_SECONDS,MAX_DIRECT_RESPONSE_SECONDS,'queueWaitSeconds'),
    transferWaitSeconds:budget(args?.transferWaitSeconds,DEFAULT_TRANSFER_WAIT_SECONDS,MAX_DIRECT_RESPONSE_SECONDS,'transferWaitSeconds')
  };
}

export const directWaitSeconds=args=>directWaitSettings(args).seconds;

function pause(ms,signal) {
  return new Promise(resolve=>{
    if(signal?.aborted){resolve();return;}
    const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',finish);resolve();};
    const timer=setTimeout(finish,ms);
    signal?.addEventListener('abort',finish,{once:true});
  });
}

async function boundedRead(operation,remaining,signal) {
  if(signal?.aborted)return {state:'interrupted'};
  if(remaining<=0)return {state:'timed_out'};
  let timer,onAbort;
  const stopped=new Promise(resolve=>{
    timer=setTimeout(()=>resolve({state:'timed_out'}),remaining);
    onAbort=()=>resolve({state:'interrupted'});
    signal?.addEventListener('abort',onAbort,{once:true});
  });
  const read=Promise.resolve().then(operation).then(
    value=>({state:'value',value}),()=>({state:'unavailable'})
  );
  try{return await Promise.race([read,stopped]);}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
}

// Wait above admission/billing: reads are scoped to the same principal and Run.
// Ending this response never cancels or re-submits its durable execution.
export async function waitForDirectResult(gateway,receipt,seconds,{
  signal,clock=()=>performance.now(),wallClock=()=>Date.now(),delay=pause,
  queueWaitSeconds=DEFAULT_QUEUE_WAIT_SECONDS,transferWaitSeconds=DEFAULT_TRANSFER_WAIT_SECONDS
}={}) {
  const settings=directWaitSettings({mode:'direct',waitSeconds:seconds,queueWaitSeconds,transferWaitSeconds});
  if(seconds===0)return receipt;
  let latest=receipt,phase='queue',highestPhase=0;
  const started=clock(),totalDeadline=started+MAX_DIRECT_RESPONSE_SECONDS*1000;
  const deadlines={queue:started+settings.queueWaitSeconds*1000};
  const phaseDeadline=()=>deadlines[phase==='awaiting_start'?'queue':phase]??totalDeadline;
  const remaining=()=>Math.min(totalDeadline,phaseDeadline())-clock();
  const stop=state=>({...latest,waitStatus:state,waitPhase:clock()>=totalDeadline?'total':phase});
  // Fixed work bound also handles stalled/backwards test or platform clocks.
  for(let read=0;read<=MAX_DIRECT_RESPONSE_SECONDS;read++) {
    if(signal?.aborted)return stop('interrupted');
    try {
      // One final read at a stage boundary observes transitions that occurred
      // between polls. It has its own one-second read cap, never extra total time.
      const readBudget=remaining()>0?remaining():Math.min(POLL_INTERVAL_MS,totalDeadline-clock());
      const state=await boundedRead(()=>gateway.getRun({runId:receipt.runId}),readBudget,signal);
      if(state.state!=='value')return stop(state.state);
      const run=state.value;
      assertBridge(run?.runId===receipt.runId,'RUN_NOT_FOUND','Waited Run identity changed');
      if(signal?.aborted)return stop('interrupted');
      assertBridge(['QUEUED','RUNNING',...TERMINAL].includes(run.status),
        'RESULT_NOT_READY','Invalid Direct Run status');
      latest={...receipt,status:run.status};
      if(TERMINAL.has(run.status)) {
        // Evidence has a separate transfer budget but cannot reset total time.
        phase='result';deadlines.result??=Math.min(deadlines.output_transfer??Infinity,clock()+settings.transferWaitSeconds*1000);
        const evidence=await boundedRead(()=>gateway.getResult({runId:receipt.runId}),remaining(),signal);
        if(evidence.state!=='value')return stop(evidence.state);
        const result=evidence.value;
        assertBridge(result?.runId===receipt.runId&&result.status===run.status,
          'RESULT_NOT_READY','Waited result is not available');
        if(signal?.aborted)return stop('interrupted');
        return {...receipt,...result};
      }
      if(run.progress) {
        const p=run.progress,next=PHASES[p.phase],rank=Object.keys(PHASES).indexOf(p.phase)+1;
        assertBridge(next&&rank>=highestPhase&&Number.isSafeInteger(p.executionElapsedMs)&&p.executionElapsedMs>=0&&p.executionElapsedMs<=3_700_000&&
          Number.isSafeInteger(p.reportedAt)&&Number.isSafeInteger(p.phaseStartedAt)&&p.phaseStartedAt>=0&&p.phaseStartedAt<=p.reportedAt,
          'DIRECT_RUN_PROGRESS_INVALID','Invalid Direct Run progress');
        latest.progress={phase:p.phase,executionElapsedMs:p.executionElapsedMs,reportedAt:p.reportedAt,phaseStartedAt:p.phaseStartedAt};
        highestPhase=rank;phase=next;
        const observed=clock(),wall=wallClock();
        const elapsed=phase==='execution'?p.executionElapsedMs+Math.max(0,wall-p.reportedAt):Math.max(0,wall-p.phaseStartedAt);
        const limit=phase==='execution'?seconds:settings.transferWaitSeconds;
        // Repeated reports can shorten a deadline, never restart a stage.
        deadlines[phase]=Math.min(deadlines[phase]??Infinity,observed+Math.max(0,limit*1000-elapsed));
      } else if(!highestPhase) {
        // Claim time is not spawn time, including for older Hosts.
        phase=run.status==='RUNNING'?'awaiting_start':'queue';
      }
    } catch {
      return stop('unavailable');
    }
    const left=remaining();
    if(left<=0||read===MAX_DIRECT_RESPONSE_SECONDS)return stop('timed_out');
    // Timer and monotonic clocks can straddle a millisecond boundary. An
    // early wake must only finish sleeping, not trigger an extra state read.
    const nextReadAt=Math.min(clock()+POLL_INTERVAL_MS,totalDeadline,phaseDeadline());
    for(let wakes=0;clock()<nextReadAt;wakes++) {
      if(signal?.aborted)return stop('interrupted');
      if(wakes===64)return stop('timed_out');
      const before=clock();
      await delay(Math.max(1,Math.ceil(nextReadAt-before)),signal);
      if(signal?.aborted)return stop('interrupted');
      if(clock()<=before)return stop('timed_out');
    }
  }
  return stop('timed_out');
}
