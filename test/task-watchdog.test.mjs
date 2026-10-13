import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableTaskWatchdog } from '../src/task-watchdog.mjs';

const NOW=1_800_000_000_000;
const TASK='example/project#45';
const BRANCH='agent/issue-45';
const RUN='gh1:example/project:bridge-run-12345678:'+'a'.repeat(40);

function baseTask(overrides={}) {
  return {
    taskKey:TASK,
    repository:'example/project',
    issueNumber:45,
    canonicalBranch:BRANCH,
    mode:'continuous',
    status:'READY',
    dispatchId:null,
    dispatchExpiresAt:null,
    leaseOwner:null,
    leaseEpoch:0,
    leaseExpiresAt:null,
    activeRunId:null,
    checkpointSha:null,
    stateCommentId:null,
    lastTransitionReason:'TEST',
    updatedAt:new Date(NOW).toISOString(),
    ...overrides
  };
}

class MemoryTaskStore {
  constructor(task,{clock=()=>NOW}={}) {
    this.task=structuredClone(task);
    this.clock=clock;
    this.dispatchCounter=0;
  }
  async getTask(taskKey) {
    return taskKey===this.task.taskKey ? structuredClone(this.task) : null;
  }
  async dispatch(taskKey) {
    if(taskKey!==this.task.taskKey) return null;
    const now=this.clock();
    const expiredDispatch=
      this.task.status==='DISPATCHING' &&
      Date.parse(this.task.dispatchExpiresAt ?? '')<=now;
    if(
      !['READY','ORPHANED'].includes(this.task.status) &&
      !expiredDispatch
    ) return null;
    this.dispatchCounter++;
    Object.assign(this.task,{
      status:'DISPATCHING',
      dispatchId:`dispatch-${this.dispatchCounter}`,
      dispatchExpiresAt:new Date(now+60_000).toISOString(),
      leaseOwner:null,
      leaseExpiresAt:null,
      activeRunId:null,
      lastTransitionReason:'WATCHDOG_DISPATCH'
    });
    return structuredClone(this.task);
  }
  async renewActiveRun({taskKey,leaseEpoch,runId}) {
    if(
      taskKey!==this.task.taskKey ||
      leaseEpoch!==this.task.leaseEpoch ||
      runId!==this.task.activeRunId ||
      !['RECOVERING','RUNNING'].includes(this.task.status)
    ) return null;
    Object.assign(this.task,{
      status:'RUNNING',
      leaseExpiresAt:new Date(this.clock()+120_000).toISOString(),
      lastTransitionReason:'ACTIVE_BRIDGE_RUN'
    });
    return structuredClone(this.task);
  }
  async markOrphaned({taskKey,leaseEpoch}) {
    if(
      taskKey!==this.task.taskKey ||
      leaseEpoch!==this.task.leaseEpoch ||
      !['RECOVERING','RUNNING'].includes(this.task.status) ||
      Date.parse(this.task.leaseExpiresAt ?? '')>this.clock()
    ) return null;
    Object.assign(this.task,{
      status:'ORPHANED',
      leaseOwner:null,
      leaseExpiresAt:null,
      activeRunId:null,
      lastTransitionReason:'LEASE_EXPIRED'
    });
    return structuredClone(this.task);
  }
  async reconcileExpired({taskKey,leaseEpoch,status,checkpointSha,stateCommentId,reason}) {
    if(
      taskKey!==this.task.taskKey ||
      leaseEpoch!==this.task.leaseEpoch ||
      !['RECOVERING','RUNNING'].includes(this.task.status) ||
      this.task.leaseOwner===null ||
      Date.parse(this.task.leaseExpiresAt ?? '')>this.clock()
    ) return null;
    Object.assign(this.task,{
      status,
      leaseOwner:null,
      leaseExpiresAt:null,
      activeRunId:null,
      ...(status==='BLOCKED' ? {} : {checkpointSha,stateCommentId}),
      lastTransitionReason:reason
    });
    return structuredClone(this.task);
  }
}

