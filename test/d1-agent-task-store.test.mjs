import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { D1AgentTaskStore } from '../src/cloudflare/d1-agent-task-store.mjs';

const NOW=1_800_000_000_000;
const TASK='example/project#45';
const REPO='example/project';
const BRANCH='agent/issue-45';

function toRow(task) {
  if(!task) return null;
  return {
    task_key:task.taskKey,
    bridge_user_id:task.bridgeUserId ?? null,
    repository:task.repository,
    issue_number:task.issueNumber,
    canonical_branch:task.canonicalBranch,
    mode:task.mode,
    status:task.status,
    dispatch_id:task.dispatchId,
    dispatch_expires_at:task.dispatchExpiresAt,
    lease_owner:task.leaseOwner,
    lease_epoch:task.leaseEpoch,
    lease_expires_at:task.leaseExpiresAt,
    active_run_id:task.activeRunId,
    launch_id:task.launchId ?? null,
    launch_started_at:task.launchStartedAt ?? null,
    launcher_receipt_json:task.launcherReceiptJson ?? null,
    checkpoint_sha:task.checkpointSha,
    state_comment_id:task.stateCommentId,
    last_transition_reason:task.lastTransitionReason,
    updated_at:task.updatedAt
  };
}

class FakeStatement {
  constructor(db,sql,args=[]) {
    this.db=db;
    this.sql=sql.replace(/\s+/g,' ').trim();
    this.args=args;
  }
  bind(...args) {
    return new FakeStatement(this.db,this.sql,args);
  }
  async run() {
    if(this.sql.startsWith('INSERT INTO agent_tasks')) {
      const [
        taskKey,bridgeUserId,repository,issueNumber,canonicalBranch,
        mode,status,checkpointSha,stateCommentId,reason,updatedAt
      ]=this.args;
      if(!this.db.tasks.has(taskKey)) {
        this.db.tasks.set(taskKey,{
          taskKey,bridgeUserId,repository,issueNumber,canonicalBranch,mode,status,
          dispatchId:null,dispatchExpiresAt:null,
          leaseOwner:null,leaseEpoch:0,leaseExpiresAt:null,
          activeRunId:null,launchId:null,launchStartedAt:null,launcherReceiptJson:null,checkpointSha,stateCommentId,
          lastTransitionReason:reason,updatedAt
        });
      }
      return {success:true};
    }
    if(this.sql.includes('agent-task:renew-active-run-sessions')) {
      const [leaseExpiresAt,taskKey,leaseEpoch,now,key,epoch,runId,expectedExpiry]=this.args;
      const task=this.db.tasks.get(key);
      let changes=0;
      if(
        task && task.taskKey===taskKey && task.leaseEpoch===epoch &&
        task.activeRunId===runId && task.status==='RUNNING' &&
        task.leaseExpiresAt===expectedExpiry
      ) {
        for(const session of this.db.sessions.values()) {
          if(
            session.taskKey===taskKey && session.workerId===task.leaseOwner &&
            session.leaseEpoch===leaseEpoch && session.expiresAt>now
          ) {
            session.expiresAt=leaseExpiresAt;
            changes++;
          }
        }
      }
      return {success:true,meta:{changes}};
    }
    throw new Error('unexpected run SQL: '+this.sql);
  }
  async first() {
    if(this.sql.startsWith('SELECT * FROM agent_tasks')) {
      return toRow(this.db.tasks.get(this.args[0]));
    }
    if(this.sql.includes('agent-task:dispatch')) {
      const [dispatchId,dispatchExpiresAt,reason,updatedAt,key,now]=this.args;
      const task=this.db.tasks.get(key);
      if(!task) return null;
      const dispatchable=
        task.status==='READY' ||
        task.status==='ORPHANED' ||
        (
          task.status==='DISPATCHING' &&
          task.dispatchExpiresAt!==null &&
          task.dispatchExpiresAt<=now
        );
      if(!dispatchable) return null;
      Object.assign(task,{
        status:'DISPATCHING',
        dispatchId,
        dispatchExpiresAt,
        leaseOwner:null,
        leaseExpiresAt:null,
        activeRunId:null,
        launchId:null,
        launchStartedAt:null,
        launcherReceiptJson:null,
        lastTransitionReason:reason,
        updatedAt
      });
      return toRow(task);
    }
    if(this.sql.includes('agent-task:bind-run')) {
      const [runId,reason,updatedAt,key,repository,canonicalBranch,leaseEpoch,now]=this.args;
      const task=this.db.tasks.get(key);
      if(
        !task ||
        task.repository!==repository ||
        task.canonicalBranch!==canonicalBranch ||
        task.leaseEpoch!==leaseEpoch ||
        !['RECOVERING','RUNNING'].includes(task.status) ||
        task.leaseOwner===null ||
        task.leaseExpiresAt===null ||
        task.leaseExpiresAt<=now
      ) return null;
      Object.assign(task,{
        status:'RUNNING',
        activeRunId:runId,
        lastTransitionReason:reason,
        updatedAt
      });
      return toRow(task);
    }
    if(this.sql.includes('agent-task:renew-active-run')) {
      const [leaseExpiresAt,reason,updatedAt,key,leaseEpoch,runId]=this.args;
      const task=this.db.tasks.get(key);
      if(
        !task ||
        task.leaseEpoch!==leaseEpoch ||
        task.leaseOwner===null ||
        !['RECOVERING','RUNNING'].includes(task.status) ||
        task.activeRunId!==runId
      ) return null;
      Object.assign(task,{
        status:'RUNNING',
        leaseExpiresAt,
        lastTransitionReason:reason,
        updatedAt
      });
      return toRow(task);
    }
    if(this.sql.includes('agent-task:mark-orphaned')) {
      const [reason,updatedAt,key,leaseEpoch,now]=this.args;
      const task=this.db.tasks.get(key);
      if(
        !task ||
        task.leaseEpoch!==leaseEpoch ||
        !['RECOVERING','RUNNING'].includes(task.status) ||
        task.leaseExpiresAt===null ||
        task.leaseExpiresAt>now
      ) return null;
      Object.assign(task,{
        status:'ORPHANED',
        leaseOwner:null,
        leaseExpiresAt:null,
        activeRunId:null,
        lastTransitionReason:reason,
        updatedAt
      });
      return toRow(task);
    }
    if(this.sql.includes('agent-task:claim-launch')) {
      const [launchId,launchStartedAt,reason,updatedAt,key,dispatchId,now]=this.args;
      const task=this.db.tasks.get(key);
      if(
        !task ||
        task.status!=='DISPATCHING' ||
        task.dispatchId!==dispatchId ||
        task.dispatchExpiresAt===null ||
        task.dispatchExpiresAt<=now ||
        task.launchId!==null
      ) return null;
      Object.assign(task,{
        launchId,
        launchStartedAt,
        launcherReceiptJson:null,
        lastTransitionReason:reason,
        updatedAt
      });
      return toRow(task);
    }
    if(this.sql.includes('agent-task:record-launch-receipt')) {
      const [receiptJson,reason,updatedAt,key,dispatchId,launchId,now]=this.args;
      const task=this.db.tasks.get(key);
      if(
        !task ||
        task.status!=='DISPATCHING' ||
        task.dispatchId!==dispatchId ||
        task.launchId!==launchId ||
        task.dispatchExpiresAt===null ||
        task.dispatchExpiresAt<=now
      ) return null;
      Object.assign(task,{
        launcherReceiptJson:receiptJson,
        lastTransitionReason:reason,
        updatedAt
      });
      return toRow(task);
    }
    if(this.sql.includes('agent-task:complete-stage')) {
      const [status,checkpointSha,stateCommentId,reason,updatedAt,key,leaseEpoch,now]=this.args;
      const task=this.db.tasks.get(key);
      if(
        !task ||
        task.leaseEpoch!==leaseEpoch ||
        task.leaseOwner===null ||
        !['RECOVERING','RUNNING'].includes(task.status) ||
        task.leaseExpiresAt===null ||
        task.leaseExpiresAt<=now
      ) return null;
      Object.assign(task,{
        status,
        leaseOwner:null,
        leaseExpiresAt:null,
        activeRunId:null,
        checkpointSha,
        stateCommentId,
        lastTransitionReason:reason,
        updatedAt
      });
      return toRow(task);
    }
    if(this.sql.includes('agent-task:reconcile-expired')) {
      const [status,_statusForSha,checkpointSha,_statusForComment,stateCommentId,reason,updatedAt,key,leaseEpoch,now]=this.args;
      const task=this.db.tasks.get(key);
      if(
        !task ||
        task.leaseEpoch!==leaseEpoch ||
        task.leaseOwner===null ||
        !['RECOVERING','RUNNING'].includes(task.status) ||
        task.leaseExpiresAt===null ||
        task.leaseExpiresAt>now
      ) return null;
      Object.assign(task,{
        status,
        leaseOwner:null,
        leaseExpiresAt:null,
        activeRunId:null,
        ...(status==='BLOCKED' ? {} : {checkpointSha,stateCommentId}),
        lastTransitionReason:reason,
        updatedAt
      });
      return toRow(task);
    }
    if(this.sql.includes('agent-task:claim-next-stage')) {
      const [workerId,leaseExpiresAt,reason,updatedAt,key,previousLeaseEpoch,checkpointSha]=this.args;
      const task=this.db.tasks.get(key);
      if(
        !task ||
        task.mode!=='continuous' ||
        task.status!=='READY' ||
        task.leaseEpoch!==previousLeaseEpoch ||
        task.leaseOwner!==null ||
        task.checkpointSha!==checkpointSha
      ) return null;
      Object.assign(task,{
        status:'RECOVERING',
        leaseOwner:workerId,
        leaseEpoch:task.leaseEpoch+1,
        leaseExpiresAt,
        activeRunId:null,
        lastTransitionReason:reason,
        updatedAt
      });
      return toRow(task);
    }
    if(this.sql.includes('agent-task:release-failed-claim')) {
      const [reason,updatedAt,key,leaseEpoch,workerId,checkpointSha]=this.args;
      const task=this.db.tasks.get(key);
      if(
        !task ||
        task.leaseEpoch!==leaseEpoch ||
        task.leaseOwner!==workerId ||
        task.status!=='RECOVERING' ||
        task.activeRunId!==null ||
        task.checkpointSha!==checkpointSha
      ) return null;
      Object.assign(task,{
        status:'READY',
        leaseOwner:null,
        leaseExpiresAt:null,
        activeRunId:null,
        lastTransitionReason:reason,
        updatedAt
      });
      return toRow(task);
    }
    if(this.sql.includes('agent-task:block')) {
      const [reason,updatedAt,key,leaseEpoch,now]=this.args;
      const task=this.db.tasks.get(key);
      if(
        !task ||
        task.leaseEpoch!==leaseEpoch ||
        task.leaseOwner===null ||
        !['RECOVERING','RUNNING'].includes(task.status) ||
        task.leaseExpiresAt===null ||
        task.leaseExpiresAt<=now
      ) return null;
      Object.assign(task,{
        status:'BLOCKED',
        leaseOwner:null,
        leaseExpiresAt:null,
        activeRunId:null,
        lastTransitionReason:reason,
        updatedAt
      });
      return toRow(task);
    }
    if(this.sql.includes('agent-task:activate')) {
      const [workerId,leaseExpiresAt,reason,updatedAt,key,dispatchId,now]=this.args;
      const task=this.db.tasks.get(key);
      if(
        !task ||
        task.status!=='DISPATCHING' ||
        task.dispatchId!==dispatchId ||
        task.dispatchExpiresAt===null ||
        task.dispatchExpiresAt<=now
      ) return null;
      Object.assign(task,{
        status:'RECOVERING',
        dispatchId:null,
        dispatchExpiresAt:null,
        leaseOwner:workerId,
        leaseEpoch:task.leaseEpoch+1,
        leaseExpiresAt,
        activeRunId:null,
        lastTransitionReason:reason,
        updatedAt
      });
      return toRow(task);
    }
    throw new Error('unexpected first SQL: '+this.sql);
  }
  async all() {
    if(this.sql.startsWith('SELECT * FROM agent_tasks') && this.sql.includes('bridge_user_id IS NOT NULL')) {
      const limit=this.args[0];
      const rows=[...this.db.tasks.values()]
        .filter(task=>task.bridgeUserId!==null && !['BLOCKED','DONE'].includes(task.status))
        .sort((a,b)=>String(a.updatedAt).localeCompare(String(b.updatedAt)))
        .slice(0,limit)
        .map(toRow);
      return {success:true,results:rows};
    }
    throw new Error('unexpected all SQL: '+this.sql);
  }
}

