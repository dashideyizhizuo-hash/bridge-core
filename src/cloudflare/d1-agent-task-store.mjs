import { assertBridge } from '../errors.mjs';

const REPOSITORY_PATTERN=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN=/^[0-9a-f]{40}$/;
const MODES=new Set(['supervised','continuous']);
const STATUSES=new Set(['READY','DISPATCHING','RECOVERING','RUNNING','ORPHANED','BLOCKED','DONE']);

function assertDb(value) {
  assertBridge(
    value && typeof value.prepare==='function' && typeof value.batch==='function',
    'TASK_RUNTIME_CONFIG_INVALID',
    'D1 database binding is required'
  );
  return value;
}

function taskKey(value) {
  assertBridge(
    typeof value==='string' &&
      value.length>=3 &&
      value.length<=512 &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/.test(value),
    'TASK_RUNTIME_INVALID',
    'taskKey must be owner/repository#issue-number'
  );
  return value;
}

function repositoryName(value) {
  assertBridge(
    typeof value==='string' && REPOSITORY_PATTERN.test(value),
    'TASK_RUNTIME_INVALID',
    'repository must be owner/name'
  );
  return value;
}

function issueNumber(value) {
  assertBridge(
    Number.isSafeInteger(value) && value>0,
    'TASK_RUNTIME_INVALID',
    'issueNumber must be a positive integer'
  );
  return value;
}

function canonicalBranch(value) {
  assertBridge(
    typeof value==='string' && value.length>=1 && value.length<=255,
    'TASK_RUNTIME_INVALID',
    'canonicalBranch is required'
  );
  return value;
}

function executionMode(value) {
  assertBridge(MODES.has(value),'TASK_RUNTIME_INVALID',`unknown execution mode: ${value}`);
  return value;
}

function taskStatus(value) {
  assertBridge(STATUSES.has(value),'TASK_RUNTIME_INVALID',`unknown task status: ${value}`);
  return value;
}

function boundedIdentity(value,label) {
  assertBridge(
    typeof value==='string' && value.length>=1 && value.length<=256,
    'TASK_RUNTIME_INVALID',
    `${label} is invalid`
  );
  return value;
}

function optionalSha(value,label='checkpointSha') {
  if(value===undefined || value===null) return null;
  assertBridge(SHA_PATTERN.test(value),'TASK_RUNTIME_INVALID',`${label} must be an exact SHA`);
  return value;
}

function optionalCommentId(value) {
  if(value===undefined || value===null) return null;
  assertBridge(
    Number.isSafeInteger(value) && value>0,
    'TASK_RUNTIME_INVALID',
    'stateCommentId must be a positive integer'
  );
  return value;
}

function positiveEpoch(value) {
  assertBridge(
    Number.isSafeInteger(value) && value>0,
    'TASK_BINDING_INVALID',
    'leaseEpoch must be a positive integer'
  );
  return value;
}

function positiveDuration(value,label) {
  assertBridge(
    Number.isSafeInteger(value) && value>0,
    'TASK_RUNTIME_CONFIG_INVALID',
    `${label} must be a positive integer`
  );
  return value;
}

function iso(value) {
  assertBridge(Number.isFinite(value),'TASK_RUNTIME_INVALID','timestamp is invalid');
  return new Date(value).toISOString();
}

function normalizeRow(row) {
  if(!row) return null;
  return {
    taskKey:row.task_key,
    bridgeUserId:row.bridge_user_id ?? null,
    repository:row.repository,
    issueNumber:Number(row.issue_number),
    canonicalBranch:row.canonical_branch,
    mode:row.mode,
    status:row.status,
    dispatchId:row.dispatch_id ?? null,
    dispatchExpiresAt:row.dispatch_expires_at ?? null,
    leaseOwner:row.lease_owner ?? null,
    leaseEpoch:Number(row.lease_epoch),
    leaseExpiresAt:row.lease_expires_at ?? null,
    activeRunId:row.active_run_id ?? null,
    launchId:row.launch_id ?? null,
    launchStartedAt:row.launch_started_at ?? null,
    launcherReceiptJson:row.launcher_receipt_json ?? null,
    checkpointSha:row.checkpoint_sha ?? null,
    stateCommentId:row.state_comment_id===null || row.state_comment_id===undefined
      ? null
      : Number(row.state_comment_id),
    lastTransitionReason:row.last_transition_reason ?? null,
    updatedAt:row.updated_at
  };
}

