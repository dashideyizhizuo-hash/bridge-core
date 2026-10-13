import { assertBridge } from './errors.mjs';

export const MAX_DIRECT_WAIT_SECONDS=10;
const TERMINAL=new Set(['SUCCEEDED','FAILED','CANCELED']);
const POLL_INTERVAL_MS=1000;

export function directWaitSeconds(args) {
  if(args?.waitSeconds===undefined)return 0;
  assertBridge(args.mode==='direct' && Number.isInteger(args.waitSeconds) &&
    args.waitSeconds>=0 && args.waitSeconds<=MAX_DIRECT_WAIT_SECONDS,
    'INVALID_GATEWAY_REQUEST','waitSeconds is supported only for Direct Exec, as an integer from 0 to 10');
  return args.waitSeconds;
}

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
  // A provider read cannot necessarily be canceled. Observe its late rejection
  // without exposing late output or issuing more reads after this wait ends.
  const read=Promise.resolve().then(operation).then(
    value=>({state:'value',value}),()=>({state:'unavailable'})
  );
  try{return await Promise.race([read,stopped]);}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
}

// Wait above the gateway decorators: commercial admission must bind the Run
// before a Host can claim it. Reads reuse the same principal-scoped gateway.
// A canceled HTTP wait never cancels or re-submits the durable execution.
export async function waitForDirectResult(gateway,receipt,seconds,{
  signal,clock=()=>performance.now(),delay=pause
}={}) {
  assertBridge(Number.isInteger(seconds)&&seconds>=0&&seconds<=MAX_DIRECT_WAIT_SECONDS,
    'INVALID_GATEWAY_REQUEST','Invalid Direct wait window');
  if(seconds===0)return receipt;
  let latest=receipt;
  const deadline=clock()+seconds*1000;
  // A fixed read budget also bounds work if a clock stalls or moves backwards.
  for(let read=0;read<=MAX_DIRECT_WAIT_SECONDS;read++) {
    if(signal?.aborted)return {...latest,waitStatus:'interrupted'};
    try {
      const state=await boundedRead(()=>gateway.getRun({runId:receipt.runId}),deadline-clock(),signal);
      if(state.state!=='value')return {...latest,waitStatus:state.state};
      const run=state.value;
      assertBridge(run?.runId===receipt.runId,'RUN_NOT_FOUND','Waited Run identity changed');
      if(signal?.aborted)return {...latest,waitStatus:'interrupted'};
      latest={...receipt,status:run.status};
      if(TERMINAL.has(run.status)) {
        const evidence=await boundedRead(()=>gateway.getResult({runId:receipt.runId}),deadline-clock(),signal);
        if(evidence.state!=='value')return {...latest,waitStatus:evidence.state};
        const result=evidence.value;
        assertBridge(result?.runId===receipt.runId && result.status===run.status,
          'RESULT_NOT_READY','Waited result is not available');
        if(signal?.aborted)return {...latest,waitStatus:'interrupted'};
        return {...receipt,...result};
      }
    } catch {
      // Preserve the admitted identity on a read/authorization failure. Do not
      // disclose output, internal errors or invite submission of a second Run.
      return {...latest,waitStatus:'unavailable'};
    }
    const remaining=deadline-clock();
    if(remaining<=0 || read===MAX_DIRECT_WAIT_SECONDS)return {...latest,waitStatus:'timed_out'};
    await delay(Math.min(POLL_INTERVAL_MS,remaining),signal);
  }
  return latest;
}
