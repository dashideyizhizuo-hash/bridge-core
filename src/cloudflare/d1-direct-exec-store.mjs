import { assertBridge } from '../errors.mjs';
import { assertAuthenticatedPrincipal } from '../auth/principal.mjs';
import { assertDirectFileArgv, validateDirectExecRequest } from '../direct-exec.mjs';
import {DIRECT_RUN_PROGRESS_VERSION,directRunProgressFromRow,validateDirectRunProgress} from '../direct-run-progress.mjs';

const HOST_PATTERN=/^[A-Za-z0-9_.-]{1,128}$/;
const TOKEN_HASH_PATTERN=/^[0-9a-f]{64}$/;
const LEASE_OWNER_PATTERN=/^[A-Za-z0-9_.:-]{8,200}$/;
const TERMINAL=new Set(['SUCCEEDED','FAILED','CANCELED']);
const MAX_RESULT_BYTES=1_500_000;
const DEFAULT_QUEUE_TTL_MS=15*60*1000;
const MAX_QUEUE_TTL_MS=24*60*60*1000;
const HOST_SEEN_WRITE_INTERVAL_MS=60_000;
// Recheck revocable authority in the statement consuming it, not only in an
// earlier SELECT. Host rotation/disable may commit between awaited D1 calls.
const RUNNER_FENCE=`EXISTS (SELECT 1 FROM direct_hosts h
  WHERE h.host_id=direct_runs.host_id AND h.bridge_user_id=direct_runs.bridge_user_id
    AND h.enabled=1 AND h.runner_token_sha256=?)`;

function assertDb(value) {
  assertBridge(
    value && typeof value.prepare==='function' && typeof value.batch==='function',
    'DIRECT_STORE_CONFIG_INVALID',
    'D1 database binding is required'
  );
  return value;
}

function hostId(value) {
  assertBridge(
    typeof value==='string' && HOST_PATTERN.test(value),
    'DIRECT_HOST_INVALID',
    'hostId is invalid'
  );
  return value;
}

function tokenHash(value) {
  assertBridge(
    typeof value==='string' && TOKEN_HASH_PATTERN.test(value),
    'DIRECT_HOST_INVALID',
    'runner token hash is invalid'
  );
  return value;
}

function leaseOwner(value) {
  assertBridge(
    typeof value==='string' && LEASE_OWNER_PATTERN.test(value),
    'DIRECT_RUN_INVALID',
    'lease owner is invalid'
  );
  return value;
}

function queueTtl(value) {
  const ttl=value ?? DEFAULT_QUEUE_TTL_MS;
  assertBridge(
    Number.isInteger(ttl) && ttl>=30_000 && ttl<=MAX_QUEUE_TTL_MS,
    'DIRECT_RUN_INVALID',
    'queueTtlMs invalid'
  );
  return ttl;
}

function runIdFor(host,requestId) {
  return `dx1:${host}:${requestId}`;
}

export function parseDirectRunId(value) {
  assertBridge(
    typeof value==='string' && value.length<=360,
    'RUN_NOT_FOUND',
    'direct runId invalid'
  );
  const match=/^dx1:([A-Za-z0-9_.-]{1,128}):([A-Za-z0-9._-]{8,160})$/.exec(value);
  assertBridge(match,'RUN_NOT_FOUND','runId is not a Direct Exec run');
  return {hostId:match[1],requestId:match[2]};
}

function parseJson(value,label) {
  assertBridge(typeof value==='string' && value.length>0,'DIRECT_RUN_INVALID',`${label} is missing`);
  try {
    return JSON.parse(value);
  } catch {
    assertBridge(false,'DIRECT_RUN_INVALID',`${label} is invalid JSON`);
  }
}

