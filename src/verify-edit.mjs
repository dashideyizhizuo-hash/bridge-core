import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { assertBridge } from './errors.mjs';
import { ensureCommit, git, showFile } from './git.mjs';
import { parseJsonBytes, readJsonFile } from './json.mjs';
import { executeRequest } from './runtime.mjs';
import { validateEditRequest, validateHostPolicy, validateProjectPolicy } from './validate.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');

function stable(value) {
  return JSON.stringify(value);
}

function validatePrepare(prep) {
  assertBridge(prep?.schemaVersion === 1 && prep.status === 'PREPARED' && prep.executionMode === 'NO_TARGET_CODE', 'INVALID_PREPARE', 'prepare result is not a valid Bridge edit candidate');
  for (const field of ['requestId','repository','targetRef','baseSha','policySha','requestSha256','candidateSha','parentSha','treeSha','diffSha256']) {
    assertBridge(typeof prep[field] === 'string' && prep[field].length > 0, 'INVALID_PREPARE', `prepare result missing ${field}`);
  }
  assertBridge(Array.isArray(prep.changedFiles) && prep.changedFiles.length > 0, 'INVALID_PREPARE', 'prepare result changedFiles invalid');
  assertBridge(Array.isArray(prep.verification) && prep.verification.length >= 1 && prep.verification.length <= 4, 'INVALID_PREPARE', 'prepare result verification plan invalid');
}

function bindCandidate(repo, prep, prepareDir) {
  ensureCommit(repo, prep.baseSha, 'BASE_MISSING');
  ensureCommit(repo, prep.policySha, 'POLICY_STALE');
  const ref = `refs/bridge-verify/${prep.requestId}`;
  git(repo, ['fetch','--force',resolve(prepareDir,'candidate.bundle'),`${prep.candidateSha}:${ref}`], { maxBuffer: 32 * 1024 * 1024 });
  const candidateSha = git(repo, ['rev-parse',`${ref}^{commit}`]).trim();
  const parentSha = git(repo, ['rev-parse',`${candidateSha}^`]).trim();
  const treeSha = git(repo, ['rev-parse',`${candidateSha}^{tree}`]).trim();
  assertBridge(candidateSha === prep.candidateSha && parentSha === prep.baseSha && treeSha === prep.treeSha, 'CANDIDATE_BINDING_MISMATCH', 'candidate bundle identity mismatch');
  const diff = git(repo, ['diff','--no-color','--binary',`${prep.baseSha}..${candidateSha}`,'--'], { maxBuffer: 32 * 1024 * 1024 });
  assertBridge(sha256(diff) === prep.diffSha256, 'CANDIDATE_BINDING_MISMATCH', 'candidate diff digest mismatch');
  const changedFiles = git(repo, ['diff','--name-only','-z',`${prep.baseSha}..${candidateSha}`,'--']).split('\0').filter(Boolean).sort();
  assertBridge(stable(changedFiles) === stable([...prep.changedFiles].sort()), 'CANDIDATE_BINDING_MISMATCH', 'candidate changed paths mismatch');
  return { ref, candidateSha };
}