class FakeD1 {
  constructor() {
    this.tasks=new Map();
    this.sessions=new Map();
  }
  prepare(sql) {
    return new FakeStatement(this,sql);
  }
  async batch(statements) {
    const results=[];
    for(const statement of statements) {
      if(statement.sql.includes('agent-task:renew-active-run-sessions')) {
        results.push(await statement.run());
      } else {
        const row=await statement.first();
        results.push({success:true,results:row ? [row] : []});
      }
    }
    return results;
  }
}

function store(db,{clock=()=>NOW,uuids=['1']}={}) {
  let index=0;
  return new D1AgentTaskStore({
    db,
    clock,
    randomUUID:()=>uuids[index++] ?? `extra-${index}`,
    dispatchTtlMs:60_000,
    leaseTtlMs:120_000
  });
}

async function enrolled(db,options={}) {
  const value=store(db,options);
  await value.createTask({
    taskKey:TASK,
    repository:REPO,
    issueNumber:45,
    canonicalBranch:BRANCH,
    mode:'continuous'
  });
  return value;
}

test('agent task migration stores coordination state only',()=>{
  const sql=readFileSync(
    new URL('../migrations/0004_agent_tasks.sql',import.meta.url),
    'utf8'
  );
  assert.match(sql,/CREATE TABLE IF NOT EXISTS agent_tasks/i);
  assert.match(sql,/lease_epoch INTEGER NOT NULL DEFAULT 0/i);
  assert.match(sql,/UNIQUE\(repository, issue_number\)/i);
  assert.equal(/chat_transcript|stdout|stderr|diff_blob|event_log/i.test(sql),false);
});