function normalizeRun(row) {
  if(!row) return null;
  const progress=directRunProgressFromRow(row);
  return {
    runId:row.run_id,
    kind:'direct',
    transport:'direct',
    requestId:row.request_id,
    hostId:row.host_id,
    status:row.status,
    createdAt:Number(row.created_at),
    updatedAt:Number(row.updated_at),
    ...(progress ? {progress} : {}),
    ...(row.expires_at===null || row.expires_at===undefined
      ? {}
      : {expiresAt:Number(row.expires_at)}),
    ...(row.cancel_reason===null || row.cancel_reason===undefined
      ? {}
      : {cancelReason:String(row.cancel_reason)}),
    ...(row.completed_at===null || row.completed_at===undefined
      ? {}
      : {completedAt:Number(row.completed_at)})
  };
}

function canceledResult(row) {
  return {
    schemaVersion:1,
    transport:'direct',
    runId:row.run_id,
    kind:'direct',
    requestId:row.request_id,
    hostId:row.host_id,
    status:'CANCELED',
    error:{
      code:'DIRECT_RUN_CANCELED',
      message:row.cancel_reason ?? 'Direct Run canceled'
    },
    evidence:{stdout:'',stderr:''},
    createdAt:Number(row.created_at),
    completedAt:Number(row.completed_at ?? row.updated_at)
  };
}

export class D1DirectExecStore {
  constructor({db,clock=()=>Date.now()}={}) {
    this.db=assertDb(db);
    assertBridge(typeof clock==='function','DIRECT_STORE_CONFIG_INVALID','clock is required');
    this.clock=clock;
  }

  async registerHost({
    principal,
    hostId:value,
    runnerTokenSha256,
    enabled=true,
    allowRotate=true
  }={}) {
    const active=assertAuthenticatedPrincipal(principal);
    const host=hostId(value);
    const token=tokenHash(runnerTokenSha256);
    assertBridge(typeof enabled==='boolean','DIRECT_HOST_INVALID','enabled must be boolean');

    const existing=await this.db.prepare(
      `SELECT bridge_user_id, runner_token_sha256
       FROM direct_hosts
       WHERE host_id = ?
       LIMIT 1`
    ).bind(host).first();
    assertBridge(
      !existing || existing.bridge_user_id===active.bridgeUserId,
      'DIRECT_HOST_DENIED',
      'host is already owned by another Bridge principal'
    );
    assertBridge(
      !existing || allowRotate===true,
      'DIRECT_HOST_EXISTS',
      'host already exists; explicit replace approval is required'
    );

    const now=this.clock();
    const statements=[
      this.db.prepare(
        `INSERT INTO direct_hosts (
          host_id, bridge_user_id, runner_token_sha256, enabled,
          created_at, updated_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL)
        ${allowRotate===true ? `ON CONFLICT(host_id) DO UPDATE SET
          runner_token_sha256 = excluded.runner_token_sha256,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
        WHERE direct_hosts.bridge_user_id = excluded.bridge_user_id` : 'ON CONFLICT(host_id) DO NOTHING'}`
      ).bind(host,active.bridgeUserId,token,enabled?1:0,now,now)
    ];

    if(existing && existing.runner_token_sha256!==token) {
      statements.push(
        this.db.prepare(
          `UPDATE direct_runs
           SET status='CANCELED',
               cancel_reason='TOKEN_ROTATED',
               lease_owner=NULL,
               lease_expires_at=NULL,
               updated_at=?,
               completed_at=?
           WHERE host_id=? AND status='RUNNING'`
        ).bind(now,now,host)
      );
    }

    const results=await this.db.batch(statements);
    assertBridge(Number(results?.[0]?.meta?.changes ?? 0)===1,
      allowRotate===true?'DIRECT_HOST_DENIED':'DIRECT_HOST_EXISTS',
      'host registration conflicted; explicit replace approval is required');
    return {hostId:host,enabled,rotated:Boolean(existing && existing.runner_token_sha256!==token)};
  }

