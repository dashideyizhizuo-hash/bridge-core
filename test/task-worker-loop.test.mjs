import test from 'node:test';
import assert from 'node:assert/strict';
import { DurableTaskWorkerLoop } from '../src/task-worker-loop.mjs';

const TASK='example/project#45';
const REPO='example/project';
const BRANCH='agent/task-45';
const DISPATCH='dispatch-1';
const A='a'.repeat(40);
const B='b'.repeat(40);
const C='c'.repeat(40);

class MemoryTaskStore {
  constructor({mode='continuous'}={}) {
    this.task={
      taskKey:TASK,
      repository:REPO,
      canonicalBranch:BRANCH,
      mode,
      status:'DISPATCHING',
      dispatchId:DISPATCH,
      leaseOwner:null,
      leaseEpoch:0,
      checkpointSha:A,
      stateCommentId:10
    };
    this.log=[];
  }
  async activate({taskKey,dispatchId,workerId}) {
    if(
      taskKey!==TASK ||
      dispatchId!==this.task.dispatchId ||
      this.task.status!=='DISPATCHING'
    ) return null;
    Object.assign(this.task,{
      status:'RECOVERING',
      dispatchId:null,
      leaseOwner:workerId,
      leaseEpoch:this.task.leaseEpoch+1
    });
    this.log.push('activate');
    return structuredClone(this.task);
  }
  async assertCurrent({taskKey,leaseEpoch,canonicalBranch}) {
    if(
      taskKey!==TASK ||
      leaseEpoch!==this.task.leaseEpoch ||
      canonicalBranch!==BRANCH ||
      this.task.leaseOwner===null ||
      !['RECOVERING','RUNNING'].includes(this.task.status)
    ) {
      const error=new Error('stale');
      error.code='TASK_LEASE_STALE';
      throw error;
    }
    this.log.push('assert-current');
    return structuredClone(this.task);
  }
  async completeStage({leaseEpoch,checkpointSha,stateCommentId,status}) {
    if(
      leaseEpoch!==this.task.leaseEpoch ||
      this.task.leaseOwner===null
    ) return null;
    Object.assign(this.task,{
      status,
      leaseOwner:null,
      checkpointSha,
      stateCommentId
    });
    this.log.push('complete-stage');
    return structuredClone(this.task);
  }
  async claimNextStage({previousLeaseEpoch,workerId,checkpointSha}) {
    if(
      this.task.mode!=='continuous' ||
      this.task.status!=='READY' ||
      this.task.leaseEpoch!==previousLeaseEpoch ||
      this.task.leaseOwner!==null ||
      this.task.checkpointSha!==checkpointSha
    ) return null;
    Object.assign(this.task,{
      status:'RECOVERING',
      leaseOwner:workerId,
      leaseEpoch:this.task.leaseEpoch+1
    });
    this.log.push('claim-next');
    return structuredClone(this.task);
  }
  async block({leaseEpoch,reason}) {
    if(
      leaseEpoch!==this.task.leaseEpoch ||
      this.task.leaseOwner===null
    ) return null;
    Object.assign(this.task,{
      status:'BLOCKED',
      leaseOwner:null,
      lastTransitionReason:reason
    });
    this.log.push('d1-block');
    return structuredClone(this.task);
  }
}

class MemoryDurableState {
  constructor({mode='continuous',recovery='AT_CHECKPOINT'}={}) {
    this.mode=mode;
    this.headSha=A;
    this.recoveryKind=recovery;
    this.commentId=10;
    this.log=[];
    this.blocker=null;
  }
  async recover() {
    this.log.push('recover');
    return {
      state:{
        taskKey:TASK,
        mode:this.mode,
        status:'READY',
        canonicalBranch:BRANCH,
        checkpoint:{stage:'S0',sha:this.headSha,commentId:this.commentId},
        nextStage:'S1'
      },
      checkpoint:{stage:'S0',sha:this.headSha,commentId:this.commentId},
      headSha:this.headSha,
      recovery:this.recoveryKind,
      commits:this.recoveryKind==='ADVANCED'?[{sha:this.headSha}]:[],
      files:this.recoveryKind==='ADVANCED'?[{filename:'src/recovered.mjs'}]:[]
    };
  }
  async checkpoint({stage,sha,nextStage,status,runId}) {
    this.headSha=sha;
    this.commentId++;
    this.recoveryKind='AT_CHECKPOINT';
    this.log.push(`checkpoint:${stage}`);
    return {
      state:{
        taskKey:TASK,
        mode:this.mode,
        status,
        canonicalBranch:BRANCH,
        checkpoint:{stage,sha,commentId:this.commentId},
        nextStage
      },
      checkpoint:{stage,sha,commentId:this.commentId,runId}
    };
  }
  async block({reason,summary}) {
    this.blocker={reason,summary,commentId:999};
    this.log.push('github-block');
    return {
      state:{taskKey:TASK,status:'BLOCKED',mode:this.mode,canonicalBranch:BRANCH},
      blocker:this.blocker
    };
  }
}

