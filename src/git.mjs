import { spawnSync } from 'node:child_process';
import { BridgeError } from './errors.mjs';

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

export function repositoryStatus(repoPath) {
  return git(repoPath, ['status', '--porcelain=v1', '--untracked-files=all']);
}
