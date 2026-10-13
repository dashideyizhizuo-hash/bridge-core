import { readBoundedText } from './request-body.mjs';
import { BridgeError, errorEnvelope } from '../errors.mjs';

export const DIRECT_ADMIN_REGISTER_HOST_PATH='/direct/admin/register-host';
export const DIRECT_ADMIN_SET_HOST_ENABLED_PATH='/direct/admin/set-host-enabled';

function bearer(request) {
  const raw=request.headers.get('authorization');
  const match=typeof raw==='string' ? /^Bearer (.{32,1024})$/.exec(raw) : null;
  return match ? match[1] : null;
}

function constantTimeEqual(left,right) {
  if(typeof left!=='string' || typeof right!=='string') return false;
  const a=new TextEncoder().encode(left);
  const b=new TextEncoder().encode(right);
  let diff=a.length^b.length;
  const length=Math.max(a.length,b.length);
  for(let index=0;index<length;index++) {
    diff|=(a[index%a.length]??0)^(b[index%b.length]??0);
  }
  return diff===0;
}

function base64url(bytes) {
  let binary='';
  for(const value of bytes) binary+=String.fromCharCode(value);
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

async function sha256Hex(value) {
  const digest=await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value)
  );
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
}

async function body(request) {
  const raw=await readBoundedText(request,{maxBytes:64*1024,code:'DIRECT_HOST_INVALID'});
  try {
    const value=JSON.parse(raw);
    if(!value || typeof value!=='object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    const error=new BridgeError('DIRECT_HOST_INVALID','request body must be a JSON object');
    throw error;
  }
}

async function principalFor(identityStore,bridgeUserId) {
  const principal=await identityStore.resolvePrincipalById(bridgeUserId);
  if(!principal) {
    const error=new Error('Bridge principal not found');
    error.code='DIRECT_HOST_INVALID';
    throw error;
  }
  return principal;
}

export function createDirectAdminHandler({
  store,
  identityStore,
  adminToken
}={}) {
  if(
    !store ||
    typeof store.registerHost!=='function' ||
    typeof store.setHostEnabled!=='function'
  ) throw new TypeError('Direct Exec store is required');
  if(!identityStore || typeof identityStore.resolvePrincipalById!=='function') {
    throw new TypeError('identityStore is required');
  }
  if(typeof adminToken!=='string' || adminToken.length<32) {
    throw new TypeError('Direct Exec admin token must contain at least 32 characters');
  }

  return Object.freeze({
    async fetch(request) {
      const url=new URL(request.url);
      if(
        url.pathname!==DIRECT_ADMIN_REGISTER_HOST_PATH &&
        url.pathname!==DIRECT_ADMIN_SET_HOST_ENABLED_PATH
      ) return new Response('Not found',{status:404});
      if(request.method!=='POST') return new Response('Method not allowed',{status:405});

      const supplied=bearer(request);
      if(!constantTimeEqual(supplied,adminToken)) {
        return Response.json(
          {error:{code:'DIRECT_ADMIN_DENIED',message:'Direct Exec admin authorization failed'}},
          {status:403,headers:{'cache-control':'no-store'}}
        );
      }

      try {
        const input=await body(request);
        const principal=await principalFor(identityStore,input.bridgeUserId);

        if(url.pathname===DIRECT_ADMIN_SET_HOST_ENABLED_PATH) {
          if(typeof input.enabled!=='boolean') {
            const error=new Error('enabled boolean is required');
            error.code='DIRECT_HOST_INVALID';
            throw error;
          }
          const updated=await store.setHostEnabled({
            principal,
            hostId:input.hostId,
            enabled:input.enabled
          });
          return Response.json(updated,{headers:{'cache-control':'no-store'}});
        }

        const bytes=new Uint8Array(32);
        globalThis.crypto.getRandomValues(bytes);
        const runnerToken=base64url(bytes);
        const runnerTokenSha256=await sha256Hex(runnerToken);
        const registered=await store.registerHost({
          principal,
          hostId:input.hostId,
          runnerTokenSha256,
          enabled:input.enabled ?? true
        });
        return Response.json(
          {...registered,runnerToken},
          {headers:{'cache-control':'no-store'}}
        );
      } catch(error) {
        return Response.json(
          {error:errorEnvelope(error)},
          {status:400,headers:{'cache-control':'no-store'}}
        );
      }
    }
  });
}
