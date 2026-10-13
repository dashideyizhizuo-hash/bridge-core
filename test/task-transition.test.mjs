import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableTaskTransition } from '../src/task-transition.mjs';

const TASK='example/project#45';
const SHA='a'.repeat(40);

function fixture({
  stale=false,
  claim=true,
  issueError=null,
  durableStatus='READY',
  durableBranch='agent/task-45',
  durableCommentId=99,
  nextStage='next stage',
  continuation=nextStage===null ? null : 'same-worker'
}={}) {
  const calls=[];
  let task={
    taskKey:TASK,
    repository:'example/project',
    canonicalBranch:'agent/task-45',
    mode:'continuous',
    status:'RECOVERING',
    leaseOwner:'worker-session-1234',
    leaseEpoch:7,
    leaseExpiresAt:'2030-01-01T00:15:00.000Z',
    checkpointSha:'b'.repeat(40),
    stateCommentId:41
  };
  const taskStore={
    async getTask(taskKey) {
      calls.push({method:'getTask',taskKey});
      return structuredClone(task);
    },
    async assertCurrent(value) {
      calls.push({method:'assertCurrent',value:structuredClone(value)});
      if(
        stale ||
        !['RECOVERING','RUNNING'].includes(task.status) ||
        task.leaseOwner!==value.workerId ||
        task.leaseEpoch!==value.leaseEpoch
      ) {
        const error=new Error('stale');
        error.code='TASK_LEASE_STALE';
        throw error;
      }
      return structuredClone(task);
    },
    async completeStage(value) {
      calls.push({method:'completeStage',value:structuredClone(value)});
      if(!['RECOVERING','RUNNING'].includes(task.status) || task.leaseEpoch!==value.leaseEpoch) return null;
      task={...task,status:value.status,checkpointSha:value.checkpointSha,stateCommentId:value.stateCommentId,leaseOwner:null,leaseExpiresAt:null};
      return structuredClone(task);
    },
    async claimNextStage(value) {
      calls.push({method:'claimNextStage',value:structuredClone(value)});
      if(!claim || task.status!=='READY' || task.leaseEpoch!==value.previousLeaseEpoch) return null;
      task={...task,status:'RECOVERING',leaseOwner:value.workerId,leaseEpoch:8,checkpointSha:value.checkpointSha,leaseExpiresAt:'2030-01-01T00:30:00.000Z'};
      return structuredClone(task);
    },
    async releaseFailedClaim(value) {
      calls.push({method:'releaseFailedClaim',value:structuredClone(value)});
      if(
        task.status!=='RECOVERING' ||
        task.leaseEpoch!==value.leaseEpoch ||
        task.leaseOwner!==value.workerId
      ) return null;
      task={...task,status:'READY',leaseOwner:null,leaseExpiresAt:null};
      return structuredClone(task);
    },
    async block(value) {
      calls.push({method:'block',value:structuredClone(value)});
      if(!['RECOVERING','RUNNING'].includes(task.status) || task.leaseEpoch!==value.leaseEpoch) return null;
      task={...task,status:'BLOCKED',leaseOwner:null,leaseExpiresAt:null};
      return structuredClone(task);
    }
  };
  const taskSessionStore={
    async issue(value) {
      calls.push({method:'issue',value:structuredClone(value)});
      if(issueError) throw issueError;
      return 'bts_'+('N'.repeat(43));
    }
  };
  return {
    calls,
    transition:new DurableTaskTransition({
      taskStore,
      taskSessionStore,
      durableStateFactory:async()=>({
        async readState() {
          calls.push({method:'readState'});
          return {state:{
            taskKey:TASK,
            mode:'continuous',
            status:durableStatus,
            canonicalBranch:durableBranch,
            nextStage,
            continuation,
            blocker:durableStatus==='BLOCKED'
              ? {reason:'PRODUCT_DECISION_REQUIRED',commentId:99}
              : null,
            checkpoint:durableStatus==='BLOCKED'
              ? {stage:'prior stage',sha:'b'.repeat(40),commentId:41}
              : {stage:'test stage',sha:SHA,commentId:durableCommentId}
          }};
        },
        async verifyCheckpoint(value) {
          calls.push({method:'verifyCheckpoint',value:structuredClone(value)});
          return {
            taskKey:TASK,
            canonicalBranch:durableBranch,
            stage:'test stage',
            sha:SHA,
            commentId:durableCommentId,
            status:durableStatus
          };
        },
        async verifyBlocker(value) {
          calls.push({method:'verifyBlocker',value:structuredClone(value)});
          return {
            taskKey:TASK,
            reason:'PRODUCT_DECISION_REQUIRED',
            commentId:99
          };
        }
      })
    }),
    session:Object.freeze({
      taskContext:Object.freeze({taskKey:TASK,leaseEpoch:7}),
      workerId:'worker-session-1234'
    })
  };
}

