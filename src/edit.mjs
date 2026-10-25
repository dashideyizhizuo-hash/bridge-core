import {policyProfile} from './default-project-policy.mjs';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';
import { assertBridge, BridgeError } from './errors.mjs';
import { ensureCommit, git, resolveHead, readTrustedProjectPolicyBytes } from './git.mjs';
import { parseJsonBytes, readJsonFile } from './json.mjs';
import { validateEditRequest, validateHostPolicy, validateProjectPolicy } from './validate.mjs';

const PROTECTED_PREFIXES = ['.git/', '.github/', '.bridge/'];
const MAX_EDITABLE_FILE_BYTES = 8 * 1024 * 1024;
const sha256 = value => createHash('sha256').update(value).digest('hex');

function contained(root, candidate) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

function patternMatches(value, pattern) {
  if (pattern === '**') return true;
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return value === prefix || value.startsWith(prefix + '/');
  }
  return value === pattern;
}

function isProtectedPath(path) {
  return path === '.git'
    || path === '.gitmodules'
    || path === '.github'
    || path === '.bridge'
    || PROTECTED_PREFIXES.some(prefix => path.startsWith(prefix));
}

function assertEditablePath(path, allowedPaths) {
  assertBridge(typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !path.includes('\\') && !path.includes('\0') && !path.split('/').includes('..'), 'EDIT_PATH_DENIED', `invalid edit path: ${path}`);
  assertBridge(!isProtectedPath(path), 'EDIT_PATH_DENIED', `protected path cannot be edited: ${path}`);
  assertBridge(allowedPaths.some(pattern => patternMatches(path, pattern)), 'EDIT_PATH_DENIED', `path is outside trusted editing policy: ${path}`);
}

export function resolveEditPlan({ request, projectPolicy, hostPolicy }) {
  const project = projectPolicy.editing;
  assertBridge(project?.enabled === true, 'EDIT_DENIED', 'editing is not enabled by trusted project policy');
  const repoHost = hostPolicy.repositories[request.repository];
  assertBridge(repoHost, 'EDIT_DENIED', `host policy does not authorize repository: ${request.repository}`);
  const host = repoHost.editing;
  assertBridge(host?.enabled === true, 'EDIT_DENIED', 'editing is not enabled by host policy');

  const runner = projectPolicy.runners[project.runner];
  assertBridge(runner, 'PROJECT_POLICY_INVALID', 'editing references unknown project runner');
  assertBridge(repoHost.runnerClasses.includes(runner.class), 'EDIT_DENIED', `editing runner class is not granted by host policy: ${runner.class}`);
  assertBridge(host.runnerClass === runner.class, 'EDIT_DENIED', `editing host runner class mismatch: expected ${runner.class}`);
  const actualUser = userInfo().username;
  assertBridge(host.serviceUser === actualUser, 'EDIT_DENIED', `editing requires service user ${host.serviceUser}, actual user is ${actualUser}`);
  assertBridge(project.allowedBranches.some(pattern => patternMatches(request.target.ref, pattern)), 'EDIT_BRANCH_DENIED', `target branch is not allowed by trusted policy: ${request.target.ref}`);
  if (project.commitSubjectPattern !== undefined) {
    assertBridge(new RegExp(project.commitSubjectPattern).test(request.commitSubject), 'EDIT_DENIED', 'commit subject does not match trusted policy');
  }

  const maxOperations = Math.min(project.maxOperations ?? 16, host.maxOperations ?? 16);
  const maxPatchBytes = Math.min(project.maxPatchBytes ?? 262144, host.maxPatchBytes ?? 262144);
  assertBridge(request.operations.length <= maxOperations, 'EDIT_DENIED', `edit request exceeds maxOperations=${maxOperations}`);
  let payloadBytes = 0;
  for (const operation of request.operations) {
    if (operation.type === 'apply-patch') payloadBytes += Buffer.byteLength(operation.patch, 'utf8');
    else payloadBytes += Buffer.byteLength(operation.oldText, 'utf8') + Buffer.byteLength(operation.newText, 'utf8');
  }
  assertBridge(payloadBytes <= maxPatchBytes, 'EDIT_DENIED', `edit payload exceeds maxPatchBytes=${maxPatchBytes}`);

  return {
    runner: { id: project.runner, class: runner.class },
    serviceUser: actualUser,
    hostId: hostPolicy.host.id,
    allowedPaths: [...project.allowedPaths],
    limits: { maxOperations, maxPatchBytes }
  };
}

