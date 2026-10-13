import { assertBridge } from './errors.mjs';

const TASK_KEY_PATTERN=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/;
const SHA_PATTERN=/^[0-9a-f]{40}$/;

function exactKeys(value,allowed,label) {
  assertBridge(
    value && typeof value==='object' && !Array.isArray(value),
    'TASK_BINDING_INVALID',
    `${label} must be an object`
  );
  for(const key of Object.keys(value)) {
    assertBridge(
      allowed.has(key),
      'TASK_BINDING_INVALID',
      `${label} contains unsupported field: ${key}`
    );
  }
}

function key(value) {
  assertBridge(
    typeof value==='string' && value.length<=512 && TASK_KEY_PATTERN.test(value),
    'TASK_BINDING_INVALID',
    'taskKey must be owner/repository#issue-number'
  );
  return value;
}

function epoch(value) {
  assertBridge(
    Number.isSafeInteger(value) && value>0,
    'TASK_BINDING_INVALID',
    'leaseEpoch must be a positive integer'
  );
  return value;
}

function branch(value) {
  assertBridge(
    typeof value==='string' && value.length>=1 && value.length<=255,
    'TASK_BINDING_INVALID',
    'canonicalBranch is invalid'
  );
  return value;
}

function sha(value) {
  assertBridge(
    typeof value==='string' && SHA_PATTERN.test(value),
    'TASK_BINDING_INVALID',
    'baseSha must be an exact SHA'
  );
  return value;
}

export function validateTaskContext(value) {
  exactKeys(value,new Set(['taskKey','leaseEpoch']),'task context');
  return {
    taskKey:key(value.taskKey),
    leaseEpoch:epoch(value.leaseEpoch)
  };
}

export function createTaskBinding(context,{repository,target}={}) {
  const normalized=validateTaskContext(context);
  assertBridge(
    typeof repository==='string' && repository.length>0 &&
      target && typeof target.ref==='string' && SHA_PATTERN.test(target.sha ?? ''),
    'TASK_BINDING_INVALID',
    'resolved repository target is required for task binding'
  );
  const taskRepository=normalized.taskKey.slice(0,normalized.taskKey.lastIndexOf('#'));
  assertBridge(
    taskRepository===repository,
    'TASK_BINDING_INVALID',
    'task repository does not match the Bridge Run repository'
  );
  return Object.freeze({
    taskKey:normalized.taskKey,
    leaseEpoch:normalized.leaseEpoch,
    canonicalBranch:branch(target.ref),
    baseSha:sha(target.sha)
  });
}

export function validateTaskBinding(value,{repository,target}={}) {
  exactKeys(
    value,
    new Set(['taskKey','leaseEpoch','canonicalBranch','baseSha']),
    'task binding'
  );
  const normalized={
    taskKey:key(value.taskKey),
    leaseEpoch:epoch(value.leaseEpoch),
    canonicalBranch:branch(value.canonicalBranch),
    baseSha:sha(value.baseSha)
  };
  if(repository!==undefined) {
    const taskRepository=normalized.taskKey.slice(0,normalized.taskKey.lastIndexOf('#'));
    assertBridge(
      taskRepository===repository,
      'TASK_BINDING_INVALID',
      'task repository binding mismatch'
    );
  }
  if(target!==undefined) {
    assertBridge(
      normalized.canonicalBranch===target.ref,
      'TASK_BINDING_INVALID',
      'task canonical branch must match target ref'
    );
    assertBridge(
      normalized.baseSha===target.sha,
      'TASK_BINDING_INVALID',
      'task base SHA must match target SHA'
    );
  }
  return normalized;
}
