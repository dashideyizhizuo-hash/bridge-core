import { resolve } from 'node:path';
import { collectOutputs } from './artifacts.mjs';
import { assertBridge, BridgeError } from './errors.mjs';
import { runExecInWorkspace } from './exec.mjs';
import { interpolateArgv, validateAndDefaultParameters } from './parameters.mjs';
import { resolveExecutionPlan } from './policy.mjs';
import { redactBridgeError, redactResourceText } from './redaction.mjs';
import { repositoryStatus } from './git.mjs';

function allowedOutputPaths(outputs) {
  const rules = [];
  if (outputs.report) rules.push({ kind: 'exact', path: outputs.report });
  for (const pattern of outputs.artifacts ?? []) {
    if (pattern.endsWith('/**')) rules.push({ kind: 'prefix', path: pattern.slice(0, -3) });
    else rules.push({ kind: 'exact', path: pattern });
  }
  return rules;
}

function filteredStatus(status, allowed) {
  if (!status) return '';
  const permitted = path => allowed.some(rule =>
    rule.kind === 'exact' ? path === rule.path : path === rule.path || path.startsWith(rule.path + '/')
  );
  return status.split('\n').filter(Boolean).filter(line => {
    const raw = line.slice(3);
    const paths = raw.includes(' -> ') ? raw.split(' -> ') : [raw];
    return !paths.every(permitted);
  }).join('\n');
}

export function resolvePresetPlan({ request, parameters, projectPolicy, hostPolicy }) {
  const policyPlan = resolveExecutionPlan({ request, projectPolicy, hostPolicy });
  const params = validateAndDefaultParameters(policyPlan.capability.parameters ?? {}, parameters ?? {});
  const limits = {
    timeoutSeconds: policyPlan.capability.limits?.timeoutSeconds ?? 900,
    stdoutBytes: policyPlan.capability.limits?.stdoutBytes ?? 524288,
    stderrBytes: policyPlan.capability.limits?.stderrBytes ?? 262144,
    reportBytes: policyPlan.capability.limits?.reportBytes ?? 524288,
    artifactBytes: policyPlan.capability.limits?.artifactBytes ?? 10 * 1024 * 1024
  };
  return {
    type: 'preset',
    capabilityId: request.capability,
    capability: policyPlan.capability,
    runner: policyPlan.runner,
    hostId: policyPlan.hostId,
    argv: interpolateArgv(policyPlan.capability.command.argv, params),
    cwd: '.',
    env: policyPlan.env,
    resources: policyPlan.resources,
    limits
  };
}

export async function runPresetInWorkspace({ context, repoPath, plan, outputDir }) {
  const allowedOutputs = allowedOutputPaths(plan.capability.outputs ?? {});
  const before = filteredStatus(repositoryStatus(repoPath), allowedOutputs);

  let execution;
  try {
    execution = await runExecInWorkspace({ context, plan });
  } catch (error) {
    throw redactBridgeError(error, plan.resources);
  }
  if (execution.exitCode !== 0) {
    throw new BridgeError('EXECUTION_FAILED', 'capability exited with status ' + execution.exitCode, {
      ...execution,
      stdout: redactResourceText(execution.stdout.slice(-4000), plan.resources),
      stderr: redactResourceText(execution.stderr.slice(-4000), plan.resources)
    });
  }

  const after = filteredStatus(repositoryStatus(repoPath), allowedOutputs);
  assertBridge(after === before, 'WORKSPACE_MUTATED', 'observe/verify capability mutated the repository workspace', { before, after });

  const outputs = collectOutputs({
    workspace: resolve(repoPath),
    outputs: plan.capability.outputs ?? {},
    limits: plan.limits,
    outputDir
  });
  if (!outputs.report && plan.capability.outputs?.structuredStdout === 'json') {
    assertBridge(execution.stdoutBytes <= plan.limits.reportBytes, 'OUTPUT_LIMIT_EXCEEDED', 'structured stdout exceeds report limit');
    try {
      JSON.parse(execution.stdout);
    } catch (error) {
      throw new BridgeError('EVIDENCE_INVALID', 'structuredStdout=json but stdout is not valid JSON', { cause: error.message });
    }
    outputs.report = { path: 'stdout', bytes: execution.stdoutBytes, content: execution.stdout };
  }

  const report = outputs.report
    ? { ...outputs.report, content: redactResourceText(outputs.report.content, plan.resources) }
    : undefined;
  return {
    execution,
    evidence: {
      stdout: redactResourceText(execution.stdout, plan.resources),
      stderr: redactResourceText(execution.stderr, plan.resources),
      ...(report ? { report } : {}),
      artifacts: outputs.artifacts
    }
  };
}