function replaceExact(worktree, operation, allowedPaths) {
  assertEditablePath(operation.path, allowedPaths);
  const rawPath = resolve(worktree, operation.path);
  assertBridge(contained(worktree, rawPath), 'EDIT_PATH_DENIED', `path escapes worktree: ${operation.path}`);
  let realPath;
  try { realPath = realpathSync(rawPath); }
  catch (error) { throw new BridgeError('EDIT_PATH_DENIED', `edit target does not exist: ${operation.path}`, { cause: error.message }); }
  assertBridge(contained(worktree, realPath), 'EDIT_PATH_DENIED', `edit target resolves outside worktree: ${operation.path}`);
  assertBridge(!lstatSync(rawPath).isSymbolicLink() && statSync(realPath).isFile(), 'EDIT_PATH_DENIED', `edit target must be a regular non-symlink file: ${operation.path}`);
  const bytes = readFileSync(realPath);
  assertBridge(bytes.length <= MAX_EDITABLE_FILE_BYTES && !bytes.includes(0), 'EDIT_PATH_DENIED', `edit target is binary or too large: ${operation.path}`);
  const current = bytes.toString('utf8');
  const first = current.indexOf(operation.oldText);
  assertBridge(first >= 0, 'EDIT_STALE', `replace-exact oldText not found: ${operation.path}`);
  assertBridge(current.indexOf(operation.oldText, first + operation.oldText.length) < 0, 'EDIT_AMBIGUOUS', `replace-exact oldText is not unique: ${operation.path}`);
  writeFileSync(realPath, current.slice(0, first) + operation.newText + current.slice(first + operation.oldText.length));
}

function applyPatch(worktree, operation, patchPath) {
  writeFileSync(patchPath, operation.patch, { mode: 0o600 });
  git(worktree, ['apply', '--check', '--whitespace=nowarn', patchPath], { maxBuffer: 16 * 1024 * 1024 });
  git(worktree, ['apply', '--whitespace=nowarn', patchPath], { maxBuffer: 16 * 1024 * 1024 });
}

function inspectChanges(worktree, baseSha, allowedPaths, { ignoreUntracked = false, allowEmpty = false } = {}) {
  const porcelain = git(worktree, ['status', '--porcelain=v1', '-z', ignoreUntracked ? '--untracked-files=no' : '--untracked-files=all']);
  const records = porcelain.split('\0').filter(Boolean);
  if (records.length === 0 && allowEmpty) return [];
  assertBridge(records.length > 0, 'EDIT_EMPTY', 'edit request produced no repository changes');

  const changedFiles = [];
  for (const record of records) {
    const status = record.slice(0, 2);
    const path = record.slice(3);
    assertBridge(status === ' M', 'EDIT_CHANGE_TYPE_DENIED', `only modifications to existing tracked files are allowed in M4 v1: ${status} ${path}`);
    assertEditablePath(path, allowedPaths);
    const raw = resolve(worktree, path);
    assertBridge(contained(worktree, raw) && !lstatSync(raw).isSymbolicLink() && statSync(raw).isFile(), 'EDIT_PATH_DENIED', `changed path must remain a regular file: ${path}`);
    changedFiles.push(path);
  }

  const summary = git(worktree, ['diff', '--summary', baseSha, '--']);
  assertBridge(summary.trim() === '', 'EDIT_CHANGE_TYPE_DENIED', 'mode/rename/copy changes are not allowed');

  const numstat = git(worktree, ['diff', '--numstat', '-z', baseSha, '--']);
  for (const entry of numstat.split('\0').filter(Boolean)) {
    const [added, deleted] = entry.split('\t');
    assertBridge(added !== '-' && deleted !== '-', 'EDIT_BINARY_DENIED', 'binary edits are not allowed');
  }
  return changedFiles.sort();
}

export function trackedDiffState(workspace, baseSha) {
  const diff = git(workspace, ['diff', '--no-color', '--binary', baseSha, '--'], { maxBuffer: 32 * 1024 * 1024 });
  const changedFiles = git(workspace, ['diff', '--name-only', '-z', baseSha, '--'])
    .split('\0').filter(Boolean).sort();
  return { diff, diffSha256: sha256(diff), changedFiles };
}

