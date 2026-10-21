import { assertBridge } from '../errors.mjs';
import { assertAuthenticatedPrincipal } from '../auth/principal.mjs';

const ASSET_ID=/^asset-[A-Za-z0-9_-]{8,160}$/;
const RUN_ID=/^da1:(asset-[A-Za-z0-9_-]{8,160})$/;
const SHA256=/^[0-9a-f]{64}$/;
const TOKEN_HASH=/^[0-9a-f]{64}$/;
const DIRECT_RUN_ID=/^dx1:([A-Za-z0-9_.-]{1,128}):([A-Za-z0-9._-]{8,160})$/;
const LEASE_OWNER=/^[A-Za-z0-9_.:-]{8,200}$/;
const MIME=/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,127}$/;
const MAX_FILE_NAME_BYTES=255;
export const DIRECT_ASSET_MAX_BYTES=25*1024*1024;
const DEFAULT_TTL_MS=60*60*1000;
const MAX_TTL_MS=24*60*60*1000;

// An accepted run may finish staging after the public relay TTL. Admission is
// atomic with asset validation; queue TTL is capped at 24h, execution at 3600s
// plus the existing 100s lease allowance. Renewals cannot extend this hold.
function activeRunReference(now, asset='direct_assets') {
  assertBridge(Number.isSafeInteger(now) && now>=0,'DIRECT_ASSET_INVALID','clock invalid');
  return `EXISTS (SELECT 1 FROM direct_runs held_run
    JOIN json_each(held_run.request_json,'$.assets') held_asset
    WHERE held_run.bridge_user_id=${asset}.bridge_user_id
      AND json_extract(held_asset.value,'$.assetId')=${asset}.asset_id
      AND held_run.created_at<${asset}.expires_at
      AND held_run.expires_at IS NOT NULL
      AND ((held_run.status IN ('QUEUED','RUNNING') AND held_run.expires_at>${now})
        OR (held_run.status='RUNNING' AND held_run.lease_expires_at>${now}
          AND held_run.expires_at+3700000>${now})))`;
}

function assertDb(value) {
  assertBridge(
    value && typeof value.prepare==='function' && typeof value.batch==='function',
    'DIRECT_ASSET_CONFIG_INVALID',
    'D1 database binding is required'
  );
  return value;
}

function assetId(value) {
  assertBridge(typeof value==='string' && ASSET_ID.test(value),'DIRECT_ASSET_INVALID','assetId invalid');
  return value;
}

function assetRunId(value) {
  assertBridge(typeof value==='string' && RUN_ID.test(value),'RUN_NOT_FOUND','runId is not a Direct Asset run');
  return RUN_ID.exec(value)[1];
}

function sha256(value) {
  assertBridge(typeof value==='string' && SHA256.test(value),'DIRECT_ASSET_INVALID','sha256 invalid');
  return value;
}

function tokenHash(value) {
  assertBridge(typeof value==='string' && TOKEN_HASH.test(value),'DIRECT_ASSET_INVALID','upload token hash invalid');
  return value;
}

function fileName(value) {
  assertBridge(
    typeof value==='string' &&
      value.length>0 &&
      Buffer.byteLength(value,'utf8')<=MAX_FILE_NAME_BYTES &&
      !value.includes('/') &&
      !value.includes('\\') &&
      !value.includes('\0') &&
      value!=='.' &&
      value!=='..',
    'DIRECT_ASSET_INVALID',
    'fileName invalid'
  );
  return value;
}

function mimeType(value) {
  assertBridge(typeof value==='string' && MIME.test(value),'DIRECT_ASSET_INVALID','mimeType invalid');
  return value.toLowerCase();
}

function sizeBytes(value) {
  assertBridge(
    Number.isInteger(value) && value>0 && value<=DIRECT_ASSET_MAX_BYTES,
    'DIRECT_ASSET_INVALID',
    `sizeBytes must be 1-${DIRECT_ASSET_MAX_BYTES}`
  );
  return value;
}

function ttlMs(value) {
  const ttl=value ?? DEFAULT_TTL_MS;
  assertBridge(
    Number.isInteger(ttl) && ttl>=60_000 && ttl<=MAX_TTL_MS,
    'DIRECT_ASSET_INVALID',
    'asset ttl invalid'
  );
  return ttl;
}

