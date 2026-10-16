import { isAbsolute } from 'node:path';
import { assertBridge, BridgeError } from './errors.mjs';
import { validateTaskBinding } from './task-runtime-binding.mjs';

const CAPABILITY_CLASSES = new Set(['observe', 'verify']);
const PARAM_TYPES = new Set(['string', 'integer', 'boolean']);

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function keysOnly(obj, allowed, code, label) {
  for (const key of Object.keys(obj)) assertBridge(allowed.has(key), code, `${label} contains unsupported field: ${key}`);
}

function validateResourceRequirements(resources, code, label) {
  assertBridge(Array.isArray(resources), code, label + ' resources must be array');
  const names = new Set();
  const envs = new Set();
  for (const resource of resources) {
    assertBridge(isObject(resource) && typeof resource.name === 'string' && /^[a-z][a-z0-9.-]{1,63}$/.test(resource.name), code, label + ' resource name invalid');
    assertBridge(typeof resource.env === 'string' && /^[A-Z][A-Z0-9_]*$/.test(resource.env), code, label + ' resource env invalid');
    assertBridge(!names.has(resource.name), code, label + ' resource names must be unique');
    assertBridge(!envs.has(resource.env), code, label + ' resource env names must be unique');
    names.add(resource.name);
    envs.add(resource.env);
  }
}

function validateRequestIdentity(request, code) {
  assertBridge(request.schemaVersion === 1, code, 'schemaVersion must equal 1');
  assertBridge(typeof request.requestId === 'string' && request.requestId.length >= 8 && request.requestId.length <= 128, code, 'requestId length invalid');
  assertBridge(typeof request.repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(request.repository), code, 'repository must be owner/name');
  for (const [label, value] of [['target',request.target], ['policy',request.policy]]) {
    assertBridge(isObject(value), code, `${label} must be an object`);
    keysOnly(value, new Set(['ref','sha']), code, label);
    assertBridge(typeof value.ref === 'string' && value.ref.length > 0 && value.ref.length <= 255, code, `${label}.ref invalid`);
    assertBridge(typeof value.sha === 'string' && /^[0-9a-f]{40}$/.test(value.sha), code, `${label}.sha must be lowercase 40-hex`);
  }
}

export function validateEditOperations(operations, code = 'INVALID_EDIT_REQUEST') {
  assertBridge(Array.isArray(operations) && operations.length > 0, code, 'operations must be a non-empty array');
  for (const [index, operation] of operations.entries()) {
    assertBridge(isObject(operation), code, `operation ${index} must be an object`);
    if (operation.type === 'replace-exact') {
      keysOnly(operation, new Set(['type','path','oldText','newText']), code, `operation ${index}`);
      assertBridge(isSafeRelativePath(operation.path), code, `operation ${index} path invalid`);
      assertBridge(typeof operation.oldText === 'string' && operation.oldText.length > 0, code, `operation ${index} oldText required`);
      assertBridge(typeof operation.newText === 'string', code, `operation ${index} newText must be string`);
    } else if (operation.type === 'apply-patch') {
      keysOnly(operation, new Set(['type','patch']), code, `operation ${index}`);
      assertBridge(typeof operation.patch === 'string' && operation.patch.length > 0, code, `operation ${index} patch required`);
    } else {
      throw new BridgeError(code, `unsupported edit operation at index ${index}`);
    }
  }
  return operations;
}

export function validateRequest(request) {
  assertBridge(isObject(request), 'INVALID_REQUEST', 'request must be an object');
  keysOnly(request, new Set(['schemaVersion','requestId','repository','target','policy','capability','parameters','task']), 'INVALID_REQUEST', 'request');
  validateRequestIdentity(request, 'INVALID_REQUEST');
  if (request.task !== undefined) validateTaskBinding(request.task,{repository:request.repository,target:request.target});
  assertBridge(typeof request.capability === 'string' && /^[a-z][a-z0-9.-]{1,63}$/.test(request.capability), 'INVALID_REQUEST', 'capability ID invalid');
  assertBridge(isObject(request.parameters), 'INVALID_REQUEST', 'parameters must be an object');
  return request;
}