  async setHostEnabled({principal,hostId:value,enabled}={}) {
    const active=assertAuthenticatedPrincipal(principal);
    const host=hostId(value);
    assertBridge(typeof enabled==='boolean','DIRECT_HOST_INVALID','enabled must be boolean');
    const now=this.clock();

    const statements=[
      this.db.prepare(
        `UPDATE direct_hosts
         SET enabled=?, updated_at=?
         WHERE host_id=? AND bridge_user_id=?`
      ).bind(enabled?1:0,now,host,active.bridgeUserId)
    ];
    if(!enabled) {
      statements.push(
        this.db.prepare(
          `UPDATE direct_runs
           SET status='CANCELED',
               cancel_reason='HOST_DISABLED',
               lease_owner=NULL,
               lease_expires_at=NULL,
               updated_at=?,
               completed_at=?
           WHERE host_id=? AND bridge_user_id=? AND status IN ('QUEUED','RUNNING')
             AND EXISTS (SELECT 1 FROM direct_hosts h WHERE h.host_id=direct_runs.host_id
               AND h.bridge_user_id=direct_runs.bridge_user_id AND h.enabled=0)`
        ).bind(now,now,host,active.bridgeUserId)
      );
    }
    const results=await this.db.batch(statements);
    const changed=Number(results?.[0]?.meta?.changes ?? 0);
    assertBridge(changed===1,'DIRECT_HOST_DENIED',`host not owned by principal: ${host}`);
    return {hostId:host,enabled};
  }

  async listHosts({principal}={}) {
    const active=assertAuthenticatedPrincipal(principal);
    const result=await this.db.prepare(
      `SELECT host_id, enabled, created_at, updated_at, last_seen_at
       FROM direct_hosts
       WHERE bridge_user_id=?
       ORDER BY host_id ASC`
    ).bind(active.bridgeUserId).all();
    const rows=Array.isArray(result?.results) ? result.results : [];
    return rows.map(row=>({
      hostId:row.host_id,
      enabled:Number(row.enabled)===1,
      createdAt:Number(row.created_at),
      updatedAt:Number(row.updated_at),
      ...(row.last_seen_at===null || row.last_seen_at===undefined
        ? {}
        : {lastSeenAt:Number(row.last_seen_at)})
    }));
  }

  async resolveHost({principal,hostId:value}={}) {
    const active=assertAuthenticatedPrincipal(principal);
    if(value!==undefined && value!==null) {
      const host=hostId(value);
      const row=await this.db.prepare(
        `SELECT host_id
         FROM direct_hosts
         WHERE bridge_user_id = ? AND host_id = ? AND enabled = 1
         LIMIT 1`
      ).bind(active.bridgeUserId,host).first();
      assertBridge(row,'DIRECT_HOST_DENIED',`run access denied for host: ${host}`);
      return row.host_id;
    }

    const result=await this.db.prepare(
      `SELECT host_id
       FROM direct_hosts
       WHERE bridge_user_id = ? AND enabled = 1
       ORDER BY host_id ASC
       LIMIT 2`
    ).bind(active.bridgeUserId).all();
    const rows=Array.isArray(result?.results) ? result.results : [];
    assertBridge(rows.length>0,'DIRECT_HOST_DENIED','no Direct Exec host is registered');
    assertBridge(
      rows.length===1,
      'DIRECT_HOST_AMBIGUOUS',
      'multiple Direct Exec hosts are registered; specify host'
    );
    return rows[0].host_id;
  }

