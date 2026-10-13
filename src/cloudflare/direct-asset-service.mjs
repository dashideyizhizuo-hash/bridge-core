import { assertBridge, BridgeError } from '../errors.mjs';
import { assertAuthenticatedPrincipal } from '../auth/principal.mjs';
import { DIRECT_ASSET_MAX_BYTES } from './d1-direct-asset-store.mjs';
import { readBoundedBody } from './request-body.mjs';
import { withDirectAssetBufferSlot } from './direct-asset-memory.mjs';

const DEFAULT_IMPORT_HOSTS=Object.freeze([
  'files.oaiusercontent.com',
  'files.openai.com'
]);

function base64url(bytes) {
  let binary='';
  for(const value of bytes) binary+=String.fromCharCode(value);
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

async function sha256HexBytes(bytes) {
  const digest=await globalThis.crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
}

async function sha256Hex(value) {
  return sha256HexBytes(new TextEncoder().encode(value));
}

function publicOrigin(value) {
  const url=value instanceof URL ? new URL(value.href) : new URL(value);
  assertBridge(url.protocol==='https:','DIRECT_ASSET_CONFIG_INVALID','Direct Asset public URL must be HTTPS');
  return url.origin;
}

function normalizeImportHosts(values) {
  const input=values ?? DEFAULT_IMPORT_HOSTS;
  assertBridge(Array.isArray(input) && input.length>=1 && input.length<=32,
    'DIRECT_ASSET_CONFIG_INVALID','Direct Asset import hosts invalid');
  return input.map(value=>{
    assertBridge(
      typeof value==='string' &&
        /^[A-Za-z0-9.-]{1,253}$/.test(value) &&
        !value.startsWith('.') &&
        !value.endsWith('.'),
      'DIRECT_ASSET_CONFIG_INVALID',
      'Direct Asset import host invalid'
    );
    return value.toLowerCase();
  });
}

function allowedImportUrl(value,hosts) {
  let url;
  try { url=new URL(value); }
  catch { throw new BridgeError('DIRECT_ASSET_IMPORT_DENIED','file download URL invalid'); }
  assertBridge(
    url.protocol==='https:' &&
      !url.username &&
      !url.password &&
      !url.hash,
    'DIRECT_ASSET_IMPORT_DENIED',
    'file download URL must use credential-free HTTPS'
  );
  const hostname=url.hostname.toLowerCase();
  assertBridge(
    hostname!=='localhost' &&
      !/^\d+(?:\.\d+){3}$/.test(hostname) &&
      !hostname.includes(':'),
    'DIRECT_ASSET_IMPORT_DENIED',
    'file download host invalid'
  );
  assertBridge(
    hosts.some(host=>hostname===host || hostname.endsWith('.'+host)),
    'DIRECT_ASSET_IMPORT_DENIED',
    'file download host is not approved by Bridge; an authorized deployment operator must review BRIDGE_FILE_IMPORT_HOSTS',
    // Diagnose platform file-delivery changes without exposing signed URLs.
    {hostname}
  );
  return url;
}

function openAiFile(value) {
  assertBridge(value && typeof value==='object' && !Array.isArray(value),
    'DIRECT_ASSET_IMPORT_DENIED','file parameter must be an object');
  const keys=new Set(['download_url','file_id','mime_type','file_name']);
  for(const key of Object.keys(value)) {
    assertBridge(keys.has(key),'DIRECT_ASSET_IMPORT_DENIED','unknown file parameter field: '+key);
  }
  assertBridge(
    typeof value.download_url==='string' && value.download_url.length>=8 && value.download_url.length<=8192,
    'DIRECT_ASSET_IMPORT_DENIED',
    'file download_url invalid'
  );
  assertBridge(
    typeof value.file_id==='string' && value.file_id.length>=1 && value.file_id.length<=512,
    'DIRECT_ASSET_IMPORT_DENIED',
    'file_id invalid'
  );
  if(value.mime_type!==undefined) {
    assertBridge(
      typeof value.mime_type==='string' && value.mime_type.length>=3 && value.mime_type.length<=192,
      'DIRECT_ASSET_IMPORT_DENIED',
      'file mime_type invalid'
    );
  }
  if(value.file_name!==undefined) {
    assertBridge(
      typeof value.file_name==='string' &&
        value.file_name.length>=1 &&
        value.file_name.length<=255 &&
        !value.file_name.includes('/') &&
        !value.file_name.includes('\\') &&
        !value.file_name.includes('\0'),
      'DIRECT_ASSET_IMPORT_DENIED',
      'file file_name invalid'
    );
  }
  return value;
}

function normalizedMime(value) {
  if(typeof value!=='string') return 'application/octet-stream';
  const mime=value.split(';',1)[0].trim().toLowerCase();
  return /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,127}$/.test(mime)
    ? mime
    : 'application/octet-stream';
}

