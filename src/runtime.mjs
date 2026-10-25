import {policyProfile} from './default-project-policy.mjs';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { parseJsonBytes, readJsonFile } from './json.mjs';
import { validateHostPolicy, validateProjectPolicy, validateRequest } from './validate.mjs';
import { executeBatchRequest } from './batch-runtime.mjs';
import { ensureCommit, resolveHead, readTrustedProjectPolicyBytes } from './git.mjs';
import { assertBridge, BridgeError } from './errors.mjs';
import { createExecContext } from './exec.mjs';
import { resolvePresetPlan, runPresetInWorkspace } from './preset.mjs';
import { resolveWorkspaceExecPlan, runWorkspaceExec } from './workspace-exec.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
function contained(root, target) { return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep); }
function readContainedRequest(repoPath, requestPath) {
  const repo = realpathSync(resolve(repoPath));
  const raw = resolve(requestPath);
  let real;
  try { real = realpathSync(raw); } catch (error) { throw new BridgeError('INVALID_REQUEST', 'request file is unavailable', { cause: error.message }); }
  assertBridge(contained(repo, real), 'INVALID_REQUEST', 'request file must be inside target repository checkout');
  assertBridge(!lstatSync(raw).isSymbolicLink(), 'INVALID_REQUEST', 'request file cannot be a symlink');
  return readFileSync(real);
}

export async function executeRequest({ requestPath, repoPath, hostPolicyPath, outputDir }) {
  const startedAt = new Date().toISOString();
  const requestBytes = readContainedRequest(repoPath, requestPath);
  const parsedRequest = parseJsonBytes(requestBytes, 'request');
  if (parsedRequest?.mode === 'batch') {
    return await executeBatchRequest({
      request: parsedRequest,
      requestBytes,
      repoPath,
      hostPolicyPath,
      outputDir
    });
  }
  const request = validateRequest(parsedRequest);
  const head = resolveHead(repoPath);
  assertBridge(head === request.target.sha, 'TARGET_STALE', 'checked out HEAD does not equal request target SHA', { expected: request.target.sha, actual: head });
  ensureCommit(repoPath, request.policy.sha, 'POLICY_STALE');
  const projectPolicyBytes = readTrustedProjectPolicyBytes(repoPath, request.policy.sha, request.repository);
  const projectPolicy = validateProjectPolicy(parseJsonBytes(projectPolicyBytes, 'trusted project policy'), request.repository);
  const hostPolicy = validateHostPolicy(readJsonFile(hostPolicyPath, 'host policy'));

  if (request.capability === 'workspace-exec') {
    const plan = resolveWorkspaceExecPlan({ request, projectPolicy, hostPolicy });
    const execution = await runWorkspaceExec({ repoPath, targetSha: request.target.sha, plan });
    if (execution.exitCode !== 0) throw new BridgeError('EXECUTION_FAILED', `workspace-exec exited with status ${execution.exitCode}`, { ...execution, stdout: execution.stdout.slice(-4000), stderr: execution.stderr.slice(-4000) });
    const result = {
      schemaVersion: 1,
      requestId: request.requestId,
      status: 'SUCCEEDED',
      repository: request.repository,
      targetSha: request.target.sha,
      policySha: request.policy.sha,
      requestSha256: hash(requestBytes),
      projectPolicySha256: hash(projectPolicyBytes),
      policyProfile:policyProfile(JSON.parse(projectPolicyBytes)),
      capability: request.capability,
      runner: { class: plan.runner.class, hostId: plan.hostId },
      execution: {
        exitCode: execution.exitCode,
        durationMs: execution.durationMs,
        stdoutBytes: execution.stdoutBytes,
        stderrBytes: execution.stderrBytes,
        sharedWorkspace: true
      },
      evidence: { stdout: execution.stdout, stderr: execution.stderr, artifacts: [] },
      startedAt,
      completedAt: new Date().toISOString()
    };
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(resolve(outputDir, 'bridge-result.json'), JSON.stringify(result,null,2)+'\n');
    return result;
  }

  const plan = resolvePresetPlan({
    request,
    parameters: request.parameters,
    projectPolicy,
    hostPolicy
  });
  const context = createExecContext({ repoPath, isolateHome: false });
  try {
    const { execution, evidence } = await runPresetInWorkspace({
      context,
      repoPath,
      plan,
      outputDir: resolve(outputDir, 'evidence')
    });
    const result = {
      schemaVersion: 1,
      requestId: request.requestId,
      status: 'SUCCEEDED',
      repository: request.repository,
      targetSha: request.target.sha,
      policySha: request.policy.sha,
      requestSha256: hash(requestBytes),
      projectPolicySha256: hash(projectPolicyBytes),
      policyProfile:policyProfile(JSON.parse(projectPolicyBytes)),
      capability: request.capability,
      runner: { class: plan.runner.class, hostId: plan.hostId },
      execution: {
        exitCode: execution.exitCode,
        durationMs: execution.durationMs,
        stdoutBytes: execution.stdoutBytes,
        stderrBytes: execution.stderrBytes
      },
      evidence,
      startedAt,
      completedAt: new Date().toISOString()
    };
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(resolve(outputDir, 'bridge-result.json'), JSON.stringify(result,null,2)+'\n');
    return result;
  } finally {
    context.cleanup();
  }

}
