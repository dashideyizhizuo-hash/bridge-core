import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DurableTaskControl,
  createTaskRuntimeControlHandler
} from '../src/cloudflare/task-runtime-control.mjs';
import { upsertDurableTaskState } from '../src/task-github-state.mjs';

const TASK='example/project#45';
const REPO='example/project';
const BRANCH='agent/task-45';
const NOW=1_800_000_000_000;

function principal() {
  return {
    bridgeUserId:'bridge-user-1',
    externalProvider:'test',
    externalSubject:'subject-1',
    githubUserId:'9001'
  };
}

class MemoryTaskStore {
  constructor() {
    this.tasks=new Map();
    this.dispatches=0;
  }
  async createTask(value) {
    const existing=this.tasks.get(value.taskKey);
    if(existing) {
      if(existing.bridgeUserId!==value.bridgeUserId) {
        const error=new Error('owner conflict');
        error.code='TASK_ENROLLMENT_CONFLICT';
        throw error;
      }
      return structuredClone(existing);
    }
    const task={
      taskKey:value.taskKey,
      bridgeUserId:value.bridgeUserId ?? null,
      repository:value.repository,
      issueNumber:value.issueNumber,
      canonicalBranch:value.canonicalBranch,
      mode:value.mode,
      status:'READY',
      dispatchId:null,
      dispatchExpiresAt:null,
      leaseOwner:null,
      leaseEpoch:0,
      leaseExpiresAt:null,
      activeRunId:null,
      checkpointSha:value.checkpointSha ?? null,
      stateCommentId:value.stateCommentId ?? null,
      lastTransitionReason:value.reason,
      updatedAt:new Date(NOW).toISOString()
    };
    this.tasks.set(task.taskKey,task);
    return structuredClone(task);
  }
  async getTask(taskKey) {
    const task=this.tasks.get(taskKey);
    return task ? structuredClone(task) : null;
  }
  async listWatchableTasks({limit}) {
    return [...this.tasks.values()]
      .filter(task=>task.bridgeUserId && !['BLOCKED','DONE'].includes(task.status))
      .slice(0,limit)
      .map(task=>structuredClone(task));
  }
  async dispatch(taskKey) {
    const task=this.tasks.get(taskKey);
    if(!task || !['READY','ORPHANED'].includes(task.status)) return null;
    this.dispatches++;
    Object.assign(task,{
      status:'DISPATCHING',
      dispatchId:`dispatch-${this.dispatches}`,
      dispatchExpiresAt:new Date(NOW+60_000).toISOString()
    });
    return structuredClone(task);
  }
  async renewActiveRun() { return null; }
  async markOrphaned() { return null; }
  async reconcileExpired({taskKey,leaseEpoch,status,checkpointSha,stateCommentId,reason}) {
    const task=this.tasks.get(taskKey);
    if(
      !task ||
      task.leaseEpoch!==leaseEpoch ||
      !['RECOVERING','RUNNING'].includes(task.status) ||
      task.leaseOwner===null ||
      Date.parse(task.leaseExpiresAt ?? '')>NOW
    ) return null;
    Object.assign(task,{
      status,
      leaseOwner:null,
      leaseExpiresAt:null,
      activeRunId:null,
      ...(status==='BLOCKED' ? {} : {checkpointSha,stateCommentId}),
      lastTransitionReason:reason
    });
    return structuredClone(task);
  }
}

function identityStore({publish=true}={}) {
  const calls=[];
  return {
    calls,
    async resolvePrincipalById(id) {
      calls.push({method:'resolvePrincipalById',id});
      return id==='bridge-user-1' ? principal() : null;
    },
    async resolvePrincipalByGitHubUserId(id) {
      calls.push({method:'resolvePrincipalByGitHubUserId',id});
      return id==='9001' ? principal() : null;
    },
    async assert({principal:active,repository,permission}) {
      calls.push({method:'assert',repository,permission});
      assert.equal(active.bridgeUserId,'bridge-user-1');
      assert.equal(repository,REPO);
      if(permission==='publish' && !publish) {
        const error=new Error('publish denied');
        error.code='REPOSITORY_DENIED';
        throw error;
      }
      return repository;
    },
    async resolve() {
      return {installationId:123};
    }
  };
}

function credentialProvider() {
  return {
    async acquire() {
      throw new Error('credential acquisition should not be needed in READY tick');
    }
  };
}

