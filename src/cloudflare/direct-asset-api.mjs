import { readBoundedBody } from './request-body.mjs';
import { withDirectAssetBufferSlot } from './direct-asset-memory.mjs';
import { BridgeError, errorEnvelope } from '../errors.mjs';
import { DIRECT_ASSET_MAX_BYTES } from './d1-direct-asset-store.mjs';

export const DIRECT_ASSET_UPLOAD_PREFIX='/direct/assets/upload/';
export const DIRECT_RUNNER_ASSET_PREFIX='/direct/runner/assets/';
export const DIRECT_RUNNER_EXPORT_PREFIX='/direct/runner/exports/';

function bearerToken(request) {
  const raw=request.headers.get('authorization');
  if(typeof raw!=='string') return null;
  const match=/^Bearer ([A-Za-z0-9._~-]{32,512})$/.exec(raw);
  return match ? match[1] : null;
}

async function sha256HexBytes(bytes) {
  const digest=await globalThis.crypto.subtle.digest('SHA-256',bytes);
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
}

async function sha256HexText(value) {
  return sha256HexBytes(new TextEncoder().encode(value));
}

function assetFromPath(pathname,prefix) {
  if(!pathname.startsWith(prefix)) return null;
  let value;
  try {
    value=decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return null;
  }
  return /^asset-[A-Za-z0-9_-]{8,160}$/.test(value) ? value : null;
}

function exportFromPath(pathname) {
  if(!pathname.startsWith(DIRECT_RUNNER_EXPORT_PREFIX)) return null;
  const parts=pathname.slice(DIRECT_RUNNER_EXPORT_PREFIX.length).split('/');
  if(parts.length!==2) return null;
  let runId;
  try { runId=decodeURIComponent(parts[0]); }
  catch { return null; }
  if(!/^dx1:[A-Za-z0-9_.-]{1,128}:[A-Za-z0-9._-]{8,160}$/.test(runId)) return null;
  if(!/^[0-7]$/.test(parts[1])) return null;
  return {runId,exportIndex:Number(parts[1])};
}

const uploadCorsHeaders=Object.freeze({
  'access-control-allow-origin':'*',
  'access-control-allow-methods':'PUT, OPTIONS',
  'access-control-allow-headers':'authorization, content-type',
  'access-control-max-age':'600'
});

function responseHeaders(extra={},cors=false) {
  return {
    'cache-control':'no-store',
    ...(cors ? uploadCorsHeaders : {}),
    ...extra
  };
}

function failure(error,status=400,{cors=false}={}) {
  return Response.json(
    {error:errorEnvelope(error)},
    {status,headers:responseHeaders({},cors)}
  );
}

// Retain the bounded buffer until consumption/cancellation. Rechecking
// permission after R2 must happen before any file bytes are exposed.
async function runnerDownloadResponse(operation,signal) {
  let lease;
  let {bytes,headers}=await withDirectAssetBufferSlot(operation,{signal,retain:value=>{lease=value;}});
  let sent=false,controller,released=false;
  const release=()=>{if(!released){released=true;bytes=null;lease.signal.removeEventListener('abort',abort);lease.release();}};
  const abort=()=>{try{controller.error(new Error('File response canceled or timed out'));}finally{release();}};
  const body=new ReadableStream({
    start(value){controller=value;},
    pull(value){if(!sent){sent=true;value.enqueue(bytes);bytes=null;}else{release();value.close();}},
    cancel(){release();}
  },{highWaterMark:0});
  lease.signal.addEventListener('abort',abort,{once:true});
  if(lease.signal.aborted)abort();
  return new Response(body,{status:200,headers});
}

