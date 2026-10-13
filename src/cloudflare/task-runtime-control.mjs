import { readBoundedText } from './request-body.mjs';
import { assertBridge, BridgeError, errorEnvelope } from '../errors.mjs';
import { createRequestScopedGateway } from '../control-plane.mjs';
import { DurableTaskWatchdog } from '../task-watchdog.mjs';
import { createAuthorizedTaskState } from './task-github-reader.mjs';
import {
  DurableTaskLaunchCoordinator,
  HttpWorkerLauncher
} from '../task-launcher.mjs';

export const TASK_RUNTIME_CONTROL_PATH='/task-runtime/control';

const TASK_KEY_PATTERN=/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/;
const MAX_CONTROL_BYTES=8192;

function requiredString(value,label,max=512) {
  assertBridge(
    typeof value==='string' &&
      value.length>=1 &&
      value.length<=max &&
      !/\0/.test(value),
    'TASK_CONTROL_INVALID',
    `${label} is invalid`
  );
  return value;
}

function optionalString(value,label,max=512) {
  if(value===undefined || value===null) return null;
  return requiredString(value,label,max);
}

function exactObject(value,allowed,label) {
  assertBridge(
    value && typeof value==='object' && !Array.isArray(value),
    'TASK_CONTROL_INVALID',
    `${label} must be an object`
  );
  for(const key of Object.keys(value)) {
    assertBridge(
      allowed.has(key),
      'TASK_CONTROL_INVALID',
      `${label} contains unsupported field: ${key}`
    );
  }
  return value;
}

function taskIdentity(value) {
  const key=requiredString(value,'taskKey',512);
  const match=TASK_KEY_PATTERN.exec(key);
  assertBridge(match,'TASK_CONTROL_INVALID','taskKey must be owner/repository#issue-number');
  return {
    taskKey:key,
    repository:match[1],
    issueNumber:Number(match[2])
  };
}

function optionalSha(value,label) {
  if(value===undefined || value===null) return null;
  assertBridge(
    typeof value==='string' && /^[0-9a-f]{40}$/.test(value),
    'TASK_CONTROL_INVALID',
    `${label} must be an exact SHA`
  );
  return value;
}

function optionalPositiveInteger(value,label) {
  if(value===undefined || value===null) return null;
  assertBridge(
    Number.isSafeInteger(value) && value>0,
    'TASK_CONTROL_INVALID',
    `${label} must be a positive integer`
  );
  return value;
}

function mode(value) {
  assertBridge(
    value==='supervised' || value==='continuous',
    'TASK_CONTROL_INVALID',
    'mode must be supervised or continuous'
  );
  return value;
}

function assertTaskStore(value) {
  for(const method of ['createTask','getTask','listWatchableTasks','dispatch','renewActiveRun','markOrphaned','reconcileExpired']) {
    assertBridge(
      value && typeof value[method]==='function',
      'TASK_CONTROL_CONFIG_INVALID',
      `task store missing method: ${method}`
    );
  }
  return value;
}

function assertIdentityStore(value) {
  for(const method of ['resolvePrincipalById','resolvePrincipalByGitHubUserId','assert','resolve']) {
    assertBridge(
      value && typeof value[method]==='function',
      'TASK_CONTROL_CONFIG_INVALID',
      `identity store missing method: ${method}`
    );
  }
  return value;
}

function assertCredentialProvider(value) {
  assertBridge(
    value && typeof value.acquire==='function',
    'TASK_CONTROL_CONFIG_INVALID',
    'credential provider is required'
  );
  return value;
}

function safeTask(task) {
  if(!task) return null;
  return {
    taskKey:task.taskKey,
    bridgeUserId:task.bridgeUserId,
    repository:task.repository,
    issueNumber:task.issueNumber,
    canonicalBranch:task.canonicalBranch,
    mode:task.mode,
    status:task.status,
    dispatchId:task.dispatchId,
    dispatchExpiresAt:task.dispatchExpiresAt,
    leaseOwner:task.leaseOwner,
    leaseEpoch:task.leaseEpoch,
    leaseExpiresAt:task.leaseExpiresAt,
    activeRunId:task.activeRunId,
    checkpointSha:task.checkpointSha,
    stateCommentId:task.stateCommentId,
    lastTransitionReason:task.lastTransitionReason,
    updatedAt:task.updatedAt
  };
}

