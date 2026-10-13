import { assertBridge, BridgeError } from './errors.mjs';

const LIVE_RUN_STATUSES=new Set(['QUEUED','RUNNING']);

function boundedText(value,label,max=4000) {
  assertBridge(
    typeof value==='string' && value.length>=1 && value.length<=max && !/\0/.test(value),
    'TASK_WORKER_INVALID',
    `${label} is invalid`
  );
  return value;
}

function optionalStage(value,label='nextStage') {
  if(value===undefined || value===null) return null;
  return boundedText(value,label,256);
}

function continuationMode(value) {
  if(value===undefined || value===null) return null;
  assertBridge(
    value==='same-worker' || value==='handoff',
    'TASK_WORKER_INVALID',
    'continuation must be same-worker or handoff'
  );
  return value;
}

function assertStore(value) {
  for(const method of [
    'activate','assertCurrent','completeStage','claimNextStage','block'
  ]) {
    assertBridge(
      value && typeof value[method]==='function',
      'TASK_WORKER_CONFIG_INVALID',
      `task store missing method: ${method}`
    );
  }
  return value;
}

function assertDurableState(value) {
  for(const method of ['recover','checkpoint','block']) {
    assertBridge(
      value && typeof value[method]==='function',
      'TASK_WORKER_CONFIG_INVALID',
      `durable state missing method: ${method}`
    );
  }
  return value;
}

function assertGateway(value) {
  for(const method of ['run','getRun','getResult','publish']) {
    assertBridge(
      value && typeof value[method]==='function',
      'TASK_WORKER_CONFIG_INVALID',
      `Bridge gateway missing method: ${method}`
    );
  }
  return value;
}

function planShape(value) {
  assertBridge(
    value && typeof value==='object' && !Array.isArray(value),
    'TASK_WORKER_INVALID',
    'bounded stage plan must be an object'
  );
  if(value.hardStop!==undefined) {
    return {
      hardStop:boundedText(value.hardStop,'hardStop',512),
      summary:
        value.summary===undefined || value.summary===null
          ? null
          : boundedText(value.summary,'summary',4000)
    };
  }
  assertBridge(
    Array.isArray(value.steps) && value.steps.length>=1 && value.steps.length<=16,
    'TASK_WORKER_INVALID',
    'bounded stage must contain 1-16 ordered Bridge batch steps'
  );
  assertBridge(
    value.final===undefined || typeof value.final==='boolean',
    'TASK_WORKER_INVALID',
    'final must be boolean'
  );
  return {
    stage:boundedText(value.stage,'stage',256),
    steps:structuredClone(value.steps),
    commitSubject:
      value.commitSubject===undefined
        ? undefined
        : boundedText(value.commitSubject,'commitSubject',120),
    summary:
      value.summary===undefined || value.summary===null
        ? null
        : boundedText(value.summary,'summary',4000),
    nextStage:optionalStage(value.nextStage),
    continuation:continuationMode(value.continuation),
    final:value.final===true,
    recoveryAccepted:value.recoveryAccepted===true
  };
}

export class DurableTaskWorkerLoop {
  constructor({
    taskStore,
    durableState,
    gatewayFactory,
    pollIntervalMs=1000,
    maxPolls=7200,
    sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
  }={}) {
    this.taskStore=assertStore(taskStore);
    this.durableState=assertDurableState(durableState);
    assertBridge(
      typeof gatewayFactory==='function',
      'TASK_WORKER_CONFIG_INVALID',
      'gatewayFactory is required'
    );
    assertBridge(
      Number.isSafeInteger(pollIntervalMs) && pollIntervalMs>=0,
      'TASK_WORKER_CONFIG_INVALID',
      'pollIntervalMs is invalid'
    );
    assertBridge(
      Number.isSafeInteger(maxPolls) && maxPolls>=1 && maxPolls<=100000,
      'TASK_WORKER_CONFIG_INVALID',
      'maxPolls is invalid'
    );
    assertBridge(typeof sleep==='function','TASK_WORKER_CONFIG_INVALID','sleep is required');
    this.gatewayFactory=gatewayFactory;
    this.pollIntervalMs=pollIntervalMs;
    this.maxPolls=maxPolls;
    this.sleep=sleep;
  }