function runReader(handler=async()=>{ throw Object.assign(new Error('not found'),{code:'RUN_NOT_FOUND'}); }) {
  return {getRun:handler};
}

function liveRun(status='RUNNING',epoch=7) {
  return {
    runId:RUN,
    status,
    targetRef:BRANCH,
    task:{
      taskKey:TASK,
      leaseEpoch:epoch,
      canonicalBranch:BRANCH,
      baseSha:'b'.repeat(40)
    }
  };
}

test('two concurrent watchdog ticks against READY produce exactly one dispatch',async()=>{
  const store=new MemoryTaskStore(baseTask());
  const watchdog=new DurableTaskWatchdog({taskStore:store,runReader:runReader()});
  const [a,b]=await Promise.all([watchdog.tick(TASK),watchdog.tick(TASK)]);

  assert.equal([a,b].filter(item=>item.action==='DISPATCH').length,1);
  assert.equal([a,b].filter(item=>item.action==='NOOP').length,1);
  assert.equal(store.dispatchCounter,1);
  assert.equal(store.task.status,'DISPATCHING');
});

test('launcher crash leaves DISPATCHING until expiry, then watchdog replaces the dispatch',async()=>{
  let now=NOW;
  const store=new MemoryTaskStore(baseTask(),{clock:()=>now});
  const watchdog=new DurableTaskWatchdog({
    taskStore:store,
    runReader:runReader(),
    clock:()=>now
  });
  const first=await watchdog.tick(TASK);
  assert.equal(first.action,'DISPATCH');

  now+=30_000;
  const active=await watchdog.tick(TASK);
  assert.equal(active.action,'NOOP');
  assert.equal(active.reason,'ACTIVE_DISPATCH');

  now+=30_001;
  const replacement=await watchdog.tick(TASK);
  assert.equal(replacement.action,'DISPATCH');
  assert.notEqual(replacement.dispatchId,first.dispatchId);
});

test('long-running Bridge execution is liveness even with an expired lease and no recent commit signal',async()=>{
  let now=NOW;
  const store=new MemoryTaskStore(baseTask({
    status:'RUNNING',
    leaseOwner:'worker-a',
    leaseEpoch:7,
    leaseExpiresAt:new Date(NOW-1).toISOString(),
    activeRunId:RUN
  }),{clock:()=>now});
  const watchdog=new DurableTaskWatchdog({
    taskStore:store,
    runReader:runReader(async({runId})=>{
      assert.equal(runId,RUN);
      return liveRun('RUNNING',7);
    }),
    clock:()=>now
  });

  const result=await watchdog.tick(TASK);
  assert.equal(result.action,'NOOP');
  assert.equal(result.reason,'ACTIVE_BRIDGE_RUN');
  assert.equal(result.activeRunStatus,'RUNNING');
  assert.ok(Date.parse(store.task.leaseExpiresAt)>now);
  assert.equal(store.task.leaseEpoch,7);
});

test('valid recovery lease without active Bridge Run is not taken over',async()=>{
  const store=new MemoryTaskStore(baseTask({
    status:'RECOVERING',
    leaseOwner:'worker-a',
    leaseEpoch:3,
    leaseExpiresAt:new Date(NOW+60_000).toISOString(),
    activeRunId:null
  }));
  const watchdog=new DurableTaskWatchdog({taskStore:store,runReader:runReader()});
  const result=await watchdog.tick(TASK);
  assert.equal(result.action,'NOOP');
  assert.equal(result.reason,'ACTIVE_STAGE_LEASE');
  assert.equal(store.dispatchCounter,0);
});