  async submit({principal,hostId:value,request,queueTtlMs}={}) {
    const active=assertAuthenticatedPrincipal(principal);
    const host=await this.resolveHost({principal:active,hostId:value});
    const validated=validateDirectExecRequest({...request,hostId:host});
    assertDirectFileArgv(validated.argv);
    const runId=runIdFor(host,validated.requestId);
    const now=this.clock();
    const expiresAt=now+queueTtl(queueTtlMs);
    const requestJson=JSON.stringify(validated);
    const hasAssets=(validated.assets?.length ?? 0)>0;
    // The gateway's early read is UX only. Bind to still-live owned bytes in
    // the same SQL statement as queue admission, racing GC without a gap.
    const assetFence=hasAssets ? ` WHERE NOT EXISTS (
      SELECT 1 FROM json_each(?,'$.assets') input_asset
      LEFT JOIN direct_assets a ON a.asset_id=json_extract(input_asset.value,'$.assetId')
      WHERE a.asset_id IS NULL OR a.bridge_user_id<>? OR a.status<>'READY'
        OR (a.persistent=0 AND a.expires_at<=?)
        OR a.sha256<>json_extract(input_asset.value,'$.sha256')
        OR a.size_bytes<>json_extract(input_asset.value,'$.sizeBytes')
        OR a.file_name<>json_extract(input_asset.value,'$.fileName')
        OR a.mime_type<>json_extract(input_asset.value,'$.mimeType')) RETURNING run_id` : '';
    const values="?, ?, ?, ?, ?, 'QUEUED', NULL, NULL, NULL, ?, ?, NULL, ?, NULL";
    const statement=this.db.prepare(
      `INSERT INTO direct_runs (
        request_id, run_id, bridge_user_id, host_id, request_json, status,
        lease_owner, lease_expires_at, result_json, created_at, updated_at,
        completed_at, expires_at, cancel_reason
      ) ${hasAssets ? 'SELECT '+values+assetFence : 'VALUES ('+values+')'}`
    ).bind(validated.requestId,runId,active.bridgeUserId,host,requestJson,now,now,expiresAt,
      ...(hasAssets ? [requestJson,active.bridgeUserId,now] : []));
    if(hasAssets) assertBridge(await statement.first(),'DIRECT_ASSET_DENIED',
      'Input file expired, changed or is unavailable; import it again before starting a new run');
    else await statement.run();
    return {runId,hostId:host,requestId:validated.requestId,status:'QUEUED',expiresAt};
  }

  async getRun({principal,runId}={}) {
    const active=assertAuthenticatedPrincipal(principal);
    parseDirectRunId(runId);
    const row=await this.db.prepare(
      `SELECT request_id, run_id, host_id, status, created_at, updated_at,
              completed_at, expires_at, cancel_reason,
              progress_phase, execution_elapsed_ms, progress_reported_at, phase_started_at
       FROM direct_runs
       WHERE run_id = ? AND bridge_user_id = ?
       LIMIT 1`
    ).bind(runId,active.bridgeUserId).first();
    assertBridge(row,'RUN_NOT_FOUND',`run not found: ${runId}`);
    return normalizeRun(row);
  }

  async getResult({principal,runId}={}) {
    const active=assertAuthenticatedPrincipal(principal);
    parseDirectRunId(runId);
    const row=await this.db.prepare(
      `SELECT request_id, run_id, host_id, status, result_json,
              created_at, updated_at, completed_at, expires_at, cancel_reason
       FROM direct_runs
       WHERE run_id = ? AND bridge_user_id = ?
       LIMIT 1`
    ).bind(runId,active.bridgeUserId).first();
    assertBridge(row,'RUN_NOT_FOUND',`result not found: ${runId}`);
    assertBridge(TERMINAL.has(row.status),'RESULT_NOT_READY',`result is not ready: ${runId}`);
    if(row.status==='CANCELED' && (row.result_json===null || row.result_json===undefined)) {
      return canceledResult(row);
    }
    assertBridge(typeof row.result_json==='string','DIRECT_RUN_INVALID','terminal Direct Run result is missing');
    const result=parseJson(row.result_json,'direct result');
    return {...result,runId:row.run_id,kind:'direct',transport:'direct'};
  }

  // Applications with account tombstones must override this hook. The base
  // query already requires an extant owner; no paused contact grants execution.
  async assertRunnerOwnerActive(_row) {}

