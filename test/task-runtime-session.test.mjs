import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TASK_RUNTIME_HEADERS,
  activateTaskDispatch,
  taskRuntimeSessionForRequest,
  taskRuntimeSessionForToken
} from '../src/cloudflare/task-runtime-session.mjs';

const TASK='example/project#45';
const DISPATCH='dispatch-12345678';

function requestWithHeaders(overrides={}) {
  return new Request('https://bridge.example/mcp',{
    method:'POST',
    headers:{
      [TASK_RUNTIME_HEADERS.taskKey]:TASK,
      [TASK_RUNTIME_HEADERS.leaseEpoch]:'7',
      [TASK_RUNTIME_HEADERS.workerId]:'worker-12345678',
      ...overrides
    },
    body:'{}'
  });
}

function tokenStore() {
  const calls=[];
  return {
    calls,
    async issue(value) {
      calls.push({method:'issue',value});
      return 'bts_'+('A'.repeat(43));
    },
    async resolve(token) {
      calls.push({method:'resolve',token});
      if(token!=='bts_'+('A'.repeat(43))) {
        const error=new Error('invalid token');
        error.code='TASK_SESSION_INVALID';
        throw error;
      }
      return {
        taskKey:TASK,workerId:'worker-12345678',leaseEpoch:7,
        expiresAt:'2030-01-01T00:15:00.000Z'
      };
    },
    async renewSession(value) {
      calls.push({method:'renewSession',value});
      return {
        taskKey:value.taskKey,
        workerId:value.workerId,
        leaseEpoch:value.leaseEpoch,
        expiresAt:'2030-01-01T00:30:00.000Z'
      };
    }
  };
}

function sessionStore() {
  const calls=[];
  return {
    calls,
    async getTask(taskKey) {
      calls.push({method:'getTask',taskKey});
      return {taskKey,bridgeUserId:'bridge-user-1'};
    },
    async activate({taskKey,dispatchId,workerId,reason}) {
      calls.push({method:'activate',taskKey,dispatchId,workerId,reason});
      if(dispatchId==='stale-dispatch') return null;
      return {
        taskKey,
        repository:'example/project',
        canonicalBranch:'agent/task-45',
        mode:'continuous',
        status:'RECOVERING',
        leaseOwner:workerId,
        leaseEpoch:8,
        leaseExpiresAt:'2030-01-01T00:15:00.000Z'
      };
    },
    async assertCurrent(value) {
      calls.push({method:'assertCurrent',value});
      if(value.workerId!=='worker-12345678' || value.canonicalBranch!=='agent/task-45') {
        const error=new Error('wrong owner');
        error.code=value.workerId!=='worker-12345678'
          ? 'TASK_LEASE_STALE'
          : 'TASK_BINDING_MISMATCH';
        throw error;
      }
      return {leaseEpoch:value.leaseEpoch,leaseOwner:value.workerId};
    },
    async bindRun(value) {
      calls.push({method:'bindRun',value});
      return {activeRunId:value.runId};
    },
  };
}

test('ordinary MCP requests remain outside task runtime',async()=>{
  const store=sessionStore();
  const session=await taskRuntimeSessionForRequest(
    new Request('https://bridge.example/mcp'),
    {taskStore:store,bridgeUserId:'bridge-user-1'}
  );
  assert.equal(session,null);
  assert.equal(store.calls.length,0);
});

test('task MCP session requires all three pointers together',async()=>{
  const store=sessionStore();
  await assert.rejects(
    ()=>taskRuntimeSessionForRequest(
      new Request('https://bridge.example/mcp',{
        headers:{
          [TASK_RUNTIME_HEADERS.taskKey]:TASK,
          [TASK_RUNTIME_HEADERS.leaseEpoch]:'7'
        }
      }),
      {taskStore:store,bridgeUserId:'bridge-user-1'}
    ),
    error=>error.code==='TASK_SESSION_INVALID'
  );
});

test('task MCP session binds current worker owner to every lease validation and Run binding',async()=>{
  const store=sessionStore();
  const session=await taskRuntimeSessionForRequest(requestWithHeaders(),{
    taskStore:store,
    bridgeUserId:'bridge-user-1'
  });
  assert.deepEqual(session.taskContext,{taskKey:TASK,leaseEpoch:7});
  assert.equal(session.workerId,'worker-12345678');

  const binding={
    taskKey:TASK,
    leaseEpoch:7,
    repository:'example/project',
    canonicalBranch:'agent/task-45',
    baseSha:'a'.repeat(40)
  };
  await session.taskLeaseValidator.assertCurrent(binding);
  await session.taskLeaseValidator.bindRun({
    ...binding,
    runId:'gh1:example/project:bridge-request-12345678:'+'b'.repeat(40)
  });

  assert.equal(store.calls[0].method,'getTask');
  assert.equal(store.calls[1].method,'assertCurrent');
  assert.equal(store.calls[1].value.workerId,'worker-12345678');
  assert.equal(store.calls[2].method,'bindRun');
  assert.equal(store.calls[2].value.workerId,'worker-12345678');
});

test('task MCP headers cannot cross the authenticated Bridge principal boundary',async()=>{
  const store=sessionStore();
  await assert.rejects(
    ()=>taskRuntimeSessionForRequest(requestWithHeaders(),{
      taskStore:store,
      bridgeUserId:'bridge-user-2'
    }),
    error=>error.code==='TASK_SESSION_PRINCIPAL_MISMATCH'
  );
  assert.deepEqual(store.calls.map(call=>call.method),['getTask']);
});