function gatewayFactoryFor(durable,{failure=null}={}) {
  const contexts=[];
  const calls=[];
  let runCounter=0;
  const factory=async({taskContext})=>{
    contexts.push(structuredClone(taskContext));
    return {
      async run(input) {
        calls.push({kind:'run',input});
        runCounter++;
        return {runId:`run-${runCounter}-12345678`};
      },
      async getRun({runId}) {
        calls.push({kind:'getRun',runId});
        return {runId,status:'SUCCEEDED'};
      },
      async getResult({runId}) {
        calls.push({kind:'getResult',runId});
        if(failure) return {runId,status:failure};
        const candidate=runCounter===1?B:C;
        return {runId,status:'VERIFIED',candidateSha:candidate};
      },
      async publish({runId}) {
        calls.push({kind:'publish',runId});
        const candidate=runCounter===1?B:C;
        durable.headSha=candidate;
        return {runId,status:'PUBLISHED',candidateSha:candidate};
      }
    };
  };
  factory.contexts=contexts;
  factory.calls=calls;
  return factory;
}

test('continuous worker executes two bounded stages through existing batch/publish and increments epoch',async()=>{
  const store=new MemoryTaskStore();
  const durable=new MemoryDurableState();
  const gatewayFactory=gatewayFactoryFor(durable);
  const worker=new DurableTaskWorkerLoop({
    taskStore:store,
    durableState:durable,
    gatewayFactory,
    pollIntervalMs:0
  });
  let stage=0;
  const result=await worker.run({
    taskKey:TASK,
    dispatchId:DISPATCH,
    workerId:'worker-a',
    stageProvider:async()=> {
      stage++;
      return stage===1
        ? {
            stage:'S1',
            steps:[
              {id:'edit',type:'edit',operations:[
                {type:'replace-exact',path:'README.md',oldText:'x',newText:'y'}
              ]},
              {id:'verify',type:'preset',capability:'verify-clean',parameters:{}}
            ],
            commitSubject:'fix: stage one',
            summary:'stage one verified',
            nextStage:'S2',
            continuation:'same-worker'
          }
        : {
            stage:'S2',
            steps:[
              {id:'edit',type:'edit',operations:[
                {type:'replace-exact',path:'README.md',oldText:'y',newText:'z'}
              ]},
              {id:'verify',type:'preset',capability:'verify-clean',parameters:{}}
            ],
            commitSubject:'fix: stage two',
            summary:'stage two verified',
            final:true
          };
    }
  });

  assert.equal(result.action,'DONE');
  assert.equal(result.stages.length,2);
  assert.equal(store.task.status,'DONE');
  assert.equal(store.task.leaseEpoch,2);
  assert.equal(store.task.checkpointSha,C);
  assert.deepEqual(gatewayFactory.contexts,[
    {taskKey:TASK,leaseEpoch:1},
    {taskKey:TASK,leaseEpoch:2}
  ]);
  assert.equal(gatewayFactory.calls.filter(call=>call.kind==='run').length,2);
  assert.equal(gatewayFactory.calls.filter(call=>call.kind==='publish').length,2);
  assert.ok(store.log.indexOf('complete-stage')>store.log.indexOf('assert-current'));
  assert.deepEqual(
    durable.log.filter(item=>item.startsWith('checkpoint:')),
    ['checkpoint:S1','checkpoint:S2']
  );
});