test('task enrollment is idempotent only for the same durable identity',async()=>{
  const db=new FakeD1();
  const value=await enrolled(db);
  const again=await value.createTask({
    taskKey:TASK,
    repository:REPO,
    issueNumber:45,
    canonicalBranch:BRANCH,
    mode:'continuous'
  });
  assert.equal(again.taskKey,TASK);

  await assert.rejects(
    ()=>value.createTask({
      taskKey:TASK,
      repository:REPO,
      issueNumber:45,
      canonicalBranch:'agent/branch-v2',
      mode:'continuous'
    }),
    error=>error.code==='TASK_ENROLLMENT_CONFLICT'
  );
});

test('two concurrent dispatch attempts produce exactly one winner',async()=>{
  const db=new FakeD1();
  const value=await enrolled(db,{uuids:['dispatch-a','dispatch-b']});
  const [a,b]=await Promise.all([
    value.dispatch(TASK),
    value.dispatch(TASK)
  ]);
  assert.equal([a,b].filter(Boolean).length,1);
  assert.equal(db.tasks.get(TASK).status,'DISPATCHING');
});

test('expired dispatch is atomically replaceable',async()=>{
  const db=new FakeD1();
  let now=NOW;
  const value=await enrolled(db,{clock:()=>now,uuids:['a','b']});
  const first=await value.dispatch(TASK);
  assert.ok(first);
  assert.equal(await value.dispatch(TASK),null);

  now+=60_001;
  const second=await value.dispatch(TASK);
  assert.ok(second);
  assert.notEqual(second.dispatchId,first.dispatchId);
});