  async recordRunnerContact({host,token,now,allowPausedContact}) {
    await this.db.prepare(`UPDATE direct_hosts SET last_seen_at=?
      WHERE host_id=? AND runner_token_sha256=? AND (?=1 OR enabled=1)
      AND EXISTS(SELECT 1 FROM bridge_users u WHERE u.id=direct_hosts.bridge_user_id)`)
      .bind(now,host,token,allowPausedContact?1:0).run();
  }

  async assertRunner({hostId:value,runnerTokenSha256,allowPausedContact=false,signalPaused=false}={}) {
    const host=hostId(value);
    const token=tokenHash(runnerTokenSha256);
    const row=await this.db.prepare(
      `SELECT h.host_id, h.bridge_user_id, h.enabled, h.last_seen_at
       FROM direct_hosts h JOIN bridge_users u ON u.id=h.bridge_user_id
       WHERE h.host_id = ? AND h.runner_token_sha256 = ?
       LIMIT 1`
    ).bind(host,token).first();
    assertBridge(row,'DIRECT_RUNNER_DENIED','runner authentication failed');
    await this.assertRunnerOwnerActive(row);
    const enabled=Number(row.enabled)===1;
    const denial=signalPaused||allowPausedContact?'DIRECT_HOST_PAUSED':'DIRECT_RUNNER_DENIED';
    if(!enabled&&!allowPausedContact)assertBridge(false,denial,'Host execution is paused by its owner');

    const now=this.clock();
    if(
      row.last_seen_at===null ||
      row.last_seen_at===undefined ||
      Number(row.last_seen_at)<=now-HOST_SEEN_WRITE_INTERVAL_MS
    ) {
      await this.recordRunnerContact({host,token,now,allowPausedContact});
    }
    await this.assertRunnerOwnerActive(row);
    assertBridge(enabled,denial,'Host execution is paused by its owner');
    return host;
  }

  async claimNext({
    hostId:value,
    runnerTokenSha256,
    leaseOwner:valueOwner,
    leaseMs=60_000
  }={}) {
    const host=await this.assertRunner({hostId:value,runnerTokenSha256,allowPausedContact:true});
    const owner=leaseOwner(valueOwner);
    assertBridge(
      Number.isInteger(leaseMs) && leaseMs>=5_000 && leaseMs<=3_700_000,
      'DIRECT_RUN_INVALID',
      'leaseMs invalid'
    );
    const now=this.clock();
    const leaseExpiresAt=now+leaseMs;

    await this.db.batch([
      // Requeue stale work first, then apply queue expiry to the resulting
      // QUEUED set in the same D1 batch. This avoids one polling interval of
      // misleading QUEUED state for a stale run whose queue TTL also expired.
      this.db.prepare(
        `UPDATE direct_runs
         SET status='QUEUED',
             lease_owner=NULL,
             lease_expires_at=NULL,
             updated_at=?
         WHERE host_id=?
           AND status='RUNNING'
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at<=?
           AND result_json IS NULL AND ${RUNNER_FENCE}`
      ).bind(now,host,now,runnerTokenSha256),
      this.db.prepare(
        `UPDATE direct_runs
         SET status='CANCELED',
             cancel_reason='QUEUE_EXPIRED',
             updated_at=?,
             completed_at=?
         WHERE host_id=?
           AND status='QUEUED'
           AND expires_at IS NOT NULL
           AND expires_at<=? AND ${RUNNER_FENCE}`
      ).bind(now,now,host,now,runnerTokenSha256)
    ]);

    const row=await this.db.prepare(
      `UPDATE direct_runs
       SET status='RUNNING',
           lease_owner=?,
           lease_expires_at=?,
           updated_at=?
       WHERE request_id=(
         SELECT request_id
         FROM direct_runs
         WHERE host_id=?
           AND status='QUEUED'
           AND (expires_at IS NULL OR expires_at>?)
         ORDER BY created_at ASC, request_id ASC
         LIMIT 1
       )
         AND status='QUEUED' AND ${RUNNER_FENCE}
       RETURNING request_id, run_id, host_id, request_json,
                 status, lease_expires_at, created_at, updated_at,
                 expires_at, cancel_reason,
                 progress_phase, execution_elapsed_ms, progress_reported_at, phase_started_at`
    ).bind(owner,leaseExpiresAt,now,host,now,runnerTokenSha256).first();

    if(!row) return null;
    const progress=directRunProgressFromRow(row);
    return {
      runId:row.run_id,
      request:validateDirectExecRequest(parseJson(row.request_json,'direct request')),
      leaseOwner:owner,
      leaseExpiresAt:Number(row.lease_expires_at),
      progressVersion:DIRECT_RUN_PROGRESS_VERSION,
      ...(progress ? {progress} : {})
    };
  }

