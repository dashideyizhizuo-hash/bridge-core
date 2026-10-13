import { readBoundedText } from './request-body.mjs';
import { assertBridge, BridgeError } from '../errors.mjs';

export const TASK_RUNTIME_ACTIVATE_PATH='/task-runtime/activate';
export const TASK_RUNTIME_HEADERS=Object.freeze({
  taskKey:'x-bridge-task-key',
  leaseEpoch:'x-bridge-task-epoch',
  workerId:'x-bridge-task-owner'
});

const TASK_KEY_PATTERN=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/;
const OWNER_PATTERN=/^[A-Za-z0-9._:-]{8,256}$/;
const MAX_ACTIVATION_BYTES=4096;

function assertTaskStore(value) {
  for(const method of ['getTask','activate','assertCurrent','bindRun']) {
    assertBridge(
      value && typeof value[method]==='function',
      'TASK_RUNTIME_CONFIG_INVALID',
      `task store missing method: ${method}`
    );
  }
  return value;
}

function assertTaskSessionStore(value) {
  for(const method of ['issue','resolve']) {
    assertBridge(
      value && typeof value[method]==='function',
      'TASK_RUNTIME_CONFIG_INVALID',
      `task session store missing method: ${method}`
    );
  }
  return value;
}

function taskKey(value) {
  assertBridge(
    typeof value==='string' &&
      value.length<=512 &&
      TASK_KEY_PATTERN.test(value),
    'TASK_SESSION_INVALID',
    'task session task key is invalid'
  );
  return value;
}

function leaseEpoch(value) {
  const parsed=typeof value==='number' ? value : Number(value);
  assertBridge(
    Number.isSafeInteger(parsed) && parsed>0,
    'TASK_SESSION_INVALID',
    'task session lease epoch is invalid'
  );
  return parsed;
}

function workerId(value) {
  assertBridge(
    typeof value==='string' && OWNER_PATTERN.test(value),
    'TASK_SESSION_INVALID',
    'task session worker owner is invalid'
  );
  return value;
}

function dispatchId(value) {
  assertBridge(
    typeof value==='string' &&
      value.length>=8 &&
      value.length<=256 &&
      /^[A-Za-z0-9._:-]+$/.test(value),
    'TASK_ACTIVATION_INVALID',
    'dispatchId is invalid'
  );
  return value;
}

function exactObject(value,allowed,code,label) {
  assertBridge(
    value && typeof value==='object' && !Array.isArray(value),
    code,
    `${label} must be an object`
  );
  for(const key of Object.keys(value)) {
    assertBridge(
      allowed.has(key),
      code,
      `${label} contains unsupported field: ${key}`
    );
  }
  return value;
}

async function boundedJson(request) {
  const text=await readBoundedText(request,{maxBytes:MAX_ACTIVATION_BYTES,code:'TASK_ACTIVATION_INVALID',message:'task request is too large'});
  let parsed;
  try { parsed=JSON.parse(text); }
  catch(error) {
    throw new BridgeError(
      'TASK_ACTIVATION_INVALID',
      'task activation request is not valid JSON',
      {cause:error.message}
    );
  }
  return parsed;
}

function sessionFromIdentity(
  {taskKey:key,leaseEpoch:epochValue,workerId:ownerValue},
  store,
  taskActivity=null
) {
  const taskStore=assertTaskStore(store);
  const normalizedKey=taskKey(key);
  const epoch=leaseEpoch(epochValue);
  const owner=workerId(ownerValue);
  return Object.freeze({
    taskContext:Object.freeze({
      taskKey:normalizedKey,
      leaseEpoch:epoch
    }),
    taskLeaseValidator:Object.freeze({
      async assertCurrent(binding) {
        const current=await taskStore.assertCurrent({
          ...binding,
          workerId:owner
        });
        if(taskActivity!==null) await taskActivity.renew();
        return current;
      },
      async bindRun(binding) {
        return taskStore.bindRun({
          ...binding,
          workerId:owner
        });
      }
    }),
    workerId:owner,
    ...(taskActivity===null ? {} : {taskActivity})
  });
}

