import {policyProfile} from './default-project-policy.mjs';
import { randomUUID } from 'node:crypto';
import { assertBridge } from './errors.mjs';
import { validateAndDefaultParameters } from './parameters.mjs';
import { validateBatchRequest, validateEditRequest, validateProjectPolicy, validateRequest } from './validate.mjs';
import { createTaskBinding, validateTaskBinding, validateTaskContext } from './task-runtime-binding.mjs';

function repositoryName(value) {
  assertBridge(typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value), 'INVALID_GATEWAY_REQUEST', 'repository must be owner/name');
  return value;
}

function targetRef(value) {
  assertBridge(typeof value === 'string' && value.length > 0 && value.length <= 255, 'INVALID_GATEWAY_REQUEST', 'targetRef is required');
  return value;
}

function runId(value) {
  assertBridge(typeof value === 'string' && value.length >= 8 && value.length <= 256, 'INVALID_GATEWAY_REQUEST', 'runId invalid');
  return value;
}

function sanitizeCapability(id, capability, policy) {
  return {
    id,
    class: capability.class,
    runnerClass: policy.runners[capability.runner]?.class ?? null,
    parameters: capability.parameters ?? {},
    resources: (capability.resources ?? []).map(x => x.name),
    limits: capability.limits ?? {}
  };
}

function normalizeBatchSteps(policy, steps) {
  assertBridge(Array.isArray(steps), 'INVALID_GATEWAY_REQUEST', 'batch steps must be an array');
  return steps.map((step,index) => {
    assertBridge(step && typeof step === 'object' && !Array.isArray(step), 'INVALID_GATEWAY_REQUEST', `batch step ${index} must be an object`);
    if (step.type === 'exec') {
      assertBridge(policy.workspaceExec?.enabled === true, 'UNKNOWN_CAPABILITY', 'generic exec is not enabled by trusted project policy');
      return structuredClone(step);
    }
    if (step.type === 'preset') {
      const capability=policy.capabilities?.[step.capability];
      assertBridge(capability, 'UNKNOWN_CAPABILITY', `unknown trusted capability: ${step.capability}`);
      return {
        ...structuredClone(step),
        parameters:validateAndDefaultParameters(capability.parameters ?? {}, step.parameters ?? {})
      };
    }
    if (step.type === 'edit') {
      assertBridge(policy.editing?.enabled === true, 'EDIT_DENIED', 'editing is not enabled by trusted project policy');
      return structuredClone(step);
    }
    assertBridge(false, 'INVALID_GATEWAY_REQUEST', `unsupported batch step type at index ${index}`);
  });
}

function normalizeVerification(policy, verification) {
  assertBridge(Array.isArray(verification) && verification.length >= 1 && verification.length <= 4, 'INVALID_GATEWAY_REQUEST', 'edit verification must contain 1-4 entries');
  return verification.map((step,index) => {
    assertBridge(step && typeof step === 'object' && !Array.isArray(step), 'INVALID_GATEWAY_REQUEST', `verification ${index} must be an object`);
    const capability=policy.capabilities?.[step.capability];
    assertBridge(capability?.class === 'verify', 'VERIFICATION_DENIED', `verification ${index} must reference a trusted verify capability: ${step.capability}`);
    return {
      capability: step.capability,
      parameters: validateAndDefaultParameters(capability.parameters ?? {}, step.parameters ?? {})
    };
  });
}