function normalize(row) {
  if(!row) return null;
  return {
    runId:row.run_id,
    kind:'asset',
    transport:'direct-asset',
    assetId:row.asset_id,
    status:row.status,
    fileName:row.file_name,
    mimeType:row.mime_type,
    sizeBytes:Number(row.size_bytes),
    sha256:row.sha256,
    persistent:Number(row.persistent ?? 0)===1,
    ...(row.source_kind===null || row.source_kind===undefined ? {} : {sourceKind:String(row.source_kind)}),
    ...(row.source_ref===null || row.source_ref===undefined ? {} : {sourceRef:String(row.source_ref)}),
    createdAt:Number(row.created_at),
    expiresAt:Number(row.expires_at),
    ...(row.uploaded_at===null || row.uploaded_at===undefined
      ? {}
      : {uploadedAt:Number(row.uploaded_at)})
  };
}

function bridgeUserId(value) {
  assertBridge(
    typeof value==='string' && value.length>=1 && value.length<=128,
    'DIRECT_ASSET_INVALID',
    'bridgeUserId invalid'
  );
  return value;
}

function sourceValue(value,label) {
  if(value===undefined || value===null) return null;
  assertBridge(
    typeof value==='string' && value.length>=1 && value.length<=512 && !value.includes('\0'),
    'DIRECT_ASSET_INVALID',
    `${label} invalid`
  );
  return value;
}

export class D1DirectAssetStore {
  constructor({db,clock=()=>Date.now()}={}) {
    this.db=assertDb(db);
    assertBridge(typeof clock==='function','DIRECT_ASSET_CONFIG_INVALID','clock required');
    this.clock=clock;
  }

  async create({
    principal,
    assetId:value,
    objectKey,
    fileName:valueName,
    mimeType:valueMime,
    sizeBytes:valueSize,
    sha256:valueSha,
    uploadTokenSha256,
    ttlMs:valueTtl,
    persistent=false,
    sourceKind=null,
    sourceRef=null
  }={}) {
    const active=assertAuthenticatedPrincipal(principal);
    const id=assetId(value);
    const name=fileName(valueName);
    const mime=mimeType(valueMime);
    const size=sizeBytes(valueSize);
    const digest=sha256(valueSha);
    const token=tokenHash(uploadTokenSha256);
    assertBridge(typeof persistent==='boolean','DIRECT_ASSET_INVALID','persistent must be boolean');
    const sourceKindValue=sourceValue(sourceKind,'sourceKind');
    const sourceRefValue=sourceValue(sourceRef,'sourceRef');
    assertBridge(
      (sourceKindValue===null)===(sourceRefValue===null),
      'DIRECT_ASSET_INVALID',
      'sourceKind and sourceRef must be supplied together'
    );
    assertBridge(
      typeof objectKey==='string' &&
        objectKey.length>=8 &&
        objectKey.length<=512 &&
        !objectKey.includes('..') &&
        !objectKey.includes('\0'),
      'DIRECT_ASSET_INVALID',
      'objectKey invalid'
    );
    const now=this.clock();
    const expiresAt=now+ttlMs(valueTtl);
    const runId=`da1:${id}`;
    await this.db.prepare(
      `INSERT INTO direct_assets (
        asset_id, run_id, bridge_user_id, object_key, file_name, mime_type,
        size_bytes, sha256, upload_token_sha256, status,
        created_at, expires_at, uploaded_at, persistent, source_kind, source_ref
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'WAITING_UPLOAD', ?, ?, NULL, ?, ?, ?)`
    ).bind(
      id,runId,active.bridgeUserId,objectKey,name,mime,size,digest,token,now,expiresAt,
      persistent?1:0,sourceKindValue,sourceRefValue
    ).run();
    return {
      runId,kind:'asset',transport:'direct-asset',assetId:id,status:'WAITING_UPLOAD',
      fileName:name,mimeType:mime,
      sizeBytes:size,sha256:digest,persistent,createdAt:now,expiresAt,
      ...(sourceKindValue===null ? {} : {sourceKind:sourceKindValue,sourceRef:sourceRefValue})
    };
  }