function controlFor({
  store=new MemoryTaskStore(),
  identity=identityStore(),
  launcherCoordinator=null,
  credentials=credentialProvider(),
  fetchImpl=globalThis.fetch
}={}) {
  const gateways=[];
  const control=new DurableTaskControl({
    taskStore:store,
    identityStore:identity,
    credentialProvider:credentials,
    fetchImpl,
    gatewayFactory:options=>{
      gateways.push(options);
      return {
        async getRun() {
          throw Object.assign(new Error('not found'),{code:'RUN_NOT_FOUND'});
        }
      };
    },
    launcherCoordinator
  });
  return {control,store,identity,gateways};
}

async function enroll(control) {
  return control.enroll({
    taskKey:TASK,
    bridgeUserId:'bridge-user-1',
    repository:REPO,
    issueNumber:45,
    canonicalBranch:BRANCH,
    mode:'continuous',
    checkpointSha:'a'.repeat(40),
    stateCommentId:77
  });
}

test('explicit enrollment requires existing run and publish authority and binds task owner',async()=>{
  const ok=controlFor();
  const result=await enroll(ok.control);
  assert.equal(result.action,'ENROLLED');
  assert.equal(result.task.bridgeUserId,'bridge-user-1');
  assert.deepEqual(
    ok.identity.calls.filter(call=>call.method==='assert').map(call=>call.permission),
    ['run','publish']
  );

  const denied=controlFor({identity:identityStore({publish:false})});
  await assert.rejects(
    ()=>enroll(denied.control),
    error=>error.code==='REPOSITORY_DENIED'
  );
  assert.equal(denied.store.tasks.size,0);
});

test('READY tick uses owner principal and produces one atomic watchdog dispatch',async()=>{
  const launcherCalls=[];
  const fixture=controlFor({
    launcherCoordinator:{
      async launchDispatch(value) {
        launcherCalls.push(structuredClone(value));
        return {
          action:'LAUNCHED',
          taskKey:value.taskKey,
          dispatchId:value.dispatchId
        };
      }
    }
  });
  await enroll(fixture.control);

  const first=await fixture.control.tick(TASK,{launch:true,workerProfile:'coding'});
  assert.equal(first.decision.action,'DISPATCH');
  assert.equal(first.launch.action,'LAUNCHED');
  assert.equal(launcherCalls.length,1);
  assert.equal(fixture.store.dispatches,1);
  assert.equal(fixture.gateways.length,1);
  assert.equal(fixture.gateways[0].principal.bridgeUserId,'bridge-user-1');

  const second=await fixture.control.tick(TASK,{launch:true});
  assert.equal(second.decision.action,'NOOP');
  assert.equal(second.launch,null);
  assert.equal(fixture.store.dispatches,1);
});

test('tickAll isolates task failures instead of aborting the scheduler batch',async()=>{
  const fixture=controlFor();
  await enroll(fixture.control);
  fixture.store.tasks.set('example/missing#46',{
    ...structuredClone(fixture.store.tasks.get(TASK)),
    taskKey:'example/missing#46',
    repository:'example/missing',
    issueNumber:46,
    bridgeUserId:'missing-user'
  });

  const result=await fixture.control.tickAll({limit:10,launch:false});
  assert.equal(result.action,'TICK_ALL');
  assert.equal(result.count,2);
  assert.equal(result.results.filter(item=>item.ok).length,1);
  assert.equal(result.results.filter(item=>!item.ok).length,1);
});

