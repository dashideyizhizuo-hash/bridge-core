import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { boundedOriginFetch } from './host-http.mjs';
import { resolve } from 'node:path';
import { readJsonFile } from './json.mjs';
import { BridgeError, assertBridge, errorEnvelope } from './errors.mjs';
import { executeDirectExec, resolveDirectExecPlan, validateDirectExecRequest } from './direct-exec.mjs';
import { cleanupDirectAssetCache, stageDirectAssets } from './direct-runner-assets.mjs';
import {
  cleanupDirectExportCache,
  collectDirectExports,
  prepareDirectExportPaths
} from './direct-runner-exports.mjs';
import { validateHostPolicy } from './validate.mjs';
import {
  ambiguousReplayResult,
  cleanupDirectJournal,
  inspectDirectJournal,
  markDirectJournalCompleted,
  markDirectJournalStarted
} from './direct-runner-journal.mjs';

function requiredString(value,label,{max=4096}={}) {
  if(typeof value!=='string' || value.length<1 || value.length>max) {
    throw new TypeError(`${label} is required`);
  }
  return value;
}

function endpointUrl(value) {
  const url=new URL(requiredString(value,'Direct Exec endpoint'));
  if(
    url.protocol!=='https:' &&
    !(url.protocol==='http:' && ['localhost','127.0.0.1'].includes(url.hostname))
  ) {
    throw new TypeError('Direct Exec endpoint must be HTTPS');
  }
  if(url.username || url.password || url.search || url.hash) throw new TypeError('Direct Exec endpoint must not contain credentials, query or fragment');
  url.pathname=url.pathname.replace(/\/$/,'');
  url.search='';
  url.hash='';
  return url;
}

function runnerToken(value) {
  const token=requiredString(value,'BRIDGE_DIRECT_RUNNER_TOKEN',{max:512});
  if(!/^[A-Za-z0-9._~-]{32,512}$/.test(token)) throw new TypeError('runner token format is invalid');
  return token;
}

function headers(token) {
  return {
    authorization:`Bearer ${token}`,
    'content-type':'application/json',
    accept:'application/json'
  };
}

async function parseResponse(response,label) {
  const text=await response.text();
  if(!response.ok) {
    let parsed=null;
    try { parsed=JSON.parse(text); } catch {}
    const code=/^[A-Z][A-Z0-9_]{2,63}$/.test(parsed?.error?.code ?? '') ? parsed.error.code : null;
    const error=new Error(`${label} failed with HTTP ${response.status}${code ? ` (${code})` : ''}`);
    error.status=response.status;
    error.bridgeCode=code;
    if(code) error.code=code;
    throw error;
  }
  if(text.length===0) return null;
  try { return JSON.parse(text); }
  catch(error) {
    const invalid=new BridgeError('DIRECT_RUN_RESPONSE_INVALID',`${label} returned invalid JSON`);
    invalid.cause=error;throw invalid;
  }
}

export async function claimDirectRun({
  endpoint,
  hostId,
  token,
  leaseOwner,
  leaseMs=90_000,
  fetchImpl=globalThis.fetch,
  signal,
  timeoutMs=15_000
}={}) {
  const base=endpointUrl(endpoint);
  const response=await boundedOriginFetch(base.origin,{fetchImpl,signal,timeoutMs})(new URL('/direct/runner/claim',base.origin),{
    method:'POST',
    headers:headers(runnerToken(token)),
    body:JSON.stringify({hostId,leaseOwner,leaseMs})
  });
  if(response.status===204) return null;
  return parseResponse(response,'direct claim');
}

export async function heartbeatDirectRun({
  endpoint,
  hostId,
  token,
  leaseOwner,
  runId,
  leaseMs=90_000,
  fetchImpl=globalThis.fetch,
  signal,
  timeoutMs=15_000
}={}) {
  const base=endpointUrl(endpoint);
  const response=await boundedOriginFetch(base.origin,{fetchImpl,signal,timeoutMs})(new URL('/direct/runner/heartbeat',base.origin),{
    method:'POST',
    headers:headers(runnerToken(token)),
    body:JSON.stringify({hostId,leaseOwner,runId,leaseMs})
  });
  return parseResponse(response,'direct heartbeat');
}

export async function completeDirectRun({
  endpoint,
  hostId,
  token,
  leaseOwner,
  runId,
  result,
  fetchImpl=globalThis.fetch,
  signal,
  timeoutMs=15_000
}={}) {
  const base=endpointUrl(endpoint);
  const response=await boundedOriginFetch(base.origin,{fetchImpl,signal,timeoutMs})(new URL('/direct/runner/complete',base.origin),{
    method:'POST',
    headers:headers(runnerToken(token)),
    body:JSON.stringify({hostId,leaseOwner,runId,result})
  });
  return parseResponse(response,'direct complete');
}

