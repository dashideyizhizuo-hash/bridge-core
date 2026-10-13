import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { assertBridge, BridgeError } from './errors.mjs';
import { boundedOriginFetch } from './host-http.mjs';
import { validateDirectExecRequest } from './direct-exec.mjs';

function endpointOrigin(value) {
  const url=new URL(value);
  assertBridge(
    url.protocol==='https:' || (url.protocol==='http:' && ['localhost','127.0.0.1'].includes(url.hostname)),
    'DIRECT_ASSET_CONFIG_INVALID',
    'Direct Asset endpoint must be HTTPS'
  );
  assertBridge(!url.username && !url.password && !url.search && !url.hash,
    'DIRECT_ASSET_CONFIG_INVALID','Direct Asset endpoint must not contain credentials, query or fragment');
  return url.origin;
}

function assetRoot(hostPolicy) {
  return resolve(
    hostPolicy?.directExec?.assetDir ??
    resolve(
      hostPolicy?.directExec?.stateDir ??
      resolve(homedir(),'.local','state','bridge','direct-exec'),
      'assets'
    )
  );
}

function safeExtension(fileName) {
  const match=/\.([A-Za-z0-9]{1,10})$/.exec(fileName);
  return match ? `.${match[1].toLowerCase()}` : '';
}

function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function verifiedExisting(path,asset) {
  try {
    const stat=lstatSync(path);
    if(!stat.isFile() || stat.size!==asset.sizeBytes) return false;
    return hashBytes(readFileSync(path))===asset.sha256;
  } catch {
    return false;
  }
}

function writeAtomic(path,bytes) {
  mkdirSync(resolve(path,'..'),{recursive:true,mode:0o700});
  const temp=`${path}.tmp-${process.pid}-${Date.now()}`;
  const fd=openSync(temp,'wx',0o600);
  try {
    writeFileSync(fd,bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp,path);
}

export async function stageDirectAssets({
  endpoint,
  token,
  hostId,
  runId,
  leaseOwner,
  hostPolicy,
  assets=[],
  fetchImpl=globalThis.fetch,
  signal
}={}) {
  assertBridge(
    Array.isArray(assets) && assets.length<=8,
    'DIRECT_ASSET_INVALID',
    'Direct Asset staging supports at most 8 assets'
  );
  if(assets.length===0) return [];
  assertBridge(typeof runId==='string' && runId.length>=8,
    'DIRECT_ASSET_INVALID','Direct Run ID required for asset staging');
  assertBridge(typeof leaseOwner==='string' && leaseOwner.length>=8,
    'DIRECT_ASSET_INVALID','Direct Run lease owner required for asset staging');
  assets=validateDirectExecRequest({schemaVersion:1,requestId:'asset-stage-validation',hostId,argv:['asset-stage'],assets}).assets;
  const root=assetRoot(hostPolicy);
  mkdirSync(root,{recursive:true,mode:0o700});
  const paths=[];

  for(const asset of assets) {
    signal?.throwIfAborted();
    const target=resolve(root,`${asset.sha256}${safeExtension(asset.fileName)}`);
    if(verifiedExisting(target,asset)) {
      try {
        const now=new Date();
        utimesSync(target,now,now);
      } catch {}
      paths.push(target);
      continue;
    }

    const response=await boundedOriginFetch(endpointOrigin(endpoint),{
      fetchImpl,signal,timeoutMs:60_000,maxBytes:Math.max(asset.sizeBytes,4096)
    })(
      `${endpointOrigin(endpoint)}/direct/runner/assets/${encodeURIComponent(asset.assetId)}`,
      {
        method:'GET',
        headers:{
          authorization:`Bearer ${token}`,
          'x-bridge-host-id':hostId,
          'x-bridge-run-id':runId,
          'x-bridge-lease-owner':leaseOwner,
          accept:'application/octet-stream'
        }
      }
    );
    if(!response.ok) {
      await response.body?.cancel();
      const error=new BridgeError(
        response.status===401 || response.status===403 ? 'DIRECT_ASSET_DENIED' : 'DIRECT_ASSET_DOWNLOAD_FAILED',
        `Direct Asset download failed with HTTP ${response.status}`
      );
      error.status=response.status;
      throw error;
    }
    const bytes=Buffer.from(await response.arrayBuffer());
    assertBridge(
      bytes.length===asset.sizeBytes,
      'DIRECT_ASSET_INTEGRITY',
      `asset size mismatch: ${asset.assetId}`
    );
    assertBridge(
      hashBytes(bytes)===asset.sha256,
      'DIRECT_ASSET_INTEGRITY',
      `asset SHA-256 mismatch: ${asset.assetId}`
    );
    const remoteSha=response.headers.get('x-bridge-sha256');
    assertBridge(
      remoteSha===null || remoteSha===asset.sha256,
      'DIRECT_ASSET_INTEGRITY',
      `asset response SHA-256 mismatch: ${asset.assetId}`
    );
    signal?.throwIfAborted();
    writeAtomic(target,bytes);
    assertBridge(
      verifiedExisting(target,asset),
      'DIRECT_ASSET_INTEGRITY',
      `staged asset verification failed: ${asset.assetId}`
    );
    paths.push(target);
  }
  return paths;
}


export function cleanupDirectAssetCache({
  hostPolicy,
  now=Date.now(),
  retentionMs=7*24*60*60*1000
}={}) {
  assertBridge(
    Number.isFinite(retentionMs) && retentionMs>=60*60*1000,
    'DIRECT_ASSET_INVALID',
    'asset cache retention must be at least one hour'
  );
  const root=assetRoot(hostPolicy);
  if(!existsSync(root)) return {removed:0};
  let entries;
  try {
    entries=readdirSync(root,{withFileTypes:true});
  } catch {
    return {removed:0};
  }
  let removed=0;
  const ownedName=/^[0-9a-f]{64}(?:\.[a-z0-9]{1,10})?(?:\.tmp-[0-9]+-[0-9]+)?$/;
  for(const entry of entries) {
    if(!entry.isFile() && !entry.isSymbolicLink()) continue;
    if(!ownedName.test(entry.name)) continue;
    const path=resolve(root,entry.name);
    try {
      const stat=lstatSync(path);
      if(now-stat.mtimeMs>retentionMs) {
        unlinkSync(path);
        removed++;
      }
    } catch {}
  }
  return {removed};
}