  async activate({taskKey,dispatchId,workerId}={}) {
    const lease=await this.taskStore.activate({taskKey,dispatchId,workerId});
    assertBridge(
      lease,
      'TASK_DISPATCH_STALE',
      'dispatch is stale, expired, or already activated'
    );
    const recovery=await this.durableState.recover(taskKey);
    assertBridge(
      recovery?.state?.canonicalBranch===lease.canonicalBranch,
      'TASK_RECOVERY_DIVERGED',
      'GitHub canonical branch does not match task coordination state'
    );
    assertBridge(
      recovery.state.mode===lease.mode,
      'TASK_RECOVERY_DIVERGED',
      'GitHub execution mode does not match task coordination state'
    );
    assertBridge(
      recovery.state.status!=='BLOCKED' && recovery.state.status!=='DONE',
      'TASK_NOT_RUNNABLE',
      `durable task is ${recovery.state.status}`
    );
    return Object.freeze({
      taskKey:lease.taskKey,
      repository:lease.repository,
      canonicalBranch:lease.canonicalBranch,
      mode:lease.mode,
      workerId:lease.leaseOwner,
      leaseEpoch:lease.leaseEpoch,
      recovery
    });
  }

  async #gateway(session) {
    return assertGateway(await this.gatewayFactory({
      taskContext:{
        taskKey:session.taskKey,
        leaseEpoch:session.leaseEpoch
      }
    }));
  }

  async #waitForTerminal(gateway,runId) {
    for(let attempt=0;attempt<this.maxPolls;attempt++) {
      const run=await gateway.getRun({runId});
      if(!LIVE_RUN_STATUSES.has(run.status)) return run;
      if(this.pollIntervalMs>0) await this.sleep(this.pollIntervalMs);
    }
    throw new BridgeError(
      'TASK_STAGE_TIMEOUT',
      'Bridge Run did not reach a terminal state before the Worker polling bound'
    );
  }

  async #assertCurrent(session,baseSha) {
    return this.taskStore.assertCurrent({
      taskKey:session.taskKey,
      leaseEpoch:session.leaseEpoch,
      repository:session.repository,
      canonicalBranch:session.canonicalBranch,
      baseSha
    });
  }

  async hardStop(session,{reason,summary=null}={}) {
    const blockerReason=boundedText(reason,'hard-stop reason',512);
    await this.#assertCurrent(session,session.recovery.headSha);
    const durable=await this.durableState.block({
      taskKey:session.taskKey,
      reason:blockerReason,
      summary
    });
    const blocked=await this.taskStore.block({
      taskKey:session.taskKey,
      leaseEpoch:session.leaseEpoch,
      reason:blockerReason
    });
    assertBridge(
      blocked,
      'TASK_LEASE_STALE',
      'stage ownership changed before the hard stop could be finalized'
    );
    return {
      action:'BLOCKED',
      taskKey:session.taskKey,
      reason:blockerReason,
      blocker:durable.blocker
    };
  }

  async executeStage(session,rawPlan) {
    const plan=planShape(rawPlan);
    if(plan.hardStop!==undefined) {
      return this.hardStop(session,{
        reason:plan.hardStop,
        summary:plan.summary
      });
    }
    if(
      session.recovery.recovery==='ADVANCED' &&
      plan.recoveryAccepted!==true
    ) {
      throw new BridgeError(
        'TASK_RECOVERY_REVIEW_REQUIRED',
        'intervening checkpoint-to-HEAD work must be explicitly reviewed before mutation',
        {
          commits:session.recovery.commits?.map(item=>item.sha) ?? [],
          files:session.recovery.files?.map(item=>item.filename) ?? []
        }
      );
    }

    const gateway=await this.#gateway(session);
    let started;
    try {
      started=await gateway.run({
        repository:session.repository,
        targetRef:session.canonicalBranch,
        targetSha:session.recovery.headSha,
        mode:'batch',
        steps:plan.steps,
        ...(plan.commitSubject===undefined ? {} : {commitSubject:plan.commitSubject})
      });
      await this.#waitForTerminal(gateway,started.runId);
      const result=await gateway.getResult({runId:started.runId});

      let checkpointSha=session.recovery.headSha;
      let publication=null;
      if(result.status==='VERIFIED') {
        publication=await gateway.publish({runId:started.runId});
        assertBridge(
          publication?.status==='PUBLISHED' &&
            typeof publication.candidateSha==='string',
          'TASK_STAGE_EVIDENCE_INVALID',
          'verified stage did not produce a PUBLISHED candidate'
        );
        checkpointSha=publication.candidateSha;
      } else {
        assertBridge(
          result.status==='SUCCEEDED',
          'TASK_STAGE_FAILED',
          `Bridge stage did not succeed: ${result.status}`,
          {runId:started.runId,status:result.status}
        );
      }

      await this.#assertCurrent(session,session.recovery.headSha);
      const checkpoint=await this.durableState.checkpoint({
        taskKey:session.taskKey,
        stage:plan.stage,
        sha:checkpointSha,
        runId:started.runId,
        summary:plan.summary,
        nextStage:plan.final ? null : plan.nextStage,
        continuation:plan.final ? null : plan.continuation,
        status:plan.final ? 'DONE' : 'READY'
      });

      const completed=await this.taskStore.completeStage({
        taskKey:session.taskKey,
        leaseEpoch:session.leaseEpoch,
        checkpointSha,
        stateCommentId:checkpoint.checkpoint.commentId,
        status:plan.final ? 'DONE' : 'READY',
        reason:plan.final ? 'TASK_DONE' : 'STAGE_CHECKPOINTED'
      });
      assertBridge(
        completed,
        'TASK_LEASE_STALE',
        'stage ownership changed after durable checkpoint; Worker must stop'
      );

      const base={
        taskKey:session.taskKey,
        stage:plan.stage,
        runId:started.runId,
        checkpointSha,
        checkpointCommentId:checkpoint.checkpoint.commentId,
        publication
      };

      if(plan.final) {
        return {action:'DONE',...base};
      }
      if(session.mode==='supervised') {
        return {action:'STOP',reason:'SUPERVISED_CHECKPOINT',...base};
      }
      if(plan.nextStage===null) {
        return {action:'STOP',reason:'NO_AUTHORIZED_NEXT_STAGE',...base};
      }
      if(plan.continuation!=='same-worker') {
        return {action:'STOP',reason:'NEXT_STAGE_HANDOFF',...base};
      }

      const nextLease=await this.taskStore.claimNextStage({
        taskKey:session.taskKey,
        previousLeaseEpoch:session.leaseEpoch,
        workerId:session.workerId,
        checkpointSha,
        reason:'CONTINUOUS_NEXT_STAGE'
      });
      if(!nextLease) {
        return {action:'STOP',reason:'NEXT_STAGE_CLAIM_LOST',...base};
      }
      const recovery=await this.durableState.recover(session.taskKey);
      assertBridge(
        recovery.headSha===checkpointSha,
        'TASK_RECOVERY_DIVERGED',
        'canonical HEAD changed between checkpoint and next-stage claim'
      );
      return {
        action:'CONTINUE',
        ...base,
        session:Object.freeze({
          taskKey:nextLease.taskKey,
          repository:nextLease.repository,
          canonicalBranch:nextLease.canonicalBranch,
          mode:nextLease.mode,
          workerId:nextLease.leaseOwner,
          leaseEpoch:nextLease.leaseEpoch,
          recovery
        })
      };
    } catch(error) {
      if(
        error?.code==='TASK_LEASE_STALE' ||
        error?.code==='TASK_RECOVERY_REVIEW_REQUIRED'
      ) throw error;
      const reason=
        typeof error?.code==='string' && error.code.length<=128
          ? error.code
          : 'TASK_STAGE_ERROR';
      try {
        await this.hardStop(session,{
          reason,
          summary:error instanceof Error ? error.message.slice(0,4000) : String(error).slice(0,4000)
        });
      } catch(blockError) {
        if(blockError?.code==='TASK_LEASE_STALE') throw blockError;
      }
      throw error;
    }
  }

  async run({
    taskKey,
    dispatchId,
    workerId,
    stageProvider,
    maxStages=32
  }={}) {
    assertBridge(
      typeof stageProvider==='function',
      'TASK_WORKER_CONFIG_INVALID',
      'stageProvider is required'
    );
    assertBridge(
      Number.isSafeInteger(maxStages) && maxStages>=1 && maxStages<=128,
      'TASK_WORKER_CONFIG_INVALID',
      'maxStages is invalid'
    );
    let session=await this.activate({taskKey,dispatchId,workerId});
    const stages=[];
    for(let index=0;index<maxStages;index++) {
      const rawPlan=await stageProvider({
        session,
        durableState:session.recovery.state,
        recovery:session.recovery
      });
      const result=await this.executeStage(session,rawPlan);
      stages.push(result);
      if(result.action!=='CONTINUE') {
        return {taskKey,action:result.action,stages};
      }
      session=result.session;
    }
    return this.hardStop(session,{
      reason:'CONTINUOUS_STAGE_LIMIT',
      summary:`continuous Worker reached maxStages=${maxStages}`
    });
  }
}
