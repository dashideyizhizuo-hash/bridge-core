import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { BridgeError, assertBridge } from './errors.mjs';
import { createExecContext, resolveExecAuthority, resolveExecPlan, runExecInWorkspace } from './exec.mjs';
import { applyEditOperationsInWorkspace, createSharedWorkspaceCandidate, resolveEditPlan, trackedDiffState } from './edit.mjs';
import { ensureCommit, resolveHead, showFile } from './git.mjs';
import { readJsonFile, parseJsonBytes } from './json.mjs';
import { resolvePresetPlan, runPresetInWorkspace } from './preset.mjs';
import { redactBridgeError, redactResourceText } from './redaction.mjs';
import { BATCH_LIMITS, validateBatchRequest, validateHostPolicy, validateProjectPolicy } from './validate.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const RESULT_RESERVE_BYTES = 65536;

function publicError(error) {
  return {
    code: typeof error?.code === 'string' ? error.code.slice(0, 128) : 'EXECUTION_FAILED',
    message: String(error?.message ?? 'execution failed').slice(0, 2048)
  };
}
function runStatusFor(error) {
  const code = String(error?.code ?? '');
  if (code.endsWith('_STALE')) return 'STALE';
  if (code === 'EXECUTION_TIMEOUT' || code === 'EXECUTION_FAILED' || code === 'OUTPUT_LIMIT_EXCEEDED' || code === 'OUTPUT_ENCODING_INVALID') return 'FAILED';
  return 'DENIED';
}
function skipped(step) {
  return { id: step.id, type: step.type, status: 'SKIPPED', durationMs: 0 };
}
function deniedSteps(steps, index, error) {
  return steps.map((step, stepIndex) => stepIndex === index
    ? { id: step.id, type: step.type, status: 'DENIED', durationMs: 0, error: publicError(error) }
    : skipped(step));
}
function failedStep(step, error, fallbackDurationMs) {
  const details = error?.details && typeof error.details === 'object' ? error.details : {};
  const durationMs = Number.isInteger(details.durationMs) ? details.durationMs : fallbackDurationMs;
  const execution = {
    ...(Number.isInteger(details.exitCode) || details.exitCode === null ? { exitCode: details.exitCode } : {}),
    ...(typeof details.signal === 'string' || details.signal === null ? { signal: details.signal } : {}),
    ...(Number.isInteger(details.stdoutBytes) ? { stdoutBytes: details.stdoutBytes } : {}),
    ...(Number.isInteger(details.stderrBytes) ? { stderrBytes: details.stderrBytes } : {})
  };
  const evidence = {
    ...(typeof details.stdout === 'string' ? { stdout: details.stdout } : {}),
    ...(typeof details.stderr === 'string' ? { stderr: details.stderr } : {})
  };
  return {
    id: step.id,
    type: step.type,
    status: runStatusFor(error),
    durationMs: Math.max(0, durationMs),
    ...(Object.keys(execution).length ? { execution } : {}),
    ...(Object.keys(evidence).length ? { evidence } : {}),
    error: publicError(error)
  };
}
function baseResult({ request, requestBytes, projectPolicyBytes, startedAt }) {
  return {
    schemaVersion: 1,
    mode: 'batch',
    requestId: request.requestId,
    repository: request.repository,
    targetRef: request.target.ref,
    targetSha: request.target.sha,
    policySha: request.policy.sha,
    requestSha256: hash(requestBytes),
    ...(projectPolicyBytes ? { projectPolicySha256: hash(projectPolicyBytes) } : {}),
    startedAt
  };
}
function persistResult(outputDir, result) {
  const encoded = JSON.stringify(result);
  assertBridge(Buffer.byteLength(encoded + '\n', 'utf8') <= BATCH_LIMITS.resultBytes, 'OUTPUT_LIMIT_EXCEEDED', 'combined batch result exceeds total byte limit');
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(resolve(outputDir, 'bridge-result.json'), encoded + '\n');
  return result;
}
function projectedBytes(base, steps) {
  return Buffer.byteLength(JSON.stringify({
    ...base,
    status: 'SUCCEEDED',
    steps,
    durationMs: 0,
    workspace: { materializations: 1, shared: true },
    completedAt: new Date().toISOString()
  }), 'utf8');
}
function boundStepResult(base, previous, entry, suffix) {
  const fits = value => projectedBytes(base, [...previous, value, ...suffix]) <= BATCH_LIMITS.resultBytes - RESULT_RESERVE_BYTES;
  if (fits(entry)) return entry;
  const failure = {
    ...entry,
    status: 'FAILED',
    error: { code: 'OUTPUT_LIMIT_EXCEEDED', message: 'combined batch evidence exceeded total byte limit' },
    evidence: {
      stdout: entry.evidence?.stdout ?? '',
      stderr: entry.evidence?.stderr ?? '',
      truncated: true,
      ...(entry.evidence?.report ? { reportOmitted: true } : {})
    }
  };
  // Trim only the current, already-redacted step. Never erase completed evidence
  // or emit a truncated structured report as if it were a valid report.
  while (!fits(failure) && (failure.evidence.stdout.length || failure.evidence.stderr.length)) {
    failure.evidence.stdout = failure.evidence.stdout.slice(0, Math.floor(failure.evidence.stdout.length / 2));
    failure.evidence.stderr = failure.evidence.stderr.slice(0, Math.floor(failure.evidence.stderr.length / 2));
  }
  return failure;
}
function execEvidence(execution, resources) {
  return {
    execution: {
      exitCode: execution.exitCode,
      signal: execution.signal,
      stdoutBytes: execution.stdoutBytes,
      stderrBytes: execution.stderrBytes
    },
    evidence: {
      stdout: redactResourceText(execution.stdout, resources),
      stderr: redactResourceText(execution.stderr, resources)
    }
  };
}