export function applyEditOperationsInWorkspace({ workspace, baseSha, operations, plan, scratchDir }) {
  mkdirSync(scratchDir, { recursive: true });
  for (const [index, operation] of operations.entries()) {
    if (operation.type === 'replace-exact') replaceExact(workspace, operation, plan.allowedPaths);
    else applyPatch(workspace, operation, resolve(scratchDir, `operation-${index}.patch`));
  }
  const changedFiles = inspectChanges(workspace, baseSha, plan.allowedPaths, { ignoreUntracked: true });
  const state = trackedDiffState(workspace, baseSha);
  assertBridge(
    JSON.stringify(changedFiles) === JSON.stringify(state.changedFiles),
    'CANDIDATE_BINDING_MISMATCH',
    'tracked edit paths do not match publishable diff'
  );
  return state;
}

export function createSharedWorkspaceCandidate({
  requestBytes,
  request,
  repoPath,
  projectPolicyBytes,
  hostPolicyBytes,
  plan,
  verification,
  operationCount,
  outputDir
}) {
  const repo = realpathSync(resolve(repoPath));
  assertBridge(resolveHead(repo) === request.target.sha, 'TARGET_STALE', 'Run workspace HEAD changed before candidate creation');
  const changedFiles = inspectChanges(repo, request.target.sha, plan.allowedPaths, { ignoreUntracked: true });
  const beforeStage = trackedDiffState(repo, request.target.sha);
  assertBridge(
    JSON.stringify(changedFiles) === JSON.stringify(beforeStage.changedFiles),
    'CANDIDATE_BINDING_MISMATCH',
    'candidate changed paths do not match verified workspace'
  );

  git(repo, ['add', '--', ...changedFiles]);
  const stagedDiff = git(repo, ['diff', '--cached', '--no-color', '--binary', request.target.sha, '--'], { maxBuffer: 32 * 1024 * 1024 });
  assertBridge(
    sha256(stagedDiff) === beforeStage.diffSha256,
    'CANDIDATE_BINDING_MISMATCH',
    'staged candidate differs from verified workspace'
  );
  const treeSha = git(repo, ['write-tree']).trim();
  const requestSha256 = sha256(requestBytes);
  const candidateSha = git(repo, [
    '-c', 'user.name=Bridge',
    '-c', 'user.email=bridge@localhost',
    'commit-tree', treeSha,
    '-p', request.target.sha,
    '-m', request.commitSubject,
    '-m', `Bridge-Request-Id: ${request.requestId}`,
    '-m', `Bridge-Request-Base: ${request.target.sha}`,
    '-m', `Bridge-Policy-SHA: ${request.policy.sha}`,
    '-m', `Bridge-Request-SHA256: ${requestSha256}`
  ]).trim();
  const parentSha = git(repo, ['rev-parse', `${candidateSha}^`]).trim();
  assertBridge(parentSha === request.target.sha, 'CANDIDATE_BINDING_MISMATCH', 'candidate parent does not equal requested base');
  const diff = git(repo, ['diff', '--no-color', '--binary', `${request.target.sha}..${candidateSha}`, '--'], { maxBuffer: 32 * 1024 * 1024 });
  assertBridge(sha256(diff) === beforeStage.diffSha256, 'CANDIDATE_BINDING_MISMATCH', 'candidate diff differs from verified workspace');

  mkdirSync(outputDir, { recursive: true });
  const candidateRef = `refs/bridge-batch-candidate/${request.requestId}`;
  try {
    git(repo, ['update-ref', candidateRef, candidateSha]);
    git(repo, ['bundle', 'create', resolve(outputDir, 'candidate.bundle'), candidateRef, `^${request.target.sha}`], { maxBuffer: 32 * 1024 * 1024 });
  } finally {
    try { git(repo, ['update-ref', '-d', candidateRef]); } catch {}
  }

  const result = {
    schemaVersion: 1,
    status: 'PREPARED',
    executionMode: 'SHARED_WORKSPACE',
    requestMode: 'batch',
    requestId: request.requestId,
    repository: request.repository,
    targetRef: request.target.ref,
    baseSha: request.target.sha,
    policySha: request.policy.sha,
    requestSha256,
    projectPolicySha256: sha256(projectPolicyBytes),
    policyProfile:policyProfile(JSON.parse(projectPolicyBytes)),
    hostPolicySha256: sha256(hostPolicyBytes),
    candidateSha,
    parentSha,
    treeSha,
    diffSha256: sha256(diff),
    changedFiles,
    operationCount,
    verification,
    runner: { class: plan.runner.class, hostId: plan.hostId, serviceUser: plan.serviceUser },
    completedAt: new Date().toISOString()
  };
  writeFileSync(resolve(outputDir, 'request.json'), requestBytes);
  writeFileSync(resolve(outputDir, 'prepare-result.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

export function prepareEditCandidate({ requestPath, repoPath, hostPolicyPath, outputDir }) {
  const requestBytes = readFileSync(requestPath);
  const request = validateEditRequest(parseJsonBytes(requestBytes, 'edit request'));
  const repo = realpathSync(resolve(repoPath));
  const head = resolveHead(repo);
  assertBridge(head === request.target.sha, 'TARGET_STALE', 'checked out HEAD does not equal edit target SHA', { expected: request.target.sha, actual: head });
  ensureCommit(repo, request.policy.sha, 'POLICY_STALE');

  const projectPolicyBytes = readTrustedProjectPolicyBytes(repo, request.policy.sha, request.repository);
  const projectPolicy = validateProjectPolicy(parseJsonBytes(projectPolicyBytes, 'trusted project policy'), request.repository);
  const hostPolicyBytes = readFileSync(hostPolicyPath);
  const hostPolicy = validateHostPolicy(readJsonFile(hostPolicyPath, 'host policy'));
  const plan = resolveEditPlan({ request, projectPolicy, hostPolicy });

  const tempBase = process.env.RUNNER_TEMP && isAbsolute(process.env.RUNNER_TEMP) ? process.env.RUNNER_TEMP : tmpdir();
  const container = mkdtempSync(resolve(tempBase, 'bridge-edit-prepare-'));
  const worktree = resolve(container, 'worktree');
  let worktreeAdded = false;
  try {
    git(repo, ['worktree', 'add', '--detach', worktree, request.target.sha]);
    worktreeAdded = true;
    const realWorktree = realpathSync(worktree);

    for (const [index, operation] of request.operations.entries()) {
      if (operation.type === 'replace-exact') replaceExact(realWorktree, operation, plan.allowedPaths);
      else applyPatch(realWorktree, operation, resolve(container, `operation-${index}.patch`));
    }

    const changedFiles = inspectChanges(realWorktree, request.target.sha, plan.allowedPaths);
    git(realWorktree, ['add', '--', ...changedFiles]);
    const requestSha256 = sha256(requestBytes);
    git(realWorktree, [
      '-c', 'user.name=Bridge',
      '-c', 'user.email=bridge@localhost',
      'commit', '--no-gpg-sign',
      '-m', request.commitSubject,
      '-m', `Bridge-Request-Id: ${request.requestId}`,
      '-m', `Bridge-Request-Base: ${request.target.sha}`,
      '-m', `Bridge-Policy-SHA: ${request.policy.sha}`,
      '-m', `Bridge-Request-SHA256: ${requestSha256}`
    ]);

    const candidateSha = git(realWorktree, ['rev-parse', 'HEAD^{commit}']).trim();
    const parentSha = git(realWorktree, ['rev-parse', 'HEAD^']).trim();
    const treeSha = git(realWorktree, ['rev-parse', 'HEAD^{tree}']).trim();
    assertBridge(parentSha === request.target.sha, 'CANDIDATE_BINDING_MISMATCH', 'candidate parent does not equal requested base');
    const diff = git(realWorktree, ['diff', '--no-color', '--binary', `${request.target.sha}..${candidateSha}`, '--'], { maxBuffer: 32 * 1024 * 1024 });

    mkdirSync(outputDir, { recursive: true });
    const bundlePath = resolve(outputDir, 'candidate.bundle');
    git(realWorktree, ['bundle', 'create', bundlePath, 'HEAD', `^${request.target.sha}`], { maxBuffer: 32 * 1024 * 1024 });

    const result = {
      schemaVersion: 1,
      status: 'PREPARED',
      executionMode: 'NO_TARGET_CODE',
      requestId: request.requestId,
      repository: request.repository,
      targetRef: request.target.ref,
      baseSha: request.target.sha,
      policySha: request.policy.sha,
      requestSha256,
      projectPolicySha256: sha256(projectPolicyBytes),
      policyProfile:policyProfile(JSON.parse(projectPolicyBytes)),
      hostPolicySha256: sha256(hostPolicyBytes),
      candidateSha,
      parentSha,
      treeSha,
      diffSha256: sha256(diff),
      changedFiles,
      operationCount: request.operations.length,
      verification: request.verification,
      runner: { class: plan.runner.class, hostId: plan.hostId, serviceUser: plan.serviceUser },
      completedAt: new Date().toISOString()
    };
    writeFileSync(resolve(outputDir, 'request.json'), requestBytes);
    writeFileSync(resolve(outputDir, 'prepare-result.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
  } finally {
    if (worktreeAdded) {
      try { git(repo, ['worktree', 'remove', '--force', worktree]); } catch {}
    }
    rmSync(container, { recursive: true, force: true });
  }
}
