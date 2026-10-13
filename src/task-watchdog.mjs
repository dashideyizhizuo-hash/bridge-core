import { assertBridge } from './errors.mjs';
import { assertDurableStateIdentity } from './task-github-state.mjs';

const LIVE_RUN_STATUSES=new Set(['QUEUED','RUNNING']);
const TERMINAL_RUN_STATUSES=new Set(['SUCCEEDED','VERIFIED','FAILED','CANCELED','PUBLISHED']);

function parseExpiry(value) {
  if(typeof value!=='string') return Number.NaN;
  return Date.parse(value);
}

function assertStore(value) {
  for(const method of ['getTask','dispatch','renewActiveRun','markOrphaned']) {
    assertBridge(
      value && typeof value[method]==='function',
      'TASK_WATCHDOG_CONFIG_INVALID',
      `task store missing method: ${method}`
    );
  }
  return value;
}

function assertRunReader(value) {
  assertBridge(
    value && typeof value.getRun==='function',
    'TASK_WATCHDOG_CONFIG_INVALID',
    'Bridge run reader is required'
  );
  return value;
}

function optionalDurableState(value) {
  if(value===null || value===undefined) return null;
  assertBridge(
      value &&
      typeof value.readState==='function' &&
      typeof value.readLatestTaskEvents==='function' &&
      typeof value.verifyCheckpoint==='function' &&
      typeof value.verifyBlocker==='function',
    'TASK_WATCHDOG_CONFIG_INVALID',
    'durable GitHub state reader must provide state and checkpoint verification'
  );
  return value;
}

function noop(task,reason,extra={}) {
  return {
    taskKey:task.taskKey,
    status:task.status,
    action:'NOOP',
    reason,
    ...extra
  };
}

function dispatched(task) {
  return {
    taskKey:task.taskKey,
    status:task.status,
    action:'DISPATCH',
    dispatchId:task.dispatchId,
    dispatchExpiresAt:task.dispatchExpiresAt
  };
}

export class DurableTaskWatchdog {
  constructor({taskStore,runReader,durableState=null,clock=()=>Date.now()}={}) {
    this.taskStore=assertStore(taskStore);
    this.runReader=assertRunReader(runReader);
    this.durableState=optionalDurableState(durableState);
    assertBridge(typeof clock==='function','TASK_WATCHDOG_CONFIG_INVALID','clock is required');
    this.clock=clock;
  }

  async #reconcileExpired(task) {
    if(this.durableState===null) return null;
    assertBridge(
      typeof this.taskStore.reconcileExpired==='function',
      'TASK_WATCHDOG_CONFIG_INVALID',
      'task store must provide reconcileExpired when durable state reconciliation is enabled'
    );
    const durable=await this.durableState.readState(task.taskKey);
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

    let input=null;
    if(state.status==='BLOCKED') {
      assertBridge(
        state.blocker,
        'TASK_RECOVERY_DIVERGED',
        'durable BLOCKED state has no blocker pointer'
      );
      await this.durableState.verifyBlocker({
        taskKey:task.taskKey,
        blocker:state.blocker,
        previousStateCommentId:task.stateCommentId
      });
      input={
        taskKey:task.taskKey,
        leaseEpoch:task.leaseEpoch,
        status:'BLOCKED',
        reason:'GITHUB_DURABLE_BLOCKED'
      };
    } else if(state.status==='READY' || state.status==='DONE') {
      const checkpoint=state.checkpoint;
      if(
        checkpoint &&
        task.stateCommentId!==null &&
        task.stateCommentId!==undefined &&
        checkpoint.commentId<=task.stateCommentId &&
        (checkpoint.commentId!==task.stateCommentId || checkpoint.sha!==task.checkpointSha)
      ) {
        assertBridge(
          false,
          'TASK_RECOVERY_DIVERGED',
          'durable GitHub checkpoint pointer regressed or changed without advancing'
        );
      }
      const advanced=
        checkpoint &&
        (task.stateCommentId===null ||
          task.stateCommentId===undefined ||
          checkpoint.commentId>task.stateCommentId);
      if(advanced) {
        await this.durableState.verifyCheckpoint({
          taskKey:task.taskKey,
          canonicalBranch:task.canonicalBranch,
          checkpoint,
          previousCheckpointSha:task.checkpointSha,
          previousStateCommentId:task.stateCommentId,
          expectedStatus:state.status,
          expectedNextStage:state.nextStage,
          expectedContinuation:state.continuation,
          requireStatus:true
        });
        input={
          taskKey:task.taskKey,
          leaseEpoch:task.leaseEpoch,
          status:state.status,
          checkpointSha:checkpoint.sha,
          stateCommentId:checkpoint.commentId,
          reason:`GITHUB_DURABLE_${state.status}`
        };
      }
    }
    if(input===null && state.status==='READY') {
      const events=await this.durableState.readLatestTaskEvents(task.taskKey);
      const previous=task.stateCommentId ?? 0;
      const candidates=[events?.checkpoint,events?.blocker]
        .filter(event=>event && event.commentId>previous)
        .sort((left,right)=>right.commentId-left.commentId);
      const latest=candidates[0] ?? null;
      if(latest?.reason) {
        await this.durableState.verifyBlocker({
          taskKey:task.taskKey,
          blocker:{reason:latest.reason,commentId:latest.commentId},
          previousStateCommentId:task.stateCommentId
        });
        input={
          taskKey:task.taskKey,
          leaseEpoch:task.leaseEpoch,
          status:'BLOCKED',
          reason:'GITHUB_DURABLE_BLOCKER_COMMENT_RECOVERY'
        };
      } else if(latest?.status) {
        await this.durableState.verifyCheckpoint({
          taskKey:task.taskKey,
          canonicalBranch:task.canonicalBranch,
          checkpoint:{
            stage:latest.stage,
            sha:latest.sha,
            commentId:latest.commentId
          },
          previousCheckpointSha:task.checkpointSha,
          previousStateCommentId:task.stateCommentId,
          expectedStatus:latest.status,
          requireStatus:true
        });
        input={
          taskKey:task.taskKey,
          leaseEpoch:task.leaseEpoch,
          status:latest.status,
          checkpointSha:latest.sha,
          stateCommentId:latest.commentId,
          reason:`GITHUB_DURABLE_${latest.status}_COMMENT_RECOVERY`
        };
      }
    }
    if(input===null) return null;