export function validateEditRequest(request) {
  assertBridge(isObject(request), 'INVALID_EDIT_REQUEST', 'edit request must be an object');
  keysOnly(request, new Set(['schemaVersion','requestId','repository','target','policy','operations','verification','commitSubject','task']), 'INVALID_EDIT_REQUEST', 'edit request');
  validateRequestIdentity(request, 'INVALID_EDIT_REQUEST');
  if (request.task !== undefined) validateTaskBinding(request.task,{repository:request.repository,target:request.target});
  assertBridge(Array.isArray(request.operations) && request.operations.length > 0, 'INVALID_EDIT_REQUEST', 'operations must be a non-empty array');
  assertBridge(Array.isArray(request.verification) && request.verification.length >= 1 && request.verification.length <= 4, 'INVALID_EDIT_REQUEST', 'verification must contain 1-4 trusted verify capabilities');
  for (const [index, step] of request.verification.entries()) {
    assertBridge(isObject(step), 'INVALID_EDIT_REQUEST', `verification ${index} must be an object`);
    keysOnly(step, new Set(['capability','parameters']), 'INVALID_EDIT_REQUEST', `verification ${index}`);
    assertBridge(typeof step.capability === 'string' && /^[a-z][a-z0-9.-]{1,63}$/.test(step.capability), 'INVALID_EDIT_REQUEST', `verification ${index} capability invalid`);
    assertBridge(isObject(step.parameters), 'INVALID_EDIT_REQUEST', `verification ${index} parameters must be an object`);
  }
  assertBridge(typeof request.commitSubject === 'string' && request.commitSubject.length >= 3 && request.commitSubject.length <= 120 && !/[\r\n]/.test(request.commitSubject), 'INVALID_EDIT_REQUEST', 'commitSubject invalid');
  validateEditOperations(request.operations);
  return request;
}


// Hard wire-protocol ceilings. Effective project/host policy may only reduce them.
export const BATCH_LIMITS = Object.freeze({
  steps: 16,
  resources: 16,
  argv: 64,
  argumentBytes: 4096,
  argvBytes: 32768,
  requestBytes: 262144,
  operations: 64,
  seconds: 3600,
  resultBytes: 4 * 1024 * 1024
});

export function validateExecParameters(parameters, { maxArgv = BATCH_LIMITS.argv, allowResources = true, allowTimeout = true, code = 'INVALID_REQUEST' } = {}) {
  assertBridge(isObject(parameters), code, 'exec parameters must be an object');
  keysOnly(parameters, new Set(['argv', 'cwd', ...(allowResources ? ['resources'] : []), ...(allowTimeout ? ['timeoutSeconds'] : [])]), code, 'exec');
  assertBridge(Array.isArray(parameters.argv) && parameters.argv.length > 0 && parameters.argv.length <= Math.min(maxArgv, BATCH_LIMITS.argv), code, 'exec argv count is out of bounds');
  let total = 0;
  for (const arg of parameters.argv) {
    assertBridge(typeof arg === 'string' && arg.length > 0 && !arg.includes('\0'), code, 'exec argv must contain non-empty strings without NUL');
    const bytes = Buffer.byteLength(arg, 'utf8');
    assertBridge(bytes <= BATCH_LIMITS.argumentBytes, code, 'exec argument exceeds byte limit');
    total += bytes;
  }
  assertBridge(total <= BATCH_LIMITS.argvBytes, code, 'exec argv exceeds total byte limit');
  const cwd = parameters.cwd ?? '.';
  assertBridge(typeof cwd === 'string' && cwd.length <= 512 && isSafeRelativePath(cwd) && !/^[A-Za-z]:/.test(cwd) && !/[\r\n]/.test(cwd), code, 'exec cwd must be a contained repository-relative path');
  const resources = parameters.resources ?? [];
  assertBridge(Array.isArray(resources) && resources.length <= BATCH_LIMITS.resources, code, 'exec resource count is out of bounds');
  assertBridge(resources.every(name => typeof name === 'string' && /^[a-z][a-z0-9.-]{1,63}$/.test(name)) && new Set(resources).size === resources.length, code, 'exec resources must be unique logical names');
  if (parameters.timeoutSeconds !== undefined) {
    assertBridge(Number.isInteger(parameters.timeoutSeconds) && parameters.timeoutSeconds >= 1 && parameters.timeoutSeconds <= BATCH_LIMITS.seconds, code, 'exec timeoutSeconds is out of bounds');
  }
  return parameters;
}

