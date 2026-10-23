import { readBoundedText } from './request-body.mjs';
import { BridgeError, errorEnvelope } from '../errors.mjs';
import {validateDirectRunProgress} from '../direct-run-progress.mjs';

export const DIRECT_RUNNER_CLAIM_PATH='/direct/runner/claim';
export const DIRECT_RUNNER_HEARTBEAT_PATH='/direct/runner/heartbeat';
export const DIRECT_RUNNER_COMPLETE_PATH='/direct/runner/complete';

function bearerToken(request) {
  const raw=request.headers.get('authorization');
  if(typeof raw!=='string') return null;
  const match=/^Bearer ([A-Za-z0-9._~-]{32,512})$/.exec(raw);
  return match ? match[1] : null;
}

async function sha256Hex(value) {
  const bytes=new TextEncoder().encode(value);
  const digest=await globalThis.crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
}

async function jsonBody(request,{maxBytes=1_600_000}={}) {
  const raw=await readBoundedText(request,{maxBytes,code:'DIRECT_RUN_INVALID'});
  try {
    const parsed=JSON.parse(raw);
    if(!parsed || typeof parsed!=='object' || Array.isArray(parsed)) throw new Error('object required');
    return parsed;
  } catch(error) {
    if(error?.code==='DIRECT_RUN_INVALID') throw error;
    const invalid=new BridgeError('DIRECT_RUN_INVALID','request body must be a JSON object');
    throw invalid;
  }
}

function statusFor(error,path) {
  if(error?.code==='DIRECT_RUNNER_DENIED') return 403;
  // Existing Hosts cancel active execution on 409; a claim's 423 is retryable
  // without the credential-failure daemon restart behavior.
  if(error?.code==='DIRECT_HOST_PAUSED') return path===DIRECT_RUNNER_CLAIM_PATH?423:409;
  if(error?.code==='DIRECT_RUN_STALE') return 409;
  if(error?.code==='DIRECT_RUN_PROGRESS_INVALID' || error?.code==='DIRECT_RUN_INVALID' || error?.code==='DIRECT_HOST_INVALID') return 400;
  return 500;
}

export function createDirectRunnerHandler({store,randomUUID=()=>globalThis.crypto.randomUUID()}={}) {
  if(
    !store ||
    typeof store.claimNext!=='function' ||
    typeof store.renewLease!=='function' ||
    typeof store.complete!=='function'
  ) {
    throw new TypeError('Direct Exec store is required');
  }
  if(typeof randomUUID!=='function') throw new TypeError('randomUUID is required');

  return Object.freeze({
    async fetch(request) {
      const url=new URL(request.url);
      if(request.method!=='POST') return new Response('Method not allowed',{status:405});

      const token=bearerToken(request);
      if(token===null) {
        return Response.json(
          {error:{code:'DIRECT_RUNNER_DENIED',message:'runner bearer token is required'}},
          {status:401,headers:{'cache-control':'no-store'}}
        );
      }
      const runnerTokenSha256=await sha256Hex(token);

      try {
        if(url.pathname===DIRECT_RUNNER_CLAIM_PATH) {
          const body=await jsonBody(request,{maxBytes:64*1024});
          const leaseOwner=
            typeof body.leaseOwner==='string'
              ? body.leaseOwner
              : `runner:${randomUUID()}`;
          const claimed=await store.claimNext({
            hostId:body.hostId,
            runnerTokenSha256,
            leaseOwner,
            leaseMs:body.leaseMs
          });
          if(claimed===null) {
            return new Response(null,{
              status:204,
              headers:{
                'cache-control':'no-store',
                'retry-after':'5'
              }
            });
          }
          return Response.json(claimed,{headers:{'cache-control':'no-store'}});
        }

        if(url.pathname===DIRECT_RUNNER_HEARTBEAT_PATH) {
          const body=await jsonBody(request,{maxBytes:64*1024});
          const renewed=await store.renewLease({
            hostId:body.hostId,
            runnerTokenSha256,
            leaseOwner:body.leaseOwner,
            runId:body.runId,
            leaseMs:body.leaseMs,
            ...(body.progress===undefined?{}:{progress:validateDirectRunProgress(body.progress)})
          });
          return Response.json(renewed,{headers:{'cache-control':'no-store'}});
        }

        if(url.pathname===DIRECT_RUNNER_COMPLETE_PATH) {
          const body=await jsonBody(request);
          const completed=await store.complete({
            hostId:body.hostId,
            runnerTokenSha256,
            leaseOwner:body.leaseOwner,
            runId:body.runId,
            result:body.result
          });
          return Response.json(completed,{headers:{'cache-control':'no-store'}});
        }

        return new Response('Not found',{status:404});
      } catch(error) {
        return Response.json(
          {error:errorEnvelope(error)},
          {status:statusFor(error,url.pathname),headers:{'cache-control':'no-store'}}
        );
      }
    }
  });
}
