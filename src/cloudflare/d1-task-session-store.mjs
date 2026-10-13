import { assertBridge } from '../errors.mjs';

const TOKEN_PATTERN=/^bts_[A-Za-z0-9_-]{43,128}$/;

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
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/.test(value),
    'TASK_SESSION_INVALID',
    'task session task key is invalid'
  );
  return value;
}

function workerId(value) {
  assertBridge(
    typeof value==='string' && /^[A-Za-z0-9._:-]{8,256}$/.test(value),
    'TASK_SESSION_INVALID',
    'task session worker owner is invalid'
  );
  return value;
}

function leaseEpoch(value) {
  assertBridge(
    Number.isSafeInteger(value) && value>0,
    'TASK_SESSION_INVALID',
    'task session lease epoch is invalid'
  );
  return value;
}

function expiresAt(value) {
  const parsed=Date.parse(value ?? '');
  assertBridge(
    Number.isFinite(parsed),
    'TASK_SESSION_INVALID',
    'task session expiry is invalid'
  );
  return new Date(parsed).toISOString();
}

function rawToken(value) {
  assertBridge(
    typeof value==='string' && TOKEN_PATTERN.test(value),
    'TASK_SESSION_INVALID',
    'task session token is invalid'
  );
  return value;
}

function base64url(bytes) {
  let binary='';
  for(const byte of bytes) binary+=String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

function generateToken() {
  const bytes=new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return `bts_${base64url(bytes)}`;
}

async function tokenHash(token) {
  const digest=await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(rawToken(token))
  );
  return [...new Uint8Array(digest)]
    .map(byte=>byte.toString(16).padStart(2,'0'))
    .join('');
}

export class D1TaskSessionStore {
  constructor({
    db,
    clock=()=>Date.now(),
    tokenGenerator=generateToken,
    leaseTtlMs=15*60*1000
  }={}) {
    this.db=assertDb(db);
    assertBridge(typeof clock==='function','TASK_RUNTIME_CONFIG_INVALID','clock is required');
    assertBridge(typeof tokenGenerator==='function','TASK_RUNTIME_CONFIG_INVALID','tokenGenerator is required');
    assertBridge(Number.isSafeInteger(leaseTtlMs) && leaseTtlMs>0,'TASK_RUNTIME_CONFIG_INVALID','leaseTtlMs is invalid');
    this.clock=clock;
    this.tokenGenerator=tokenGenerator;
    this.leaseTtlMs=leaseTtlMs;
  }

  async issue({
    taskKey:value,
    workerId:owner,
    leaseEpoch:epochValue,
    expiresAt:expiryValue
  }={}) {
    const key=taskKey(value);
    const worker=workerId(owner);
    const epoch=leaseEpoch(epochValue);
    const expiry=expiresAt(expiryValue);
    assertBridge(
      Date.parse(expiry)>this.clock(),
      'TASK_SESSION_INVALID',
      'task session lease is already expired'
    );
    const token=rawToken(this.tokenGenerator());
    const hash=await tokenHash(token);
    const createdAt=new Date(this.clock()).toISOString();
    await this.db.prepare(
      `INSERT INTO agent_task_sessions (
        token_hash, task_key, worker_id, lease_epoch, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(hash,key,worker,epoch,expiry,createdAt).run();
    return token;
  }

  async resolve(tokenValue) {
    const token=rawToken(tokenValue);
    const hash=await tokenHash(token);
    const row=await this.db.prepare(
      `SELECT task_key, worker_id, lease_epoch, expires_at
       FROM agent_task_sessions
       WHERE token_hash = ?
       LIMIT 1`
    ).bind(hash).first();
    assertBridge(row,'TASK_SESSION_INVALID','task session token is invalid');
    const expiry=expiresAt(row.expires_at);
    assertBridge(
      Date.parse(expiry)>this.clock(),
      'TASK_LEASE_STALE',
      'task session token is expired'
    );
    return Object.freeze({
      taskKey:taskKey(row.task_key),
      workerId:workerId(row.worker_id),
      leaseEpoch:leaseEpoch(Number(row.lease_epoch)),
      expiresAt:expiry
    });
  }

  async renewSession({token:tokenValue,taskKey:value,workerId:owner,leaseEpoch:epochValue}={}) {
    const token=rawToken(tokenValue);
    const hash=await tokenHash(token);
    const key=taskKey(value);
    const worker=workerId(owner);
    const epoch=leaseEpoch(epochValue);
    const nowMs=this.clock();
    const now=new Date(nowMs).toISOString();
    const expiry=new Date(nowMs+this.leaseTtlMs).toISOString();
    const results=await this.db.batch([
      this.db.prepare(
        `/* task-session:renew-token */
         UPDATE agent_task_sessions
         SET expires_at = ?
         WHERE token_hash = ?
           AND task_key = ?
           AND worker_id = ?
           AND lease_epoch = ?
           AND expires_at > ?
           AND EXISTS (
             SELECT 1 FROM agent_tasks
             WHERE task_key = ?
               AND lease_owner = ?
               AND lease_epoch = ?
               AND status IN ('RECOVERING', 'RUNNING')
               AND lease_expires_at > ?
           )`
      ).bind(expiry,hash,key,worker,epoch,now,key,worker,epoch,now),
      this.db.prepare(
        `/* task-session:renew-lease */
         UPDATE agent_tasks
         SET lease_expires_at = ?,
             last_transition_reason = 'TASK_SESSION_ACTIVITY',
             updated_at = ?
         WHERE task_key = ?
           AND lease_owner = ?
           AND lease_epoch = ?
           AND status IN ('RECOVERING', 'RUNNING')
           AND lease_expires_at > ?
           AND EXISTS (
             SELECT 1 FROM agent_task_sessions
             WHERE token_hash = ?
               AND task_key = ?
               AND worker_id = ?
               AND lease_epoch = ?
               AND expires_at = ?
           )
         RETURNING task_key, lease_owner AS worker_id, lease_epoch, lease_expires_at AS expires_at`
      ).bind(expiry,now,key,worker,epoch,now,hash,key,worker,epoch,expiry)
    ]);
    const row=Array.isArray(results?.[1]?.results)
      ? results[1].results[0] ?? null
      : null;
    assertBridge(row,'TASK_LEASE_STALE','task session or lease expired before renewal');
    return Object.freeze({
      taskKey:taskKey(row.task_key),
      workerId:workerId(row.worker_id),
      leaseEpoch:leaseEpoch(Number(row.lease_epoch)),
      expiresAt:expiresAt(row.expires_at)
    });
  }


  async pruneExpired({limit=100}={}) {
    assertBridge(
      Number.isInteger(limit) && limit>=1 && limit<=500,
      'TASK_SESSION_INVALID',
      'task session prune limit invalid'
    );
    const now=new Date(this.clock()).toISOString();
    const result=await this.db.prepare(
      `DELETE FROM agent_task_sessions
       WHERE token_hash IN (
         SELECT token_hash
         FROM agent_task_sessions
         WHERE expires_at<=?
         ORDER BY expires_at ASC
         LIMIT ?
       )
       RETURNING token_hash`
    ).bind(now,limit).all();
    return {
      removed:Array.isArray(result?.results) ? result.results.length : 0
    };
  }

}