export function validateBatchRequest(request) {
  const code = 'INVALID_REQUEST';
  assertBridge(isObject(request), code, 'batch request must be an object');
  keysOnly(request, new Set(['schemaVersion', 'mode', 'requestId', 'repository', 'target', 'policy', 'steps', 'commitSubject', 'task']), code, 'batch request');
  validateRequestIdentity(request, code);
  if (request.task !== undefined) validateTaskBinding(request.task,{repository:request.repository,target:request.target});
  assertBridge(request.mode === 'batch', code, 'batch mode must equal batch');
  assertBridge(Array.isArray(request.steps) && request.steps.length >= 1 && request.steps.length <= BATCH_LIMITS.steps, code, 'batch must contain 1-16 ordered steps');
  const ids = new Set();
  let operationCount = 0;
  for (const [index, step] of request.steps.entries()) {
    assertBridge(isObject(step), code, `step ${index} must be an object`);
    assertBridge(typeof step.id === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(step.id) && !ids.has(step.id), code, `step ${index} id must be valid and unique`);
    ids.add(step.id);
    if (step.type === 'exec') {
      keysOnly(step, new Set(['id', 'type', 'argv', 'cwd', 'resources', 'timeoutSeconds']), code, `step ${index}`);
      const { id, type, ...parameters } = step;
      validateExecParameters(parameters);
    } else if (step.type === 'preset') {
      keysOnly(step, new Set(['id', 'type', 'capability', 'parameters']), code, `step ${index}`);
      assertBridge(typeof step.capability === 'string' && /^[a-z][a-z0-9.-]{1,63}$/.test(step.capability), code, `step ${index} capability invalid`);
      assertBridge(step.parameters === undefined || isObject(step.parameters), code, `step ${index} parameters must be an object`);
    } else if (step.type === 'edit') {
      keysOnly(step, new Set(['id', 'type', 'operations']), code, `step ${index}`);
      validateEditOperations(step.operations, code);
      operationCount += step.operations.length;
    } else {
      throw new BridgeError(code, `unsupported batch step type at index ${index}`);
    }
  }
  assertBridge(operationCount <= BATCH_LIMITS.operations, code, 'batch exceeds total edit-operation limit');
  if (operationCount > 0) {
    assertBridge(typeof request.commitSubject === 'string' && request.commitSubject.length >= 3 && request.commitSubject.length <= 120 && !/[\r\n\0]/.test(request.commitSubject), code, 'edited batch requires a single-line commitSubject');
  } else {
    assertBridge(request.commitSubject === undefined, code, 'commitSubject is only valid for an edited batch');
  }
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(request), 'utf8'); }
  catch { throw new BridgeError(code, 'batch request must be JSON serializable'); }
  assertBridge(bytes <= BATCH_LIMITS.requestBytes, code, 'batch request exceeds total byte limit');
  return request;
}