  async renewLease({
    hostId:value,
    runnerTokenSha256,
    leaseOwner:valueOwner,
    runId,
    leaseMs=60_000,
    progress
  }={}) {
    const nextProgress=progress===undefined ? undefined : validateDirectRunProgress(progress);
    const host=await this.assertRunner({hostId:value,runnerTokenSha256,signalPaused:true});
    const owner=leaseOwner(valueOwner);
    const parsed=parseDirectRunId(runId);
    assertBridge(parsed.hostId===host,'DIRECT_RUN_INVALID','run host binding mismatch');
    assertBridge(
      Number.isInteger(leaseMs) && leaseMs>=5_000 && leaseMs<=3_700_000,
      'DIRECT_RUN_INVALID',
      'leaseMs invalid'
    );
    const now=this.clock();
    const leaseExpiresAt=now+leaseMs;
    if(nextProgress) {
      // Phase and elapsed fences are consumed atomically with the same live
      // credential/owner lease. Replay cannot reset a phase or extend a known
      // execution start by refreshing an identical progress observation.
      const row=await this.db.prepare(
        `UPDATE direct_runs
         SET lease_expires_at=?, updated_at=?,
             progress_reported_at=CASE WHEN progress_phase IS NULL OR progress_phase<>? OR execution_elapsed_ms<>?
               THEN ? ELSE progress_reported_at END,
             phase_started_at=CASE WHEN progress_phase IS NULL OR progress_phase<>? THEN ? ELSE phase_started_at END,
             progress_phase=?, execution_elapsed_ms=?
         WHERE run_id=? AND host_id=? AND status='RUNNING' AND lease_owner=?
           AND lease_expires_at>? AND ${RUNNER_FENCE}
           AND (progress_phase IS NULL OR (
             CASE progress_phase WHEN 'PREPARING' THEN 0 WHEN 'EXECUTING' THEN 1 ELSE 2 END
               <= CASE ? WHEN 'PREPARING' THEN 0 WHEN 'EXECUTING' THEN 1 ELSE 2 END
             AND execution_elapsed_ms<=?
             AND (progress_phase<>'RETURNING_RESULT' OR execution_elapsed_ms=?)))
         RETURNING run_id, lease_expires_at, progress_phase, execution_elapsed_ms, progress_reported_at, phase_started_at`
      ).bind(leaseExpiresAt,now,nextProgress.phase,nextProgress.executionElapsedMs,now,
        nextProgress.phase,now,nextProgress.phase,nextProgress.executionElapsedMs,
        runId,host,owner,now,runnerTokenSha256,
        nextProgress.phase,nextProgress.executionElapsedMs,nextProgress.executionElapsedMs).first();
      assertBridge(row,'DIRECT_RUN_STALE','Direct Run lease or progress is stale or canceled');
      return {runId:row.run_id,continue:true,leaseExpiresAt:Number(row.lease_expires_at),progress:directRunProgressFromRow(row)};
    }
    const row=await this.db.prepare(
      `UPDATE direct_runs
       SET lease_expires_at=?, updated_at=?
       WHERE run_id=?
         AND host_id=?
         AND status='RUNNING'
         AND lease_owner=?
         AND lease_expires_at>? AND ${RUNNER_FENCE}
       RETURNING run_id, lease_expires_at`
    ).bind(leaseExpiresAt,now,runId,host,owner,now,runnerTokenSha256).first();
    assertBridge(row,'DIRECT_RUN_STALE','Direct Run lease is stale or canceled');
    return {runId:row.run_id,continue:true,leaseExpiresAt:Number(row.lease_expires_at)};
  }