export async function uploadDirectExport({
  endpoint,
  hostId,
  token,
  leaseOwner,
  runId,
  item,
  fetchImpl=globalThis.fetch,
  signal,
  timeoutMs=60_000
}={}) {
  assertBridge(
    item &&
      typeof item==='object' &&
      Number.isInteger(item.index) &&
      item.index>=0 &&
      item.index<8 &&
      Buffer.isBuffer(item.bytes) &&
      item.bytes.length>=1 &&
      typeof item.sha256==='string' &&
      /^[0-9a-f]{64}$/.test(item.sha256),
    'DIRECT_EXPORT_INVALID',
    'Direct export upload item invalid'
  );
  const base=endpointUrl(endpoint);
  const response=await boundedOriginFetch(base.origin,{
    fetchImpl,
    signal,
    timeoutMs,
    maxBytes:256*1024
  })(new URL(
    '/direct/runner/exports/'+encodeURIComponent(runId)+'/'+item.index,
    base.origin
  ),{
    method:'PUT',
    headers:{
      authorization:`Bearer ${runnerToken(token)}`,
      'content-type':item.mimeType,
      'content-length':String(item.bytes.length),
      'x-bridge-host-id':hostId,
      'x-bridge-lease-owner':leaseOwner,
      'x-bridge-sha256':item.sha256,
      accept:'application/json'
    },
    body:item.bytes
  });
  return parseResponse(response,'direct export');
}

function failedResult(request,error,reason=error) {
  const trustedError=reason instanceof BridgeError ? reason :
    (typeof reason?.bridgeCode==='string' && reason.bridgeCode.length>0
      ? new BridgeError(reason.bridgeCode,reason.message) : reason);
  const {code,message}=errorEnvelope(trustedError);
  // Structured evidence is already top-level; do not serialize it twice.
  const envelope={code,message};
  const details=
    error?.details &&
    typeof error.details==='object' &&
    !Array.isArray(error.details) &&
    error.details.requestId===request.requestId &&
    error.details.hostId===request.hostId
      ? error.details
      : null;
  return {
    ...(details ?? {
      schemaVersion:1,
      transport:'direct',
      requestId:request.requestId,
      hostId:request.hostId,
      evidence:{stdout:'',stderr:''},
      startedAt:new Date().toISOString(),
      completedAt:new Date().toISOString()
    }),
    status:'FAILED',
    error:envelope
  };
}

function authFatal(error) {
  return error?.status===401 || error?.status===403;
}

function ownerPaused(error) {
  return [403,409,423].includes(error?.status) && error?.code==='DIRECT_HOST_PAUSED';
}

function startHeartbeat({
  endpoint,hostId,token,leaseOwner,runId,leaseMs,heartbeatMs,
  controller,fetchImpl,onContact,claimStartedAt
}) {
  let stopped=false,busy=false,fatalError=null,deadline;
  const stopController=new AbortController();
  const signal=AbortSignal.any([controller.signal,stopController.signal]);
  const expire=()=>{
    if(stopped || controller.signal.aborted) return;
    fatalError=new BridgeError('DIRECT_RUN_LEASE_UNCERTAIN',
      'Direct Run heartbeat lost near lease expiry; stopping local execution');
    controller.abort(fatalError);
  };
  const arm=sentAt=>{
    clearTimeout(deadline);
    // Start at dispatch: response latency must not extend a remote lease.
    const remaining=Math.max(5_000,leaseMs-10_000)-(performance.now()-sentAt);
    if(remaining<=0) return expire();
    deadline=setTimeout(expire,remaining);deadline.unref?.();
  };
  arm(claimStartedAt);
  const tick=async()=>{
    if(stopped || busy || controller.signal.aborted) return;
    busy=true;
    const sentAt=performance.now();
    try {
      await heartbeatDirectRun({endpoint,hostId,token,leaseOwner,runId,leaseMs,fetchImpl,signal});
      if(!stopped && !controller.signal.aborted) {arm(sentAt);onContact();}
    } catch(error) {
      if(!stopped && !controller.signal.aborted && (authFatal(error) || ownerPaused(error) || error?.status===409)) {
        fatalError=error;controller.abort(error);
      }
      // Independent deadline still fires while a fetch is pending or busy.
    } finally {busy=false;}
  };
  const timer=setInterval(()=>{void tick();},heartbeatMs);timer.unref?.();
  return {
    stop() {stopped=true;clearInterval(timer);clearTimeout(deadline);stopController.abort();},
    fatalError:()=>fatalError
  };
}

