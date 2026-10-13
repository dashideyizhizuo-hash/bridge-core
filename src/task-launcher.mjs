import { assertBridge, BridgeError } from './errors.mjs';

const TASK_KEY_PATTERN=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/;

function boundedString(value,label,max=256) {
  assertBridge(
    typeof value==='string' && value.length>=1 && value.length<=max && !/\0/.test(value),
    'TASK_LAUNCHER_INVALID',
    `${label} is invalid`
  );
  return value;
}

function taskKey(value) {
  assertBridge(
    typeof value==='string' && value.length<=512 && TASK_KEY_PATTERN.test(value),
    'TASK_LAUNCHER_INVALID',
    'taskKey must be owner/repository#issue-number'
  );
  return value;
}

function profile(value) {
  if(value===undefined || value===null) return null;
  return boundedString(value,'workerProfile',128);
}

function boundedReceipt(value) {
  assertBridge(
    value && typeof value==='object' && !Array.isArray(value),
    'TASK_LAUNCHER_INVALID',
    'launcher receipt must be an object'
  );
  let json;
  try { json=JSON.stringify(value); }
  catch(error) {
    throw new BridgeError('TASK_LAUNCHER_INVALID','launcher receipt must be JSON serializable',{cause:error.message});
  }
  assertBridge(
    Buffer.byteLength(json,'utf8')<=4096,
    'TASK_LAUNCHER_INVALID',
    'launcher receipt exceeds 4096 bytes'
  );
  return structuredClone(value);
}

export function createWorkerBootstrap({taskKey:value,dispatchId}={}) {
  const key=taskKey(value);
  const dispatch=boundedString(dispatchId,'dispatchId',256);
  return `Continue durable task ${key}.

Dispatch: ${dispatch}

Before mutation:
1. Load the Continuous GitHub Development Agent Skill.
2. Activate this dispatched task through Bridge.
3. Read canonical GitHub task state and latest checkpoint.
4. Resolve the canonical branch and exact HEAD.
5. Compare checkpoint SHA -> HEAD and recover intervening work.
6. Read repository-local AGENTS/governance and execution contract.
7. Do not create or switch to another product branch.
8. Resume exactly one bounded stage.
9. All task mutation must use the active lease/fencing epoch.
10. Persist a durable checkpoint at the stage boundary.
11. In continuous mode, continue only through another valid stage claim.
12. Hard-stop on authority, safety, design, or unexplained-divergence conflicts.`;
}

export class HttpWorkerLauncher {
  constructor({
    endpoint,
    fetchImpl=globalThis.fetch,
    headers={},
    launcherName='http-worker'
  }={}) {
    assertBridge(
      typeof endpoint==='string' && /^https:\/\//.test(endpoint),
      'TASK_LAUNCHER_CONFIG_INVALID',
      'HTTPS worker launcher endpoint is required'
    );
    assertBridge(typeof fetchImpl==='function','TASK_LAUNCHER_CONFIG_INVALID','fetch implementation is required');
    assertBridge(
      headers && typeof headers==='object' && !Array.isArray(headers),
      'TASK_LAUNCHER_CONFIG_INVALID',
      'launcher headers must be an object'
    );
    this.endpoint=endpoint;
    this.fetchImpl=fetchImpl;
    this.headers={...headers};
    this.launcherName=boundedString(launcherName,'launcherName',128);
  }

  async launch({taskKey:value,dispatchId,bootstrap,workerProfile}={}) {
    const key=taskKey(value);
    const dispatch=boundedString(dispatchId,'dispatchId',256);
    const instructions=boundedString(bootstrap,'bootstrap',12000);
    const selectedProfile=profile(workerProfile);

    const response=await this.fetchImpl(this.endpoint,{
      method:'POST',
      headers:{
        'content-type':'application/json',
        ...this.headers
      },
      body:JSON.stringify({
        taskKey:key,
        dispatchId:dispatch,
        bootstrap:instructions,
        ...(selectedProfile===null ? {} : {workerProfile:selectedProfile})
      })
    });

    const text=await response.text();
    let body=null;
    if(text) {
      try { body=JSON.parse(text); }
      catch {
        body={message:text.slice(0,1000)};
      }
    }
    if(!response.ok) {
      throw new BridgeError(
        'TASK_LAUNCH_FAILED',
        `worker launcher returned HTTP ${response.status}`,
        {status:response.status}
      );
    }
    const externalId=
      typeof body?.workerId==='string' && body.workerId.length<=256
        ? body.workerId
        : typeof body?.id==='string' && body.id.length<=256
          ? body.id
          : null;
    return boundedReceipt({
      launcher:this.launcherName,
      status:'ACCEPTED',
      ...(externalId===null ? {} : {workerId:externalId})
    });
  }
}