function assertEnrollmentIdentity(record,{repository,issueNumber,canonicalBranch}) {
  assertBridge(
    record.repository===repository &&
      record.issueNumber===issueNumber &&
      record.canonicalBranch===canonicalBranch,
    'TASK_ENROLLMENT_CONFLICT',
    'durable task identity conflicts with the existing enrollment'
  );
}

export class D1AgentTaskStore {
  constructor({
    db,
    clock=()=>Date.now(),
    randomUUID=()=>globalThis.crypto.randomUUID(),
    dispatchTtlMs=10*60*1000,
    leaseTtlMs=15*60*1000
  }={}) {
    this.db=assertDb(db);
    assertBridge(typeof clock==='function','TASK_RUNTIME_CONFIG_INVALID','clock is required');
    assertBridge(typeof randomUUID==='function','TASK_RUNTIME_CONFIG_INVALID','randomUUID is required');
    this.clock=clock;
    this.randomUUID=randomUUID;
    this.dispatchTtlMs=positiveDuration(dispatchTtlMs,'dispatchTtlMs');
    this.leaseTtlMs=positiveDuration(leaseTtlMs,'leaseTtlMs');
  }

  async getTask(value) {
    const key=taskKey(value);
    const row=await this.db.prepare(
      `SELECT *
       FROM agent_tasks
       WHERE task_key = ?
       LIMIT 1`
    ).bind(key).first();
    return normalizeRow(row);
  }

  async createTask({
    taskKey:value,
    bridgeUserId=null,
    repository,
    issueNumber:issue,
    canonicalBranch:branch,
    mode='supervised',
    status='READY',
    checkpointSha,
    stateCommentId,
    reason='TASK_ENROLLED'
  }={}) {
    const key=taskKey(value);
    const owner=bridgeUserId===null ? null : boundedIdentity(bridgeUserId,'bridgeUserId');
    const repo=repositoryName(repository);
    const number=issueNumber(issue);
    const canonical=canonicalBranch(branch);
    const taskMode=executionMode(mode);
    const initialStatus=taskStatus(status);
    assertBridge(
      initialStatus==='READY' || initialStatus==='BLOCKED',
      'TASK_RUNTIME_INVALID',
      'new tasks may be enrolled only as READY or BLOCKED'
    );
    const checkpoint=optionalSha(checkpointSha);
    const commentId=optionalCommentId(stateCommentId);
    const now=iso(this.clock());

    await this.db.prepare(
      `INSERT INTO agent_tasks (
        task_key, bridge_user_id, repository, issue_number, canonical_branch,
        mode, status,
        dispatch_id, dispatch_expires_at,
        lease_owner, lease_epoch, lease_expires_at,
        active_run_id,
        checkpoint_sha, state_comment_id,
        last_transition_reason, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, NULL, NULL, ?, ?, ?, ?)
      ON CONFLICT(task_key) DO NOTHING`
    ).bind(
      key,owner,repo,number,canonical,
      taskMode,initialStatus,
      checkpoint,commentId,
      boundedIdentity(reason,'reason'),now
    ).run();

    const record=await this.getTask(key);
    assertBridge(record,'TASK_NOT_FOUND','unable to persist durable task enrollment');
    assertEnrollmentIdentity(record,{repository:repo,issueNumber:number,canonicalBranch:canonical});
    if(owner!==null) {
      assertBridge(
        record.bridgeUserId===owner,
        'TASK_ENROLLMENT_CONFLICT',
        'durable task is owned by another Bridge principal'
      );
    }
    return record;
  }

  async listWatchableTasks({limit=100}={}) {
    assertBridge(
      Number.isSafeInteger(limit) && limit>=1 && limit<=500,
      'TASK_RUNTIME_INVALID',
      'watchable task limit must be between 1 and 500'
    );
    const result=await this.db.prepare(
      `SELECT *
       FROM agent_tasks
       WHERE bridge_user_id IS NOT NULL
         AND status NOT IN ('BLOCKED', 'DONE')
       ORDER BY updated_at ASC
       LIMIT ?`
    ).bind(limit).all();
    const rows=Array.isArray(result?.results) ? result.results : [];
    return rows.map(normalizeRow);
  }