test('two concurrent activations of one dispatch produce one lease owner and monotonic epoch',async()=>{
  const db=new FakeD1();
  const value=await enrolled(db,{uuids:['dispatch']});
  const dispatched=await value.dispatch(TASK);

  const [a,b]=await Promise.all([
    value.activate({taskKey:TASK,workerId:'worker-a',dispatchId:dispatched.dispatchId}),
    value.activate({taskKey:TASK,workerId:'worker-b',dispatchId:dispatched.dispatchId})
  ]);
  const winners=[a,b].filter(Boolean);
  assert.equal(winners.length,1);
  assert.equal(winners[0].leaseEpoch,1);
  assert.equal(db.tasks.get(TASK).status,'RECOVERING');
  assert.ok(['worker-a','worker-b'].includes(db.tasks.get(TASK).leaseOwner));
});

test('expired dispatch cannot activate a worker',async()=>{
  const db=new FakeD1();
  let now=NOW;
  const value=await enrolled(db,{clock:()=>now,uuids:['dispatch']});
  const dispatched=await value.dispatch(TASK);
  now+=60_001;

  const activated=await value.activate({
    taskKey:TASK,
    workerId:'worker-a',
    dispatchId:dispatched.dispatchId
  });
  assert.equal(activated,null);
  assert.equal(db.tasks.get(TASK).leaseEpoch,0);
});