export class DurableTaskControl {
  constructor({
    taskStore,
    identityStore,
    credentialProvider,
    fetchImpl=globalThis.fetch,
    apiBase='https://api.github.com',
    gatewayFactory=createRequestScopedGateway,
    launcherCoordinator=null
  }={}) {
    this.taskStore=assertTaskStore(taskStore);
    this.identityStore=assertIdentityStore(identityStore);
    this.credentialProvider=assertCredentialProvider(credentialProvider);
    assertBridge(typeof fetchImpl==='function','TASK_CONTROL_CONFIG_INVALID','fetch implementation is required');
    assertBridge(typeof gatewayFactory==='function','TASK_CONTROL_CONFIG_INVALID','gatewayFactory is required');
    if(launcherCoordinator!==null) {
      assertBridge(
        launcherCoordinator && typeof launcherCoordinator.launchDispatch==='function',
        'TASK_CONTROL_CONFIG_INVALID',
        'launcherCoordinator must provide launchDispatch'
      );
    }
    this.fetchImpl=fetchImpl;
    this.apiBase=apiBase;
    this.gatewayFactory=gatewayFactory;
    this.launcherCoordinator=launcherCoordinator;
  }

  async #principalFor(task) {
    assertBridge(
      typeof task?.bridgeUserId==='string' && task.bridgeUserId.length>0,
      'TASK_OWNER_MISSING',
      'durable task has no owning Bridge principal'
    );
    const principal=await this.identityStore.resolvePrincipalById(task.bridgeUserId);
    assertBridge(
      principal,
      'TASK_OWNER_MISSING',
      'durable task owner principal is unavailable'
    );
    return principal;
  }

  async #authorizedPrincipal({bridgeUserId,githubUserId,repository}) {
    assertBridge(
      (bridgeUserId!==undefined && bridgeUserId!==null) !==
        (githubUserId!==undefined && githubUserId!==null),
      'TASK_CONTROL_INVALID',
      'enrollment requires exactly one of bridgeUserId or githubUserId'
    );
    const principal=bridgeUserId!==undefined && bridgeUserId!==null
      ? await this.identityStore.resolvePrincipalById(
          requiredString(bridgeUserId,'bridgeUserId',256)
        )
      : await this.identityStore.resolvePrincipalByGitHubUserId(
          requiredString(githubUserId,'githubUserId',128)
        );
    assertBridge(principal,'TASK_OWNER_MISSING','Bridge principal is unavailable');
    await this.identityStore.assert({principal,repository,permission:'run'});
    await this.identityStore.assert({principal,repository,permission:'publish'});
    return principal;
  }

  async #runReader(task) {
    const principal=await this.#principalFor(task);
    await this.identityStore.assert({
      principal,
      repository:task.repository,
      permission:'read'
    });
    return this.gatewayFactory({
      principal,
      principalRepositoryAuthorizer:this.identityStore,
      installationResolver:this.identityStore,
      credentialProvider:this.credentialProvider,
      fetchImpl:this.fetchImpl,
      apiBase:this.apiBase
    });
  }

  async #durableStateFor(task) {
    const principal=await this.#principalFor(task);
    return createAuthorizedTaskState({
      principal,
      repository:task.repository,
      identityStore:this.identityStore,
      credentialProvider:this.credentialProvider,
      fetchImpl:this.fetchImpl,
      apiBase:this.apiBase
    });
  }

  async enroll(input) {
    const value=exactObject(
      input,
      new Set([
        'taskKey','bridgeUserId','githubUserId','repository','issueNumber','canonicalBranch',
        'mode','checkpointSha','stateCommentId'
      ]),
      'task enrollment'
    );
    const identity=taskIdentity(value.taskKey);
    const repository=requiredString(value.repository,'repository',256);
    const issueNumber=optionalPositiveInteger(value.issueNumber,'issueNumber');
    assertBridge(
      repository===identity.repository &&
        issueNumber===identity.issueNumber,
      'TASK_CONTROL_INVALID',
      'taskKey must match repository and issueNumber'
    );
    const canonicalBranch=requiredString(value.canonicalBranch,'canonicalBranch',255);
    const executionMode=mode(value.mode);
    const checkpointSha=optionalSha(value.checkpointSha,'checkpointSha');
    const stateCommentId=optionalPositiveInteger(value.stateCommentId,'stateCommentId');

    const principal=await this.#authorizedPrincipal({
      bridgeUserId:value.bridgeUserId,
      githubUserId:value.githubUserId,
      repository
    });

    const task=await this.taskStore.createTask({
      taskKey:identity.taskKey,
      bridgeUserId:principal.bridgeUserId,
      repository,
      issueNumber,
      canonicalBranch,
      mode:executionMode,
      ...(checkpointSha===null ? {} : {checkpointSha}),
      ...(stateCommentId===null ? {} : {stateCommentId}),
      reason:'EXPLICIT_TASK_ENROLLMENT'
    });
    return {action:'ENROLLED',task:safeTask(task)};
  }

  async inspect(taskKey) {
    const task=await this.taskStore.getTask(taskIdentity(taskKey).taskKey);
    assertBridge(task,'TASK_NOT_FOUND','durable task is not enrolled');
    return {action:'INSPECT',task:safeTask(task)};
  }

  async tick(taskKey,{launch=true,workerProfile=null}={}) {
    const key=taskIdentity(taskKey).taskKey;
    const task=await this.taskStore.getTask(key);
    assertBridge(task,'TASK_NOT_FOUND','durable task is not enrolled');
    const runReader=await this.#runReader(task);
    let durablePromise=null;
    const durable=()=>{
      durablePromise ??= this.#durableStateFor(task);
      return durablePromise;
    };
    const watchdog=new DurableTaskWatchdog({
      taskStore:this.taskStore,
      runReader,
      durableState:{
        readState:async value=>(await durable()).readState(value),
        readLatestTaskEvents:async value=>(await durable()).readLatestTaskEvents(value),
        verifyCheckpoint:async value=>(await durable()).verifyCheckpoint(value),
        verifyBlocker:async value=>(await durable()).verifyBlocker(value)
      }
    });
    const decision=await watchdog.tick(key);
    if(
      decision.action!=='DISPATCH' ||
      launch!==true ||
      this.launcherCoordinator===null
    ) {
      return {
        action:'TICK',
        decision,
        launch:null
      };
    }
    const launched=await this.launcherCoordinator.launchDispatch({
      taskKey:key,
      dispatchId:decision.dispatchId,
      ...(workerProfile===null ? {} : {workerProfile})
    });
    return {
      action:'TICK',
      decision,
      launch:launched
    };
  }

  async tickAll({limit=100,launch=true,workerProfile=null}={}) {
    const tasks=await this.taskStore.listWatchableTasks({limit});
    const results=[];
    for(const task of tasks) {
      try {
        results.push({
          taskKey:task.taskKey,
          ok:true,
          result:await this.tick(task.taskKey,{launch,workerProfile})
        });
      } catch(error) {
        results.push({
          taskKey:task.taskKey,
          ok:false,
          error:errorEnvelope(error)
        });
      }
    }
    return {
      action:'TICK_ALL',
      count:tasks.length,
      results
    };
  }
}