export class BridgeGateway {
  constructor({ transport, directExec = null, directAssets = null, directPairing = null, principal = null, taskContext, taskLifecycle = null, taskActivity = null } = {}) {
    assertBridge(transport && typeof transport === 'object', 'GATEWAY_CONFIG_INVALID', 'transport is required');
    for (const method of ['resolveRepository','resolveTarget','readProjectPolicy','submitCapabilityRequest','submitEditRequest','getRun','getResult','publishVerified']) {
      assertBridge(typeof transport[method] === 'function', 'GATEWAY_CONFIG_INVALID', `transport missing method: ${method}`);
    }
    this.transport=transport;
    assertBridge(
      directExec===null ||
        (
          directExec &&
          typeof directExec.submit==='function' &&
          typeof directExec.getRun==='function' &&
          typeof directExec.getResult==='function'
        ),
      'GATEWAY_CONFIG_INVALID',
      'directExec must provide submit/getRun/getResult'
    );
    this.directExec=directExec;
    assertBridge(
      directAssets===null ||
        (
          directAssets &&
          typeof directAssets.createUpload==='function' &&
          typeof directAssets.importFile==='function' &&
          typeof directAssets.assertReady==='function' &&
          typeof directAssets.getRun==='function' &&
          typeof directAssets.getResult==='function' &&
          typeof directAssets.issueResource==='function' &&
          typeof directAssets.readResource==='function'
        ),
      'GATEWAY_CONFIG_INVALID',
      'directAssets must provide createUpload/importFile/assertReady/getRun/getResult/issueResource/readResource'
    );
    this.directAssets=directAssets;
    assertBridge(
      directPairing===null ||
        (
          directPairing &&
          typeof directPairing.create==='function'
        ),
      'GATEWAY_CONFIG_INVALID',
      'directPairing must provide create'
    );
    this.directPairing=directPairing;
    this.principal=principal;
    this.taskContext=taskContext === undefined ? null : validateTaskContext(taskContext);
    assertBridge(
      taskLifecycle===null ||
        (taskLifecycle && typeof taskLifecycle.transition==='function'),
      'GATEWAY_CONFIG_INVALID',
      'taskLifecycle must provide transition'
    );
    this.taskLifecycle=taskLifecycle;
    assertBridge(
      taskActivity===null ||
        (taskActivity && typeof taskActivity.renew==='function'),
      'GATEWAY_CONFIG_INVALID',
      'taskActivity must provide renew'
    );
    this.taskActivity=taskActivity;
  }