test('current lease is required to bind a Bridge Run and stale epochs fail closed',async()=>{
  const db=new FakeD1();
  const value=await enrolled(db,{uuids:['dispatch']});
  const dispatched=await value.dispatch(TASK);
  const activated=await value.activate({
    taskKey:TASK,
    workerId:'worker-a',
    dispatchId:dispatched.dispatchId
  });
  assert.equal(activated.leaseEpoch,1);

  const current=await value.assertCurrent({
    taskKey:TASK,
    leaseEpoch:1,
    repository:REPO,
    canonicalBranch:BRANCH,
    baseSha:'a'.repeat(40)
  });
  assert.equal(current.leaseOwner,'worker-a');

  const bound=await value.bindRun({
    taskKey:TASK,
    leaseEpoch:1,
    repository:REPO,
    canonicalBranch:BRANCH,
    baseSha:'a'.repeat(40),
    runId:'gh1:example/project:bridge-request-12345678:'+'b'.repeat(40)
  });
  assert.equal(bound.status,'RUNNING');
  assert.match(bound.activeRunId,/^gh1:/);

  db.tasks.get(TASK).leaseEpoch=2;
  db.tasks.get(TASK).leaseOwner='worker-b';
  await assert.rejects(
    ()=>value.assertCurrent({
      taskKey:TASK,
      leaseEpoch:1,
      repository:REPO,
      canonicalBranch:BRANCH,
      baseSha:'a'.repeat(40)
    }),
    error=>error.code==='TASK_LEASE_STALE'
  );
});

test('lease check rejects canonical branch drift with a stable binding error',async()=>{
  const db=new FakeD1();
  const value=await enrolled(db,{uuids:['dispatch']});
  const dispatched=await value.dispatch(TASK);
  await value.activate({
    taskKey:TASK,
    workerId:'worker-a',
    dispatchId:dispatched.dispatchId
  });
  await assert.rejects(
    ()=>value.assertCurrent({
      taskKey:TASK,
      leaseEpoch:1,
      repository:REPO,
      canonicalBranch:'agent/other',
      baseSha:'a'.repeat(40)
    }),
    error=>error.code==='TASK_BINDING_MISMATCH'
  );
});