export async function verifyEditCandidate({ prepareDir, repoPath, hostPolicyPath, outputDir }) {
  const prepareBytes = readFileSync(resolve(prepareDir,'prepare-result.json'));
  const prep = parseJsonBytes(prepareBytes, 'prepare result');
  validatePrepare(prep);

  const requestBytes = readFileSync(resolve(prepareDir,'request.json'));
  assertBridge(sha256(requestBytes) === prep.requestSha256, 'REQUEST_DIGEST_MISMATCH', 'immutable edit request digest mismatch');
  const request = validateEditRequest(parseJsonBytes(requestBytes, 'edit request'));
  assertBridge(request.requestId === prep.requestId && request.repository === prep.repository, 'REQUEST_BINDING_MISMATCH', 'edit request identity mismatch');
  assertBridge(request.target.sha === prep.baseSha && request.target.ref === prep.targetRef && request.policy.sha === prep.policySha, 'REQUEST_BINDING_MISMATCH', 'edit request target/policy binding mismatch');
  assertBridge(stable(request.verification) === stable(prep.verification), 'REQUEST_BINDING_MISMATCH', 'verification plan changed after preparation');

  const repo = realpathSync(resolve(repoPath));
  const projectPolicyBytes = showFile(repo, prep.policySha, '.bridge/project.json');
  const projectPolicy = validateProjectPolicy(parseJsonBytes(projectPolicyBytes, 'trusted project policy'), prep.repository);
  const hostPolicyBytes = readFileSync(hostPolicyPath);
  validateHostPolicy(readJsonFile(hostPolicyPath, 'host policy'));

  for (const [index, step] of request.verification.entries()) {
    const capability = projectPolicy.capabilities[step.capability];
    assertBridge(capability?.class === 'verify', 'VERIFICATION_DENIED', `verification ${index} must reference a trusted verify capability: ${step.capability}`);
  }

  const { ref, candidateSha } = bindCandidate(repo, prep, prepareDir);
  const tempBase = process.env.RUNNER_TEMP && isAbsolute(process.env.RUNNER_TEMP) ? process.env.RUNNER_TEMP : tmpdir();
  const container = mkdtempSync(resolve(tempBase,'bridge-edit-verify-'));
  const verifications = [];

  try {
    for (const [index, step] of request.verification.entries()) {
      const worktree = resolve(container,`worktree-${index}`);
      git(repo, ['worktree','add','--detach',worktree,candidateSha]);
      try {
        const requestPath = resolve(worktree,`.bridge-verify-${index}.json`);
        const capabilityRequest = {
          schemaVersion: 1,
          requestId: `${request.requestId}-v${index}`,
          repository: prep.repository,
          target: { ref: prep.targetRef, sha: candidateSha },
          policy: { ref: request.policy.ref, sha: prep.policySha },
          capability: step.capability,
          parameters: step.parameters
        };
        writeFileSync(requestPath, JSON.stringify(capabilityRequest, null, 2) + '\n', { mode: 0o600 });
        const stepDir = resolve(outputDir,`step-${index}`);
        const result = await executeRequest({ requestPath, repoPath: worktree, hostPolicyPath, outputDir: stepDir });
        const resultBytes = readFileSync(resolve(stepDir,'bridge-result.json'));
        verifications.push({
          index,
          capability: step.capability,
          parametersSha256: sha256(stable(step.parameters)),
          resultSha256: sha256(resultBytes),
          execution: result.execution,
          runner: result.runner,
          stdoutSha256: sha256(result.evidence.stdout ?? ''),
          stderrSha256: sha256(result.evidence.stderr ?? '')
        });
      } finally {
        try { git(repo, ['worktree','remove','--force',worktree]); } catch {}
      }
    }

    mkdirSync(outputDir, { recursive: true });
    const result = {
      schemaVersion: 1,
      status: 'VERIFIED',
      requestId: prep.requestId,
      repository: prep.repository,
      requestSha256: prep.requestSha256,
      prepareResultSha256: sha256(prepareBytes),
      baseSha: prep.baseSha,
      policySha: prep.policySha,
      candidateSha: prep.candidateSha,
      treeSha: prep.treeSha,
      diffSha256: prep.diffSha256,
      changedFiles: prep.changedFiles,
      verificationPlanSha256: sha256(stable(request.verification)),
      projectPolicySha256: sha256(projectPolicyBytes),
      verificationHostPolicySha256: sha256(hostPolicyBytes),
      verifications,
      completedAt: new Date().toISOString()
    };
    writeFileSync(resolve(outputDir,'verification-result.json'), JSON.stringify(result, null, 2) + '\n');
    return result;
  } finally {
    try { git(repo, ['update-ref','-d',ref]); } catch {}
    rmSync(container, { recursive: true, force: true });
  }
}