export function createDirectAssetHandler({
  store,
  bucket,
  directExecStore=null,
  randomUUID=()=>globalThis.crypto.randomUUID()
}={}) {
  if(
    !store ||
    typeof store.authorizeUpload!=='function' ||
    typeof store.markReady!=='function' ||
    typeof store.authorizeRunnerDownload!=='function'
  ) throw new TypeError('Direct Asset store is required');
  if(
    !bucket ||
    typeof bucket.put!=='function' ||
    typeof bucket.get!=='function' ||
    typeof bucket.delete!=='function'
  ) throw new TypeError('Direct Asset R2 bucket is required');
  if(
    directExecStore!==null &&
    (
      typeof directExecStore.authorizeExportUpload!=='function' ||
      typeof store.findReadyBySource!=='function' ||
      typeof store.prepareReady!=='function' ||
      typeof store.finalizePreparedReady!=='function'
    )
  ) throw new TypeError('Direct Exec export authorization store is invalid');
  if(typeof randomUUID!=='function') throw new TypeError('randomUUID is required');

  return Object.freeze({
    async fetch(request) {
      const url=new URL(request.url);
      const uploadAssetId=assetFromPath(url.pathname,DIRECT_ASSET_UPLOAD_PREFIX);
      const runnerAssetId=assetFromPath(url.pathname,DIRECT_RUNNER_ASSET_PREFIX);
      const runnerExport=exportFromPath(url.pathname);

      if(uploadAssetId!==null) {
        if(request.method==='OPTIONS') {
          return new Response(null,{status:204,headers:responseHeaders({},true)});
        }
        if(request.method!=='PUT') {
          return new Response('Method not allowed',{
            status:405,
            headers:responseHeaders({'allow':'PUT, OPTIONS'},true)
          });
        }
        const token=bearerToken(request);
        if(token===null) return failure(
          new BridgeError('DIRECT_ASSET_UPLOAD_DENIED','asset upload token required'),
          401,
          {cors:true}
        );

        try {
          const uploadTokenSha256=await sha256HexText(token);
          const ticket=await store.authorizeUpload({
            assetId:uploadAssetId,
            uploadTokenSha256
          });
          const declaredLength=request.headers.get('content-length');
          if(declaredLength!==null && Number(declaredLength)!==ticket.sizeBytes) {
            throw new BridgeError('DIRECT_ASSET_UPLOAD_DENIED','asset Content-Length does not match upload ticket');
          }
          return await withDirectAssetBufferSlot(async(signal)=>{
          const bytes=await readBoundedBody(request,{maxBytes:Math.min(ticket.sizeBytes,DIRECT_ASSET_MAX_BYTES),signal,
              code:'DIRECT_ASSET_UPLOAD_DENIED',message:'asset byte size does not match upload ticket'});
            if(bytes.byteLength<1 || bytes.byteLength>DIRECT_ASSET_MAX_BYTES || bytes.byteLength!==ticket.sizeBytes) {
              throw new BridgeError('DIRECT_ASSET_UPLOAD_DENIED','asset byte size does not match upload ticket');
            }
            const actualSha256=await sha256HexBytes(bytes);
            if(actualSha256!==ticket.sha256) {
              throw new BridgeError('DIRECT_ASSET_UPLOAD_DENIED','asset SHA-256 does not match upload ticket');
            }

            try {
              signal.throwIfAborted();
              await bucket.put(ticket.objectKey,bytes,{
                httpMetadata:{contentType:ticket.mimeType},
                customMetadata:{
                  assetId:ticket.assetId,
                  sha256:ticket.sha256,
                  fileName:ticket.fileName
                }
              });
              signal.throwIfAborted();
              const ready=await store.markReady({
                assetId:uploadAssetId,
                uploadTokenSha256,
                actualSizeBytes:bytes.byteLength,
                actualSha256
              });
              return Response.json(ready,{headers:responseHeaders({},true)});
            } catch(error) {
              if(typeof store.rememberRetiredObject==='function' && await store.rememberRetiredObject(ticket))
                await bucket.delete(ticket.objectKey);
              throw error;
            }
          });
        } catch(error) {
          const status=
            error?.code==='DIRECT_ASSET_BUSY' ? 429 :
            error?.code==='DIRECT_ASSET_UPLOAD_DENIED' ? 403 :
            error?.code==='DIRECT_ASSET_INVALID' ? 400 :
            500;
          return failure(error,status,{cors:true});
        }
      }

      if(runnerExport!==null) {
        if(request.method!=='PUT') return new Response('Method not allowed',{status:405});
        if(directExecStore===null) return new Response('Not found',{status:404});
        const token=bearerToken(request);
        const hostId=request.headers.get('x-bridge-host-id');
        const leaseOwner=request.headers.get('x-bridge-lease-owner');
        if(
          token===null ||
          typeof hostId!=='string' || hostId.length===0 ||
          typeof leaseOwner!=='string' || leaseOwner.length===0
        ) {
          return failure(new BridgeError('DIRECT_EXPORT_DENIED','runner export authorization required'),401);
        }
        try {
          const runnerTokenSha256=await sha256HexText(token);
          const slot=await directExecStore.authorizeExportUpload({
            hostId,
            runnerTokenSha256,
            leaseOwner,
            runId:runnerExport.runId,
            exportIndex:runnerExport.exportIndex
          });
          const exportAuthorization={hostId,runnerTokenSha256,leaseOwner,runId:runnerExport.runId};
          const sourceRef=slot.runId+':'+slot.exportIndex;
          const declaredLength=request.headers.get('content-length');
          const declaredSha=request.headers.get('x-bridge-sha256');
          if(
            declaredLength===null ||
            !/^[0-9]+$/.test(declaredLength) ||
            Number(declaredLength)<1 ||
            Number(declaredLength)>slot.maxBytes
          ) {
            throw new BridgeError('DIRECT_EXPORT_INVALID','export Content-Length invalid');
          }
          if(declaredSha===null || !/^[0-9a-f]{64}$/.test(declaredSha)) {
            throw new BridgeError('DIRECT_EXPORT_INVALID','export SHA-256 header invalid');
          }

          const existing=await store.findReadyBySource({
            bridgeUserId:slot.bridgeUserId,
            sourceKind:'direct-export',
            sourceRef
          });
          if(existing!==null) {
            await request.body?.cancel().catch(()=>{});
            if(
              existing.fileName!==slot.fileName ||
              existing.mimeType!==slot.mimeType ||
              existing.sizeBytes!==Number(declaredLength) ||
              existing.sha256!==declaredSha
            ) {
              throw new BridgeError('DIRECT_EXPORT_CONFLICT','replayed export metadata does not match stored object');
            }
            return Response.json(existing,{headers:responseHeaders()});
          }

          return await withDirectAssetBufferSlot(async(signal)=>{
          const bytes=await readBoundedBody(request,{
              maxBytes:slot.maxBytes,signal,
              code:'DIRECT_EXPORT_INVALID',
              message:'export exceeds declared Direct Run slot limit'
            });
            if(bytes.byteLength!==Number(declaredLength)) {
              throw new BridgeError('DIRECT_EXPORT_INVALID','export byte size does not match Content-Length');
            }
            const actualSha256=await sha256HexBytes(bytes);
            if(actualSha256!==declaredSha) {
              throw new BridgeError('DIRECT_EXPORT_INVALID','export SHA-256 mismatch');
            }

            await directExecStore.authorizeExportUpload({...exportAuthorization,exportIndex:runnerExport.exportIndex});
            signal.throwIfAborted();
            const proposedAssetId='asset-'+randomUUID();
            const prepared=await store.prepareReady({
              bridgeUserId:slot.bridgeUserId,
              assetId:proposedAssetId,
              objectKey:'direct-assets/'+proposedAssetId,
              fileName:slot.fileName,
              mimeType:slot.mimeType,
              sizeBytes:bytes.byteLength,
              sha256:actualSha256,
              sourceKind:'direct-export',
              sourceRef
            });
            if(prepared.status==='READY') {
              return Response.json(prepared,{headers:responseHeaders()});
            }
            try {
              signal.throwIfAborted();
              await bucket.put(prepared.objectKey,bytes,{
                httpMetadata:{contentType:slot.mimeType},
                customMetadata:{
                  assetId:prepared.assetId,
                  sha256:actualSha256,
                  fileName:slot.fileName,
                  sourceKind:'direct-export',
                  sourceRef
                }
              });
              signal.throwIfAborted();
              const ready=await store.finalizePreparedReady({
                bridgeUserId:slot.bridgeUserId,
                assetId:prepared.assetId,
                objectKey:prepared.objectKey,
                exportAuthorization,
                persistent:false
              });
              return Response.json(ready,{headers:responseHeaders()});
            } catch(error) {
              if(typeof store.rememberRetiredObject==='function' &&
                await store.rememberRetiredObject({assetId:prepared.assetId,objectKey:prepared.objectKey})) {
                await bucket.delete(prepared.objectKey);
              }
              if(error?.code==='DIRECT_RUN_STALE') throw error;
              const raced=await store.findReadyBySource({
                bridgeUserId:slot.bridgeUserId,
                sourceKind:'direct-export',
                sourceRef
              });
              if(raced!==null) return Response.json(raced,{headers:responseHeaders()});
              throw error;
            }
          });
        } catch(error) {
          const status=
            error?.code==='DIRECT_ASSET_BUSY' ? 429 :
            error?.code==='DIRECT_RUNNER_DENIED' || error?.code==='DIRECT_HOST_PAUSED' || error?.code==='DIRECT_EXPORT_DENIED' ? 403 :
            error?.code==='DIRECT_RUN_STALE' || error?.code==='DIRECT_EXPORT_CONFLICT' ? 409 :
            error?.code==='DIRECT_EXPORT_INVALID' || error?.code==='DIRECT_ASSET_INVALID' ? 400 :
            500;
          return failure(error,status);
        }
      }

      if(runnerAssetId!==null) {
        if(request.method!=='GET') return new Response('Method not allowed',{status:405});
        const token=bearerToken(request);
        const hostId=request.headers.get('x-bridge-host-id');
        const runId=request.headers.get('x-bridge-run-id');
        const leaseOwner=request.headers.get('x-bridge-lease-owner');
        if(
          token===null ||
          typeof hostId!=='string' || hostId.length===0 ||
          typeof runId!=='string' || runId.length===0 ||
          typeof leaseOwner!=='string' || leaseOwner.length===0
        ) {
          return failure(new BridgeError('DIRECT_ASSET_DENIED','runner asset authorization required'),401);
        }
        try {
          const runnerTokenSha256=await sha256HexText(token);
          const authorizeDownload=async()=>{
            if(typeof directExecStore?.assertRunner==='function')await directExecStore.assertRunner({hostId,runnerTokenSha256,signalPaused:true});
            return store.authorizeRunnerDownload({hostId,runnerTokenSha256,assetId:runnerAssetId,runId,leaseOwner});
          };
          const asset=await authorizeDownload();
          const headers=new Headers({
            'cache-control':'private, no-store',
            'content-type':asset.mimeType,
            'content-length':String(asset.sizeBytes),
            'x-bridge-asset-id':asset.assetId,
            'x-bridge-sha256':asset.sha256,
            'x-bridge-file-name':encodeURIComponent(asset.fileName)
          });
          return await runnerDownloadResponse(async(signal)=>{
            const object=await bucket.get(asset.objectKey);
            if(object===null)throw new BridgeError('DIRECT_ASSET_MISSING','asset object is missing');
            const bytes=await readBoundedBody(new Response(object.body,{headers:{'content-length':String(asset.sizeBytes)}}),
              {maxBytes:Math.min(asset.sizeBytes,DIRECT_ASSET_MAX_BYTES),signal,code:'DIRECT_ASSET_INTEGRITY',message:'asset size mismatch'});
            if(bytes.byteLength!==asset.sizeBytes||await sha256HexBytes(bytes)!==asset.sha256)throw new BridgeError('DIRECT_ASSET_INTEGRITY','asset integrity mismatch');
            await authorizeDownload();
            signal.throwIfAborted();
            return {bytes,headers};
          },request.signal);
        } catch(error) {
          const status=
            error?.code==='DIRECT_ASSET_BUSY' ? 429 :
            error?.code==='DIRECT_ASSET_DENIED' || error?.code==='DIRECT_RUNNER_DENIED' || error?.code==='DIRECT_HOST_PAUSED' ? 403 :
            error?.code==='DIRECT_ASSET_MISSING' ? 404 :
            500;
          return failure(error,status);
        }
      }

      return new Response('Not found',{status:404});
    }
  });
}

export async function cleanupDirectAssets({store,bucket,limit=100}={}) {
  if(
    !store ||
    typeof store.listExpired!=='function' ||
    typeof store.markExpired!=='function'
  ) return {expired:0};
  if(!bucket || typeof bucket.delete!=='function') return {expired:0};

  const expired=await store.listExpired({limit});
  const marked=expired.length===0 ? [] : await store.markExpired({
    assetIds:expired.map(item=>item.assetId),objects:expired
  });
  // markExpired atomically journals each retired object before making it
  // unbindable. Never delete from the stale listExpired snapshot itself.
  if(typeof store.listRetiredObjects==='function' && typeof store.acknowledgeRetiredObjects==='function') {
    const retired=await store.listRetiredObjects({limit});
    if(retired.length>0) {
      await bucket.delete(retired.map(item=>item.objectKey));
      await store.acknowledgeRetiredObjects({objects:retired});
    }
  }
  return {expired:marked.length};
}