test('live bound Bridge Run can renew an expired lease without changing epoch',async()=>{
  const db=new FakeD1();
  let now=NOW;
  const value=await enrolled(db,{clock:()=>now,uuids:['dispatch']});
  const dispatched=await value.dispatch(TASK);
  await value.activate({taskKey:TASK,workerId:'worker-a',dispatchId:dispatched.dispatchId});
  const runId='gh1:example/project:bridge-live-12345678:'+'c'.repeat(40);
  await value.bindRun({
    taskKey:TASK,
    leaseEpoch:1,
    repository:REPO,
    canonicalBranch:BRANCH,
    baseSha:'a'.repeat(40),
    runId
  });
  db.sessions.set('token-hash',{
    taskKey:TASK,
    workerId:'worker-a',
    leaseEpoch:1,
    expiresAt:new Date(NOW+180_000).toISOString()
  });

  now+=120_001;
  const renewed=await value.renewActiveRun({
    taskKey:TASK,
    leaseEpoch:1,
    runId
  });
  assert.equal(renewed.status,'RUNNING');
  assert.equal(renewed.leaseEpoch,1);
  assert.ok(Date.parse(renewed.leaseExpiresAt)>now);
  assert.equal(db.sessions.get('token-hash').expiresAt,renewed.leaseExpiresAt);
});

test('expired lease can be orphaned only by its current fencing epoch',async()=>{
  const db=new FakeD1();
  let now=NOW;
  const value=await enrolled(db,{clock:()=>now,uuids:['dispatch']});
  const dispatched=await value.dispatch(TASK);
  await value.activate({taskKey:TASK,workerId:'worker-a',dispatchId:dispatched.dispatchId});

  now+=120_001;
  assert.equal(
    await value.markOrphaned({taskKey:TASK,leaseEpoch:2}),
    null
  );
  const orphaned=await value.markOrphaned({taskKey:TASK,leaseEpoch:1});
  assert.equal(orphaned.status,'ORPHANED');
  assert.equal(orphaned.leaseOwner,null);
  assert.equal(orphaned.activeRunId,null);
});


test('launcher migration adds only bounded current-dispatch coordination columns',()=>{
  const sql=readFileSync(
    new URL('../migrations/0005_task_launcher.sql',import.meta.url),
    'utf8'
  );
  assert.match(sql,/ADD COLUMN launch_id TEXT/i);
  assert.match(sql,/ADD COLUMN launch_started_at TEXT/i);
  assert.match(sql,/ADD COLUMN launcher_receipt_json TEXT/i);
  assert.equal(/transcript|prompt_history|event_log/i.test(sql),false);
});

test('two launch claims for one dispatch produce exactly one winner and preserve a bounded receipt',async()=>{
  const db=new FakeD1();
  const value=await enrolled(db,{uuids:['dispatch']});
  const dispatched=await value.dispatch(TASK);

  const [a,b]=await Promise.all([
    value.claimLaunch({
      taskKey:TASK,
      dispatchId:dispatched.dispatchId,
      launchId:'launch-a'
    }),
    value.claimLaunch({
      taskKey:TASK,
      dispatchId:dispatched.dispatchId,
      launchId:'launch-b'
    })
  ]);
  const winner=[a,b].find(Boolean);
  assert.ok(winner);
  assert.equal([a,b].filter(Boolean).length,1);

  const recorded=await value.recordLaunchReceipt({
    taskKey:TASK,
    dispatchId:dispatched.dispatchId,
    launchId:winner.launchId,
    receipt:{launcher:'http-worker',status:'ACCEPTED',workerId:'worker-1'}
  });
  assert.equal(recorded.launcherReceiptJson,JSON.stringify({
    launcher:'http-worker',
    status:'ACCEPTED',
    workerId:'worker-1'
  }));
});


test('stage completion releases the lease and continuous next-stage claim increments fencing epoch',async()=>{
  const db=new FakeD1();
  const value=await enrolled(db,{uuids:['dispatch']});
  const dispatched=await value.dispatch(TASK);
  const active=await value.activate({
    taskKey:TASK,
    workerId:'worker-a',
    dispatchId:dispatched.dispatchId
  });
  const completed=await value.completeStage({
    taskKey:TASK,
    leaseEpoch:active.leaseEpoch,
    checkpointSha:'c'.repeat(40),
    stateCommentId:77,
    status:'READY'
  });
  assert.equal(completed.status,'READY');
  assert.equal(completed.leaseOwner,null);
  assert.equal(completed.checkpointSha,'c'.repeat(40));

  const next=await value.claimNextStage({
    taskKey:TASK,
    previousLeaseEpoch:active.leaseEpoch,
    workerId:'worker-a',
    checkpointSha:'c'.repeat(40)
  });
  assert.equal(next.status,'RECOVERING');
  assert.equal(next.leaseEpoch,active.leaseEpoch+1);
  assert.equal(next.leaseOwner,'worker-a');
});