test('expired stage with terminal run is orphaned and redispatched exactly once',async()=>{
  const store=new MemoryTaskStore(baseTask({
    status:'RUNNING',
    leaseOwner:'worker-a',
    leaseEpoch:4,
    leaseExpiresAt:new Date(NOW-1).toISOString(),
    activeRunId:RUN
  }));
  const watchdog=new DurableTaskWatchdog({
    taskStore:store,
    runReader:runReader(async()=>liveRun('SUCCEEDED',4)),
    clock:()=>NOW
  });
  const result=await watchdog.tick(TASK);

  assert.equal(result.action,'DISPATCH');
  assert.equal(store.task.status,'DISPATCHING');
  assert.equal(store.dispatchCounter,1);
});

test('expired stage reconciles an advanced GitHub checkpoint instead of redispatching',async()=>{
  const store=new MemoryTaskStore(baseTask({
    status:'RECOVERING',
    leaseOwner:'worker-a',
    leaseEpoch:5,
    leaseExpiresAt:new Date(NOW-1).toISOString(),
    checkpointSha:'a'.repeat(40),
    stateCommentId:40
  }));
  const watchdog=new DurableTaskWatchdog({
    taskStore:store,
    runReader:runReader(),
    durableState:{
      async readState() {
        return {state:{
          taskKey:TASK,
          mode:'continuous',
          status:'READY',
          canonicalBranch:BRANCH,
          checkpoint:{stage:'review',sha:'b'.repeat(40),commentId:41}
        }};
      },
      async readLatestTaskEvents() { return {checkpoint:null,blocker:null}; },
      async verifyCheckpoint() { return true; },
      async verifyBlocker() { return true; }
    },
    clock:()=>NOW
  });

  const result=await watchdog.tick(TASK);
  assert.equal(result.action,'RECONCILED');
  assert.equal(result.status,'READY');
  assert.equal(store.task.checkpointSha,'b'.repeat(40));
  assert.equal(store.task.stateCommentId,41);
  assert.equal(store.dispatchCounter,0);
});

test('expired stage with unchanged GitHub checkpoint is treated as a crash and redispatched',async()=>{
  const store=new MemoryTaskStore(baseTask({
    status:'RECOVERING',
    leaseOwner:'worker-a',
    leaseEpoch:5,
    leaseExpiresAt:new Date(NOW-1).toISOString(),
    checkpointSha:'a'.repeat(40),
    stateCommentId:40
  }));
  const watchdog=new DurableTaskWatchdog({
    taskStore:store,
    runReader:runReader(),
    durableState:{
      async readState() {
        return {state:{
          taskKey:TASK,
          mode:'continuous',
          status:'READY',
          canonicalBranch:BRANCH,
          checkpoint:{stage:'old',sha:'a'.repeat(40),commentId:40}
        }};
      },
      async readLatestTaskEvents() { return {checkpoint:null,blocker:null}; },
      async verifyCheckpoint() { return true; },
      async verifyBlocker() { return true; }
    },
    clock:()=>NOW
  });

  const result=await watchdog.tick(TASK);
  assert.equal(result.action,'DISPATCH');
  assert.equal(store.dispatchCounter,1);
});

test('expired stage recovers a newer status-bearing checkpoint comment when the Issue pointer write was interrupted',async()=>{
  const store=new MemoryTaskStore(baseTask({
    status:'RECOVERING',
    leaseOwner:'worker-a',
    leaseEpoch:5,
    leaseExpiresAt:new Date(NOW-1).toISOString(),
    checkpointSha:'a'.repeat(40),
    stateCommentId:40
  }));
  let verified=0;
  const watchdog=new DurableTaskWatchdog({
    taskStore:store,
    runReader:runReader(),
    durableState:{
      async readState() { return {state:{
        taskKey:TASK,
        mode:'continuous',
        status:'READY',
        canonicalBranch:BRANCH,
        checkpoint:{stage:'old',sha:'a'.repeat(40),commentId:40}
      }}; },
      async readLatestTaskEvents() {
        return {checkpoint:{
          taskKey:TASK,
          canonicalBranch:BRANCH,
          stage:'review',
          sha:'b'.repeat(40),
          commentId:41,
          status:'READY'
        },blocker:null};
      },
      async verifyCheckpoint() { verified++; return true; },
      async verifyBlocker() { return true; }
    },
    clock:()=>NOW
  });
  const result=await watchdog.tick(TASK);
  assert.equal(result.action,'RECONCILED');
  assert.equal(store.task.checkpointSha,'b'.repeat(40));
  assert.equal(store.task.stateCommentId,41);
  assert.equal(verified,1);
  assert.equal(store.dispatchCounter,0);
});