function constantTimeEqual(left,right) {
  if(left.length!==right.length) return false;
  let diff=0;
  for(let index=0;index<left.length;index++) {
    diff|=left[index]^right[index];
  }
  return diff===0;
}

async function secretDigest(value) {
  const bytes=new TextEncoder().encode(value);
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',bytes));
}

async function authorizedAdmin(request,secret) {
  assertBridge(
    typeof secret==='string' && secret.length>=32 && secret.length<=4096,
    'TASK_CONTROL_CONFIG_INVALID',
    'BRIDGE_TASK_RUNTIME_ADMIN_TOKEN must be at least 32 characters'
  );
  const header=request.headers.get('authorization');
  if(typeof header!=='string' || !header.startsWith('Bearer ')) return false;
  const presented=header.slice('Bearer '.length);
  if(presented.length<1 || presented.length>4096) return false;
  return constantTimeEqual(
    await secretDigest(presented),
    await secretDigest(secret)
  );
}

async function boundedJson(request) {
  const text=await readBoundedText(request,{maxBytes:MAX_CONTROL_BYTES,code:'TASK_CONTROL_INVALID',message:'task request is too large'});
  let parsed;
  try { parsed=JSON.parse(text); }
  catch(error) {
    throw new BridgeError(
      'TASK_CONTROL_INVALID',
      'task control request is not valid JSON',
      {cause:error.message}
    );
  }
  return parsed;
}