    const reconciled=await this.taskStore.reconcileExpired(input);
    if(!reconciled) {
      const latest=await this.taskStore.getTask(task.taskKey);
      return noop(latest ?? task,'COORDINATION_CHANGED');
    }
    return {
      taskKey:task.taskKey,
      status:reconciled.status,
      action:'RECONCILED',
      reason:input.reason,
      checkpointSha:reconciled.checkpointSha,
      stateCommentId:reconciled.stateCommentId
    };
  }

  async #dispatch(taskKey,current) {
    const winner=await this.taskStore.dispatch(taskKey,{
      reason:current.status==='DISPATCHING'
        ? 'DISPATCH_EXPIRED'
        : current.status==='ORPHANED'
          ? 'ORPHAN_REDISPATCH'
          : 'WATCHDOG_DISPATCH'
    });
    if(winner) return dispatched(winner);
    const latest=await this.taskStore.getTask(taskKey);
    assertBridge(latest,'TASK_NOT_FOUND',`durable task is not enrolled: ${taskKey}`);
    return noop(latest,'COORDINATION_CHANGED');
  }

  #assertActiveRunBinding(task,run) {
    assertBridge(
      run && run.runId===task.activeRunId,
      'TASK_ACTIVE_RUN_MISMATCH',
      'active Bridge Run identity does not match task coordination state'
    );
    const binding=run.task ?? run.request?.task;
    assertBridge(
      binding &&
        binding.taskKey===task.taskKey &&
        binding.leaseEpoch===task.leaseEpoch &&
        binding.canonicalBranch===task.canonicalBranch &&
        run.targetRef===task.canonicalBranch,
      'TASK_ACTIVE_RUN_MISMATCH',
      'active Bridge Run is not bound to the current task lease/canonical branch'
    );
  }

  async tick(taskKey) {
    const task=await this.taskStore.getTask(taskKey);
    assertBridge(task,'TASK_NOT_FOUND',`durable task is not enrolled: ${taskKey}`);

    if(task.status==='BLOCKED' || task.status==='DONE') {
      return noop(task,'TASK_NOT_RUNNABLE');
    }

    if(task.status==='READY' || task.status==='ORPHANED') {
      return this.#dispatch(taskKey,task);
    }

    const now=this.clock();

    if(task.status==='DISPATCHING') {
      const expires=parseExpiry(task.dispatchExpiresAt);
      if(Number.isFinite(expires) && expires>now) {
        return noop(task,'ACTIVE_DISPATCH');
      }
      return this.#dispatch(taskKey,task);
    }

    assertBridge(
      task.status==='RECOVERING' || task.status==='RUNNING',
      'TASK_WATCHDOG_STATE_INVALID',
      `watchdog cannot classify task status: ${task.status}`
    );

    let activeRunStatus=null;
    if(task.activeRunId) {
      try {
        const run=await this.runReader.getRun({runId:task.activeRunId});
        this.#assertActiveRunBinding(task,run);
        activeRunStatus=run.status;
        assertBridge(
          LIVE_RUN_STATUSES.has(run.status) || TERMINAL_RUN_STATUSES.has(run.status),
          'TASK_ACTIVE_RUN_MISMATCH',
          `unknown active Bridge Run status: ${run.status}`
        );
        if(LIVE_RUN_STATUSES.has(run.status)) {
          const renewed=await this.taskStore.renewActiveRun({
            taskKey,
            leaseEpoch:task.leaseEpoch,
            runId:task.activeRunId,
            reason:`ACTIVE_BRIDGE_RUN_${run.status}`
          });
          if(renewed) {
            return noop(renewed,'ACTIVE_BRIDGE_RUN',{activeRunStatus:run.status});
          }
          const latest=await this.taskStore.getTask(taskKey);
          return noop(latest ?? task,'COORDINATION_CHANGED',{activeRunStatus:run.status});
        }
      } catch(error) {
        if(error?.code!=='RUN_NOT_FOUND') throw error;
        activeRunStatus='NOT_FOUND';
      }
    }

    const leaseExpires=parseExpiry(task.leaseExpiresAt);
    if(Number.isFinite(leaseExpires) && leaseExpires>now) {
      return noop(task,'ACTIVE_STAGE_LEASE',{
        ...(activeRunStatus===null ? {} : {activeRunStatus})
      });
    }

    const reconciled=await this.#reconcileExpired(task);
    if(reconciled!==null) return reconciled;

    const orphaned=await this.taskStore.markOrphaned({
      taskKey,
      leaseEpoch:task.leaseEpoch,
      reason:activeRunStatus && TERMINAL_RUN_STATUSES.has(activeRunStatus)
        ? `LEASE_EXPIRED_AFTER_RUN_${activeRunStatus}`
        : 'LEASE_EXPIRED_NO_LIVE_RUN'
    });
    if(!orphaned) {
      const latest=await this.taskStore.getTask(taskKey);
      return noop(latest ?? task,'COORDINATION_CHANGED',{
        ...(activeRunStatus===null ? {} : {activeRunStatus})
      });
    }
    return this.#dispatch(taskKey,orphaned);
  }
}