export async function executeBatchRequest({ request: rawRequest, requestBytes, repoPath, hostPolicyPath, outputDir }) {
  const startedMs = performance.now();
  const startedAt = new Date().toISOString();
  const request = validateBatchRequest(rawRequest);

  let projectPolicyBytes;
  let projectPolicy;
  let hostPolicy;
  let base = baseResult({ request, requestBytes, startedAt });

  try {
    const head = resolveHead(repoPath);
    assertBridge(head === request.target.sha, 'TARGET_STALE', 'checked out HEAD does not equal request target SHA', { expected: request.target.sha, actual: head });
    ensureCommit(repoPath, request.policy.sha, 'POLICY_STALE');
    projectPolicyBytes = showFile(repoPath, request.policy.sha, '.bridge/project.json');
    projectPolicy = validateProjectPolicy(parseJsonBytes(projectPolicyBytes, 'trusted project policy'), request.repository);
    hostPolicy = validateHostPolicy(readJsonFile(hostPolicyPath, 'host policy'));
    base = baseResult({ request, requestBytes, projectPolicyBytes, startedAt });
  } catch (error) {
    return persistResult(outputDir, {
      ...base,
      status: runStatusFor(error),
      steps: request.steps.map(skipped),
      durationMs: Math.max(0, Math.round(performance.now() - startedMs)),
      workspace: { materializations: 1, shared: true },
      error: publicError(error),
      completedAt: new Date().toISOString()
    });
  }

  const plans = [];
  let execAuthority;
  let runnerClass = null;
  let runnerHostId = null;
  const editIndexes = request.steps.map((step,index)=>step.type==='edit'?index:-1).filter(index=>index>=0);
  const edited = editIndexes.length > 0;
  const finalVerificationIndexes = new Set();
  let editAuthority = null;
  if (edited) {
    try {
      const operations = editIndexes.flatMap(index=>request.steps[index].operations);
      editAuthority = resolveEditPlan({
        request: {
          repository: request.repository,
          target: { ref: request.target.ref },
          commitSubject: request.commitSubject,
          operations
        },
        projectPolicy,
        hostPolicy
      });
      const lastEdit = editIndexes.at(-1);
      let firstVerify = -1;
      for (let index = lastEdit + 1; index < request.steps.length; index += 1) {
        const step = request.steps[index];
        if (step.type === 'preset' && projectPolicy.capabilities[step.capability]?.class === 'verify') {
          firstVerify = index;
          break;
        }
      }
      assertBridge(firstVerify >= 0, 'VERIFICATION_DENIED', 'edited batch requires a trusted verification tail after the last edit');
      const verifyTail = request.steps.slice(firstVerify);
      assertBridge(verifyTail.length >= 1 && verifyTail.length <= 4, 'VERIFICATION_DENIED', 'edited batch requires 1-4 final trusted verification presets');
      for (let index = firstVerify; index < request.steps.length; index += 1) {
        const step = request.steps[index];
        assertBridge(step.type === 'preset' && projectPolicy.capabilities[step.capability]?.class === 'verify', 'VERIFICATION_DENIED', 'only trusted verify presets may follow final verification start');
        finalVerificationIndexes.add(index);
      }
    } catch (error) {
      const deniedIndex = editIndexes.at(-1);
      return persistResult(outputDir, {
        ...base,
        status: runStatusFor(error),
        steps: deniedSteps(request.steps, deniedIndex, error),
        durationMs: Math.max(0, Math.round(performance.now() - startedMs)),
        workspace: { materializations: 1, shared: true },
        error: publicError(error),
        completedAt: new Date().toISOString()
      });
    }
  }

  for (const [index, step] of request.steps.entries()) {
    try {
      let plan;
      if (step.type === 'exec') {
        execAuthority ??= resolveExecAuthority({ repository: request.repository, projectPolicy, hostPolicy });
        plan = resolveExecPlan({
          parameters: {
            argv: step.argv,
            ...(step.cwd !== undefined ? { cwd: step.cwd } : {}),
            ...(step.resources !== undefined ? { resources: step.resources } : {}),
            ...(step.timeoutSeconds !== undefined ? { timeoutSeconds: step.timeoutSeconds } : {})
          },
          authority: execAuthority,
          code: 'PARAMETER_DENIED'
        });
      } else if (step.type === 'preset') {
        plan = resolvePresetPlan({
          request: { ...request, capability: step.capability },
          parameters: step.parameters ?? {},
          projectPolicy,
          hostPolicy
        });
      } else if (step.type === 'edit') {
        plan = { ...editAuthority, type: 'edit', operations: step.operations };
      } else {
        throw new BridgeError('BATCH_STEP_UNAVAILABLE', 'unsupported batch step type');
      }

      if (runnerClass === null) {
        runnerClass = plan.runner.class;
        runnerHostId = plan.hostId;
      } else {
        assertBridge(plan.runner.class === runnerClass, 'BATCH_RUNNER_MISMATCH', 'all batch steps must use one runner class');
        assertBridge(plan.hostId === runnerHostId, 'BATCH_RUNNER_MISMATCH', 'all batch steps must use one host identity');
      }
      plans.push(plan);
    } catch (error) {
      return persistResult(outputDir, {
        ...base,
        status: runStatusFor(error),
        ...(runnerClass ? { runner: { class: runnerClass, hostId: runnerHostId } } : {}),
        steps: deniedSteps(request.steps, index, error),
        durationMs: Math.max(0, Math.round(performance.now() - startedMs)),
        workspace: { materializations: 1, shared: true },
        error: publicError(error),
        completedAt: new Date().toISOString()
      });
    }
  }

  base = { ...base, runner: { class: runnerClass, hostId: runnerHostId } };
  const runSeconds = Math.min(BATCH_LIMITS.seconds, execAuthority?.limits.timeoutSeconds ?? BATCH_LIMITS.seconds);
  const results = [];
  let terminalError = null;
  let candidate = null;
  let verificationResultSha256 = null;
  let authorizedDiff = trackedDiffState(repoPath, request.target.sha);
  assertBridge(authorizedDiff.changedFiles.length === 0, 'WORKSPACE_MUTATED', 'Run workspace contains tracked changes before batch execution');
  const verificationRecords = [];
  const context = createExecContext({ repoPath });
  try {
    for (let index = 0; index < request.steps.length; index += 1) {
      const step = request.steps[index];
      const basePlan = plans[index];
      const remainingMs = runSeconds * 1000 - (Math.max(0, Math.round(performance.now() - startedMs)));
      if (remainingMs <= 0) {
        const error = new BridgeError('EXECUTION_TIMEOUT', 'batch exceeded total execution deadline');
        results.push(failedStep(step, error, 0));
        terminalError = error;
        break;
      }

      const plan = {
        ...basePlan,
        limits: {
          ...(basePlan.limits ?? {}),
          timeoutSeconds: Math.min(basePlan.limits?.timeoutSeconds ?? (remainingMs / 1000), remainingMs / 1000),
          outputBudgetBytes: BATCH_LIMITS.resultBytes - RESULT_RESERVE_BYTES - projectedBytes(base, [
            ...results, ...request.steps.slice(index).map(skipped)
          ])
        }
      };
      const stepStarted = performance.now();
      try {
        assertBridge(plan.limits.outputBudgetBytes > 64, 'OUTPUT_LIMIT_EXCEEDED', 'batch exhausted its combined output budget');
        assertBridge(resolveHead(repoPath) === request.target.sha, 'TARGET_STALE', 'Run workspace HEAD changed');
        let execution = null;
        let evidence;
        if (step.type === 'edit') {
          const current = trackedDiffState(repoPath, request.target.sha);
          assertBridge(current.diffSha256 === authorizedDiff.diffSha256, 'WORKSPACE_MUTATED', 'tracked workspace changed outside authorized edit steps');
          authorizedDiff = applyEditOperationsInWorkspace({
            workspace: repoPath,
            baseSha: request.target.sha,
            operations: step.operations,
            plan,
            scratchDir: resolve(outputDir, 'steps', step.id, 'patches')
          });
          evidence = { changedFiles: authorizedDiff.changedFiles, diffSha256: authorizedDiff.diffSha256 };
        } else if (step.type === 'preset') {
          if (finalVerificationIndexes.has(index)) {
            const current = trackedDiffState(repoPath, request.target.sha);
            assertBridge(current.diffSha256 === authorizedDiff.diffSha256, 'WORKSPACE_MUTATED', 'tracked workspace changed before trusted verification');
          }
          const preset = await runPresetInWorkspace({
            context,
            repoPath,
            plan,
            outputDir: resolve(outputDir, 'steps', step.id)
          });
          execution = preset.execution;
          evidence = preset.evidence;
          if (finalVerificationIndexes.has(index)) {
            const afterVerify = trackedDiffState(repoPath, request.target.sha);
            assertBridge(afterVerify.diffSha256 === authorizedDiff.diffSha256, 'WORKSPACE_MUTATED', 'trusted verification changed publishable workspace content', {
              ...execution,
              stdout: evidence.stdout,
              stderr: evidence.stderr
            });
          }
        } else {
          try {
            execution = await runExecInWorkspace({ context, plan });
          } catch (error) {
            throw redactBridgeError(error, plan.resources);
          }
          if (execution.exitCode !== 0) {
            throw new BridgeError('EXECUTION_FAILED', 'exec step exited with status ' + execution.exitCode, {
              ...execution,
              stdout: redactResourceText(execution.stdout, plan.resources),
              stderr: redactResourceText(execution.stderr, plan.resources)
            });
          }
          evidence = execEvidence(execution, plan.resources).evidence;
        }

        assertBridge(resolveHead(repoPath) === request.target.sha, 'TARGET_STALE', 'Run workspace HEAD changed', execution ? {
          ...execution, ...execEvidence(execution, plan.resources).evidence
        } : undefined);
        const completed = {
          id: step.id,
          type: step.type,
          status: 'SUCCEEDED',
          durationMs: execution?.durationMs ?? Math.max(0, Math.round(performance.now() - stepStarted)),
          ...(execution ? { execution: {
            exitCode: execution.exitCode,
            signal: execution.signal,
            stdoutBytes: execution.stdoutBytes,
            stderrBytes: execution.stderrBytes
          } } : {}),
          evidence
        };
        const bounded = boundStepResult(base, results, completed, request.steps.slice(index + 1).map(skipped));
        results.push(bounded);
        if (bounded.status !== 'SUCCEEDED') {
          terminalError = new BridgeError(bounded.error.code, bounded.error.message);
          break;
        }
        if (finalVerificationIndexes.has(index)) {
          verificationRecords.push({
            stepId: step.id,
            capability: step.capability,
            parametersSha256: hash(JSON.stringify(step.parameters ?? {})),
            resultSha256: hash(JSON.stringify(bounded)),
            execution: bounded.execution,
            runner: { class: plan.runner.class, hostId: plan.hostId },
            stdoutSha256: hash(bounded.evidence?.stdout ?? ''),
            stderrSha256: hash(bounded.evidence?.stderr ?? '')
          });
        }
      } catch (error) {
        const failed = boundStepResult(base, results,
          failedStep(step, error, Math.max(0, Math.round(performance.now() - stepStarted))),
          request.steps.slice(index + 1).map(skipped));
        results.push(failed);
        terminalError = new BridgeError(failed.error.code, failed.error.message);
        break;
      }
    }
  } finally {
    context.cleanup();
  }

  if (!terminalError && edited) {
    try {
      const current = trackedDiffState(repoPath, request.target.sha);
      assertBridge(current.diffSha256 === authorizedDiff.diffSha256, 'WORKSPACE_MUTATED', 'tracked workspace changed after trusted verification');
      const verification = [...finalVerificationIndexes].map(index => {
        const step = request.steps[index];
        return { stepId: step.id, capability: step.capability, parameters: step.parameters ?? {} };
      });
      assertBridge(verificationRecords.length === verification.length, 'VERIFICATION_DENIED', 'not all trusted verification presets completed');
      const hostPolicyBytes = readFileSync(hostPolicyPath);
      candidate = createSharedWorkspaceCandidate({
        requestBytes,
        request,
        repoPath,
        projectPolicyBytes,
        hostPolicyBytes,
        plan: editAuthority,
        verification,
        operationCount: editIndexes.reduce((total,index)=>total+request.steps[index].operations.length,0),
        outputDir: resolve(outputDir, 'prepare')
      });
      const prepareBytes = readFileSync(resolve(outputDir, 'prepare', 'prepare-result.json'));
      const verificationResult = {
        schemaVersion: 1,
        status: 'VERIFIED',
        requestId: request.requestId,
        repository: request.repository,
        requestSha256: candidate.requestSha256,
        prepareResultSha256: hash(prepareBytes),
        baseSha: candidate.baseSha,
        policySha: candidate.policySha,
        candidateSha: candidate.candidateSha,
        treeSha: candidate.treeSha,
        diffSha256: candidate.diffSha256,
        changedFiles: candidate.changedFiles,
        verificationPlanSha256: hash(JSON.stringify(verification)),
        projectPolicySha256: hash(projectPolicyBytes),
        verificationHostPolicySha256: hash(hostPolicyBytes),
        verifications: verificationRecords,
        completedAt: new Date().toISOString()
      };
      mkdirSync(resolve(outputDir, 'verification'), { recursive: true });
      const verificationBytes = Buffer.from(JSON.stringify(verificationResult, null, 2) + '\n');
      writeFileSync(resolve(outputDir, 'verification', 'verification-result.json'), verificationBytes);
      verificationResultSha256 = hash(verificationBytes);
    } catch (error) {
      terminalError = error;
    }
  }

  while (results.length < request.steps.length) results.push(skipped(request.steps[results.length]));

  return persistResult(outputDir, {
    ...base,
    status: terminalError ? runStatusFor(terminalError) : (edited ? 'VERIFIED' : 'SUCCEEDED'),
    runner: { class: runnerClass, hostId: runnerHostId },
    steps: results,
    durationMs: Math.max(0, Math.round(performance.now() - startedMs)),
    workspace: { materializations: 1, shared: true },
    ...(!terminalError && candidate ? {
      baseSha: candidate.baseSha,
      candidateSha: candidate.candidateSha,
      treeSha: candidate.treeSha,
      diffSha256: candidate.diffSha256,
      changedFiles: candidate.changedFiles,
      verificationResultSha256
    } : {}),
    ...(terminalError ? { error: publicError(terminalError) } : {}),
    completedAt: new Date().toISOString()
  });
}