  async authorizeExportUpload({
    hostId:value,
    runnerTokenSha256,
    leaseOwner:valueOwner,
    runId,
    exportIndex
  }={}) {
    const host=await this.assertRunner({hostId:value,runnerTokenSha256,signalPaused:true});
    const owner=leaseOwner(valueOwner);
    const parsed=parseDirectRunId(runId);
    assertBridge(parsed.hostId===host,'DIRECT_RUN_INVALID','run host binding mismatch');
    assertBridge(
      Number.isInteger(exportIndex) && exportIndex>=0 && exportIndex<8,
      'DIRECT_EXPORT_INVALID',
      'export index invalid'
    );
    const now=this.clock();
    const row=await this.db.prepare(
      `SELECT bridge_user_id, request_json
       FROM direct_runs
       WHERE run_id=?
         AND host_id=?
         AND status='RUNNING'
         AND lease_owner=?
         AND lease_expires_at>? AND ${RUNNER_FENCE}
       LIMIT 1`
    ).bind(runId,host,owner,now,runnerTokenSha256).first();
    assertBridge(row,'DIRECT_RUN_STALE','Direct Run lease is stale or canceled');
    const request=validateDirectExecRequest(parseJson(row.request_json,'direct request'));
    const spec=request.exports?.[exportIndex];
    assertBridge(spec,'DIRECT_EXPORT_DENIED','export slot is not declared by this Direct Run');
    return {
      bridgeUserId:row.bridge_user_id,
      runId,
      exportIndex,
      fileName:spec.fileName,
      mimeType:spec.mimeType,
      maxBytes:spec.maxBytes,
      required:spec.required
    };
  }

  async complete({
    hostId:value,
    runnerTokenSha256,
    leaseOwner:valueOwner,
    runId,
    result
  }={}) {
    const host=await this.assertRunner({hostId:value,runnerTokenSha256,signalPaused:true});
    const owner=leaseOwner(valueOwner);
    const parsed=parseDirectRunId(runId);
    assertBridge(parsed.hostId===host,'DIRECT_RUN_INVALID','run host binding mismatch');
    assertBridge(
      result && typeof result==='object' && !Array.isArray(result),
      'DIRECT_RUN_INVALID',
      'direct result must be an object'
    );
    assertBridge(
      result.requestId===parsed.requestId && result.hostId===host,
      'DIRECT_RUN_INVALID',
      'direct result identity mismatch'
    );
    assertBridge(
      result.status==='SUCCEEDED' || result.status==='FAILED',
      'DIRECT_RUN_INVALID',
      'direct result status must be SUCCEEDED or FAILED'
    );
    const encoded=JSON.stringify(result);
    assertBridge(
      Buffer.byteLength(encoded,'utf8')<=MAX_RESULT_BYTES,
      'DIRECT_RUN_INVALID',
      'direct result exceeds D1-safe byte limit'
    );
    const now=this.clock();
    const row=await this.db.prepare(
      `UPDATE direct_runs
       SET status=?,
           result_json=?,
           lease_owner=NULL,
           lease_expires_at=NULL,
           updated_at=?,
           completed_at=?
       WHERE run_id=?
         AND host_id=?
         AND status='RUNNING'
         AND lease_owner=?
         AND lease_expires_at>? AND ${RUNNER_FENCE}
       RETURNING request_id, run_id, host_id, status,
                 created_at, updated_at, completed_at,
                 expires_at, cancel_reason,
                 progress_phase, execution_elapsed_ms, progress_reported_at, phase_started_at`
    ).bind(
      result.status,
      encoded,
      now,
      now,
      runId,
      host,
      owner,
      now,
      runnerTokenSha256
    ).first();
    assertBridge(row,'DIRECT_RUN_STALE','direct run lease is stale or already completed');
    return normalizeRun(row);
  }