async function fetchImportedBytes({
  url,
  fetchImpl,
  hosts,
  signal,
  maxRedirects=3
}) {
  let current=allowedImportUrl(url,hosts);
  for(let redirect=0;redirect<=maxRedirects;redirect++) {
    const response=await fetchImpl(current,{
      method:'GET',
      signal,
      redirect:'manual',
      headers:{accept:'application/octet-stream'}
    });
    if([301,302,303,307,308].includes(response.status)) {
      await response.body?.cancel().catch(()=>{});
      assertBridge(redirect<maxRedirects,'DIRECT_ASSET_IMPORT_DENIED','too many file download redirects');
      const location=response.headers.get('location');
      assertBridge(typeof location==='string' && location.length>0,
        'DIRECT_ASSET_IMPORT_DENIED','file download redirect missing location');
      current=allowedImportUrl(new URL(location,current).href,hosts);
      continue;
    }
    if(!response.ok) {
      await response.body?.cancel().catch(()=>{});
      throw new BridgeError('DIRECT_ASSET_IMPORT_FAILED','file download failed with HTTP '+response.status);
    }
    const bytes=await readBoundedBody(response,{
      maxBytes:DIRECT_ASSET_MAX_BYTES,signal,
      code:'DIRECT_ASSET_IMPORT_DENIED',
      message:'file exceeds Direct Asset size limit'
    });
    assertBridge(bytes.byteLength>=1,'DIRECT_ASSET_IMPORT_DENIED','file is empty');
    return {bytes,response};
  }
  throw new BridgeError('DIRECT_ASSET_IMPORT_DENIED','file download redirect limit exceeded');
}

export class DirectAssetService {
  constructor({
    store,
    bucket=null,
    resourceCodec=null,
    publicUrl,
    fetchImpl=globalThis.fetch,
    importHosts,
    randomUUID=()=>globalThis.crypto.randomUUID(),
    randomBytes=size=>{
      const bytes=new Uint8Array(size);
      globalThis.crypto.getRandomValues(bytes);
      return bytes;
    }
  }={}) {
    assertBridge(
      store &&
        typeof store.create==='function' &&
        typeof store.createReady==='function' &&
        typeof store.prepareReady==='function' &&
        typeof store.finalizePreparedReady==='function' &&
        typeof store.findReadyBySource==='function' &&
        typeof store.getOwnedReady==='function' &&
        typeof store.assertReady==='function' &&
        typeof store.getRun==='function' &&
        typeof store.getResult==='function',
      'DIRECT_ASSET_CONFIG_INVALID',
      'Direct Asset store is required'
    );
    assertBridge(
      bucket===null ||
        (typeof bucket.put==='function' && typeof bucket.get==='function' && typeof bucket.delete==='function'),
      'DIRECT_ASSET_CONFIG_INVALID',
      'Direct Asset R2 bucket invalid'
    );
    assertBridge(
      resourceCodec===null ||
        (typeof resourceCodec.issue==='function' && typeof resourceCodec.verify==='function'),
      'DIRECT_ASSET_CONFIG_INVALID',
      'Direct Asset resource codec invalid'
    );
    assertBridge(typeof fetchImpl==='function','DIRECT_ASSET_CONFIG_INVALID','fetchImpl required');
    assertBridge(typeof randomUUID==='function','DIRECT_ASSET_CONFIG_INVALID','randomUUID required');
    assertBridge(typeof randomBytes==='function','DIRECT_ASSET_CONFIG_INVALID','randomBytes required');
    this.store=store;
    this.bucket=bucket;
    this.resourceCodec=resourceCodec;
    this.origin=publicOrigin(publicUrl);
    this.fetchImpl=fetchImpl;
    this.importHosts=normalizeImportHosts(importHosts);
    this.randomUUID=randomUUID;
    this.randomBytes=randomBytes;
  }

  async createUpload({
    principal,
    fileName,
    mimeType,
    sizeBytes,
    sha256,
    ttlMs,
    persistent=false
  }={}) {
    assertBridge(persistent===false,'DIRECT_ASSET_INVALID','New files are temporary transfers; persistent storage is not supported');
    const assetId='asset-'+this.randomUUID();
    const uploadToken=base64url(this.randomBytes(32));
    const uploadTokenSha256=await sha256Hex(uploadToken);
    const objectKey='direct-assets/'+assetId;
    const created=await this.store.create({
      principal,
      assetId,
      objectKey,
      fileName,
      mimeType,
      sizeBytes,
      sha256,
      uploadTokenSha256,
      ttlMs,
      persistent
    });
    return {
      ...created,
      upload:{
        url:this.origin+'/direct/assets/upload/'+encodeURIComponent(assetId),
        token:uploadToken,
        expiresAt:created.expiresAt
      }
    };
  }