export async function taskRuntimeSessionForRequest(
  request,
  {taskStore,bridgeUserId}={}
) {
  assertBridge(
    request instanceof Request,
    'TASK_SESSION_INVALID',
    'task session request is required'
  );
  const raw={
    taskKey:request.headers.get(TASK_RUNTIME_HEADERS.taskKey),
    leaseEpoch:request.headers.get(TASK_RUNTIME_HEADERS.leaseEpoch),
    workerId:request.headers.get(TASK_RUNTIME_HEADERS.workerId)
  };
  const present=Object.values(raw).filter(value=>value!==null).length;
  if(present===0) return null;
  assertBridge(
    present===3,
    'TASK_SESSION_INVALID',
    'task session requires task key, lease epoch, and worker owner together'
  );
  const store=assertTaskStore(taskStore);
  assertBridge(
    typeof bridgeUserId==='string' && bridgeUserId.length>=1 && bridgeUserId.length<=256,
    'TASK_SESSION_INVALID',
    'authenticated Bridge principal is required for task session headers'
  );
  const task=await store.getTask(taskKey(raw.taskKey));
  assertBridge(task,'TASK_NOT_FOUND','durable task is not enrolled');
  assertBridge(
    task.bridgeUserId===bridgeUserId,
    'TASK_SESSION_PRINCIPAL_MISMATCH',
    'task session headers belong to another Bridge principal'
  );
  return sessionFromIdentity(raw,store);
}

export async function taskRuntimeSessionForToken(
  token,
  {taskStore,taskSessionStore,bridgeUserId}={}
) {
  const store=assertTaskStore(taskStore);
  const sessions=assertTaskSessionStore(taskSessionStore);
  assertBridge(
    typeof sessions.renewSession==='function',
    'TASK_RUNTIME_CONFIG_INVALID',
    'task session store missing method: renewSession'
  );
  const identity=await sessions.resolve(token);
  assertBridge(
    typeof bridgeUserId==='string' && bridgeUserId.length>=1 && bridgeUserId.length<=256,
    'TASK_SESSION_INVALID',
    'authenticated Bridge principal is required for task session capability'
  );
  assertBridge(
    typeof store.getTask==='function',
    'TASK_RUNTIME_CONFIG_INVALID',
    'task store missing method: getTask'
  );
  const task=await store.getTask(identity.taskKey);
  assertBridge(task,'TASK_NOT_FOUND','durable task is not enrolled');
  assertBridge(
    task.bridgeUserId===bridgeUserId,
    'TASK_SESSION_PRINCIPAL_MISMATCH',
    'task session capability belongs to another Bridge principal'
  );
  return sessionFromIdentity(identity,store,Object.freeze({
    async renew() {
      return sessions.renewSession({
        token,
        taskKey:identity.taskKey,
        workerId:identity.workerId,
        leaseEpoch:identity.leaseEpoch
      });
    }
  }));
}

export async function activateTaskDispatch({
  request,
  taskStore,
  taskSessionStore,
  randomUUID=()=>globalThis.crypto.randomUUID()
}={}) {
  const store=assertTaskStore(taskStore);
  const sessions=assertTaskSessionStore(taskSessionStore);
  assertBridge(
    request instanceof Request,
    'TASK_ACTIVATION_INVALID',
    'task activation request is required'
  );
  assertBridge(
    request.method==='POST',
    'TASK_ACTIVATION_INVALID',
    'task activation requires POST'
  );
  assertBridge(
    typeof randomUUID==='function',
    'TASK_RUNTIME_CONFIG_INVALID',
    'activation randomUUID is required'
  );

  const body=exactObject(
    await boundedJson(request),
    new Set(['taskKey','dispatchId']),
    'TASK_ACTIVATION_INVALID',
    'task activation'
  );
  const key=taskKey(body.taskKey);
  const dispatch=dispatchId(body.dispatchId);
  const owner=workerId(`worker-${randomUUID()}`);

  const lease=await store.activate({
    taskKey:key,
    dispatchId:dispatch,
    workerId:owner,
    reason:'PROGRAMMABLE_WORKER_ACTIVATED'
  });
  if(!lease) return null;

  assertBridge(
    lease.taskKey===key &&
      lease.leaseOwner===owner &&
      Number.isSafeInteger(lease.leaseEpoch) &&
      lease.leaseEpoch>0 &&
      typeof lease.canonicalBranch==='string' &&
      typeof lease.leaseExpiresAt==='string',
    'TASK_ACTIVATION_INVALID',
    'task store returned an invalid activated lease'
  );

  const taskSessionToken=await sessions.issue({
    taskKey:key,
    workerId:owner,
    leaseEpoch:lease.leaseEpoch,
    expiresAt:lease.leaseExpiresAt
  });

  return Object.freeze({
    status:'ACTIVATED',
    taskKey:key,
    workerId:owner,
    leaseEpoch:lease.leaseEpoch,
    leaseExpiresAt:lease.leaseExpiresAt,
    canonicalBranch:lease.canonicalBranch,
    mode:lease.mode,
    taskSessionToken,
    mcpSession:Object.freeze({
      headers:Object.freeze({
        [TASK_RUNTIME_HEADERS.taskKey]:key,
        [TASK_RUNTIME_HEADERS.leaseEpoch]:String(lease.leaseEpoch),
        [TASK_RUNTIME_HEADERS.workerId]:owner
      })
    })
  });
}