export function createTaskRuntimeControlHandler({
  control,
  adminToken
}={}) {
  assertBridge(
    control &&
      typeof control.enroll==='function' &&
      typeof control.inspect==='function' &&
      typeof control.tick==='function',
    'TASK_CONTROL_CONFIG_INVALID',
    'DurableTaskControl is required'
  );
  return Object.freeze({
    async fetch(request) {
      assertBridge(request instanceof Request,'TASK_CONTROL_INVALID','request is required');
      if(request.method!=='POST') {
        return Response.json(
          {error:{code:'TASK_CONTROL_METHOD_NOT_ALLOWED',message:'task control requires POST'}},
          {status:405,headers:{'cache-control':'no-store'}}
        );
      }
      if(!(await authorizedAdmin(request,adminToken))) {
        return Response.json(
          {error:{code:'TASK_CONTROL_UNAUTHORIZED',message:'task control authorization failed'}},
          {status:401,headers:{'cache-control':'no-store'}}
        );
      }
      try {
        const body=exactObject(
          await boundedJson(request),
          new Set(['action','task','taskKey','launch','workerProfile']),
          'task control request'
        );
        const action=requiredString(body.action,'action',32);
        let result;
        if(action==='enroll') {
          result=await control.enroll(body.task);
        } else if(action==='inspect') {
          result=await control.inspect(body.taskKey);
        } else if(action==='tick') {
          result=await control.tick(body.taskKey,{
            launch:body.launch!==false,
            workerProfile:optionalString(body.workerProfile,'workerProfile',128)
          });
        } else {
          throw new BridgeError('TASK_CONTROL_INVALID',`unsupported task control action: ${action}`);
        }
        return Response.json(
          result,
          {headers:{'cache-control':'no-store'}}
        );
      } catch(error) {
        const status=
          error?.code==='TASK_NOT_FOUND' ? 404 :
          error?.code==='TASK_ENROLLMENT_CONFLICT' ? 409 :
          error?.code==='REPOSITORY_DENIED' ? 403 :
          400;
        return Response.json(
          {error:errorEnvelope(error)},
          {status,headers:{'cache-control':'no-store'}}
        );
      }
    }
  });
}

export function createConfiguredTaskLauncher({
  taskStore,
  endpoint,
  token,
  fetchImpl=globalThis.fetch
}={}) {
  if(endpoint===undefined || endpoint===null || endpoint==='') return null;
  const headers={};
  if(token!==undefined && token!==null && token!=='') {
    headers.authorization=`Bearer ${requiredString(token,'launcher token',4096)}`;
  }
  return new DurableTaskLaunchCoordinator({
    taskStore,
    launcher:new HttpWorkerLauncher({
      endpoint:requiredString(endpoint,'launcher endpoint',2048),
      fetchImpl,
      headers,
      launcherName:'cloudflare-programmable-worker'
    })
  });
}
