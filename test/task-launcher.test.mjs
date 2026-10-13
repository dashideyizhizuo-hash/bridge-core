import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DurableTaskLaunchCoordinator,
  HttpWorkerLauncher,
  ManualWorkerLauncher,
  createWorkerBootstrap
} from '../src/task-launcher.mjs';

const TASK='example/project#45';
const DISPATCH='dispatch-123';
const DEADLINE='2030-01-01T00:10:00.000Z';

class MemoryStore {
  constructor() {
    this.task={
      taskKey:TASK,
      status:'DISPATCHING',
      dispatchId:DISPATCH,
      dispatchExpiresAt:DEADLINE,
      launchId:null,
      launcherReceiptJson:null
    };
  }
  async getTask(taskKey) {
    return taskKey===TASK ? structuredClone(this.task) : null;
  }
  async claimLaunch({taskKey,dispatchId,launchId}) {
    if(
      taskKey!==TASK ||
      this.task.status!=='DISPATCHING' ||
      this.task.dispatchId!==dispatchId ||
      this.task.launchId!==null
    ) return null;
    this.task.launchId=launchId;
    return structuredClone(this.task);
  }
  async recordLaunchReceipt({taskKey,dispatchId,launchId,receipt}) {
    if(
      taskKey!==TASK ||
      this.task.status!=='DISPATCHING' ||
      this.task.dispatchId!==dispatchId ||
      this.task.launchId!==launchId
    ) return null;
    this.task.launcherReceiptJson=JSON.stringify(receipt);
    return structuredClone(this.task);
  }
}

test('standard bootstrap carries only durable pointers and recovery rules',()=>{
  const bootstrap=createWorkerBootstrap({taskKey:TASK,dispatchId:DISPATCH});
  assert.match(bootstrap,/Continue durable task example\/project#45/);
  assert.match(bootstrap,/Dispatch: dispatch-123/);
  assert.match(bootstrap,/Activate this dispatched task through Bridge/);
  assert.match(bootstrap,/Compare checkpoint SHA -> HEAD/);
  assert.match(bootstrap,/Do not create or switch to another product branch/);
  assert.equal(/failed test|changed file|implementation detail/i.test(bootstrap),false);
});

test('HTTP launcher sends a narrow bootstrap payload and returns a bounded receipt',async()=>{
  const calls=[];
  const launcher=new HttpWorkerLauncher({
    endpoint:'https://workers.example/launch',
    fetchImpl:async(url,init)=>{
      calls.push({url,init,body:JSON.parse(init.body)});
      return Response.json({workerId:'worker-789'},{status:202});
    },
    headers:{authorization:'Bearer deployment-secret'},
    launcherName:'codex-adapter'
  });

  const receipt=await launcher.launch({
    taskKey:TASK,
    dispatchId:DISPATCH,
    bootstrap:createWorkerBootstrap({taskKey:TASK,dispatchId:DISPATCH}),
    workerProfile:'coding'
  });

  assert.deepEqual(receipt,{
    launcher:'codex-adapter',
    status:'ACCEPTED',
    workerId:'worker-789'
  });
  assert.equal(calls.length,1);
  assert.deepEqual(Object.keys(calls[0].body).sort(),[
    'bootstrap','dispatchId','taskKey','workerProfile'
  ]);
  assert.equal('repositoryCredential' in calls[0].body,false);
});

test('launch coordinator prevents duplicate launcher calls for one dispatch',async()=>{
  const store=new MemoryStore();
  let launchCalls=0;
  const launcher={
    async launch() {
      launchCalls++;
      return {launcher:'test',status:'ACCEPTED',workerId:'worker-1'};
    }
  };
  let id=0;
  const coordinator=new DurableTaskLaunchCoordinator({
    taskStore:store,
    launcher,
    randomUUID:()=>String(++id)
  });

  const [a,b]=await Promise.all([
    coordinator.launchDispatch({
      taskKey:TASK,
      dispatchId:DISPATCH,
      workerProfile:'coding'
    }),
    coordinator.launchDispatch({
      taskKey:TASK,
      dispatchId:DISPATCH,
      workerProfile:'coding'
    })
  ]);

  assert.equal([a,b].filter(item=>item.action==='LAUNCHED').length,1);
  assert.equal([a,b].filter(item=>item.action==='NOOP').length,1);
  assert.equal(launchCalls,1);
  const launched=[a,b].find(item=>item.action==='LAUNCHED');
  assert.equal(launched.activationDeadline,DEADLINE);
  assert.equal(store.task.launcherReceiptJson,JSON.stringify({
    launcher:'test',
    status:'ACCEPTED',
    workerId:'worker-1'
  }));
});

test('ambiguous launcher failure is recorded and the same dispatch is not launched twice',async()=>{
  const store=new MemoryStore();
  let launchCalls=0;
  const launcher={
    async launch() {
      launchCalls++;
      const error=new Error('network broke after request');
      error.code='TASK_LAUNCH_FAILED';
      throw error;
    }
  };
  const coordinator=new DurableTaskLaunchCoordinator({
    taskStore:store,
    launcher,
    randomUUID:()=>'failure'
  });

  await assert.rejects(
    ()=>coordinator.launchDispatch({taskKey:TASK,dispatchId:DISPATCH}),
    error=>error.code==='TASK_LAUNCH_FAILED'
  );
  const second=await coordinator.launchDispatch({taskKey:TASK,dispatchId:DISPATCH});
  assert.equal(second.action,'NOOP');
  assert.equal(launchCalls,1);
  assert.equal(JSON.parse(store.task.launcherReceiptJson).status,'LAUNCH_UNKNOWN');
});

test('manual launcher exposes the exact standard bootstrap as the documented fallback',async()=>{
  const launcher=new ManualWorkerLauncher();
  const bootstrap=createWorkerBootstrap({taskKey:TASK,dispatchId:DISPATCH});
  const receipt=await launcher.launch({
    taskKey:TASK,
    dispatchId:DISPATCH,
    bootstrap
  });
  assert.equal(receipt.status,'MANUAL_REQUIRED');
  assert.equal(receipt.bootstrap,bootstrap);
  assert.equal(receipt.dispatchId,DISPATCH);
});