export function validateProjectPolicy(policy, repository) {
  assertBridge(isObject(policy), 'PROJECT_POLICY_INVALID', 'project policy must be an object');
  assertBridge(policy.version === 1, 'PROJECT_POLICY_INVALID', 'project policy version must equal 1');
  assertBridge(isObject(policy.project) && policy.project.repository === repository, 'PROJECT_POLICY_INVALID', 'project.repository mismatch');
  assertBridge(isObject(policy.runners) && Object.keys(policy.runners).length > 0, 'PROJECT_POLICY_INVALID', 'at least one runner is required');
  for (const [id, runner] of Object.entries(policy.runners)) {
    assertBridge(/^[a-z][a-z0-9.-]{0,63}$/.test(id), 'PROJECT_POLICY_INVALID', `runner id invalid: ${id}`);
    assertBridge(isObject(runner) && typeof runner.class === 'string' && /^[A-Za-z0-9_.-]+$/.test(runner.class), 'PROJECT_POLICY_INVALID', `runner class invalid: ${id}`);
  }
  assertBridge(isObject(policy.capabilities), 'PROJECT_POLICY_INVALID', 'capabilities must be an object');
  for (const [id, capability] of Object.entries(policy.capabilities)) {
    assertBridge(/^[a-z][a-z0-9.-]{1,63}$/.test(id), 'PROJECT_POLICY_INVALID', `capability id invalid: ${id}`);
    validateCapability(capability, policy.runners, id);
  }
  if (policy.workspaceExec !== undefined) {
    assertBridge(isObject(policy.workspaceExec), 'PROJECT_POLICY_INVALID', 'workspaceExec must be object');
    const w = policy.workspaceExec;
    assertBridge(typeof w.enabled === 'boolean', 'PROJECT_POLICY_INVALID', 'workspaceExec.enabled must be boolean');
    if (w.enabled) {
      assertBridge(typeof w.runner === 'string' && policy.runners[w.runner], 'PROJECT_POLICY_INVALID', 'workspaceExec.runner must reference a project runner');
      for (const [key, fallback, max] of [
        ['maxArgv', 32, 64],
        ['maxSeconds', 900, 3600],
        ['stdoutBytes', 524288, 4*1024*1024],
        ['stderrBytes', 262144, 4*1024*1024]
      ]) {
        const value = w[key] ?? fallback;
        assertBridge(Number.isInteger(value) && value > 0 && value <= max, 'PROJECT_POLICY_INVALID', `workspaceExec.${key} invalid`);
      }
      if (w.resources !== undefined) validateResourceRequirements(w.resources, 'PROJECT_POLICY_INVALID', 'workspaceExec');
    }
  }

  if (policy.editing !== undefined) {
    assertBridge(isObject(policy.editing), 'PROJECT_POLICY_INVALID', 'editing must be object');
    const e = policy.editing;
    assertBridge(typeof e.enabled === 'boolean', 'PROJECT_POLICY_INVALID', 'editing.enabled must be boolean');
    if (e.enabled) {
      assertBridge(typeof e.runner === 'string' && policy.runners[e.runner], 'PROJECT_POLICY_INVALID', 'editing.runner must reference a project runner');
      assertBridge(Array.isArray(e.allowedBranches) && e.allowedBranches.length > 0 && e.allowedBranches.every(isSafeBranchPattern), 'PROJECT_POLICY_INVALID', 'editing.allowedBranches invalid');
      assertBridge(Array.isArray(e.allowedPaths) && e.allowedPaths.length > 0 && e.allowedPaths.every(isSafeEditPattern), 'PROJECT_POLICY_INVALID', 'editing.allowedPaths invalid');
      if (e.publish !== undefined) assertBridge(typeof e.publish === 'boolean', 'PROJECT_POLICY_INVALID', 'editing.publish must be boolean');
      const maxOperations = e.maxOperations ?? 16;
      const maxPatchBytes = e.maxPatchBytes ?? 262144;
      assertBridge(Number.isInteger(maxOperations) && maxOperations > 0 && maxOperations <= 64, 'PROJECT_POLICY_INVALID', 'editing.maxOperations invalid');
      assertBridge(Number.isInteger(maxPatchBytes) && maxPatchBytes > 0 && maxPatchBytes <= 4*1024*1024, 'PROJECT_POLICY_INVALID', 'editing.maxPatchBytes invalid');
      if (e.commitSubjectPattern !== undefined) {
        assertBridge(typeof e.commitSubjectPattern === 'string' && e.commitSubjectPattern.length <= 512, 'PROJECT_POLICY_INVALID', 'editing.commitSubjectPattern invalid');
        try { new RegExp(e.commitSubjectPattern); } catch { throw new BridgeError('PROJECT_POLICY_INVALID', 'editing.commitSubjectPattern is invalid regexp'); }
      }
    }
  }
  return policy;
}

