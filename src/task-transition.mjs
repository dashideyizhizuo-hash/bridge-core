import { assertBridge } from './errors.mjs';
import { assertDurableStateIdentity } from './task-github-state.mjs';

const SHA_PATTERN=/^[0-9a-f]{40}$/;
const REASON_PATTERN=/^[A-Z][A-Z0-9_]{2,63}$/;

function assertStore(value) {
  for(const method of ['getTask','assertCurrent','completeStage','claimNextStage','releaseFailedClaim','block']) {
    assertBridge(
      value && typeof value[method]==='function',
      'TASK_TRANSITION_CONFIG_INVALID',
      `task store missing method: ${method}`
    );
  }
  return value;
}

function assertSessionStore(value) {
  assertBridge(
    value && typeof value.issue==='function',
    'TASK_TRANSITION_CONFIG_INVALID',
    'task session store missing method: issue'
  );
  return value;
}

function assertDurableStateFactory(value) {
  assertBridge(
    typeof value==='function',
    'TASK_TRANSITION_CONFIG_INVALID',
    'durableStateFactory is required'
  );
  return value;
}

function exactObject(value,allowed,label) {
  assertBridge(
    value && typeof value==='object' && !Array.isArray(value),
    'TASK_TRANSITION_INVALID',
    `${label} must be an object`
  );
  for(const key of Object.keys(value)) {
    assertBridge(
      allowed.has(key),
      'TASK_TRANSITION_INVALID',
      `${label} contains unsupported field: ${key}`
    );
  }
  return value;
}

function exactSha(value) {
  assertBridge(
    typeof value==='string' && SHA_PATTERN.test(value),
    'TASK_TRANSITION_INVALID',
    'checkpointSha must be an exact SHA'
  );
  return value;
}

function commentId(value) {
  assertBridge(
    Number.isSafeInteger(value) && value>0,
    'TASK_TRANSITION_INVALID',
    'stateCommentId must be a positive integer'
  );
  return value;
}

function reasonCode(value) {
  assertBridge(
    typeof value==='string' && REASON_PATTERN.test(value),
    'TASK_TRANSITION_INVALID',
    'reasonCode must be a stable uppercase reason code'
  );
  return value;
}

function sessionShape(value) {
  const session=exactObject(
    value,
    new Set(['taskContext','taskLeaseValidator','workerId','taskActivity']),
    'task session'
  );
  const context=exactObject(
    session.taskContext,
    new Set(['taskKey','leaseEpoch']),
    'task context'
  );
  assertBridge(
    typeof context.taskKey==='string' && context.taskKey.length>0,
    'TASK_TRANSITION_INVALID',
    'task context taskKey is required'
  );
  assertBridge(
    Number.isSafeInteger(context.leaseEpoch) && context.leaseEpoch>0,
    'TASK_TRANSITION_INVALID',
    'task context leaseEpoch is invalid'
  );
  assertBridge(
    typeof session.workerId==='string' && session.workerId.length>=8,
    'TASK_TRANSITION_INVALID',
    'task session workerId is invalid'
  );
  return {
    taskKey:context.taskKey,
    leaseEpoch:context.leaseEpoch,
    workerId:session.workerId
  };
}

function inputShape(value) {
  const input=exactObject(
    value,
    new Set(['outcome','checkpointSha','stateCommentId','continue','reasonCode']),
    'task transition'
  );
  assertBridge(
    input.outcome==='READY' || input.outcome==='BLOCKED' || input.outcome==='DONE',
    'TASK_TRANSITION_INVALID',
    'outcome must be READY, BLOCKED or DONE'
  );
  const keepGoing=input.continue===true;
  assertBridge(
    input.continue===undefined || typeof input.continue==='boolean',
    'TASK_TRANSITION_INVALID',
    'continue must be boolean'
  );

  if(input.outcome==='BLOCKED') {
    assertBridge(
      input.checkpointSha===undefined &&
        input.stateCommentId===undefined &&
        input.continue===undefined,
      'TASK_TRANSITION_INVALID',
      'BLOCKED accepts only reasonCode'
    );
    return {
      outcome:'BLOCKED',
      reasonCode:reasonCode(input.reasonCode)
    };
  }

  assertBridge(
    input.reasonCode===undefined,
    'TASK_TRANSITION_INVALID',
    'reasonCode is only valid for BLOCKED'
  );
  assertBridge(
    input.outcome==='READY' || keepGoing===false,
    'TASK_TRANSITION_INVALID',
    'only READY may continue to another stage'
  );
  return {
    outcome:input.outcome,
    checkpointSha:exactSha(input.checkpointSha),
    stateCommentId:commentId(input.stateCommentId),
    continue:keepGoing
  };
}

export class DurableTaskTransition {
  constructor({taskStore,taskSessionStore,durableStateFactory}={}) {
    this.taskStore=assertStore(taskStore);
    this.taskSessionStore=assertSessionStore(taskSessionStore);
    this.durableStateFactory=assertDurableStateFactory(durableStateFactory);
  }

