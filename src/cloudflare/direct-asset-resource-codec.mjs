import { assertBridge } from '../errors.mjs';
import { assertAuthenticatedPrincipal } from '../auth/principal.mjs';

const ASSET=/^asset-[A-Za-z0-9_-]{8,160}$/;
const TOKEN=/^bf1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;
const DEFAULT_TTL_SECONDS=15*60;
const MAX_TTL_SECONDS=60*60;

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
    'DIRECT_ASSET_RESOURCE_DENIED',
    'file resource capability encoding is invalid'
  );
  const padding='='.repeat((4-value.length%4)%4);
  let binary;
  try {
    binary=atob(value.replace(/-/g,'+').replace(/_/g,'/')+padding);
  } catch {
    assertBridge(false,'DIRECT_ASSET_RESOURCE_DENIED','file resource capability encoding is invalid');
  }
  const bytes=new Uint8Array(binary.length);
  for(let index=0;index<binary.length;index++) bytes[index]=binary.charCodeAt(index);
  return bytes;
}

async function signingKey(secret) {
  assertBridge(
    typeof secret==='string' && secret.length>=16 && secret.length<=4096,
    'DIRECT_ASSET_RESOURCE_CONFIG_INVALID',
    'file resource signing secret is invalid'
  );
  const context=new TextEncoder().encode('bridge-direct-file-resource-v1\0'+secret);
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
    assertBridge(false,'DIRECT_ASSET_RESOURCE_DENIED','file resource capability payload is invalid');
  }
  assertBridge(
    value &&
      typeof value==='object' &&
      !Array.isArray(value) &&
      value.v===1 &&
      typeof value.bridgeUserId==='string' &&
      value.bridgeUserId.length>=1 &&
      value.bridgeUserId.length<=128 &&
      typeof value.assetId==='string' &&
      ASSET.test(value.assetId) &&
      Number.isSafeInteger(value.iat) &&
      Number.isSafeInteger(value.exp) &&
      value.exp>value.iat &&
      value.exp-value.iat<=MAX_TTL_SECONDS*1000 &&
      typeof value.nonce==='string' &&
      /^[A-Za-z0-9_-]{16,64}$/.test(value.nonce),
    'DIRECT_ASSET_RESOURCE_DENIED',
    'file resource capability payload is invalid'
  );
  return value;
}

export class DirectAssetResourceCodec {
  constructor({
    secret,
    clock=()=>Date.now(),
    randomBytes=size=>{
      const bytes=new Uint8Array(size);
      globalThis.crypto.getRandomValues(bytes);
      return bytes;
    }
  }={}) {
    assertBridge(typeof clock==='function','DIRECT_ASSET_RESOURCE_CONFIG_INVALID','clock required');
    assertBridge(typeof randomBytes==='function','DIRECT_ASSET_RESOURCE_CONFIG_INVALID','randomBytes required');
    this.secret=secret;
    this.clock=clock;
    this.randomBytes=randomBytes;
  }

  async issue({principal,assetId,ttlSeconds=DEFAULT_TTL_SECONDS}={}) {
    const active=assertAuthenticatedPrincipal(principal);
    assertBridge(
      typeof assetId==='string' && ASSET.test(assetId),
      'DIRECT_ASSET_RESOURCE_INVALID',
      'assetId invalid'
    );
    assertBridge(
      Number.isInteger(ttlSeconds) && ttlSeconds>=60 && ttlSeconds<=MAX_TTL_SECONDS,
      'DIRECT_ASSET_RESOURCE_INVALID',
      'resource ttlSeconds must be 60-3600'
    );
    const now=this.clock();
    const payload=Object.freeze({
      v:1,
      bridgeUserId:active.bridgeUserId,
      assetId,
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
      token:'bf1.'+base64url(bytes)+'.'+base64url(signature),
      assetId,
      expiresAt:payload.exp
    });
  }

  async verify({principal,token}={}) {
    const active=assertAuthenticatedPrincipal(principal);
    assertBridge(
      typeof token==='string' && token.length<=2048,
      'DIRECT_ASSET_RESOURCE_DENIED',
      'file resource capability is invalid'
    );
    const match=TOKEN.exec(token);
    assertBridge(match,'DIRECT_ASSET_RESOURCE_DENIED','file resource capability is invalid');
    const payloadBytes=decodeBase64url(match[1]);
    const signature=decodeBase64url(match[2]);
    const key=await signingKey(this.secret);
    const valid=await globalThis.crypto.subtle.verify('HMAC',key,signature,payloadBytes);
    assertBridge(valid,'DIRECT_ASSET_RESOURCE_DENIED','file resource capability signature is invalid');
    const payload=parsePayload(payloadBytes);
    const now=this.clock();
    assertBridge(
      payload.iat<=now+60_000 && payload.exp>now,
      'DIRECT_ASSET_RESOURCE_DENIED',
      'file resource capability is expired or not yet valid'
    );
    assertBridge(
      payload.bridgeUserId===active.bridgeUserId,
      'DIRECT_ASSET_RESOURCE_DENIED',
      'file resource capability belongs to another Bridge principal'
    );
    return Object.freeze({
      assetId:payload.assetId,
      issuedAt:payload.iat,
      expiresAt:payload.exp
    });
  }
}