  async pruneTerminal({
    retentionMs=14*24*60*60*1000,
    limit=100
  }={}) {
    assertBridge(
      Number.isInteger(retentionMs) &&
        retentionMs>=24*60*60*1000 &&
        retentionMs<=90*24*60*60*1000,
      'DIRECT_RUN_INVALID',
      'retentionMs invalid'
    );
    assertBridge(
      Number.isInteger(limit) && limit>=1 && limit<=500,
      'DIRECT_RUN_INVALID',
      'prune limit invalid'
    );
    const cutoff=this.clock()-retentionMs;
    const result=await this.db.prepare(
      `DELETE FROM direct_runs
       WHERE request_id IN (
         SELECT request_id
         FROM direct_runs
         WHERE status IN ('SUCCEEDED','FAILED','CANCELED')
           AND completed_at IS NOT NULL
           AND completed_at<=?
         ORDER BY completed_at ASC
         LIMIT ?
       )
       RETURNING request_id`
    ).bind(cutoff,limit).all();
    return {
      removed:Array.isArray(result?.results) ? result.results.length : 0
    };
  }


  async reconcileExpired({limit=100}={}) {
    assertBridge(
      Number.isInteger(limit) && limit>=1 && limit<=500,
      'DIRECT_RUN_INVALID',
      'reconcile limit invalid'
    );
    const now=this.clock();

    const canceledQueued=await this.db.prepare(
      `UPDATE direct_runs
       SET status='CANCELED',
           cancel_reason='QUEUE_EXPIRED',
           lease_owner=NULL,
           lease_expires_at=NULL,
           updated_at=?,
           completed_at=?
       WHERE request_id IN (
         SELECT request_id
         FROM direct_runs
         WHERE status='QUEUED'
           AND expires_at IS NOT NULL
           AND expires_at<=?
         ORDER BY expires_at ASC
         LIMIT ?
       )
       RETURNING request_id`
    ).bind(now,now,now,limit).all();

    const canceledRunning=await this.db.prepare(
      `UPDATE direct_runs
       SET status='CANCELED',
           cancel_reason='LEASE_EXPIRED',
           lease_owner=NULL,
           lease_expires_at=NULL,
           updated_at=?,
           completed_at=?
       WHERE request_id IN (
         SELECT request_id
         FROM direct_runs
         WHERE status='RUNNING'
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at<=?
           AND expires_at IS NOT NULL
           AND expires_at<=?
         ORDER BY lease_expires_at ASC
         LIMIT ?
       )
       RETURNING request_id`
    ).bind(now,now,now,now,limit).all();

    const requeued=await this.db.prepare(
      `UPDATE direct_runs
       SET status='QUEUED',
           lease_owner=NULL,
           lease_expires_at=NULL,
           updated_at=?
       WHERE request_id IN (
         SELECT request_id
         FROM direct_runs
         WHERE status='RUNNING'
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at<=?
           AND (expires_at IS NULL OR expires_at>?)
         ORDER BY lease_expires_at ASC
         LIMIT ?
       )
       RETURNING request_id`
    ).bind(now,now,now,limit).all();

    return {
      canceledQueued:Array.isArray(canceledQueued?.results) ? canceledQueued.results.length : 0,
      canceledRunning:Array.isArray(canceledRunning?.results) ? canceledRunning.results.length : 0,
      requeued:Array.isArray(requeued?.results) ? requeued.results.length : 0
    };
  }

}