  async dispatch(value,{reason='WORKER_NEEDED'}={}) {
    const key=taskKey(value);
    const nowMs=this.clock();
    const now=iso(nowMs);
    const dispatchId=`dispatch-${this.randomUUID()}`;
    const expiresAt=iso(nowMs+this.dispatchTtlMs);
    const row=await this.db.prepare(
      `/* agent-task:dispatch */
       UPDATE agent_tasks
       SET status = 'DISPATCHING',
           dispatch_id = ?,
           dispatch_expires_at = ?,
           lease_owner = NULL,
           lease_expires_at = NULL,
           active_run_id = NULL,
           launch_id = NULL,
           launch_started_at = NULL,
           launcher_receipt_json = NULL,
           last_transition_reason = ?,
           updated_at = ?
       WHERE task_key = ?
         AND (
           status IN ('READY', 'ORPHANED')
           OR (
             status = 'DISPATCHING'
             AND dispatch_expires_at IS NOT NULL
             AND dispatch_expires_at <= ?
           )
         )
       RETURNING *`
    ).bind(
      dispatchId,expiresAt,boundedIdentity(reason,'reason'),now,key,now
    ).first();
    if(!row) return null;
    return normalizeRow(row);
  }

  async claimLaunch({
    taskKey:value,
    dispatchId,
    launchId,
    reason='LAUNCH_CLAIMED'
  }={}) {
    const key=taskKey(value);
    const dispatch=boundedIdentity(dispatchId,'dispatchId');
    const launch=boundedIdentity(launchId,'launchId');
    const now=iso(this.clock());
    const row=await this.db.prepare(
      `/* agent-task:claim-launch */
       UPDATE agent_tasks
       SET launch_id = ?,
           launch_started_at = ?,
           launcher_receipt_json = NULL,
           last_transition_reason = ?,
           updated_at = ?
       WHERE task_key = ?
         AND status = 'DISPATCHING'
         AND dispatch_id = ?
         AND dispatch_expires_at IS NOT NULL
         AND dispatch_expires_at > ?
         AND launch_id IS NULL
       RETURNING *`
    ).bind(
      launch,now,boundedIdentity(reason,'reason'),now,
      key,dispatch,now
    ).first();
    return normalizeRow(row);
  }

  async recordLaunchReceipt({
    taskKey:value,
    dispatchId,
    launchId,
    receipt,
    reason='LAUNCH_RECEIPT_RECORDED'
  }={}) {
    const key=taskKey(value);
    const dispatch=boundedIdentity(dispatchId,'dispatchId');
    const launch=boundedIdentity(launchId,'launchId');
    let json;
    try { json=JSON.stringify(receipt); }
    catch {
      assertBridge(false,'TASK_RUNTIME_INVALID','launcher receipt must be JSON serializable');
    }
    assertBridge(
      typeof json==='string' && Buffer.byteLength(json,'utf8')<=4096,
      'TASK_RUNTIME_INVALID',
      'launcher receipt exceeds 4096 bytes'
    );
    const now=iso(this.clock());
    const row=await this.db.prepare(
      `/* agent-task:record-launch-receipt */
       UPDATE agent_tasks
       SET launcher_receipt_json = ?,
           last_transition_reason = ?,
           updated_at = ?
       WHERE task_key = ?
         AND status = 'DISPATCHING'
         AND dispatch_id = ?
         AND launch_id = ?
         AND dispatch_expires_at IS NOT NULL
         AND dispatch_expires_at > ?
       RETURNING *`
    ).bind(
      json,boundedIdentity(reason,'reason'),now,
      key,dispatch,launch,now
    ).first();
    return normalizeRow(row);
  }

  async assertCurrent({
    taskKey:value,
    leaseEpoch,
    repository,
    canonicalBranch:branch,
    baseSha,
    workerId
  }={}) {
    const key=taskKey(value);
    const epoch=positiveEpoch(leaseEpoch);
    const repo=repositoryName(repository);
    const canonical=canonicalBranch(branch);
    optionalSha(baseSha,'baseSha');
    const expectedWorker=workerId===undefined
      ? null
      : boundedIdentity(workerId,'workerId');
    const record=await this.getTask(key);
    assertBridge(record,'TASK_NOT_FOUND',`durable task is not enrolled: ${key}`);
    assertBridge(
      record.repository===repo && record.canonicalBranch===canonical,
      'TASK_BINDING_MISMATCH',
      'task repository/canonical branch no longer matches the bound Bridge Run'
    );
    const now=this.clock();
    const expires=Date.parse(record.leaseExpiresAt ?? '');
    assertBridge(
      (record.status==='RECOVERING' || record.status==='RUNNING') &&
        record.leaseOwner!==null &&
        (expectedWorker===null || record.leaseOwner===expectedWorker) &&
        record.leaseEpoch===epoch &&
        Number.isFinite(expires) &&
        expires>now,
      'TASK_LEASE_STALE',
      'task lease is stale or no longer owns the bounded stage',
      {
        taskKey:key,
        leaseEpoch:epoch,
        currentLeaseEpoch:record.leaseEpoch,
        status:record.status,
        ...(expectedWorker===null ? {} : {workerId:expectedWorker})
      }
    );
    return record;
  }