test('expired stage recovers the newest blocker comment when its Issue pointer write was interrupted',async()=>{
  const store=new MemoryTaskStore(baseTask({
    status:'RECOVERING',
    leaseOwner:'worker-a',
    leaseEpoch:5,
    leaseExpiresAt:new Date(NOW-1).toISOString(),
    checkpointSha:'a'.repeat(40),
    stateCommentId:40
  }));
  let verified=0;
  const watchdog=new DurableTaskWatchdog({
    taskStore:store,
    runReader:runReader(),
    durableState:{
      async readState() { return {state:{
        taskKey:TASK,
        mode:'continuous',
        status:'READY',
        canonicalBranch:BRANCH,
        checkpoint:{stage:'old',sha:'a'.repeat(40),commentId:40}
      }}; },
      async readLatestTaskEvents() {
        return {
          checkpoint:{
            taskKey:TASK,
            canonicalBranch:BRANCH,
            stage:'review',
            sha:'b'.repeat(40),
            commentId:41,
            status:'READY'
          },
          blocker:{
            taskKey:TASK,
            reason:'SECURITY_BOUNDARY_CHANGED',
            commentId:42
          }
        };
      },
      async verifyCheckpoint() { throw new Error('older checkpoint must not win'); },
      async verifyBlocker() {
        verified++;
        return {reason:'SECURITY_BOUNDARY_CHANGED',commentId:42};
      }
    },
    clock:()=>NOW
  });
  const result=await watchdog.tick(TASK);
  assert.equal(result.action,'RECONCILED');
  assert.equal(result.status,'BLOCKED');
  assert.equal(store.task.status,'BLOCKED');
  assert.equal(verified,1);
  assert.equal(store.dispatchCounter,0);
});

test('expired stage rejects a regressed managed checkpoint instead of redispatching it',async()=>{
  const store=new MemoryTaskStore(baseTask({
    status:'RECOVERING',
    leaseOwner:'worker-a',
    leaseEpoch:5,
    leaseExpiresAt:new Date(NOW-1).toISOString(),
    checkpointSha:'b'.repeat(40),
    stateCommentId:41
  }));
  const watchdog=new DurableTaskWatchdog({
    taskStore:store,
    runReader:runReader(),
    durableState:{
      async readState() { return {state:{
        taskKey:TASK,
        mode:'continuous',
        status:'READY',
        canonicalBranch:BRANCH,
        checkpoint:{stage:'older',sha:'a'.repeat(40),commentId:40}
      }}; },
      async readLatestTaskEvents() { return {checkpoint:null,blocker:null}; },
      async verifyCheckpoint() { return true; },
      async verifyBlocker() { return true; }
    },
    clock:()=>NOW
  });
  await assert.rejects(
    ()=>watchdog.tick(TASK),
    error=>error.code==='TASK_RECOVERY_DIVERGED'
  );
  assert.equal(store.dispatchCounter,0);
});