  async importFile({principal,file,persistent=false,ttlMs}={}) {
    const active=assertAuthenticatedPrincipal(principal);
    assertBridge(this.bucket!==null,'DIRECT_ASSET_UNAVAILABLE','Direct Asset storage is unavailable');
    assertBridge(persistent===false,'DIRECT_ASSET_IMPORT_DENIED','New files are temporary transfers; persistent storage is not supported');
    const source=openAiFile(file);
    const existing=await this.store.findReadyBySource({
      bridgeUserId:active.bridgeUserId,
      sourceKind:'openai-file',
      sourceRef:source.file_id
    });
    if(existing!==null) return existing;

    return withDirectAssetBufferSlot(async(signal)=>{
      const {bytes,response}=await fetchImportedBytes({
        url:source.download_url,
        fetchImpl:this.fetchImpl,
        hosts:this.importHosts,signal
      });
      const digest=await sha256HexBytes(bytes);
      signal.throwIfAborted();
      const proposedAssetId='asset-'+this.randomUUID();
      const proposedObjectKey='direct-assets/'+proposedAssetId;
      const fileName=source.file_name ?? ('openai-'+digest.slice(0,16));
      const mimeType=normalizedMime(source.mime_type ?? response.headers.get('content-type'));
      const prepared=await this.store.prepareReady({
        principal:active,
        assetId:proposedAssetId,
        objectKey:proposedObjectKey,
        fileName,
        mimeType,
        sizeBytes:bytes.byteLength,
        sha256:digest,
        sourceKind:'openai-file',
        sourceRef:source.file_id,
        ttlMs
      });
      if(prepared.status==='READY') return prepared;

      try {
        signal.throwIfAborted();
        await this.bucket.put(prepared.objectKey,bytes,{
          httpMetadata:{contentType:mimeType},
          customMetadata:{
            assetId:prepared.assetId,
            sha256:digest,
            fileName,
            sourceKind:'openai-file'
          }
        });
        signal.throwIfAborted();
        return await this.store.finalizePreparedReady({
          principal:active,
          assetId:prepared.assetId,
          objectKey:prepared.objectKey,
          persistent,
          ttlMs
        });
      } catch(error) {
        if(typeof this.store.rememberRetiredObject==='function' &&
          await this.store.rememberRetiredObject({assetId:prepared.assetId,objectKey:prepared.objectKey})) {
          await this.bucket.delete(prepared.objectKey);
        }
        const raced=await this.store.findReadyBySource({
          bridgeUserId:active.bridgeUserId,
          sourceKind:'openai-file',
          sourceRef:source.file_id
        });
        if(raced!==null) return raced;
        throw error;
      }
    });
  }

  async assertReady({principal,assetIds}) {
    return this.store.assertReady({principal,assetIds});
  }

  async getRun({principal,runId}) {
    return this.store.getRun({principal,runId});
  }

  async getResult({principal,runId}) {
    return this.store.getResult({principal,runId});
  }

  async issueResource({principal,assetId,ttlSeconds=15*60}) {
    assertBridge(this.resourceCodec!==null,'DIRECT_ASSET_RESOURCE_UNAVAILABLE','file resource capabilities are unavailable');
    const asset=await this.store.getOwnedReady({principal,assetId});
    const issued=await this.resourceCodec.issue({principal,assetId:asset.assetId,ttlSeconds});
    return {
      asset,
      uri:'bridge-file:///access/'+encodeURIComponent(issued.token),
      expiresAt:issued.expiresAt
    };
  }

  async readResource({principal,token,holdBuffer,signal:requestSignal}) {
    assertBridge(this.bucket!==null,'DIRECT_ASSET_UNAVAILABLE','Direct Asset storage is unavailable');
    assertBridge(this.resourceCodec!==null,'DIRECT_ASSET_RESOURCE_UNAVAILABLE','file resource capabilities are unavailable');
    const verified=await this.resourceCodec.verify({principal,token});
    const asset=await this.store.getOwnedReady({principal,assetId:verified.assetId});
    return withDirectAssetBufferSlot(async(signal)=>{
      const object=await this.bucket.get(asset.objectKey);
      assertBridge(object!==null,'DIRECT_ASSET_MISSING','asset object is missing');
      const bytes=await readBoundedBody(new Response(object.body,{headers:{'content-length':String(asset.sizeBytes)}}),
        {maxBytes:Math.min(asset.sizeBytes,DIRECT_ASSET_MAX_BYTES),signal,code:'DIRECT_ASSET_INTEGRITY',message:'asset size mismatch'});
      assertBridge(bytes.byteLength===asset.sizeBytes,'DIRECT_ASSET_INTEGRITY','asset size mismatch');
      assertBridge(await sha256HexBytes(bytes)===asset.sha256,'DIRECT_ASSET_INTEGRITY','asset SHA-256 mismatch');
      return {asset,bytes,expiresAt:verified.expiresAt};
    },{retain:holdBuffer,signal:requestSignal});
  }
}
