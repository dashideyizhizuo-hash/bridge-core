import { spawnSync } from 'node:child_process';
import { BridgeError,assertBridge } from './errors.mjs';
import {defaultProjectPolicyBytes} from './default-project-policy.mjs';

export function git(repoPath, args, { maxBuffer = 8 * 1024 * 1024 } = {}) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repoPath, ...args], {
    encoding: 'utf8',
    maxBuffer,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  });
  if (result.error || result.status !== 0) {
    throw new BridgeError('GIT_FAILED', `git ${args[0] ?? ''} failed`, {
      status: result.status,
      stderr: String(result.stderr ?? '').slice(-4000)
    });
  }
  return String(result.stdout ?? '');
}

export function resolveHead(repoPath) {
  return git(repoPath, ['rev-parse', 'HEAD^{commit}']).trim();
}

export function ensureCommit(repoPath, sha, code = 'POLICY_STALE') {
  try { return git(repoPath, ['rev-parse', `${sha}^{commit}`]).trim(); }
  catch (error) { throw new BridgeError(code, `required commit is not available in checkout: ${sha}`, { cause: error.message }); }
}

export function showFile(repoPath, sha, path) {
  try { return git(repoPath, ['show', `${sha}:${path}`], { maxBuffer: 2 * 1024 * 1024 }); }
  catch (error) { throw new BridgeError('PROJECT_POLICY_MISSING', `trusted project policy is missing at ${sha}:${path}`, { cause: error.message }); }
}

export function readTrustedProjectPolicyBytes(repoPath,sha,repository){
  assertBridge(typeof sha==='string'&&/^[0-9a-f]{40}$/.test(sha),'POLICY_STALE','Exact policy commit required');
  assertBridge(ensureCommit(repoPath,sha)===sha,'POLICY_STALE','Policy commit mismatch');
  const entry=git(repoPath,['ls-tree','-z',sha,'--','.bridge/project.json']);
  if(entry===''){
    const parent=git(repoPath,['ls-tree','-z',sha,'--','.bridge']);
    assertBridge(parent===''||/^040000 tree [0-9a-f]{40}\t\.bridge\0$/.test(parent),'PROJECT_POLICY_INVALID','Policy directory must be a tree');
    return defaultProjectPolicyBytes(repository,sha);
  }
  assertBridge(/^100(?:644|755) blob [0-9a-f]{40}\t\.bridge\/project\.json\0$/.test(entry),'PROJECT_POLICY_INVALID','Policy must be a regular file');
  return git(repoPath,['show',`${sha}:.bridge/project.json`],{maxBuffer:2*1024*1024});
}

export function repositoryStatus(repoPath) {
  return git(repoPath, ['status', '--porcelain=v1', '--untracked-files=all']);
}