test('READY checkpoint releases the current lease and stops at an independent gate',async()=>{
  const value=fixture();
  const result=await value.transition.apply(value.session,{
    outcome:'READY',
    checkpointSha:SHA,
    stateCommentId:99,
    continue:false
  });

  assert.deepEqual(result,{
    action:'STOP',
    status:'READY',
    taskKey:TASK,
    checkpointSha:SHA,
    stateCommentId:99,
    leaseEpoch:7
  });
  assert.deepEqual(value.calls.map(call=>call.method),[
    'getTask','assertCurrent','readState','verifyCheckpoint','completeStage'
  ]);
  assert.equal(value.calls[3].value.requireStatus,true);
  assert.equal(value.calls[3].value.expectedContinuation,'same-worker');
  assert.equal(value.calls[4].value.reason,'WORKER_STAGE_CHECKPOINTED');
});

test('READY checkpoint may atomically claim the next authorized stage and rotates the task token',async()=>{
  const value=fixture();
  const result=await value.transition.apply(value.session,{
    outcome:'READY',
    checkpointSha:SHA,
    stateCommentId:99,
    continue:true
  });

  assert.equal(result.action,'CONTINUE');
  assert.equal(result.status,'RECOVERING');
  assert.equal(result.leaseEpoch,8);
  assert.equal(result.taskSessionToken,'bts_'+('N'.repeat(43)));
  assert.deepEqual(value.calls.map(call=>call.method),[
    'getTask','assertCurrent','readState','verifyCheckpoint','completeStage','claimNextStage','issue'
  ]);
  assert.equal(value.calls[5].value.workerId,'worker-session-1234');
  assert.equal(value.calls[6].value.leaseEpoch,8);
});

test('BLOCKED releases the lease with a bounded stable reason and cannot claim another stage',async()=>{
  const value=fixture({durableStatus:'BLOCKED'});
  const result=await value.transition.apply(value.session,{
    outcome:'BLOCKED',
    reasonCode:'PRODUCT_DECISION_REQUIRED'
  });

  assert.deepEqual(result,{
    action:'BLOCKED',
    status:'BLOCKED',
    taskKey:TASK,
    leaseEpoch:7,
    reasonCode:'PRODUCT_DECISION_REQUIRED'
  });
  assert.deepEqual(value.calls.map(call=>call.method),[
    'getTask','assertCurrent','readState','verifyBlocker','block'
  ]);
});

test('DONE requires a durable checkpoint and releases the final lease',async()=>{
  const value=fixture({durableStatus:'DONE'});
  const result=await value.transition.apply(value.session,{
    outcome:'DONE',
    checkpointSha:SHA,
    stateCommentId:99
  });

  assert.equal(result.action,'DONE');
  assert.equal(result.status,'DONE');
  assert.equal(value.calls[4].value.status,'DONE');
});

test('stale task session fails before any runtime transition',async()=>{
  const value=fixture({stale:true});
  await assert.rejects(
    value.transition.apply(value.session,{
      outcome:'READY',
      checkpointSha:SHA,
      stateCommentId:99
    }),
    error=>error.code==='TASK_LEASE_STALE'
  );
  assert.deepEqual(value.calls.map(call=>call.method),[
    'getTask','assertCurrent'
  ]);
});

test('invalid transition shapes fail closed without touching D1',async()=>{
  const value=fixture();
  await assert.rejects(
    value.transition.apply(value.session,{
      outcome:'DONE',
      checkpointSha:SHA,
      stateCommentId:99,
      continue:true
    }),
    error=>error.code==='TASK_TRANSITION_INVALID'
  );
  assert.deepEqual(value.calls,[]);
});