test('task control reads GitHub only after lease expiry and reconciles an advanced checkpoint',async()=>{
  const fetchCalls=[];
  const issueBody=upsertDurableTaskState('',{
    schemaVersion:1,
    taskKey:TASK,
    mode:'continuous',
    status:'READY',
    canonicalBranch:BRANCH,
    checkpoint:{stage:'independent review',sha:'b'.repeat(40),commentId:78},
    nextStage:'implementation',
    pullRequest:null,
    updatedAt:new Date(NOW).toISOString()
  });
  const credentials={
    async acquire({installationId,repository,permission}) {
      assert.equal(permission,'task-read');
      return {
        token:'task-read-installation-token',
        expiresAt:new Date(NOW+60_000).toISOString(),
        installationId,
        repository,
        permission
      };
    }
  };
  const checkpointBody=`<!-- bridge-stage-checkpoint:v1 -->
\`\`\`json
${JSON.stringify({
  schemaVersion:1,
  taskKey:TASK,
  canonicalBranch:BRANCH,
  stage:'independent review',
  sha:'b'.repeat(40),
  runId:null,
  nextStage:'implementation',
  pullRequest:null,
  summary:'review passed',
  status:'READY'
},null,2)}
\`\`\``;
  const fixture=controlFor({
    credentials,
    fetchImpl:async(input,init)=>{
      const url=new URL(String(input));
      fetchCalls.push({url:url.href,method:init?.method});
      if(url.pathname===`/repos/${REPO}/issues/45`) {
        return Response.json({body:issueBody});
      }
      if(url.pathname===`/repos/${REPO}/issues/comments/78`) {
        return Response.json({id:78,body:checkpointBody,user:{id:9001}});
      }
      if(url.pathname===`/repos/${REPO}/commits/agent%2Ftask-45`) {
        return Response.json({sha:'b'.repeat(40)});
      }
      if(url.pathname===`/repos/${REPO}/compare/${'a'.repeat(40)}...${'b'.repeat(40)}`) {
        return Response.json({
          status:'ahead',
          ahead_by:1,
          merge_base_commit:{sha:'a'.repeat(40)},
          commits:[{sha:'b'.repeat(40),commit:{message:'review stage'}}],
          files:[]
        });
      }
      throw new Error(`unexpected GitHub request: ${url.pathname}`);
    }
  });
  await enroll(fixture.control);
  Object.assign(fixture.store.tasks.get(TASK),{
    status:'RECOVERING',
    leaseOwner:'worker-a',
    leaseEpoch:3,
    leaseExpiresAt:new Date(Date.now()+60_000).toISOString()
  });

  const active=await fixture.control.tick(TASK,{launch:false});
  assert.equal(active.decision.reason,'ACTIVE_STAGE_LEASE');
  assert.equal(fetchCalls.length,0);

  fixture.store.tasks.get(TASK).leaseExpiresAt=new Date(Date.now()-1).toISOString();
  const expired=await fixture.control.tick(TASK,{launch:false});
  assert.equal(expired.decision.action,'RECONCILED');
  assert.equal(expired.decision.status,'READY');
  assert.equal(fetchCalls.length,4);
  assert.match(fetchCalls[0].url,/\/repos\/example\/project\/issues\/45$/);
  assert.equal(fixture.store.tasks.get(TASK).checkpointSha,'b'.repeat(40));
});

test('admin HTTP control rejects wrong secret before task logic and accepts exact bearer secret',async()=>{
  const fixture=controlFor();
  const secret='s'.repeat(64);
  const handler=createTaskRuntimeControlHandler({
    control:fixture.control,
    adminToken:secret
  });
  const body={
    action:'enroll',
    task:{
      taskKey:TASK,
      bridgeUserId:'bridge-user-1',
      repository:REPO,
      issueNumber:45,
      canonicalBranch:BRANCH,
      mode:'continuous'
    }
  };

  const denied=await handler.fetch(new Request('https://bridge.example/task-runtime/control',{
    method:'POST',
    headers:{
      authorization:'Bearer wrong-secret',
      'content-type':'application/json'
    },
    body:JSON.stringify(body)
  }));
  assert.equal(denied.status,401);
  assert.equal(fixture.store.tasks.size,0);

  const accepted=await handler.fetch(new Request('https://bridge.example/task-runtime/control',{
    method:'POST',
    headers:{
      authorization:`Bearer ${secret}`,
      'content-type':'application/json'
    },
    body:JSON.stringify(body)
  }));
  assert.equal(accepted.status,200);
  const payload=await accepted.json();
  assert.equal(payload.action,'ENROLLED');
  assert.equal(fixture.store.tasks.size,1);
});


test('enrollment may resolve the existing Bridge principal from verified GitHub user id',async()=>{
  const fixture=controlFor();
  const result=await fixture.control.enroll({
    taskKey:TASK,
    githubUserId:'9001',
    repository:REPO,
    issueNumber:45,
    canonicalBranch:BRANCH,
    mode:'continuous'
  });
  assert.equal(result.task.bridgeUserId,'bridge-user-1');
  assert.ok(
    fixture.identity.calls.some(
      call=>call.method==='resolvePrincipalByGitHubUserId' && call.id==='9001'
    )
  );
});