test('dispatch activation creates a server-owned Worker identity and bounded MCP session headers',async()=>{
  const store=sessionStore();
  const request=new Request('https://bridge.example/task-runtime/activate',{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify({taskKey:TASK,dispatchId:DISPATCH})
  });
  const tokens=tokenStore();
  const activated=await activateTaskDispatch({
    request,
    taskStore:store,
    taskSessionStore:tokens,
    randomUUID:()=>'fixed-uuid-1234'
  });

  assert.equal(activated.status,'ACTIVATED');
  assert.equal(activated.workerId,'worker-fixed-uuid-1234');
  assert.equal(activated.leaseEpoch,8);
  assert.equal(activated.canonicalBranch,'agent/task-45');
  assert.equal(activated.mode,'continuous');
  assert.equal(activated.taskSessionToken,'bts_'+('A'.repeat(43)));
  assert.deepEqual(activated.mcpSession.headers,{
    [TASK_RUNTIME_HEADERS.taskKey]:TASK,
    [TASK_RUNTIME_HEADERS.leaseEpoch]:'8',
    [TASK_RUNTIME_HEADERS.workerId]:'worker-fixed-uuid-1234'
  });
  assert.equal(JSON.stringify(activated).includes(DISPATCH),false);
  assert.deepEqual(store.calls[0],{
    method:'activate',
    taskKey:TASK,
    dispatchId:DISPATCH,
    workerId:'worker-fixed-uuid-1234',
    reason:'PROGRAMMABLE_WORKER_ACTIVATED'
  });
  assert.equal(tokens.calls[0].method,'issue');
  assert.deepEqual(tokens.calls[0].value,{
    taskKey:TASK,
    workerId:'worker-fixed-uuid-1234',
    leaseEpoch:8,
    expiresAt:'2030-01-01T00:15:00.000Z'
  });
});

test('opaque token resolves to a task runtime session without model-supplied worker identity',async()=>{
  const store=sessionStore();
  const tokens=tokenStore();
  const session=await taskRuntimeSessionForToken('bts_'+('A'.repeat(43)),{
    taskStore:store,
    taskSessionStore:tokens,
    bridgeUserId:'bridge-user-1'
  });
  assert.deepEqual(session.taskContext,{taskKey:TASK,leaseEpoch:7});
  assert.equal(session.workerId,'worker-12345678');
  assert.equal(tokens.calls[0].method,'resolve');
  assert.equal(store.calls[0].method,'getTask');
  assert.equal(store.calls.length,1);
  assert.equal(tokens.calls.length,1);
  await session.taskLeaseValidator.assertCurrent({
    taskKey:TASK,leaseEpoch:7,repository:'example/project',
    canonicalBranch:'agent/task-45',baseSha:'a'.repeat(40)
  });
  assert.equal(store.calls[1].method,'assertCurrent');
  assert.equal(tokens.calls[1].method,'renewSession');
  assert.deepEqual(tokens.calls[1].value,{
    token:'bts_'+('A'.repeat(43)),
    taskKey:TASK,
    workerId:'worker-12345678',
    leaseEpoch:7
  });
  await assert.rejects(
    ()=>session.taskLeaseValidator.assertCurrent({
      taskKey:TASK,leaseEpoch:7,repository:'example/project',
      canonicalBranch:'agent/other',baseSha:'a'.repeat(40)
    }),
    error=>error.code==='TASK_BINDING_MISMATCH'
  );
  assert.equal(tokens.calls.length,2);
});

test('opaque token cannot be used by another authenticated Bridge principal',async()=>{
  const store=sessionStore();
  const tokens=tokenStore();
  await assert.rejects(
    ()=>taskRuntimeSessionForToken('bts_'+('A'.repeat(43)),{
      taskStore:store,
      taskSessionStore:tokens,
      bridgeUserId:'bridge-user-2'
    }),
    error=>error.code==='TASK_SESSION_PRINCIPAL_MISMATCH'
  );
});

test('stale dispatch cannot mint a task MCP session',async()=>{
  const store=sessionStore();
  const activated=await activateTaskDispatch({
    request:new Request('https://bridge.example/task-runtime/activate',{
      method:'POST',
      body:JSON.stringify({taskKey:TASK,dispatchId:'stale-dispatch'})
    }),
    taskStore:store,
    taskSessionStore:tokenStore(),
    randomUUID:()=>'fixed-uuid-1234'
  });
  assert.equal(activated,null);
});

test('activation rejects extra fields and oversized bodies before task state mutation',async()=>{
  const store=sessionStore();
  await assert.rejects(
    ()=>activateTaskDispatch({
      request:new Request('https://bridge.example/task-runtime/activate',{
        method:'POST',
        body:JSON.stringify({
          taskKey:TASK,
          dispatchId:DISPATCH,
          repositoryCredential:'must-not-be-accepted'
        })
      }),
      taskStore:store,
      taskSessionStore:tokenStore()
    }),
    error=>error.code==='TASK_ACTIVATION_INVALID'
  );
  assert.equal(store.calls.length,0);

  await assert.rejects(
    ()=>activateTaskDispatch({
      request:new Request('https://bridge.example/task-runtime/activate',{
        method:'POST',
        headers:{'content-length':'5000'},
        body:'{}'
      }),
      taskStore:store,
      taskSessionStore:tokenStore()
    }),
    error=>error.code==='TASK_ACTIVATION_INVALID'
  );
  assert.equal(store.calls.length,0);
});