  async createReady({
    principal,
    bridgeUserId:valueBridgeUserId,
    assetId:value,
    objectKey,
    fileName:valueName,
    mimeType:valueMime,
    sizeBytes:valueSize,
    sha256:valueSha,
    persistent=false,
    sourceKind=null,
    sourceRef=null,
    ttlMs:valueTtl
  }={}) {
    const owner=principal===undefined
      ? bridgeUserId(valueBridgeUserId)
      : assertAuthenticatedPrincipal(principal).bridgeUserId;
    const id=assetId(value);
    const name=fileName(valueName);
    const mime=mimeType(valueMime);
    const size=sizeBytes(valueSize);
    const digest=sha256(valueSha);
    assertBridge(typeof persistent==='boolean','DIRECT_ASSET_INVALID','persistent must be boolean');
    const sourceKindValue=sourceValue(sourceKind,'sourceKind');
    const sourceRefValue=sourceValue(sourceRef,'sourceRef');
    assertBridge(
      (sourceKindValue===null)===(sourceRefValue===null),
      'DIRECT_ASSET_INVALID',
      'sourceKind and sourceRef must be supplied together'
    );
    assertBridge(
      typeof objectKey==='string' &&
        objectKey.length>=8 &&
        objectKey.length<=512 &&
        !objectKey.includes('..') &&
        !objectKey.includes('\0'),
      'DIRECT_ASSET_INVALID',
      'objectKey invalid'
    );
    const now=this.clock();
    const expiresAt=now+ttlMs(valueTtl ?? MAX_TTL_MS);
    const runId=`da1:${id}`;
    await this.db.prepare(
      `INSERT INTO direct_assets (
        asset_id, run_id, bridge_user_id, object_key, file_name, mime_type,
        size_bytes, sha256, upload_token_sha256, status,
        created_at, expires_at, uploaded_at, persistent, source_kind, source_ref
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'READY', ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,runId,owner,objectKey,name,mime,size,digest,now,expiresAt,now,
      persistent?1:0,sourceKindValue,sourceRefValue
    ).run();
    return {
      runId,kind:'asset',transport:'direct-asset',assetId:id,status:'READY',
      fileName:name,mimeType:mime,sizeBytes:size,
      sha256:digest,persistent,createdAt:now,expiresAt,uploadedAt:now,
      ...(sourceKindValue===null ? {} : {sourceKind:sourceKindValue,sourceRef:sourceRefValue})
    };
  }

  async prepareReady({
    principal,
    bridgeUserId:valueBridgeUserId,
    assetId:value,
    objectKey,
    fileName:valueName,
    mimeType:valueMime,
    sizeBytes:valueSize,
    sha256:valueSha,
    sourceKind,
    sourceRef,
    ttlMs:valueTtl
  }={}) {
    const owner=principal===undefined
      ? bridgeUserId(valueBridgeUserId)
      : assertAuthenticatedPrincipal(principal).bridgeUserId;
    const id=assetId(value);
    const name=fileName(valueName);
    const mime=mimeType(valueMime);
    const size=sizeBytes(valueSize);
    const digest=sha256(valueSha);
    const sourceKindValue=sourceValue(sourceKind,'sourceKind');
    const sourceRefValue=sourceValue(sourceRef,'sourceRef');
    assertBridge(
      sourceKindValue!==null && sourceRefValue!==null,
      'DIRECT_ASSET_INVALID',
      'source identity required'
    );
    assertBridge(
      typeof objectKey==='string' &&
        objectKey.length>=8 &&
        objectKey.length<=512 &&
        !objectKey.includes('..') &&
        !objectKey.includes('\0'),
      'DIRECT_ASSET_INVALID',
      'objectKey invalid'
    );
    const now=this.clock();
    const expiresAt=now+ttlMs(valueTtl);
    const runId=`da1:${id}`;
    await this.db.prepare(
      `INSERT INTO direct_assets (
        asset_id, run_id, bridge_user_id, object_key, file_name, mime_type,
        size_bytes, sha256, upload_token_sha256, status,
        created_at, expires_at, uploaded_at, persistent, source_kind, source_ref
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'WAITING_UPLOAD', ?, ?, NULL, 0, ?, ?)
      ON CONFLICT DO NOTHING`
    ).bind(
      id,runId,owner,objectKey,name,mime,size,digest,now,expiresAt,sourceKindValue,sourceRefValue
    ).run();

    let row=await this.db.prepare(
      `SELECT * FROM direct_assets
       WHERE bridge_user_id=? AND source_kind=? AND source_ref=?
       LIMIT 1`
    ).bind(owner,sourceKindValue,sourceRefValue).first();
    assertBridge(row,'DIRECT_ASSET_CONFLICT','source identity collides with another asset');
    assertBridge(
      row.file_name===name &&
      row.mime_type===mime &&
      Number(row.size_bytes)===size &&
      row.sha256===digest,
      'DIRECT_ASSET_CONFLICT',
      'source identity metadata changed across retries'
    );

    if(
      row.status==='EXPIRED' ||
      (row.status==='WAITING_UPLOAD' && Number(row.expires_at)<=now) ||
      (row.status==='READY' && Number(row.persistent ?? 0)===0 && Number(row.expires_at)<=now)
    ) {
      assertBridge(objectKey!==row.object_key,'DIRECT_ASSET_CONFLICT','expired source requires a new object generation');
      row=await this.db.prepare(
        `UPDATE direct_assets
         SET status='WAITING_UPLOAD',
             object_key=?,
             upload_token_sha256=NULL,
             persistent=0,
             uploaded_at=NULL,
             expires_at=?
         WHERE asset_id=? AND bridge_user_id=? AND object_key=?
           AND (status='EXPIRED' OR (persistent=0 AND expires_at<=?))
           AND NOT ${activeRunReference(now)}
         RETURNING *`
      ).bind(objectKey,expiresAt,row.asset_id,owner,row.object_key,now).first();
      if(!row) row=await this.db.prepare(
        `SELECT * FROM direct_assets WHERE bridge_user_id=? AND source_kind=? AND source_ref=? LIMIT 1`
      ).bind(owner,sourceKindValue,sourceRefValue).first();
    }
    assertBridge(
      row && (row.status==='WAITING_UPLOAD' || row.status==='READY') &&
        (Number(row.persistent ?? 0)===1 || Number(row.expires_at)>now),
      'DIRECT_ASSET_CONFLICT',
      'source asset is not retryable'
    );
    return {...normalize(row),objectKey:row.object_key};
  }

  async finalizePreparedReady({
    principal,bridgeUserId:valueBridgeUserId,assetId:value,objectKey,
    persistent=false,ttlMs:valueTtl,exportAuthorization
  }={}) {
    const owner=principal===undefined ? bridgeUserId(valueBridgeUserId) : assertAuthenticatedPrincipal(principal).bridgeUserId;
    const id=assetId(value);
    assertBridge(typeof persistent==='boolean','DIRECT_ASSET_INVALID','persistent must be boolean');
    assertBridge(typeof objectKey==='string' && objectKey.length>0,'DIRECT_ASSET_INVALID','prepared object identity required');
    const now=this.clock(),expiresAt=now+ttlMs(valueTtl ?? MAX_TTL_MS);
    let fence='',fenceArgs=[];
    if(exportAuthorization!==undefined) {
      const {hostId,runnerTokenSha256,leaseOwner,runId}=exportAuthorization;
      tokenHash(runnerTokenSha256);
      assertBridge(typeof hostId==='string' && typeof leaseOwner==='string' && typeof runId==='string',
        'DIRECT_EXPORT_DENIED','export authority required');
      fence=` AND EXISTS (SELECT 1 FROM direct_hosts h JOIN direct_runs r ON r.host_id=h.host_id
        AND r.bridge_user_id=h.bridge_user_id WHERE h.host_id=? AND h.runner_token_sha256=? AND h.enabled=1
        AND h.bridge_user_id=direct_assets.bridge_user_id AND r.run_id=? AND r.status='RUNNING'
        AND r.lease_owner=? AND r.lease_expires_at>?)`;
      fenceArgs=[hostId,runnerTokenSha256,runId,leaseOwner,now];
    }
    let row=await this.db.prepare(
      `UPDATE direct_assets SET status='READY',persistent=?,upload_token_sha256=NULL,uploaded_at=?,expires_at=?
       WHERE asset_id=? AND bridge_user_id=? AND object_key=? AND status='WAITING_UPLOAD'
       AND upload_token_sha256 IS NULL AND expires_at>?`+fence+` RETURNING *`
    ).bind(persistent?1:0,now,expiresAt,id,owner,objectKey,now,...fenceArgs).first();
    if(!row) row=await this.db.prepare(
      `SELECT * FROM direct_assets WHERE asset_id=? AND bridge_user_id=? AND object_key=? AND status='READY'
       AND (persistent=1 OR expires_at>?)`+fence+` LIMIT 1`
    ).bind(id,owner,objectKey,now,...fenceArgs).first();
    assertBridge(row,exportAuthorization ? 'DIRECT_RUN_STALE' : 'DIRECT_ASSET_CONFLICT',
      'prepared object or export authority is stale');
    return normalize(row);
  }

  async listRetiredObjects({limit=100}={}) {
    assertBridge(Number.isInteger(limit) && limit>=1 && limit<=500,'DIRECT_ASSET_INVALID','cleanup limit invalid');
    const now=this.clock();
    const rows=await this.db.prepare(
      `SELECT object_key, retirement_token FROM direct_asset_object_retirements retirement
       WHERE NOT EXISTS (SELECT 1 FROM direct_assets WHERE object_key=retirement.object_key
         AND ((status='WAITING_UPLOAD' AND expires_at>${now})
           OR (status='READY' AND (persistent=1 OR expires_at>${now} OR ${activeRunReference(now)}))))
       ORDER BY retired_at,object_key LIMIT ?`
    ).bind(limit).all();
    return (rows.results ?? []).map(row=>({objectKey:row.object_key,retirementToken:row.retirement_token}));
  }

  async acknowledgeRetiredObjects({objects}={}) {
    assertBridge(Array.isArray(objects) && objects.length>0 && objects.length<=500 &&
      objects.every(item=>typeof item?.objectKey==='string' && item.objectKey.length>0 && item.objectKey.length<=512 &&
        typeof item.retirementToken==='string' && /^[0-9a-f]{32}$/.test(item.retirementToken)),
      'DIRECT_ASSET_INVALID','retired object identities invalid');
    // A late writer renews the opaque token, including after deletion/reinsertion.
    // A cleanup pass can acknowledge only the exact retirement it read.
    for(let offset=0;offset<objects.length;offset+=50) {
      const chunk=objects.slice(offset,offset+50);
      await this.db.prepare(`DELETE FROM direct_asset_object_retirements
        WHERE ${chunk.map(()=>'(object_key=? AND retirement_token=?)').join(' OR ')}`)
        .bind(...chunk.flatMap(item=>[item.objectKey,item.retirementToken])).run();
    }
  }

  async rememberRetiredObject({assetId:value,objectKey}={}) {
    assetId(value);
    assertBridge(typeof objectKey==='string' && objectKey.startsWith('direct-assets/') && objectKey.length<=512,
      'DIRECT_ASSET_INVALID','retired object identity invalid');
    // Also cover late puts to a current-but-expired generation, or pruned metadata.
    // Expired generations cannot publish again: prepareReady must replace the key.
    // Keep live WAITING/READY objects intact, including concurrent successful retries.
    const now=this.clock();
    const row=await this.db.prepare(`INSERT INTO direct_asset_object_retirements(object_key,retired_at,retirement_token)
      SELECT ?,?,lower(hex(randomblob(16))) WHERE NOT EXISTS (SELECT 1 FROM direct_assets WHERE object_key=?
        AND ((status='WAITING_UPLOAD' AND expires_at>?) OR (status='READY' AND (persistent=1 OR expires_at>? OR ${activeRunReference(now)}))))
      ON CONFLICT(object_key) DO UPDATE SET retired_at=excluded.retired_at,retirement_token=excluded.retirement_token
      RETURNING object_key`)
      .bind(objectKey,now,objectKey,now,now).first();
    return Boolean(row);
  }

  async findReadyBySource({bridgeUserId:valueBridgeUserId,sourceKind,sourceRef}={}) {
    const owner=bridgeUserId(valueBridgeUserId);
    const kind=sourceValue(sourceKind,'sourceKind');
    const ref=sourceValue(sourceRef,'sourceRef');
    assertBridge(kind!==null && ref!==null,'DIRECT_ASSET_INVALID','source identity required');
    const now=this.clock();
    const row=await this.db.prepare(
      `SELECT *
       FROM direct_assets
       WHERE bridge_user_id=?
         AND source_kind=?
         AND source_ref=?
         AND status='READY'
         AND (persistent=1 OR expires_at>?)
       LIMIT 1`
    ).bind(owner,kind,ref,now).first();
    return normalize(row);
  }

  async getOwnedReady({principal,assetId:value}={}) {
    const active=assertAuthenticatedPrincipal(principal);
    const id=assetId(value);
    const now=this.clock();
    const row=await this.db.prepare(
      `SELECT *
       FROM direct_assets
       WHERE asset_id=?
         AND bridge_user_id=?
         AND status='READY'
         AND (persistent=1 OR expires_at>?)
       LIMIT 1`
    ).bind(id,active.bridgeUserId,now).first();
    assertBridge(row,'DIRECT_ASSET_DENIED',`asset expired, unavailable or not owned: ${id}`);
    return {...normalize(row),objectKey:row.object_key};
  }

  async markDeletedOwned({principal,assetId:value}={}) {
    const active=assertAuthenticatedPrincipal(principal);
    const id=assetId(value);
    const now=this.clock();
    const row=await this.db.prepare(
      `UPDATE direct_assets
       SET status='EXPIRED',
           expires_at=?,
           upload_token_sha256=NULL,
           source_kind=NULL,
           source_ref=NULL
       WHERE asset_id=?
         AND bridge_user_id=?
         AND status='READY'
         AND persistent=1
       RETURNING *`
    ).bind(now,id,active.bridgeUserId).first();
    assertBridge(row,'DIRECT_ASSET_DENIED',`persistent asset is not ready or not owned: ${id}`);
    return normalize(row);
  }

  async authorizeUpload({assetId:value,uploadTokenSha256}={}) {
    const id=assetId(value);
    const token=tokenHash(uploadTokenSha256);
    const now=this.clock();
    const row=await this.db.prepare(
      `SELECT *
       FROM direct_assets
       WHERE asset_id=?
         AND upload_token_sha256=?
         AND status='WAITING_UPLOAD'
         AND expires_at>?
       LIMIT 1`
    ).bind(id,token,now).first();
    assertBridge(row,'DIRECT_ASSET_UPLOAD_DENIED','asset upload ticket invalid or expired');
    return {...normalize(row),objectKey:row.object_key};
  }

  async markReady({
    assetId:value,
    uploadTokenSha256,
    actualSizeBytes,
    actualSha256
  }={}) {
    const id=assetId(value);
    const token=tokenHash(uploadTokenSha256);
    const size=sizeBytes(actualSizeBytes);
    const digest=sha256(actualSha256);
    const now=this.clock();
    let row=await this.db.prepare(
      `UPDATE direct_assets
       SET status='READY',
           upload_token_sha256=NULL,
           uploaded_at=?
       WHERE asset_id=?
         AND upload_token_sha256=?
         AND status='WAITING_UPLOAD'
         AND expires_at>?
         AND size_bytes=?
         AND sha256=?
       RETURNING *`
    ).bind(now,id,token,now,size,digest).first();
    if(!row) {
      row=await this.db.prepare(
        `SELECT * FROM direct_assets
         WHERE asset_id=?
           AND status='READY'
           AND size_bytes=?
           AND sha256=?
         LIMIT 1`
      ).bind(id,size,digest).first();
    }
    assertBridge(row,'DIRECT_ASSET_UPLOAD_DENIED','asset bytes do not match upload ticket or ticket is stale');
    return normalize(row);
  }

  async getRun({principal,runId}={}) {
    const active=assertAuthenticatedPrincipal(principal);
    const id=assetRunId(runId);
    const row=await this.db.prepare(
      `SELECT *
       FROM direct_assets
       WHERE asset_id=? AND bridge_user_id=?
       LIMIT 1`
    ).bind(id,active.bridgeUserId).first();
    assertBridge(row,'RUN_NOT_FOUND',`asset run not found: ${runId}`);
    return normalize(row);
  }

  async getResult({principal,runId}={}) {
    const value=await this.getRun({principal,runId});
    assertBridge(value.persistent || value.expiresAt>this.clock(),'DIRECT_ASSET_EXPIRED',
      'This temporary file has expired; import or generate it again. Existing local copies are unchanged',
      {expiresAt:value.expiresAt});
    assertBridge(value.status==='READY','RESULT_NOT_READY',`asset is not ready: ${runId}`);
    return value;
  }

  async assertReady({principal,assetIds}={}) {
    const active=assertAuthenticatedPrincipal(principal);
    assertBridge(
      Array.isArray(assetIds) && assetIds.length>=1 && assetIds.length<=8,
      'DIRECT_ASSET_INVALID',
      'assets must contain 1-8 asset ids'
    );
    const unique=[...new Set(assetIds.map(assetId))];
    assertBridge(unique.length===assetIds.length,'DIRECT_ASSET_INVALID','asset ids must be unique');
    const now=this.clock();
    const results=[];
    for(const id of unique) {
      const row=await this.db.prepare(
        `SELECT *
         FROM direct_assets
         WHERE asset_id=?
           AND bridge_user_id=?
           AND status='READY'
           AND (persistent=1 OR expires_at>?)
         LIMIT 1`
      ).bind(id,active.bridgeUserId,now).first();
      assertBridge(row,'DIRECT_ASSET_DENIED',`asset expired, unavailable or not owned: ${id}`);
      results.push(normalize(row));
    }
    return results;
  }

  async authorizeRunnerDownload({
    hostId,
    runnerTokenSha256,
    assetId:value,
    runId,
    leaseOwner
  }={}) {
    const id=assetId(value);
    tokenHash(runnerTokenSha256);
    const parsed=typeof runId==='string' ? DIRECT_RUN_ID.exec(runId) : null;
    assertBridge(parsed && parsed[1]===hostId,'DIRECT_ASSET_DENIED','runner asset run binding invalid');
    assertBridge(
      typeof leaseOwner==='string' && LEASE_OWNER.test(leaseOwner),
      'DIRECT_ASSET_DENIED',
      'runner asset lease binding invalid'
    );
    const now=this.clock();
    const row=await this.db.prepare(
      `SELECT a.*, h.host_id, r.request_json
       FROM direct_assets a
       JOIN direct_hosts h
         ON h.bridge_user_id=a.bridge_user_id
       JOIN direct_runs r
         ON r.bridge_user_id=a.bridge_user_id
        AND r.host_id=h.host_id
       WHERE a.asset_id=?
         AND a.status='READY'
         AND (a.persistent=1 OR a.expires_at>? OR (r.created_at<a.expires_at AND r.expires_at+3700000>${now}))
         AND h.host_id=?
         AND h.runner_token_sha256=?
         AND h.enabled=1
         AND r.run_id=?
         AND r.status='RUNNING'
         AND r.lease_owner=?
         AND r.lease_expires_at>?
       LIMIT 1`
    ).bind(id,now,hostId,runnerTokenSha256,runId,leaseOwner,now).first();
    assertBridge(row,'DIRECT_ASSET_DENIED','runner asset access denied');
    let request;
    try { request=JSON.parse(row.request_json); }
    catch { assertBridge(false,'DIRECT_ASSET_DENIED','runner asset run request is invalid'); }
    assertBridge(
      Array.isArray(request?.assets) && request.assets.some(asset=>asset?.assetId===id),
      'DIRECT_ASSET_DENIED',
      'asset is not declared by the active Direct Run'
    );
    return {...normalize(row),objectKey:row.object_key};
  }

  async listExpired({limit=100}={}) {
    assertBridge(Number.isInteger(limit) && limit>=1 && limit<=500,'DIRECT_ASSET_INVALID','cleanup limit invalid');
    const now=this.clock();
    const result=await this.db.prepare(
      `SELECT asset_id, object_key
       FROM direct_assets
       WHERE expires_at<=?
         AND (
           status='WAITING_UPLOAD' OR
           (persistent=0 AND status='READY')
         )
         AND NOT ${activeRunReference(now)}
       ORDER BY expires_at ASC
       LIMIT ?`
    ).bind(now,limit).all();
    return Array.isArray(result?.results) ? result.results.map(row=>({
      assetId:row.asset_id,
      objectKey:row.object_key
    })) : [];
  }

  async markExpired({assetIds,objects}={}) {
    assertBridge(
      Array.isArray(assetIds) && assetIds.length>=1 && assetIds.length<=500,
      'DIRECT_ASSET_INVALID',
      'assetIds must contain 1-500 ids'
    );
    const ids=[...new Set(assetIds.map(assetId))];
    assertBridge(ids.length===assetIds.length,'DIRECT_ASSET_INVALID','assetIds must be unique');
    const now=this.clock();
    const placeholders=ids.map(()=>'?').join(',');
    if(objects!==undefined) assertBridge(Array.isArray(objects) && objects.length===ids.length &&
      new Set(objects.map(item=>item?.assetId)).size===ids.length &&
      objects.every(item=>ids.includes(item.assetId) && typeof item.objectKey==='string'),
      'DIRECT_ASSET_INVALID','cleanup object identities invalid');
    // D1 allows at most 100 bound parameters per statement. Generation fences
    // need three per asset plus the cutoff; the legacy path needs one per asset.
    const chunkSize=objects===undefined ? 99 : 33;
    if(ids.length>chunkSize) {
      const marked=[];
      for(let offset=0;offset<ids.length;offset+=chunkSize) {
        const chunk=ids.slice(offset,offset+chunkSize);
        marked.push(...await this.markExpired({assetIds:chunk,
          ...(objects===undefined ? {} : {objects:objects.filter(item=>chunk.includes(item.assetId))})}));
      }
      return marked;
    }
    const generation=objects===undefined ? '' : ' AND ('+objects.map(()=>'(asset_id=? AND object_key=?)').join(' OR ')+')';
    const generationArgs=objects?.flatMap(item=>[item.assetId,item.objectKey]) ?? [];
    const predicate=`asset_id IN (${placeholders}) AND expires_at<=?
      AND (status='WAITING_UPLOAD' OR (persistent=0 AND status='READY'))
      AND NOT ${activeRunReference(now)} ${generation}`;
    const args=[...ids,now,...generationArgs];
    // D1 batch is transactional: bytes become unbindable and their durable
    // deletion receipt exists together. Failed R2 deletes remain retryable.
    const results=await this.db.batch([
      this.db.prepare(`INSERT INTO direct_asset_object_retirements(object_key,retired_at,retirement_token)
        SELECT object_key,${now},lower(hex(randomblob(16))) FROM direct_assets WHERE ${predicate}
        ON CONFLICT(object_key) DO UPDATE SET retired_at=excluded.retired_at,retirement_token=excluded.retirement_token`).bind(...args),
      this.db.prepare(`UPDATE direct_assets SET status='EXPIRED',upload_token_sha256=NULL
        WHERE ${predicate} RETURNING asset_id`).bind(...args)
    ]);
    const result=results[1];
    return Array.isArray(result?.results)
      ? result.results.map(row=>row.asset_id)
      : [];
  }

  async pruneExpiredMetadata({
    retentionMs=7*24*60*60*1000,
    limit=100
  }={}) {
    assertBridge(
      Number.isInteger(retentionMs) &&
        retentionMs>=24*60*60*1000 &&
        retentionMs<=90*24*60*60*1000,
      'DIRECT_ASSET_INVALID',
      'asset metadata retention invalid'
    );
    assertBridge(
      Number.isInteger(limit) && limit>=1 && limit<=500,
      'DIRECT_ASSET_INVALID',
      'asset metadata prune limit invalid'
    );
    const cutoff=this.clock()-retentionMs;
    const result=await this.db.prepare(
      `DELETE FROM direct_assets
       WHERE asset_id IN (
         SELECT asset_id
         FROM direct_assets
         WHERE status='EXPIRED'
           AND expires_at<=?
         ORDER BY expires_at ASC
         LIMIT ?
       )
       RETURNING asset_id`
    ).bind(cutoff,limit).all();
    return {
      removed:Array.isArray(result?.results) ? result.results.length : 0
    };
  }

}