test('supervised mode checkpoints one stage and stops without claiming another epoch',async()=>{
  const store=new MemoryTaskStore({mode:'supervised'});
  const durable=new MemoryDurableState({mode:'supervised'});
  const gatewayFactory=gatewayFactoryFor(durable);
  const worker=new DurableTaskWorkerLoop({
    taskStore:store,
    durableState:durable,
    gatewayFactory,
    pollIntervalMs:0
  });
  const result=await worker.run({
    taskKey:TASK,
    dispatchId:DISPATCH,
    workerId:'worker-a',
    stageProvider:async()=>({
      stage:'S1',
      steps:[{id:'status',type:'exec',argv:['git','status','--short']}],
      summary:'observed',
      nextStage:'S2'
    })
  });
  assert.equal(result.action,'STOP');
  assert.equal(result.stages[0].reason,'SUPERVISED_CHECKPOINT');
  assert.equal(store.task.leaseEpoch,1);
  assert.equal(store.task.status,'READY');
});

test('continuous worker releases an explicit handoff gate without claiming another epoch',async()=>{
  const store=new MemoryTaskStore();
  const durable=new MemoryDurableState();
  const worker=new DurableTaskWorkerLoop({
    taskStore:store,
    durableState:durable,
    gatewayFactory:gatewayFactoryFor(durable),
    pollIntervalMs:0
  });
  const result=await worker.run({
    taskKey:TASK,
    dispatchId:DISPATCH,
    workerId:'worker-a',
    stageProvider:async()=>(
      {
        stage:'S1',
        steps:[{id:'status',type:'exec',argv:['git','status','--short']}],
        summary:'review gate prepared',
        nextStage:'independent review',
        continuation:'handoff'
      }
    )
  });
  assert.equal(result.action,'STOP');
  assert.equal(result.stages[0].reason,'NEXT_STAGE_HANDOFF');
  assert.equal(store.task.leaseEpoch,1);
  assert.equal(store.task.status,'READY');
});

test('advanced recovery must be explicitly reviewed before any Bridge mutation',async()=>{
  const store=new MemoryTaskStore();
  const durable=new MemoryDurableState({recovery:'ADVANCED'});
  const gatewayFactory=gatewayFactoryFor(durable);
  const worker=new DurableTaskWorkerLoop({
    taskStore:store,
    durableState:durable,
    gatewayFactory,
    pollIntervalMs:0
  });
  const session=await worker.activate({
    taskKey:TASK,
    dispatchId:DISPATCH,
    workerId:'worker-a'
  });

  await assert.rejects(
    ()=>worker.executeStage(session,{
      stage:'S1',
      steps:[{id:'status',type:'exec',argv:['git','status','--short']}]
    }),
    error=>error.code==='TASK_RECOVERY_REVIEW_REQUIRED'
  );
  assert.equal(gatewayFactory.calls.length,0);
});

test('explicit hard stop is persisted to GitHub before D1 releases authority',async()=>{
  const store=new MemoryTaskStore();
  const durable=new MemoryDurableState();
  const worker=new DurableTaskWorkerLoop({
    taskStore:store,
    durableState:durable,
    gatewayFactory:gatewayFactoryFor(durable),
    pollIntervalMs:0
  });
  const session=await worker.activate({
    taskKey:TASK,
    dispatchId:DISPATCH,
    workerId:'worker-a'
  });
  const result=await worker.executeStage(session,{
    hardStop:'UNEXPLAINED_DIFF',
    summary:'unexpected unrelated file changes'
  });
  assert.equal(result.action,'BLOCKED');
  assert.equal(store.task.status,'BLOCKED');
  assert.deepEqual(
    [...durable.log.filter(x=>x.includes('block')),...store.log.filter(x=>x.includes('block'))],
    ['github-block','d1-block']
  );
});

test('failed Bridge evidence blocks continuous execution instead of improvising',async()=>{
  const store=new MemoryTaskStore();
  const durable=new MemoryDurableState();
  const gatewayFactory=gatewayFactoryFor(durable,{failure:'FAILED'});
  const worker=new DurableTaskWorkerLoop({
    taskStore:store,
    durableState:durable,
    gatewayFactory,
    pollIntervalMs:0
  });

  await assert.rejects(
    ()=>worker.run({
      taskKey:TASK,
      dispatchId:DISPATCH,
      workerId:'worker-a',
      stageProvider:async()=>({
        stage:'S1',
        steps:[{id:'verify',type:'preset',capability:'verify-clean',parameters:{}}],
        summary:'must pass'
      })
    }),
    error=>error.code==='TASK_STAGE_FAILED'
  );
  assert.equal(store.task.status,'BLOCKED');
  assert.equal(durable.blocker.reason,'TASK_STAGE_FAILED');
});