export class ManualWorkerLauncher {
  async launch({taskKey:value,dispatchId,bootstrap,workerProfile}={}) {
    const key=taskKey(value);
    const dispatch=boundedString(dispatchId,'dispatchId',256);
    const instructions=boundedString(bootstrap,'bootstrap',12000);
    return boundedReceipt({
      launcher:'manual',
      status:'MANUAL_REQUIRED',
      taskKey:key,
      dispatchId:dispatch,
      ...(profile(workerProfile)===null ? {} : {workerProfile}),
      bootstrap:instructions
    });
  }
}

function assertTaskStore(value) {
  for(const method of ['getTask','claimLaunch','recordLaunchReceipt']) {
    assertBridge(
      value && typeof value[method]==='function',
      'TASK_LAUNCHER_CONFIG_INVALID',
      `task store missing method: ${method}`
    );
  }
  return value;
}

function assertLauncher(value) {
  assertBridge(
    value && typeof value.launch==='function',
    'TASK_LAUNCHER_CONFIG_INVALID',
    'worker launcher must provide launch()'
  );
  return value;
}

export class DurableTaskLaunchCoordinator {
  constructor({
    taskStore,
    launcher,
    randomUUID=()=>globalThis.crypto.randomUUID()
  }={}) {
    this.taskStore=assertTaskStore(taskStore);
    this.launcher=assertLauncher(launcher);
    assertBridge(typeof randomUUID==='function','TASK_LAUNCHER_CONFIG_INVALID','randomUUID is required');
    this.randomUUID=randomUUID;
  }

  async launchDispatch({taskKey:value,dispatchId,workerProfile=null}={}) {
    const key=taskKey(value);
    const dispatch=boundedString(dispatchId,'dispatchId',256);
    const selectedProfile=profile(workerProfile);
    const launchId=`launch-${this.randomUUID()}`;

    const claimed=await this.taskStore.claimLaunch({
      taskKey:key,
      dispatchId:dispatch,
      launchId
    });
    if(!claimed) {
      const current=await this.taskStore.getTask(key);
      return {
        taskKey:key,
        action:'NOOP',
        reason:'LAUNCH_ALREADY_CLAIMED_OR_DISPATCH_STALE',
        status:current?.status ?? null
      };
    }

    const bootstrap=createWorkerBootstrap({taskKey:key,dispatchId:dispatch});
    let receipt;
    try {
      receipt=await this.launcher.launch({
        taskKey:key,
        dispatchId:dispatch,
        bootstrap,
        ...(selectedProfile===null ? {} : {workerProfile:selectedProfile})
      });
      receipt=boundedReceipt(receipt);
    } catch(error) {
      const failure={
        launcher:'unknown',
        status:'LAUNCH_UNKNOWN',
        errorCode:
          typeof error?.code==='string' && error.code.length<=128
            ? error.code
            : 'TASK_LAUNCH_FAILED'
      };
      await this.taskStore.recordLaunchReceipt({
        taskKey:key,
        dispatchId:dispatch,
        launchId,
        receipt:failure
      });
      throw error;
    }

    const recorded=await this.taskStore.recordLaunchReceipt({
      taskKey:key,
      dispatchId:dispatch,
      launchId,
      receipt
    });
    assertBridge(
      recorded,
      'TASK_LAUNCH_STALE',
      'dispatch changed before launcher receipt could be recorded'
    );

    return {
      taskKey:key,
      action:'LAUNCHED',
      dispatchId:dispatch,
      launchId,
      activationDeadline:claimed.dispatchExpiresAt,
      receipt
    };
  }
}