function validateCapability(capability, runners, id) {
  assertBridge(isObject(capability), 'PROJECT_POLICY_INVALID', `capability ${id} must be object`);
  assertBridge(CAPABILITY_CLASSES.has(capability.class), 'PROJECT_POLICY_INVALID', `capability ${id} class must be observe|verify`);
  assertBridge(typeof capability.runner === 'string' && runners[capability.runner], 'PROJECT_POLICY_INVALID', `capability ${id} references unknown runner`);
  assertBridge(isObject(capability.command) && Array.isArray(capability.command.argv) && capability.command.argv.length > 0, 'PROJECT_POLICY_INVALID', `capability ${id} command.argv required`);
  for (const arg of capability.command.argv) assertBridge(typeof arg === 'string' && arg.length > 0, 'PROJECT_POLICY_INVALID', `capability ${id} argv must contain strings`);
  if (capability.parameters !== undefined) {
    assertBridge(isObject(capability.parameters), 'PROJECT_POLICY_INVALID', `capability ${id} parameters must be object`);
    for (const [name, spec] of Object.entries(capability.parameters)) validateParameterSpec(name, spec, id);
  }
  if (capability.resources !== undefined) validateResourceRequirements(capability.resources, 'PROJECT_POLICY_INVALID', `capability ${id}`);
  const limits = capability.limits ?? {};
  assertBridge(isObject(limits), 'PROJECT_POLICY_INVALID', `capability ${id} limits must be object`);
  for (const [k, fallback, max] of [['timeoutSeconds',900,21600],['stdoutBytes',524288,16*1024*1024],['stderrBytes',262144,16*1024*1024],['reportBytes',524288,4*1024*1024],['artifactBytes',10*1024*1024,100*1024*1024]]) {
    const value = limits[k] ?? fallback;
    assertBridge(Number.isInteger(value) && value > 0 && value <= max, 'PROJECT_POLICY_INVALID', `capability ${id} ${k} invalid`);
  }
  if (capability.outputs !== undefined) {
    assertBridge(isObject(capability.outputs), 'PROJECT_POLICY_INVALID', `capability ${id} outputs must be object`);
    if (capability.outputs.report !== undefined) assertBridge(isSafeRelativePath(capability.outputs.report), 'PROJECT_POLICY_INVALID', `capability ${id} report path invalid`);
    if (capability.outputs.artifacts !== undefined) {
      assertBridge(Array.isArray(capability.outputs.artifacts), 'PROJECT_POLICY_INVALID', `capability ${id} artifacts must be array`);
      for (const pattern of capability.outputs.artifacts) {
        assertBridge(typeof pattern === 'string' && isSafeArtifactPattern(pattern), 'PROJECT_POLICY_INVALID', `capability ${id} artifact pattern invalid`);
      }
    }
  }
}

function validateParameterSpec(name, spec, capabilityId) {
  assertBridge(/^[A-Za-z_][A-Za-z0-9_]*$/.test(name), 'PROJECT_POLICY_INVALID', `parameter name invalid in ${capabilityId}: ${name}`);
  assertBridge(isObject(spec) && PARAM_TYPES.has(spec.type), 'PROJECT_POLICY_INVALID', `parameter ${name} type invalid`);
  if (spec.pattern !== undefined) {
    assertBridge(spec.type === 'string' && typeof spec.pattern === 'string' && spec.pattern.length <= 512, 'PROJECT_POLICY_INVALID', `parameter ${name} pattern invalid`);
    try { new RegExp(spec.pattern); } catch { throw new BridgeError('PROJECT_POLICY_INVALID', `parameter ${name} pattern is invalid regexp`); }
  }
}