test('reusing the old task session after a successful transition is rejected',async()=>{
  const value=fixture();
  const input={
    outcome:'READY',
    checkpointSha:SHA,
    stateCommentId:99,
    continue:false
  };
  await value.transition.apply(value.session,input);
  await assert.rejects(
    value.transition.apply(value.session,input),
    error=>error.code==='TASK_LEASE_STALE'
  );
  assert.equal(value.calls.filter(call=>call.method==='completeStage').length,1);
});

test('lost next-stage claim stops cleanly without minting another task token',async()=>{
  const value=fixture({claim:false});
  const result=await value.transition.apply(value.session,{
    outcome:'READY',
    checkpointSha:SHA,
    stateCommentId:99,
    continue:true
  });
  assert.equal(result.action,'STOP');
  assert.equal(result.reason,'NEXT_STAGE_CLAIM_LOST');
  assert.equal(value.calls.some(call=>call.method==='issue'),false);
});

test('token issuance failure releases the exact unstarted next-stage claim',async()=>{
  const issuanceError=Object.assign(new Error('token store unavailable'),{
    code:'TASK_SESSION_STORE_UNAVAILABLE'
  });
  const value=fixture({issueError:issuanceError});
  await assert.rejects(
    value.transition.apply(value.session,{
      outcome:'READY',
      checkpointSha:SHA,
      stateCommentId:99,
      continue:true
    }),
    error=>error===issuanceError
  );
  assert.deepEqual(value.calls.map(call=>call.method),[
    'getTask','assertCurrent','readState','verifyCheckpoint','completeStage','claimNextStage','issue','releaseFailedClaim'
  ]);
  assert.equal(value.calls.at(-1).value.leaseEpoch,8);
});

test('transition fails closed when GitHub status, checkpoint, or canonical identity disagrees',async()=>{
  const status=fixture({durableStatus:'DONE'});
  await assert.rejects(
    status.transition.apply(status.session,{
      outcome:'READY',
      checkpointSha:SHA,
      stateCommentId:99
    }),
    error=>error.code==='TASK_TRANSITION_DURABLE_MISMATCH'
  );
  assert.equal(status.calls.some(call=>call.method==='completeStage'),false);

  const branch=fixture({durableBranch:'agent/other'});
  await assert.rejects(
    branch.transition.apply(branch.session,{
      outcome:'READY',
      checkpointSha:SHA,
      stateCommentId:99
    }),
    error=>error.code==='TASK_RECOVERY_DIVERGED'
  );
  assert.equal(branch.calls.some(call=>call.method==='completeStage'),false);

  const blocker=fixture({durableStatus:'BLOCKED'});
  await assert.rejects(
    blocker.transition.apply(blocker.session,{
      outcome:'BLOCKED',
      reasonCode:'DIFFERENT_REASON'
    }),
    error=>error.code==='TASK_TRANSITION_DURABLE_MISMATCH'
  );
  assert.equal(blocker.calls.some(call=>call.method==='block'),false);
});

test('READY cannot replay the prior checkpoint or continue without a durable next stage',async()=>{
  const replay=fixture({durableCommentId:41});
  await assert.rejects(
    replay.transition.apply(replay.session,{
      outcome:'READY',
      checkpointSha:SHA,
      stateCommentId:41
    }),
    error=>error.code==='TASK_TRANSITION_DURABLE_MISMATCH'
  );
  assert.equal(replay.calls.some(call=>call.method==='completeStage'),false);

  const noNext=fixture({nextStage:null});
  await assert.rejects(
    noNext.transition.apply(noNext.session,{
      outcome:'READY',
      checkpointSha:SHA,
      stateCommentId:99,
      continue:true
    }),
    error=>error.code==='TASK_TRANSITION_DURABLE_MISMATCH'
  );
  assert.equal(noNext.calls.some(call=>call.method==='completeStage'),false);

  const handoff=fixture({continuation:'handoff'});
  await assert.rejects(
    handoff.transition.apply(handoff.session,{
      outcome:'READY',
      checkpointSha:SHA,
      stateCommentId:99,
      continue:true
    }),
    error=>error.code==='TASK_TRANSITION_DURABLE_MISMATCH'
  );
  assert.equal(handoff.calls.some(call=>call.method==='completeStage'),false);
});
