import { assertBridge } from '../errors.mjs';
import { assertAuthenticatedPrincipal } from '../auth/principal.mjs';

const HOST=/^[A-Za-z0-9_.-]{1,128}$/;
const TOKEN=/^hp1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
const MAX_TTL_MS=30*60*1000;

function base64url(bytes) {
  let binary='';
  for(const value of bytes) binary+=String.fromCharCode(value);
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

function decodeBase64url(value) {
  assertBridge(
    typeof value==='string' &&
      value.length>=1 &&
      value.length<=4096 &&
      /^[A-Za-z0-9_-]+$/.test(value),
    'DIRECT_PAIRING_DENIED',
    'pairing capability encoding is invalid'
  );
  const padding='='.repeat((4-value.length%4)%4);
  let binary;
  try {
    binary=atob(value.replace(/-/g,'+').replace(/_/g,'/')+padding);
  } catch {
    assertBridge(false,'DIRECT_PAIRING_DENIED','pairing capability encoding is invalid');
  }
  const bytes=new Uint8Array(binary.length);
  for(let index=0;index<binary.length;index++) bytes[index]=binary.charCodeAt(index);
  return bytes;
}

async function signingKey(secret) {
  assertBridge(
    typeof secret==='string' && secret.length>=16 && secret.length<=4096,
    'DIRECT_PAIRING_CONFIG_INVALID',
    'pairing signing secret is invalid'
  );
  const context=new TextEncoder().encode(`bridge-direct-host-pairing-v1\0${secret}`);
  const digest=await globalThis.crypto.subtle.digest('SHA-256',context);
  return globalThis.crypto.subtle.importKey(
    'raw',
    digest,
    {name:'HMAC',hash:'SHA-256'},
    false,
    ['sign','verify']
  );
}

function parsePayload(bytes) {
  let value;
  try {
    value=JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    assertBridge(false,'DIRECT_PAIRING_DENIED','pairing capability payload is invalid');
  }
  assertBridge(
    value &&
      typeof value==='object' &&
      !Array.isArray(value) &&
      value.v===1 &&
      value.principal &&
      typeof value.principal==='object' &&
      !Array.isArray(value.principal) &&
      typeof value.hostId==='string' &&
      HOST.test(value.hostId) &&
      Number.isSafeInteger(value.iat) &&
      Number.isSafeInteger(value.exp) &&
      value.exp>value.iat &&
      value.exp-value.iat<=MAX_TTL_MS &&
      typeof value.nonce==='string' &&
      /^[A-Za-z0-9_-]{16,64}$/.test(value.nonce),
    'DIRECT_PAIRING_DENIED',
    'pairing capability payload is invalid'
  );
  const principal=assertAuthenticatedPrincipal(value.principal);
  return {...value,principal};
}

export class DirectPairingCodec {
  constructor({
    secret,
    clock=()=>Date.now(),
    randomBytes=size=>{
      const bytes=new Uint8Array(size);
      globalThis.crypto.getRandomValues(bytes);
      return bytes;
    }
  }={}) {
    assertBridge(typeof clock==='function','DIRECT_PAIRING_CONFIG_INVALID','clock required');
    assertBridge(typeof randomBytes==='function','DIRECT_PAIRING_CONFIG_INVALID','randomBytes required');
    this.secret=secret;
    this.clock=clock;
    this.randomBytes=randomBytes;
  }

  async issue({principal,hostId,ttlSeconds=600}={}) {
    const active=assertAuthenticatedPrincipal(principal);
    assertBridge(
      typeof hostId==='string' && HOST.test(hostId),
      'DIRECT_PAIRING_INVALID',
      'pairing hostId invalid'
    );
    assertBridge(
      Number.isInteger(ttlSeconds) && ttlSeconds>=60 && ttlSeconds<=1800,
      'DIRECT_PAIRING_INVALID',
      'pairing ttlSeconds must be 60-1800'
    );

    const now=this.clock();
    const payload=Object.freeze({
      v:1,
      principal:active,
      hostId,
      iat:now,
      exp:now+ttlSeconds*1000,
      nonce:base64url(this.randomBytes(16))
    });
    const bytes=new TextEncoder().encode(JSON.stringify(payload));
    const key=await signingKey(this.secret);
    const signature=new Uint8Array(
      await globalThis.crypto.subtle.sign('HMAC',key,bytes)
    );
    return Object.freeze({
      token:`hp1.${base64url(bytes)}.${base64url(signature)}`,
      expiresAt:payload.exp
    });
  }

  async verify(token) {
    assertBridge(
      typeof token==='string' && token.length<=1024,
      'DIRECT_PAIRING_DENIED',
      'pairing capability is invalid'
    );
    const match=TOKEN.exec(token);
    assertBridge(match,'DIRECT_PAIRING_DENIED','pairing capability is invalid');
    const payloadBytes=decodeBase64url(match[1]);
    const signature=decodeBase64url(match[2]);
    const key=await signingKey(this.secret);
    const valid=await globalThis.crypto.subtle.verify(
      'HMAC',
      key,
      signature,
      payloadBytes
    );
    assertBridge(valid,'DIRECT_PAIRING_DENIED','pairing capability signature is invalid');
    const payload=parsePayload(payloadBytes);
    const now=this.clock();
    assertBridge(
      payload.iat<=now+60_000 && payload.exp>now,
      'DIRECT_PAIRING_DENIED',
      'pairing capability is expired or not yet valid'
    );
    return Object.freeze({
      principal:payload.principal,
      hostId:payload.hostId,
      issuedAt:payload.iat,
      expiresAt:payload.exp
    });
  }
}