export function validateHostPolicy(policy) {
  assertBridge(isObject(policy), 'HOST_POLICY_INVALID', 'host policy must be object');
  assertBridge(policy.version === 1, 'HOST_POLICY_INVALID', 'host policy version must equal 1');
  assertBridge(isObject(policy.host) && typeof policy.host.id === 'string' && policy.host.id.length > 0, 'HOST_POLICY_INVALID', 'host.id required');
  if (policy.directExec !== undefined) {
    assertBridge(
      isObject(policy.directExec) && typeof policy.directExec.enabled === 'boolean',
      'HOST_POLICY_INVALID',
      'directExec must be an object with enabled boolean'
    );
    const direct = policy.directExec;
    if (direct.enabled) {
      assertBridge(
        typeof direct.serviceUser === 'string' &&
          direct.serviceUser !== 'root' &&
          /^[^\p{C}]{1,256}$/u.test(direct.serviceUser),
        'HOST_POLICY_INVALID',
        'directExec.serviceUser invalid'
      );
      if (direct.root !== undefined) {
        assertBridge(
          typeof direct.root === 'string' && isAbsolute(direct.root),
          'HOST_POLICY_INVALID',
          'directExec.root must be absolute'
        );
      }
      if (direct.stateDir !== undefined) {
        assertBridge(
          typeof direct.stateDir === 'string' && isAbsolute(direct.stateDir),
          'HOST_POLICY_INVALID',
          'directExec.stateDir must be absolute'
        );
      }
      if (direct.assetDir !== undefined) {
        assertBridge(
          typeof direct.assetDir === 'string' && isAbsolute(direct.assetDir),
          'HOST_POLICY_INVALID',
          'directExec.assetDir must be absolute'
        );
      }
      for (const [key, fallback, max] of [
        ['maxArgv', 64, 64],
        ['maxSeconds', 900, 3600],
        ['stdoutBytes', 524288, 4*1024*1024],
        ['stderrBytes', 262144, 4*1024*1024],
        ['resultBytes', 1048576, 1250000]
      ]) {
        const value = direct[key] ?? fallback;
        assertBridge(
          Number.isInteger(value) && value > 0 && value <= max,
          'HOST_POLICY_INVALID',
          `directExec.${key} invalid`
        );
      }
    }
  }
  assertBridge(isObject(policy.repositories), 'HOST_POLICY_INVALID', 'repositories must be object');
  for (const [repo, entry] of Object.entries(policy.repositories)) {
    assertBridge(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo), 'HOST_POLICY_INVALID', `repository key invalid: ${repo}`);
    assertBridge(isObject(entry), 'HOST_POLICY_INVALID', `repository ${repo} policy must be object`);
    assertBridge(Array.isArray(entry.runnerClasses) && entry.runnerClasses.every(x => typeof x === 'string' && x.length > 0), 'HOST_POLICY_INVALID', `repository ${repo} runnerClasses invalid`);
    if (entry.resources !== undefined) {
      assertBridge(isObject(entry.resources), 'HOST_POLICY_INVALID', `repository ${repo} resources must be object`);
      for (const [name, resource] of Object.entries(entry.resources)) {
        assertBridge(/^[a-z][a-z0-9.-]{1,63}$/.test(name), 'HOST_POLICY_INVALID', `resource name invalid: ${name}`);
        assertBridge(isObject(resource) && typeof resource.root === 'string' && isAbsolute(resource.root), 'HOST_POLICY_INVALID', `resource ${name} root must be absolute`);
        for (const access of ['read','write']) if (resource[access] !== undefined) {
          assertBridge(Array.isArray(resource[access]) && resource[access].every(isSafeResourcePattern), 'HOST_POLICY_INVALID', `resource ${name} ${access} patterns invalid`);
        }
      }
    }
    if (entry.workspaceExec !== undefined) {
      assertBridge(isObject(entry.workspaceExec) && typeof entry.workspaceExec.enabled === 'boolean', 'HOST_POLICY_INVALID', `repository ${repo} workspaceExec invalid`);
      const w = entry.workspaceExec;
      if (w.enabled) {
        assertBridge(typeof w.runnerClass === 'string' && entry.runnerClasses.includes(w.runnerClass), 'HOST_POLICY_INVALID', `repository ${repo} workspaceExec.runnerClass must be granted by runnerClasses`);
        assertBridge(
          typeof w.serviceUser === 'string' &&
            w.serviceUser !== 'root' &&
            /^[A-Za-z_][A-Za-z0-9._-]{0,63}\$?$/.test(w.serviceUser),
          'HOST_POLICY_INVALID',
          `repository ${repo} workspaceExec.serviceUser invalid`
        );
        for (const [key, fallback, max] of [
          ['maxArgv', 32, 64],
          ['maxSeconds', 900, 3600],
          ['stdoutBytes', 524288, 4*1024*1024],
          ['stderrBytes', 262144, 4*1024*1024]
        ]) {
          const value = w[key] ?? fallback;
          assertBridge(Number.isInteger(value) && value > 0 && value <= max, 'HOST_POLICY_INVALID', `repository ${repo} workspaceExec.${key} invalid`);
        }
        if (w.deniedRoots !== undefined) {
          assertBridge(Array.isArray(w.deniedRoots) && w.deniedRoots.every(x => typeof x === 'string' && isAbsolute(x)), 'HOST_POLICY_INVALID', `repository ${repo} workspaceExec.deniedRoots must contain absolute paths`);
        }
      }
    }

    if (entry.editing !== undefined) {
      assertBridge(isObject(entry.editing) && typeof entry.editing.enabled === 'boolean', 'HOST_POLICY_INVALID', `repository ${repo} editing invalid`);
      const e = entry.editing;
      if (e.enabled) {
        assertBridge(typeof e.runnerClass === 'string' && entry.runnerClasses.includes(e.runnerClass), 'HOST_POLICY_INVALID', `repository ${repo} editing.runnerClass must be granted by runnerClasses`);
        assertBridge(
          typeof e.serviceUser === 'string' &&
            e.serviceUser !== 'root' &&
            /^[A-Za-z_][A-Za-z0-9._-]{0,63}\$?$/.test(e.serviceUser),
          'HOST_POLICY_INVALID',
          `repository ${repo} editing.serviceUser invalid`
        );
        const maxOperations = e.maxOperations ?? 16;
        const maxPatchBytes = e.maxPatchBytes ?? 262144;
        assertBridge(Number.isInteger(maxOperations) && maxOperations > 0 && maxOperations <= 64, 'HOST_POLICY_INVALID', `repository ${repo} editing.maxOperations invalid`);
        assertBridge(Number.isInteger(maxPatchBytes) && maxPatchBytes > 0 && maxPatchBytes <= 4*1024*1024, 'HOST_POLICY_INVALID', `repository ${repo} editing.maxPatchBytes invalid`);
      }
    }
  }
  return policy;
}