test('continuous next-stage claim loses cleanly if watchdog already moved READY to DISPATCHING',async()=>{
  const db=new FakeD1();
  const value=await enrolled(db,{uuids:['dispatch-a','dispatch-b']});
  const dispatched=await value.dispatch(TASK);
  const active=await value.activate({
    taskKey:TASK,
    workerId:'worker-a',
    dispatchId:dispatched.dispatchId
  });
  await value.completeStage({
    taskKey:TASK,
    leaseEpoch:active.leaseEpoch,
    checkpointSha:'d'.repeat(40),
    stateCommentId:88
  });
  const watchdog=await value.dispatch(TASK);
  assert.equal(watchdog.status,'DISPATCHING');

  const next=await value.claimNextStage({
    taskKey:TASK,
    previousLeaseEpoch:active.leaseEpoch,
    workerId:'worker-a',
    checkpointSha:'d'.repeat(40)
  });
  assert.equal(next,null);
});

test('failed token issuance may release only the exact unstarted next-stage claim',async()=>{
  const db=new FakeD1();
  const value=await enrolled(db,{uuids:['dispatch']});
  const dispatched=await value.dispatch(TASK);
  const active=await value.activate({
    taskKey:TASK,
    workerId:'worker-a',
    dispatchId:dispatched.dispatchId
  });
  await value.completeStage({
    taskKey:TASK,
    leaseEpoch:active.leaseEpoch,
    checkpointSha:'d'.repeat(40),
    stateCommentId:88
  });
  const next=await value.claimNextStage({
    taskKey:TASK,
    previousLeaseEpoch:active.leaseEpoch,
    workerId:'worker-a',
    checkpointSha:'d'.repeat(40)
  });
  assert.equal(await value.releaseFailedClaim({
    taskKey:TASK,
    leaseEpoch:next.leaseEpoch,
    workerId:'worker-other',
    checkpointSha:'d'.repeat(40)
  }),null);
  const released=await value.releaseFailedClaim({
    taskKey:TASK,
    leaseEpoch:next.leaseEpoch,
    workerId:'worker-a',
    checkpointSha:'d'.repeat(40)
  });
  assert.equal(released.status,'READY');
  assert.equal(released.leaseOwner,null);
  assert.equal(released.leaseEpoch,next.leaseEpoch);
});

test('hard stop atomically clears active mutation authority and enters BLOCKED',async()=>{
  const db=new FakeD1();
  const value=await enrolled(db,{uuids:['dispatch']});
  const dispatched=await value.dispatch(TASK);
  const active=await value.activate({
    taskKey:TASK,
    workerId:'worker-a',
    dispatchId:dispatched.dispatchId
  });
  const blocked=await value.block({
    taskKey:TASK,
    leaseEpoch:active.leaseEpoch,
    reason:'UNEXPLAINED_DIFF'
  });
  assert.equal(blocked.status,'BLOCKED');
  assert.equal(blocked.leaseOwner,null);
  assert.equal(blocked.activeRunId,null);
});