  async bindRun({
    taskKey:value,
    leaseEpoch,
    repository,
    canonicalBranch:branch,
    baseSha,
    runId,
    workerId,
    reason='BRIDGE_RUN_BOUND'
  }={}) {
    const key=taskKey(value);
    const epoch=positiveEpoch(leaseEpoch);
    const repo=repositoryName(repository);
    const canonical=canonicalBranch(branch);
    optionalSha(baseSha,'baseSha');
    const id=boundedIdentity(runId,'runId');
    await this.assertCurrent({
      taskKey:key,
      leaseEpoch:epoch,
      repository:repo,
      canonicalBranch:canonical,
      baseSha,
      ...(workerId===undefined ? {} : {workerId})
    });
    const now=iso(this.clock());
    const row=await this.db.prepare(
      `/* agent-task:bind-run */
       UPDATE agent_tasks
       SET status = 'RUNNING',
           active_run_id = ?,
           last_transition_reason = ?,
           updated_at = ?
       WHERE task_key = ?
         AND repository = ?
         AND canonical_branch = ?
         AND lease_epoch = ?
         AND status IN ('RECOVERING', 'RUNNING')
         AND lease_owner IS NOT NULL
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at > ?
       RETURNING *`
    ).bind(
      id,boundedIdentity(reason,'reason'),now,
      key,repo,canonical,epoch,now
    ).first();
    assertBridge(
      row,
      'TASK_LEASE_STALE',
      'task lease became stale before the Bridge Run could be bound'
    );
    return normalizeRow(row);
  }

  async renewActiveRun({
    taskKey:value,
    leaseEpoch,
    runId,
    reason='ACTIVE_BRIDGE_RUN'
  }={}) {
    const key=taskKey(value);
    const epoch=positiveEpoch(leaseEpoch);
    const id=boundedIdentity(runId,'runId');
    const nowMs=this.clock();
    const now=iso(nowMs);
    const leaseExpiresAt=iso(nowMs+this.leaseTtlMs);
    const results=await this.db.batch([
      this.db.prepare(
        `/* agent-task:renew-active-run */
       UPDATE agent_tasks
       SET status = 'RUNNING',
           lease_expires_at = ?,
           last_transition_reason = ?,
           updated_at = ?
       WHERE task_key = ?
         AND lease_epoch = ?
         AND lease_owner IS NOT NULL
         AND status IN ('RECOVERING', 'RUNNING')
         AND active_run_id = ?
       RETURNING *`
      ).bind(
        leaseExpiresAt,boundedIdentity(reason,'reason'),now,
        key,epoch,id
      ),
      this.db.prepare(
        `/* agent-task:renew-active-run-sessions */
         UPDATE agent_task_sessions
         SET expires_at = ?
         WHERE task_key = ?
           AND lease_epoch = ?
           AND expires_at > ?
           AND worker_id = (
             SELECT lease_owner
             FROM agent_tasks
             WHERE task_key = ?
               AND lease_epoch = ?
               AND active_run_id = ?
               AND status = 'RUNNING'
               AND lease_expires_at = ?
           )`
      ).bind(leaseExpiresAt,key,epoch,now,key,epoch,id,leaseExpiresAt)
    ]);
    const row=Array.isArray(results?.[0]?.results)
      ? results[0].results[0] ?? null
      : null;
    return normalizeRow(row);
  }