function isSafeRelativePath(path) {
  return typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !path.includes('\\') && !path.split('/').includes('..') && !path.startsWith('./') && !path.includes('\0');
}
function isSafeArtifactPattern(pattern) {
  if (!isSafeRelativePath(pattern.replace(/\/\*\*$/, ''))) return false;
  return !pattern.includes('*') || pattern.endsWith('/**') && !pattern.slice(0,-3).includes('*');
}
function isSafeResourcePattern(pattern) {
  return typeof pattern === 'string' && pattern.length > 0 && !isAbsolute(pattern) && !pattern.includes('\\') && !pattern.split('/').includes('..') && !pattern.includes('\0') && (!pattern.includes('*') || pattern.endsWith('/**'));
}

function isSafeBranchPattern(pattern) {
  return typeof pattern === 'string'
    && pattern.length > 0
    && pattern.length <= 255
    && !pattern.includes('\\')
    && !pattern.includes('\0')
    && !pattern.split('/').includes('..')
    && (!pattern.includes('*') || (pattern.endsWith('/**') && !pattern.slice(0,-3).includes('*')));
}
function isSafeEditPattern(pattern) {
  if (pattern === '**') return true;
  return typeof pattern === 'string' && (isSafeRelativePath(pattern) || pattern.endsWith('/**') && isSafeRelativePath(pattern.slice(0,-3)));
}