export async function runDirectRunnerOnce({
  endpoint,token,hostPolicyPath,leaseOwner=`runner:${randomUUID()}`,
  leaseMs=90_000,heartbeatMs=20_000,fetchImpl=globalThis.fetch,signal,onContact=()=>{}
}={}) {
  if(!Number.isInteger(leaseMs) || leaseMs<30_000 || leaseMs>300_000) throw new TypeError('leaseMs invalid');
  if(!Number.isInteger(heartbeatMs) || heartbeatMs<1_000 || heartbeatMs>=leaseMs/2) throw new TypeError('heartbeatMs invalid');
  signal?.throwIfAborted();
  const hostPolicy=validateHostPolicy(readJsonFile(resolve(hostPolicyPath),'host policy'));
  const hostId=hostPolicy.host.id;
  const claimStartedAt=performance.now();
  const claimed=await claimDirectRun({endpoint,hostId,token,leaseOwner,leaseMs,fetchImpl,signal});
  onContact();
  if(claimed===null) return {status:'IDLE',hostId};
  signal?.throwIfAborted();
  const request=validateDirectExecRequest(claimed.request);
  assertBridge(request.hostId===hostId && hostPolicy.directExec?.enabled===true,
    'DIRECT_EXEC_DENIED','Direct claim does not match the enabled local host');
  let journal=inspectDirectJournal({hostPolicy,request});
  let result,assetFailure=false,exportItems=[];
  const controller=new AbortController();
  const lifecycleSignal=signal ? AbortSignal.any([controller.signal,signal]) : controller.signal;
  const heartbeat=startHeartbeat({endpoint,hostId,token,leaseOwner:claimed.leaseOwner,runId:claimed.runId,
    leaseMs,heartbeatMs,controller,fetchImpl,onContact,claimStartedAt});
  try {
    if(journal.state==='COMPLETED') {
      result=journal.result;
      if(result.status==='SUCCEEDED' && (request.exports?.length ?? 0)>0) {
        exportItems=collectDirectExports({
          request,
          exportPaths:prepareDirectExportPaths({hostPolicy,request,reset:false})
        });
      }
    } else if(journal.state==='AMBIGUOUS') {
      result=ambiguousReplayResult(request);
      markDirectJournalCompleted({hostPolicy,request,result});
    } else {
      let preparingAssets=false;
      try {
        lifecycleSignal.throwIfAborted();
        resolveDirectExecPlan({request,hostPolicy});
        preparingAssets=true;
        const assetPaths=await stageDirectAssets({
          endpoint,
          token,
          hostId,
          runId:claimed.runId,
          leaseOwner:claimed.leaseOwner,
          hostPolicy,
          assets:request.assets ?? [],
          fetchImpl,
          signal:lifecycleSignal
        });
        preparingAssets=false;
        lifecycleSignal.throwIfAborted();
        // Acquire the exclusive start marker immediately before command side effects.
        journal=markDirectJournalStarted({hostPolicy,request});
        if(journal.state==='COMPLETED') {
          result=journal.result;
          if(result.status==='SUCCEEDED' && (request.exports?.length ?? 0)>0) {
            exportItems=collectDirectExports({
              request,
              exportPaths:prepareDirectExportPaths({hostPolicy,request,reset:false})
            });
          }
        } else if(journal.state==='AMBIGUOUS') {
          result=ambiguousReplayResult(request);
        } else {
          const exportPaths=prepareDirectExportPaths({hostPolicy,request,reset:true});
          result=await executeDirectExec({
            request,
            requestBytes:Buffer.from(JSON.stringify(request),'utf8'),
            hostPolicy,
            signal:lifecycleSignal,
            assetPaths,
            exportPaths
          });
          if(result.status==='SUCCEEDED' && exportPaths.length>0) {
            exportItems=collectDirectExports({request,exportPaths});
          }
        }
      } catch(error) {
        assetFailure=preparingAssets;
        if(ownerPaused(error))controller.abort(error);
        result=failedResult(request,error,heartbeat.fatalError() ?? error);
        exportItems=[];
      }
      result=markDirectJournalCompleted({hostPolicy,request,result}).result;
    }

    // Upload only files from declared, Bridge-owned export slots while the
    // lease is still current. A network failure leaves the local journal and
    // slot intact so a later authorized replay can retry idempotently.
    if(result.status==='SUCCEEDED' && exportItems.length>0) {
      const exports=[];
      for(const item of exportItems) {
        lifecycleSignal.throwIfAborted();
        exports.push(await uploadDirectExport({
          endpoint,
          hostId,
          token,
          leaseOwner:claimed.leaseOwner,
          runId:claimed.runId,
          item,
          fetchImpl,
          signal:lifecycleSignal
        }));
      }
      result={...result,exports};
    }

    // Preserve durable evidence, but never begin/continue uploading under a
    // revoked or expired lease. A later authorized claim replays this result.
    lifecycleSignal.throwIfAborted();
    await completeDirectRun({endpoint,hostId,token,leaseOwner:claimed.leaseOwner,
      runId:claimed.runId,result,fetchImpl,signal:lifecycleSignal});
    return {status:result.status,hostId,runId:claimed.runId,requestId:request.requestId,
      replayed:journal.state==='COMPLETED',...(assetFailure ? {assetFailure:true} : {})};
  } finally {heartbeat?.stop();}
}