  async #assertCurrent(session) {
    const task=await this.taskStore.getTask(session.taskKey);
    assertBridge(task,'TASK_NOT_FOUND','durable task is not enrolled');
    await this.taskStore.assertCurrent({
      taskKey:session.taskKey,
      leaseEpoch:session.leaseEpoch,
      workerId:session.workerId,
      repository:task.repository,
      canonicalBranch:task.canonicalBranch
    });
    return task;
  }

  async #assertDurable(task,input) {
    const durableState=await this.durableStateFactory(task);
    assertBridge(
      durableState &&
        typeof durableState.readState==='function' &&
        typeof durableState.verifyCheckpoint==='function' &&
        typeof durableState.verifyBlocker==='function',
      'TASK_TRANSITION_CONFIG_INVALID',
      'durableStateFactory must return a GitHub state verifier'
    );
    const durable=await durableState.readState(task.taskKey);
    const state=assertDurableStateIdentity(durable?.state,task);
    if(
      (task.checkpointSha!==null || task.stateCommentId!==null) &&
      state.checkpoint===null
    ) {
      assertBridge(
        false,
        'TASK_RECOVERY_DIVERGED',
        'durable GitHub checkpoint pointer was removed'
      );
    }
    assertBridge(
      state.status===input.outcome,
      'TASK_TRANSITION_DURABLE_MISMATCH',
      'requested transition does not match durable GitHub status'
    );
    if(input.outcome==='BLOCKED') {
      assertBridge(
        state.blocker && state.blocker.reason===input.reasonCode,
        'TASK_TRANSITION_DURABLE_MISMATCH',
        'requested BLOCKED reason does not match the durable GitHub blocker'
      );
      await durableState.verifyBlocker({
        taskKey:task.taskKey,
        blocker:state.blocker,
        previousStateCommentId:task.stateCommentId
      });
      return state;
    }
    assertBridge(
      state.checkpoint &&
        state.checkpoint.sha===input.checkpointSha &&
        state.checkpoint.commentId===input.stateCommentId,
      'TASK_TRANSITION_DURABLE_MISMATCH',
      'requested transition does not match the durable GitHub checkpoint'
    );
    assertBridge(
      task.stateCommentId===null ||
        task.stateCommentId===undefined ||
        state.checkpoint.commentId>task.stateCommentId,
      'TASK_TRANSITION_DURABLE_MISMATCH',
      'durable checkpoint did not advance beyond the current runtime pointer'
    );
    if(input.continue) {
      assertBridge(
        typeof state.nextStage==='string' &&
          state.nextStage.length>0 &&
          state.continuation==='same-worker',
        'TASK_TRANSITION_DURABLE_MISMATCH',
        'continuous transition requires a next stage durably authorized for the same Worker'
      );
    }
    await durableState.verifyCheckpoint({
      taskKey:task.taskKey,
      canonicalBranch:task.canonicalBranch,
      checkpoint:state.checkpoint,
      previousCheckpointSha:task.checkpointSha,
      previousStateCommentId:task.stateCommentId,
      expectedStatus:input.outcome,
      expectedNextStage:state.nextStage,
      expectedContinuation:state.continuation,
      requireStatus:true
    });
    return state;
  }

  async apply(rawSession,rawInput) {
    const session=sessionShape(rawSession);
    const input=inputShape(rawInput);
    const task=await this.#assertCurrent(session);
    await this.#assertDurable(task,input);

    if(input.outcome==='BLOCKED') {
      const blocked=await this.taskStore.block({
        taskKey:session.taskKey,
        leaseEpoch:session.leaseEpoch,
        reason:input.reasonCode
      });
      assertBridge(
        blocked,
        'TASK_LEASE_STALE',
        'task ownership changed before BLOCKED could be recorded'
      );
      return {
        action:'BLOCKED',
        status:'BLOCKED',
        taskKey:session.taskKey,
        leaseEpoch:session.leaseEpoch,
        reasonCode:input.reasonCode
      };
    }

    const completed=await this.taskStore.completeStage({
      taskKey:session.taskKey,
      leaseEpoch:session.leaseEpoch,
      checkpointSha:input.checkpointSha,
      stateCommentId:input.stateCommentId,
      status:input.outcome,
      reason:input.outcome==='DONE'
        ? 'WORKER_TASK_DONE'
        : 'WORKER_STAGE_CHECKPOINTED'
    });
    assertBridge(
      completed,
      'TASK_LEASE_STALE',
      'task ownership changed before the stage transition completed'
    );

    const base={
      status:input.outcome,
      taskKey:session.taskKey,
      checkpointSha:input.checkpointSha,
      stateCommentId:input.stateCommentId,
      leaseEpoch:session.leaseEpoch
    };
    if(input.outcome==='DONE') return {action:'DONE',...base};
    if(!input.continue) return {action:'STOP',...base};

    const next=await this.taskStore.claimNextStage({
      taskKey:session.taskKey,
      previousLeaseEpoch:session.leaseEpoch,
      workerId:session.workerId,
      checkpointSha:input.checkpointSha,
      reason:'WORKER_CONTINUOUS_NEXT_STAGE'
    });
    if(!next) {
      return {
        action:'STOP',
        reason:'NEXT_STAGE_CLAIM_LOST',
        ...base
      };
    }
    let taskSessionToken;
    try {
      taskSessionToken=await this.taskSessionStore.issue({
        taskKey:session.taskKey,
        workerId:session.workerId,
        leaseEpoch:next.leaseEpoch,
        expiresAt:next.leaseExpiresAt
      });
    } catch(error) {
      const released=await this.taskStore.releaseFailedClaim({
        taskKey:session.taskKey,
        leaseEpoch:next.leaseEpoch,
        workerId:session.workerId,
        checkpointSha:input.checkpointSha,
        reason:'TASK_SESSION_ISSUE_FAILED'
      });
      assertBridge(
        released,
        'TASK_TRANSITION_RECOVERY_FAILED',
        'next-stage token issuance failed and the claimed lease could not be released'
      );
      throw error;
    }
    return {
      action:'CONTINUE',
      status:'RECOVERING',
      taskKey:session.taskKey,
      checkpointSha:input.checkpointSha,
      stateCommentId:input.stateCommentId,
      leaseEpoch:next.leaseEpoch,
      leaseExpiresAt:next.leaseExpiresAt,
      taskSessionToken
    };
  }
}