  async markOrphaned({
    taskKey:value,
    leaseEpoch,
    reason='LEASE_EXPIRED'
  }={}) {
    const key=taskKey(value);
    const epoch=positiveEpoch(leaseEpoch);
    const now=iso(this.clock());
    const row=await this.db.prepare(
      `/* agent-task:mark-orphaned */
       UPDATE agent_tasks
       SET status = 'ORPHANED',
           lease_owner = NULL,
           lease_expires_at = NULL,
           active_run_id = NULL,
           last_transition_reason = ?,
           updated_at = ?
       WHERE task_key = ?
         AND lease_epoch = ?
         AND status IN ('RECOVERING', 'RUNNING')
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at <= ?
       RETURNING *`
    ).bind(
      boundedIdentity(reason,'reason'),now,key,epoch,now
    ).first();
    return normalizeRow(row);
  }

  async completeStage({
    taskKey:value,
    leaseEpoch,
    checkpointSha,
    stateCommentId,
    status='READY',
    reason='STAGE_CHECKPOINTED'
  }={}) {
    const key=taskKey(value);
    const epoch=positiveEpoch(leaseEpoch);
    const checkpoint=optionalSha(checkpointSha);
    assertBridge(checkpoint!==null,'TASK_RUNTIME_INVALID','checkpointSha is required');
    const commentId=optionalCommentId(stateCommentId);
    assertBridge(commentId!==null,'TASK_RUNTIME_INVALID','stateCommentId is required');
    assertBridge(
      status==='READY' || status==='DONE',
      'TASK_RUNTIME_INVALID',
      'completed stage status must be READY or DONE'
    );
    const now=iso(this.clock());
    const row=await this.db.prepare(
      `/* agent-task:complete-stage */
       UPDATE agent_tasks
       SET status = ?,
           lease_owner = NULL,
           lease_expires_at = NULL,
           active_run_id = NULL,
           checkpoint_sha = ?,
           state_comment_id = ?,
           last_transition_reason = ?,
           updated_at = ?
       WHERE task_key = ?
         AND lease_epoch = ?
         AND lease_owner IS NOT NULL
         AND status IN ('RECOVERING', 'RUNNING')
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at > ?
       RETURNING *`
    ).bind(
      status,checkpoint,commentId,boundedIdentity(reason,'reason'),now,
      key,epoch,now
    ).first();
    return normalizeRow(row);
  }

  async reconcileExpired({
    taskKey:value,
    leaseEpoch,
    status,
    checkpointSha,
    stateCommentId,
    reason='GITHUB_DURABLE_STATE_RECONCILED'
  }={}) {
    const key=taskKey(value);
    const epoch=positiveEpoch(leaseEpoch);
    assertBridge(
      status==='READY' || status==='BLOCKED' || status==='DONE',
      'TASK_RUNTIME_INVALID',
      'reconciled status must be READY, BLOCKED or DONE'
    );
    const checkpoint=status==='BLOCKED' ? null : optionalSha(checkpointSha);
    const commentId=status==='BLOCKED' ? null : optionalCommentId(stateCommentId);
    if(status!=='BLOCKED') {
      assertBridge(checkpoint!==null,'TASK_RUNTIME_INVALID','checkpointSha is required');
      assertBridge(commentId!==null,'TASK_RUNTIME_INVALID','stateCommentId is required');
    }
    const now=iso(this.clock());
    const row=await this.db.prepare(
      `/* agent-task:reconcile-expired */
       UPDATE agent_tasks
       SET status = ?,
           lease_owner = NULL,
           lease_expires_at = NULL,
           active_run_id = NULL,
           checkpoint_sha = CASE WHEN ? = 'BLOCKED' THEN checkpoint_sha ELSE ? END,
           state_comment_id = CASE WHEN ? = 'BLOCKED' THEN state_comment_id ELSE ? END,
           last_transition_reason = ?,
           updated_at = ?
       WHERE task_key = ?
         AND lease_epoch = ?
         AND lease_owner IS NOT NULL
         AND status IN ('RECOVERING', 'RUNNING')
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at <= ?
       RETURNING *`
    ).bind(
      status,status,checkpoint,status,commentId,
      boundedIdentity(reason,'reason'),now,
      key,epoch,now
    ).first();
    return normalizeRow(row);
  }