test('expired stage rejects removal of an existing managed checkpoint pointer',async()=>{
  const store=new MemoryTaskStore(baseTask({
    status:'RECOVERING',
    leaseOwner:'worker-a',
    leaseEpoch:5,
    leaseExpiresAt:new Date(NOW-1).toISOString(),
    checkpointSha:'b'.repeat(40),
    stateCommentId:41
  }));
  const watchdog=new DurableTaskWatchdog({
    taskStore:store,
    runReader:runReader(),
    durableState:{
      async readState() { return {state:{
        taskKey:TASK,
        mode:'continuous',
        status:'READY',
        canonicalBranch:BRANCH,
        checkpoint:null
      }}; },
      async readLatestTaskEvents() { return {checkpoint:null,blocker:null}; },
      async verifyCheckpoint() { return true; },
      async verifyBlocker() { return true; }
    },
    clock:()=>NOW
  });
  await assert.rejects(
    ()=>watchdog.tick(TASK),
    error=>error.code==='TASK_RECOVERY_DIVERGED'
  );
  assert.equal(store.dispatchCounter,0);
});

test('expired stage reconciles durable BLOCKED and identity divergence fails closed',async()=>{
  const blockedStore=new MemoryTaskStore(baseTask({
    status:'RECOVERING',
    leaseOwner:'worker-a',
    leaseEpoch:5,
    leaseExpiresAt:new Date(NOW-1).toISOString()
  }));
  const blocked=new DurableTaskWatchdog({
    taskStore:blockedStore,
    runReader:runReader(),
    durableState:{
      async readState(){return {state:{
        taskKey:TASK,
        mode:'continuous',
        status:'BLOCKED',
        canonicalBranch:BRANCH,
        blocker:{reason:'PRODUCT_DECISION_REQUIRED',commentId:41},
        checkpoint:null
      }};},
      async readLatestTaskEvents() { return {checkpoint:null,blocker:null}; },
      async verifyCheckpoint() { return true; },
      async verifyBlocker() {
        return {reason:'PRODUCT_DECISION_REQUIRED',commentId:41};
      }
    },
    clock:()=>NOW
  });
  const result=await blocked.tick(TASK);
  assert.equal(result.action,'RECONCILED');
  assert.equal(result.status,'BLOCKED');

  const divergentStore=new MemoryTaskStore(baseTask({
    status:'RECOVERING',
    leaseOwner:'worker-a',
    leaseEpoch:5,
    leaseExpiresAt:new Date(NOW-1).toISOString()
  }));
  const divergent=new DurableTaskWatchdog({
    taskStore:divergentStore,
    runReader:runReader(),
    durableState:{
      async readState(){return {state:{
        taskKey:TASK,
        mode:'continuous',
        status:'READY',
        canonicalBranch:'agent/other',
        checkpoint:{stage:'review',sha:'b'.repeat(40),commentId:41}
      }};},
      async readLatestTaskEvents() { return {checkpoint:null,blocker:null}; },
      async verifyCheckpoint() { return true; },
      async verifyBlocker() { return true; }
    },
    clock:()=>NOW
  });
  await assert.rejects(
    ()=>divergent.tick(TASK),
    error=>error.code==='TASK_RECOVERY_DIVERGED'
  );
  assert.equal(divergentStore.dispatchCounter,0);
});

test('mismatched active Run binding fails closed instead of guessing takeover',async()=>{
  const store=new MemoryTaskStore(baseTask({
    status:'RUNNING',
    leaseOwner:'worker-a',
    leaseEpoch:7,
    leaseExpiresAt:new Date(NOW-1).toISOString(),
    activeRunId:RUN
  }));
  const watchdog=new DurableTaskWatchdog({
    taskStore:store,
    runReader:runReader(async()=>liveRun('RUNNING',6))
  });

  await assert.rejects(
    ()=>watchdog.tick(TASK),
    error=>error.code==='TASK_ACTIVE_RUN_MISMATCH'
  );
  assert.equal(store.dispatchCounter,0);
});

test('BLOCKED and DONE tasks never dispatch',async()=>{
  for(const status of ['BLOCKED','DONE']) {
    const store=new MemoryTaskStore(baseTask({status}));
    const watchdog=new DurableTaskWatchdog({taskStore:store,runReader:runReader()});
    const result=await watchdog.tick(TASK);
    assert.equal(result.action,'NOOP');
    assert.equal(result.reason,'TASK_NOT_RUNNABLE');
  }
});