test('expired Worker cannot transition, while watchdog may reconcile exact durable GitHub state',async()=>{
  const db=new FakeD1();
  let now=NOW;
  const value=await enrolled(db,{clock:()=>now,uuids:['dispatch']});
  const dispatched=await value.dispatch(TASK);
  const active=await value.activate({
    taskKey:TASK,
    workerId:'worker-a',
    dispatchId:dispatched.dispatchId
  });
  now+=120_001;

  assert.equal(await value.completeStage({
    taskKey:TASK,
    leaseEpoch:active.leaseEpoch,
    checkpointSha:'e'.repeat(40),
    stateCommentId:91
  }),null);
  assert.equal(await value.block({
    taskKey:TASK,
    leaseEpoch:active.leaseEpoch,
    reason:'LATE_WORKER'
  }),null);

  const reconciled=await value.reconcileExpired({
    taskKey:TASK,
    leaseEpoch:active.leaseEpoch,
    status:'READY',
    checkpointSha:'e'.repeat(40),
    stateCommentId:91
  });
  assert.equal(reconciled.status,'READY');
  assert.equal(reconciled.checkpointSha,'e'.repeat(40));
  assert.equal(reconciled.stateCommentId,91);
  assert.equal(reconciled.leaseOwner,null);
});


test('current fencing epoch is insufficient without the active worker owner when a session owner is supplied',async()=>{
  const db=new FakeD1();
  const value=await enrolled(db,{uuids:['dispatch-owner']});
  const dispatched=await value.dispatch(TASK);
  const activated=await value.activate({
    taskKey:TASK,
    workerId:'worker-owner-a',
    dispatchId:dispatched.dispatchId
  });
  assert.equal(activated.leaseEpoch,1);

  const current=await value.assertCurrent({
    taskKey:TASK,
    leaseEpoch:1,
    repository:REPO,
    canonicalBranch:BRANCH,
    baseSha:'a'.repeat(40),
    workerId:'worker-owner-a'
  });
  assert.equal(current.leaseOwner,'worker-owner-a');

  await assert.rejects(
    ()=>value.assertCurrent({
      taskKey:TASK,
      leaseEpoch:1,
      repository:REPO,
      canonicalBranch:BRANCH,
      baseSha:'a'.repeat(40),
      workerId:'worker-owner-b'
    }),
    error=>error.code==='TASK_LEASE_STALE'
  );
});


test('owned task enrollment records principal and watchable listing excludes unowned/terminal tasks',async()=>{
  const db=new FakeD1();
  const value=store(db,{uuids:['x']});
  const owned=await value.createTask({
    taskKey:TASK,
    bridgeUserId:'bridge-user-1',
    repository:REPO,
    issueNumber:45,
    canonicalBranch:BRANCH,
    mode:'continuous'
  });
  assert.equal(owned.bridgeUserId,'bridge-user-1');

  db.tasks.set('example/other#46',{
    ...structuredClone(db.tasks.get(TASK)),
    taskKey:'example/other#46',
    bridgeUserId:null,
    repository:'example/other',
    issueNumber:46
  });
  db.tasks.set('example/done#47',{
    ...structuredClone(db.tasks.get(TASK)),
    taskKey:'example/done#47',
    repository:'example/done',
    issueNumber:47,
    status:'DONE'
  });

  const listed=await value.listWatchableTasks({limit:10});
  assert.deepEqual(listed.map(item=>item.taskKey),[TASK]);
});

test('owned task cannot be re-enrolled under another Bridge principal',async()=>{
  const db=new FakeD1();
  const value=store(db);
  await value.createTask({
    taskKey:TASK,
    bridgeUserId:'bridge-user-1',
    repository:REPO,
    issueNumber:45,
    canonicalBranch:BRANCH
  });
  await assert.rejects(
    ()=>value.createTask({
      taskKey:TASK,
      bridgeUserId:'bridge-user-2',
      repository:REPO,
      issueNumber:45,
      canonicalBranch:BRANCH
    }),
    error=>error.code==='TASK_ENROLLMENT_CONFLICT'
  );
});


test('task owner migration stores only a principal authorization pointer',()=>{
  const sql=readFileSync(
    new URL('../migrations/0006_task_owner.sql',import.meta.url),
    'utf8'
  );
  assert.match(sql,/ADD COLUMN bridge_user_id TEXT/i);
  assert.match(sql,/agent_tasks_bridge_user/i);
  assert.equal(/token|secret|transcript|prompt|credential/i.test(sql),false);
});