  async claimNextStage({
    taskKey:value,
    previousLeaseEpoch,
    workerId,
    checkpointSha,
    reason='CONTINUOUS_NEXT_STAGE'
  }={}) {
    const key=taskKey(value);
    const previous=positiveEpoch(previousLeaseEpoch);
    const worker=boundedIdentity(workerId,'workerId');
    const checkpoint=optionalSha(checkpointSha);
    assertBridge(checkpoint!==null,'TASK_RUNTIME_INVALID','checkpointSha is required');
    const nowMs=this.clock();
    const now=iso(nowMs);
    const leaseExpiresAt=iso(nowMs+this.leaseTtlMs);
    const row=await this.db.prepare(
      `/* agent-task:claim-next-stage */
       UPDATE agent_tasks
       SET status = 'RECOVERING',
           lease_owner = ?,
           lease_epoch = lease_epoch + 1,
           lease_expires_at = ?,
           active_run_id = NULL,
           last_transition_reason = ?,
           updated_at = ?
       WHERE task_key = ?
         AND mode = 'continuous'
         AND status = 'READY'
         AND lease_epoch = ?
         AND lease_owner IS NULL
         AND checkpoint_sha = ?
       RETURNING *`
    ).bind(
      worker,leaseExpiresAt,boundedIdentity(reason,'reason'),now,
      key,previous,checkpoint
    ).first();
    return normalizeRow(row);
  }

  async releaseFailedClaim({
    taskKey:value,
    leaseEpoch,
    workerId,
    checkpointSha,
    reason='TASK_SESSION_ISSUE_FAILED'
  }={}) {
    const key=taskKey(value);
    const epoch=positiveEpoch(leaseEpoch);
    const worker=boundedIdentity(workerId,'workerId');
    const checkpoint=optionalSha(checkpointSha);
    assertBridge(checkpoint!==null,'TASK_RUNTIME_INVALID','checkpointSha is required');
    const now=iso(this.clock());
    const row=await this.db.prepare(
      `/* agent-task:release-failed-claim */
       UPDATE agent_tasks
       SET status = 'READY',
           lease_owner = NULL,
           lease_expires_at = NULL,
           active_run_id = NULL,
           last_transition_reason = ?,
           updated_at = ?
       WHERE task_key = ?
         AND lease_epoch = ?
         AND lease_owner = ?
         AND status = 'RECOVERING'
         AND active_run_id IS NULL
         AND checkpoint_sha = ?
       RETURNING *`
    ).bind(
      boundedIdentity(reason,'reason'),now,
      key,epoch,worker,checkpoint
    ).first();
    return normalizeRow(row);
  }

  async block({
    taskKey:value,
    leaseEpoch,
    reason='HARD_STOP'
  }={}) {
    const key=taskKey(value);
    const epoch=positiveEpoch(leaseEpoch);
    const now=iso(this.clock());
    const row=await this.db.prepare(
      `/* agent-task:block */
       UPDATE agent_tasks
       SET status = 'BLOCKED',
           lease_owner = NULL,
           lease_expires_at = NULL,
           active_run_id = NULL,
           last_transition_reason = ?,
           updated_at = ?
       WHERE task_key = ?
         AND lease_epoch = ?
         AND lease_owner IS NOT NULL
         AND status IN ('RECOVERING', 'RUNNING')
         AND lease_expires_at IS NOT NULL
         AND lease_expires_at > ?
       RETURNING *`
    ).bind(
      boundedIdentity(reason,'reason'),now,key,epoch,now
    ).first();
    return normalizeRow(row);
  }

  async activate({
    taskKey:value,
    workerId,
    dispatchId,
    reason='WORKER_ACTIVATED'
  }={}) {
    const key=taskKey(value);
    const worker=boundedIdentity(workerId,'workerId');
    const dispatch=boundedIdentity(dispatchId,'dispatchId');
    const nowMs=this.clock();
    const now=iso(nowMs);
    const leaseExpiresAt=iso(nowMs+this.leaseTtlMs);
    const row=await this.db.prepare(
      `/* agent-task:activate */
       UPDATE agent_tasks
       SET status = 'RECOVERING',
           dispatch_id = NULL,
           dispatch_expires_at = NULL,
           lease_owner = ?,
           lease_epoch = lease_epoch + 1,
           lease_expires_at = ?,
           active_run_id = NULL,
           last_transition_reason = ?,
           updated_at = ?
       WHERE task_key = ?
         AND status = 'DISPATCHING'
         AND dispatch_id = ?
         AND dispatch_expires_at IS NOT NULL
         AND dispatch_expires_at > ?
       RETURNING *`
    ).bind(
      worker,leaseExpiresAt,boundedIdentity(reason,'reason'),now,
      key,dispatch,now
    ).first();
    if(!row) return null;
    return normalizeRow(row);
  }
}