  async #renewTaskActivity() {
    if(this.taskActivity!==null) await this.taskActivity.renew();
  }

  #assertTaskRun(value) {
    if(this.taskContext===null) return;
    const binding=validateTaskBinding(value?.task);
    assertBridge(
      binding.taskKey===this.taskContext.taskKey &&
        binding.leaseEpoch===this.taskContext.leaseEpoch,
      'TASK_BINDING_MISMATCH',
      'Bridge Run does not belong to the current task lease'
    );
  }

  #taskBinding(repository,target) {
    return this.taskContext === null
      ? null
      : createTaskBinding(this.taskContext,{repository,target});
  }

  async #trustedContext(repository,{signal}={}) {
    signal?.throwIfAborted();
    const repo=repositoryName(repository);
    const combined=typeof this.transport.readTrustedRepositoryContext==='function';
    const context=combined?await this.transport.readTrustedRepositoryContext(repo,{signal}):null;
    const info=combined?context?.info:await this.transport.resolveRepository(repo,{signal});
    signal?.throwIfAborted();
    assertBridge(info && typeof info.defaultRef === 'string' && /^[0-9a-f]{40}$/.test(info.defaultSha), 'GATEWAY_TRANSPORT_INVALID', 'transport returned invalid repository identity');
    const policy=validateProjectPolicy(combined?context.policy:await this.transport.readProjectPolicy(repo,info.defaultSha,{signal}),repo);
    signal?.throwIfAborted();
    return { repository:repo, info, policy };
  }

  async listRepositories() {
    // Enumeration is an owner-scoped convenience, never an execution grant.
    if(typeof this.transport.listRepositories!=='function')return [];
    const repositories=await this.transport.listRepositories();
    assertBridge(Array.isArray(repositories)&&repositories.length<=17&&repositories.every(value=>typeof value==='string'),
      'MCP_CATALOG_UNAVAILABLE','Repository catalog is unavailable');
    return [...new Set(repositories.map(repositoryName))].sort();
  }

  async discover({ repository,signal } = {}) {
    if(repository===undefined || repository===null) {
      assertBridge(
        this.directExec!==null && typeof this.directExec.listHosts==='function',
        'DIRECT_EXEC_UNAVAILABLE',
        'Direct Exec is not configured on this Bridge deployment'
      );
      const hosts=await this.directExec.listHosts({principal:this.principal});
      const enabled=hosts.filter(host=>host.enabled);
      return {
        direct:{
          enabled:true,
          hosts,
          ...(enabled.length===1 ? {defaultHost:enabled[0].hostId} : {}),
          assets:{
            enabled:this.directAssets!==null,
            nativeFileImport:this.directAssets!==null,
            persistentStorage:false,
            defaultRetentionSeconds:86400,
            exports:this.directAssets!==null,
            maxBytes:25*1024*1024,
            maxPerRun:8
          },
          connect:{
            enabled:this.directPairing!==null,
            selfService:this.directPairing!==null
          }
        }
      };
    }
    const {repository:repo,info,policy}=await this.#trustedContext(repository,{signal});
    const capabilities=Object.entries(policy.capabilities)
      .map(([id,capability])=>sanitizeCapability(id,capability,policy))
      .sort((a,b)=>a.id.localeCompare(b.id));
    const workspace=policy.workspaceExec?.enabled === true
      ? {
          enabled:true,
          runnerClass:policy.runners[policy.workspaceExec.runner]?.class ?? null,
          maxArgv:policy.workspaceExec.maxArgv ?? 32,
          maxSeconds:policy.workspaceExec.maxSeconds ?? 900
        }
      : {enabled:false};
    const editing=policy.editing?.enabled === true
      ? {
          enabled:true,
          publish:policy.editing.publish === true,
          runnerClass:policy.runners[policy.editing.runner]?.class ?? null,
          allowedBranches:[...policy.editing.allowedBranches],
          allowedPaths:[...policy.editing.allowedPaths],
          maxOperations:policy.editing.maxOperations ?? 16,
          maxPatchBytes:policy.editing.maxPatchBytes ?? 262144
        }
      : {enabled:false};
    const genericExec=workspace.enabled
      ? {...workspace,resources:(policy.workspaceExec.resources ?? []).map(item=>item.name)}
      : {enabled:false};
    return {
      repository:repo,
      policy:{ref:info.defaultRef,sha:info.defaultSha},
      capabilities,
      mcp:{verificationConfigured:Array.isArray(policy.mcp?.verification)},
      policyProfile:policyProfile(policy),
      executionEnvironment:{status:"unchecked",requirements:["workflow","runner","host-policy"]},
      exec:genericExec,
      workspaceExec:workspace,
      editing
    };
  }

  async run(input) {
    if(input?.mode === 'host') {
      assertBridge(this.taskContext===null,'DIRECT_HOST_TASK_UNSUPPORTED','Host management is not part of GitHub Durable Task Runtime');
      assertBridge(this.directExec!==null,'DIRECT_EXEC_UNAVAILABLE','Direct Exec is not configured on this Bridge deployment');
      assertBridge(
        typeof input.host==='string' &&
          /^[A-Za-z0-9_.-]{1,128}$/.test(input.host) &&
          typeof input.enabled==='boolean',
        'INVALID_GATEWAY_REQUEST',
        'host mode requires host and enabled'
      );
      const updated=await this.directExec.setHostEnabled({
        principal:this.principal,
        hostId:input.host,
        enabled:input.enabled
      });
      return {
        kind:'host',
        ...updated
      };
    }

    if(input?.mode === 'connect') {
      assertBridge(this.taskContext===null,'DIRECT_PAIRING_TASK_UNSUPPORTED','Host pairing is not part of GitHub Durable Task Runtime');
      assertBridge(this.directPairing!==null,'DIRECT_PAIRING_UNAVAILABLE','Self-service host pairing is not configured on this Bridge deployment');
      return this.directPairing.create({
        principal:this.principal,
        ttlSeconds:input.ttlSeconds ?? 600
      });
    }

    if(input?.mode === 'asset') {
      assertBridge(this.taskContext===null,'DIRECT_ASSET_TASK_UNSUPPORTED','Direct Assets are not part of GitHub Durable Task Runtime');
      assertBridge(this.directAssets!==null,'DIRECT_ASSET_UNAVAILABLE','Direct Assets are not configured on this Bridge deployment');
      assertBridge(input.persistent!==true,'INVALID_GATEWAY_REQUEST',
        'New files are temporary transfers; persistent storage is not supported');
      const ttl=input.ttlSeconds===undefined ? {} : {ttlMs:input.ttlSeconds*1000};
      if(input.assetAction!==undefined) {
        assertBridge(
          input.assetAction==='delete' &&
            typeof input.assetId==='string' &&
            Object.keys(input).every(key=>['mode','assetAction','assetId'].includes(key)),
          'INVALID_GATEWAY_REQUEST',
          'asset delete accepts only mode, assetAction=delete and assetId'
        );
        assertBridge(
          typeof this.directAssets.deletePersistent==='function',
          'DIRECT_ASSET_UNAVAILABLE',
          'persistent asset deletion is unavailable'
        );
        return this.directAssets.deletePersistent({principal:this.principal,assetId:input.assetId});
      }
      if(input.file!==undefined) {
        return this.directAssets.importFile({
          principal:this.principal,
          file:input.file,
          persistent:input.persistent ?? false,
          ...ttl
        });
      }
      return this.directAssets.createUpload({
        principal:this.principal,
        fileName:input.fileName,
        mimeType:input.mimeType,
        sizeBytes:input.sizeBytes,
        sha256:input.sha256,
        persistent:false,
        ...ttl
      });
    }

    if(input?.mode === 'direct') {
      assertBridge(this.directExec!==null,'DIRECT_EXEC_UNAVAILABLE','Direct Exec is not configured on this Bridge deployment');
      assertBridge(this.taskContext===null,'DIRECT_EXEC_TASK_UNSUPPORTED','Direct Exec is not part of GitHub Durable Task Runtime');
      const requestId=`direct-${randomUUID()}`;
      let assets=[];
      if(input.assets!==undefined) {
        assertBridge(this.directAssets!==null,'DIRECT_ASSET_UNAVAILABLE','Direct Assets are not configured on this Bridge deployment');
        assertBridge(
          Array.isArray(input.assets) && input.assets.length>=1 && input.assets.length<=8 &&
            input.assets.every(value=>typeof value==='string'),
          'INVALID_GATEWAY_REQUEST',
          'direct assets must contain 1-8 asset IDs'
        );
        assets=await this.directAssets.assertReady({
          principal:this.principal,
          assetIds:input.assets
        });
      }
      const request={
        schemaVersion:1,
        requestId,
        argv:input.argv,
        ...(input.cwd===undefined ? {} : {cwd:input.cwd}),
        ...(input.timeoutSeconds===undefined ? {} : {timeoutSeconds:input.timeoutSeconds}),
        ...(input.exports===undefined ? {} : {exports:input.exports}),
        ...(assets.length===0 ? {} : {
          assets:assets.map(asset=>({
            assetId:asset.assetId,
            fileName:asset.fileName,
            mimeType:asset.mimeType,
            sizeBytes:asset.sizeBytes,
            sha256:asset.sha256
          }))
        })
      };
      const submitted=await this.directExec.submit({
        principal:this.principal,
        hostId:input.host,
        request
      });
      assertBridge(
        submitted && typeof submitted.runId==='string' && typeof submitted.hostId==='string',
        'GATEWAY_TRANSPORT_INVALID',
        'Direct Exec store did not return run identity'
      );
      return {
        runId:submitted.runId,
        kind:'direct',
        transport:'direct',
        hostId:submitted.hostId,
        status:submitted.status
      };
    }

    const {repository:repo,info,policy}=await this.#trustedContext(input?.repository);
    if(input?.expectedPolicySha!==undefined)assertBridge(
      input.expectedPolicySha===info.defaultSha,'POLICY_STALE',
      'Trusted repository policy changed; refresh the tools and repository configuration before retrying');
    if(input?.trustedVerification===true) {
      assertBridge(['batch','edit'].includes(input.mode)&&Array.isArray(policy.mcp?.verification),
        'VERIFICATION_DENIED','Trusted project policy must declare mcp.verification');
      const verification=normalizeVerification(policy,policy.mcp.verification);
      input=input.mode==='edit'
        ? {...input,verification}
        : {...input,steps:verification.map((step,index)=>({id:'verify-'+index,type:'preset',...step}))};
    }
    const ref=targetRef(input?.targetRef);
    const target=await this.transport.resolveTarget(repo,{ref,sha:input?.targetSha});
    assertBridge(target && target.ref===ref && /^[0-9a-f]{40}$/.test(target.sha), 'GATEWAY_TRANSPORT_INVALID', 'transport returned invalid target identity');
    const requestId=`bridge-${randomUUID()}`;
    const task=this.#taskBinding(repo,target);

    if(input?.mode === 'capability') {
      assertBridge(typeof input.capability === 'string', 'INVALID_GATEWAY_REQUEST', 'capability is required');
      let parameters;
      if(input.capability === 'workspace-exec') {
        assertBridge(policy.workspaceExec?.enabled === true, 'UNKNOWN_CAPABILITY', 'workspace-exec is not enabled by trusted project policy');
        parameters=input.parameters ?? {};
        assertBridge(parameters && typeof parameters === 'object' && !Array.isArray(parameters), 'INVALID_GATEWAY_REQUEST', 'parameters must be an object');
      } else {
        const capability=policy.capabilities[input.capability];
        assertBridge(capability, 'UNKNOWN_CAPABILITY', `unknown trusted capability: ${input.capability}`);
        parameters=validateAndDefaultParameters(capability.parameters ?? {}, input.parameters ?? {});
      }
      const request=validateRequest({
        schemaVersion:1,
        requestId,
        repository:repo,
        target,
        policy:{ref:info.defaultRef,sha:info.defaultSha},
        capability:input.capability,
        parameters,
        ...(task === null ? {} : {task})
      });
      const submitted=await this.transport.submitCapabilityRequest(request);
      assertBridge(submitted && typeof submitted.runId === 'string', 'GATEWAY_TRANSPORT_INVALID', 'transport did not return runId');
      return {
        runId:submitted.runId,
        kind:'capability',
        repository:repo,
        target,
        policy:{ref:info.defaultRef,sha:info.defaultSha},
        capability:input.capability,
        ...(task === null ? {} : {task})
      };
    }

    if(input?.mode === 'batch') {
      assertBridge(typeof this.transport.submitBatchRequest === 'function', 'GATEWAY_CONFIG_INVALID', 'transport does not support batch requests');
      const steps=normalizeBatchSteps(policy,input.steps);
      const request=validateBatchRequest({
        schemaVersion:1,
        mode:'batch',
        requestId,
        repository:repo,
        target,
        policy:{ref:info.defaultRef,sha:info.defaultSha},
        steps,
        ...(input.commitSubject !== undefined ? {commitSubject:input.commitSubject} : {}),
        ...(task === null ? {} : {task})
      });
      const submitted=await this.transport.submitBatchRequest(request);
      assertBridge(submitted && typeof submitted.runId === 'string', 'GATEWAY_TRANSPORT_INVALID', 'transport did not return runId');
      return {
        runId:submitted.runId,
        kind:'batch',
        repository:repo,
        target,
        policy:{ref:info.defaultRef,sha:info.defaultSha},
        stepCount:steps.length,
        ...(task === null ? {} : {task})
      };
    }

    if(input?.mode === 'edit') {
      assertBridge(policy.editing?.enabled === true, 'EDIT_DENIED', 'editing is not enabled by trusted project policy');
      const verification=normalizeVerification(policy,input.verification);
      const request=validateEditRequest({
        schemaVersion:1,
        requestId,
        repository:repo,
        target,
        policy:{ref:info.defaultRef,sha:info.defaultSha},
        operations:input.operations,
        verification,
        commitSubject:input.commitSubject,
        ...(task === null ? {} : {task})
      });
      const submitted=await this.transport.submitEditRequest(request);
      assertBridge(submitted && typeof submitted.runId === 'string', 'GATEWAY_TRANSPORT_INVALID', 'transport did not return runId');
      return {
        runId:submitted.runId,
        kind:'edit',
        repository:repo,
        target,
        policy:{ref:info.defaultRef,sha:info.defaultSha},
        verification,
        ...(task === null ? {} : {task})
      };
    }

    assertBridge(false, 'INVALID_GATEWAY_REQUEST', 'mode must be host, connect, asset, direct, capability, edit or batch');
  }

  async getRun({ runId: value }) {
    const id=runId(value);
    if(id.startsWith('da1:')) {
      assertBridge(this.taskContext===null,'DIRECT_ASSET_TASK_UNSUPPORTED','Direct Assets are not part of GitHub Durable Task Runtime');
      assertBridge(this.directAssets!==null,'DIRECT_ASSET_UNAVAILABLE','Direct Assets are not configured on this Bridge deployment');
      const result=await this.directAssets.getRun({principal:this.principal,runId:id});
      assertBridge(result && result.runId===id,'RUN_NOT_FOUND',`run not found: ${id}`);
      return result;
    }
    if(id.startsWith('dx1:')) {
      assertBridge(this.taskContext===null,'DIRECT_EXEC_TASK_UNSUPPORTED','Direct Exec is not part of GitHub Durable Task Runtime');
      assertBridge(this.directExec!==null,'DIRECT_EXEC_UNAVAILABLE','Direct Exec is not configured on this Bridge deployment');
      const result=await this.directExec.getRun({principal:this.principal,runId:id});
      assertBridge(result && result.runId===id,'RUN_NOT_FOUND',`run not found: ${id}`);
      return result;
    }
    const result=await this.transport.getRun(id);
    assertBridge(result && result.runId===id, 'RUN_NOT_FOUND', `run not found: ${id}`);
    this.#assertTaskRun(result);
    await this.#renewTaskActivity();
    return result;
  }

  async getResult({ runId: value }) {
    const id=runId(value);
    if(id.startsWith('da1:')) {
      assertBridge(this.taskContext===null,'DIRECT_ASSET_TASK_UNSUPPORTED','Direct Assets are not part of GitHub Durable Task Runtime');
      assertBridge(this.directAssets!==null,'DIRECT_ASSET_UNAVAILABLE','Direct Assets are not configured on this Bridge deployment');
      const result=await this.directAssets.getResult({principal:this.principal,runId:id});
      assertBridge(result && result.runId===id,'RUN_NOT_FOUND',`result not found: ${id}`);
      return result;
    }
    if(id.startsWith('dx1:')) {
      assertBridge(this.taskContext===null,'DIRECT_EXEC_TASK_UNSUPPORTED','Direct Exec is not part of GitHub Durable Task Runtime');
      assertBridge(this.directExec!==null,'DIRECT_EXEC_UNAVAILABLE','Direct Exec is not configured on this Bridge deployment');
      const result=await this.directExec.getResult({principal:this.principal,runId:id});
      assertBridge(result && result.runId===id,'RUN_NOT_FOUND',`result not found: ${id}`);
      return result;
    }
    const result=await this.transport.getResult(id);
    assertBridge(result && result.runId===id, 'RUN_NOT_FOUND', `result not found: ${id}`);
    this.#assertTaskRun(result);
    await this.#renewTaskActivity();
    return result;
  }

  async issueAssetResource({assetId,ttlSeconds}) {
    assertBridge(this.taskContext===null,'DIRECT_ASSET_TASK_UNSUPPORTED','Direct Assets are not part of GitHub Durable Task Runtime');
    assertBridge(this.directAssets!==null,'DIRECT_ASSET_UNAVAILABLE','Direct Assets are not configured on this Bridge deployment');
    return this.directAssets.issueResource({
      principal:this.principal,
      assetId,
      ...(ttlSeconds===undefined ? {} : {ttlSeconds})
    });
  }

  async readAssetResource({token,holdBuffer,signal}) {
    assertBridge(this.taskContext===null,'DIRECT_ASSET_TASK_UNSUPPORTED','Direct Assets are not part of GitHub Durable Task Runtime');
    assertBridge(this.directAssets!==null,'DIRECT_ASSET_UNAVAILABLE','Direct Assets are not configured on this Bridge deployment');
    return this.directAssets.readResource({principal:this.principal,token,holdBuffer,signal});
  }

  async publish({ runId: value }) {
    const id=runId(value);
    assertBridge(!id.startsWith('dx1:') && !id.startsWith('da1:'),'PUBLISH_DENIED','Direct Exec and Direct Asset runs are not publishable');
    const run=await this.transport.getRun(id);
    assertBridge(run && run.runId===id, 'RUN_NOT_FOUND', `run not found: ${id}`);
    assertBridge(run.kind==='edit' || run.kind==='batch', 'PUBLISH_DENIED', 'only verified edit or edited batch runs can be published');
    const result=await this.transport.getResult(id);
    assertBridge(result && result.runId===id && result.status==='VERIFIED' && typeof result.candidateSha==='string', 'PUBLISH_DENIED', 'edit run is not verified');
    this.#assertTaskRun(run);
    this.#assertTaskRun(result);
    const published=await this.transport.publishVerified({run,result});
    assertBridge(published && published.runId===id && published.status==='PUBLISHED', 'GATEWAY_TRANSPORT_INVALID', 'transport did not return PUBLISHED result');
    return published;
  }

  async transitionTask(input) {
    assertBridge(
      this.taskLifecycle!==null,
      'TASK_SESSION_REQUIRED',
      'bridge.task_transition requires an active durable task session'
    );
    return this.taskLifecycle.transition(input);
  }
}