export async function runDirectRunnerLoop({
  endpoint,
  token,
  hostPolicyPath,
  pollMs=15_000,
  leaseMs=90_000,
  heartbeatMs=20_000,
  maintenanceIntervalMs=60*60*1000,
  once=false,
  fetchImpl=globalThis.fetch,
  signal,
  sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  clock=()=>Date.now(),
  onContact=()=>{},
  onError=error=>process.stderr.write(
    JSON.stringify({
      level:'error',
      component:'bridge-direct-runner',
      message:error?.message ?? String(error),
      status:error?.status ?? null,
      code:error?.bridgeCode ?? error?.code ?? null
    })+'\n'
  )
}={}) {
  if(!Number.isInteger(pollMs) || pollMs<1_000 || pollMs>60_000) throw new TypeError('pollMs invalid');
  if(
    !Number.isInteger(maintenanceIntervalMs) ||
    maintenanceIntervalMs<60_000 ||
    maintenanceIntervalMs>24*60*60*1000
  ) throw new TypeError('maintenanceIntervalMs invalid');
  if(typeof clock!=='function') throw new TypeError('clock invalid');

  const leaseOwner=`runner:${randomUUID()}`;
  const hostPolicy=validateHostPolicy(readJsonFile(resolve(hostPolicyPath),'host policy'));
  const maintain=()=>{
    cleanupDirectJournal({hostPolicy,now:clock()});
    cleanupDirectAssetCache({hostPolicy,now:clock()});
    cleanupDirectExportCache({hostPolicy,now:clock()});
  };
  maintain();
  let nextMaintenanceAt=clock()+maintenanceIntervalMs;

  const pause=async ms=>{
    if(!signal) return sleep(ms);
    if(signal.aborted) return;
    await new Promise(resolve=>{
      const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};
      const timer=setTimeout(done,ms);signal.addEventListener('abort',done,{once:true});
    });
  };
  let backoffMs=1_000,lastActivityAt=clock();
  const idleDelay=()=>{
    // Completed work, not successful empty claims or network retries, renews
    // the hot window. Cap the exponent before multiplying configurable input.
    const window=Math.min(6,Math.max(0,Math.floor((clock()-lastActivityAt)/300_000)));
    return Math.min(60_000,pollMs*(2**window));
  };
  while(!signal?.aborted) {
    try {
      if(clock()>=nextMaintenanceAt) {
        maintain();
        nextMaintenanceAt=clock()+maintenanceIntervalMs;
      }
      const result=await runDirectRunnerOnce({
        endpoint,token,hostPolicyPath,leaseOwner,leaseMs,heartbeatMs,fetchImpl,signal,onContact
      });
      backoffMs=1_000;
      if(once) return result;
      if(result.status==='IDLE') {
        await pause(idleDelay());
      } else lastActivityAt=clock(); // Completed work immediately claims again.
    } catch(error) {
      if(signal?.aborted) break;
      if(ownerPaused(error)) {
        // Only the authenticated, explicit owner-pause response is recoverable
        // without process restart. Bad/rotated credentials still fail closed.
        onContact();backoffMs=1_000;
        if(once)return {status:'PAUSED',hostId:hostPolicy.host.id};
        await pause(Math.max(pollMs,60_000));
        continue;
      }
      onError(error);
      if(once || authFatal(error)) throw error;
      await pause(backoffMs);
      backoffMs=Math.min(30_000,backoffMs*2);
    }
  }
  return {status:'STOPPED',hostId:hostPolicy.host.id};
}
