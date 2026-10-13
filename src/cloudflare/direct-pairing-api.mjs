import { readBoundedText } from './request-body.mjs';
import { BridgeError, errorEnvelope } from '../errors.mjs';

export const DIRECT_ENROLL_CLAIM_PATH='/direct/enroll/claim';

function bearer(request) {
  const raw=request.headers.get('authorization');
  const match=typeof raw==='string'
    ? /^Bearer ([A-Za-z0-9._~-]{32,1024})$/.exec(raw)
    : null;
  return match ? match[1] : null;
}

async function body(request) {
  const raw=await readBoundedText(request,{maxBytes:64*1024,code:'DIRECT_PAIRING_INVALID'});
  let value;
  try { value=JSON.parse(raw); }
  catch { throw new BridgeError('DIRECT_PAIRING_INVALID','pairing claim body must be JSON'); }
  if(!value || typeof value!=='object' || Array.isArray(value)) {
    throw new BridgeError('DIRECT_PAIRING_INVALID','pairing claim body must be an object');
  }
  const keys=Object.keys(value);
  if(
    keys.length!==1 ||
    keys[0]!=='runnerTokenSha256' ||
    typeof value.runnerTokenSha256!=='string' ||
    !/^[0-9a-f]{64}$/.test(value.runnerTokenSha256)
  ) {
    throw new BridgeError(
      'DIRECT_PAIRING_INVALID',
      'pairing claim accepts only runnerTokenSha256'
    );
  }
  return value;
}

function statusFor(error) {
  if(
    error?.code==='DIRECT_PAIRING_DENIED' ||
    error?.code==='DIRECT_HOST_DENIED'
  ) return 403;
  if(error?.code==='DIRECT_HOST_EXISTS') return 409;
  if(
    error?.code==='DIRECT_PAIRING_INVALID' ||
    error?.code==='DIRECT_HOST_INVALID'
  ) return 400;
  return 500;
}

export function createDirectPairingClaimHandler({
  pairingCodec,
  directExecStore
}={}) {
  if(!pairingCodec || typeof pairingCodec.verify!=='function') {
    throw new TypeError('Direct pairing codec is required');
  }
  if(!directExecStore || typeof directExecStore.registerHost!=='function') {
    throw new TypeError('Direct Exec store is required');
  }

  return Object.freeze({
    async fetch(request) {
      const url=new URL(request.url);
      if(url.pathname!==DIRECT_ENROLL_CLAIM_PATH) return new Response('Not found',{status:404});
      if(request.method!=='POST') return new Response('Method not allowed',{status:405});

      const pairingToken=bearer(request);
      if(pairingToken===null) {
        return Response.json(
          {error:{code:'DIRECT_PAIRING_DENIED',message:'pairing capability required'}},
          {status:401,headers:{'cache-control':'no-store'}}
        );
      }

      try {
        const input=await body(request);
        const pairing=await pairingCodec.verify(pairingToken);

        const registered=await directExecStore.registerHost({
          principal:pairing.principal,
          hostId:pairing.hostId,
          runnerTokenSha256:input.runnerTokenSha256,
          enabled:true,
          allowRotate:false
        });

        return Response.json(
          {
            paired:true,
            hostId:registered.hostId,
            enabled:registered.enabled
          },
          {headers:{'cache-control':'no-store'}}
        );
      } catch(error) {
        return Response.json(
          {error:errorEnvelope(error)},
          {status:statusFor(error),headers:{'cache-control':'no-store'}}
        );
      }
    }
  });
}
