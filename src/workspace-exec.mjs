import { assertBridge } from './errors.mjs';
import { createExecContext, resolveExecAuthority, resolveExecPlan, runExecInWorkspace } from './exec.mjs';

export function resolveWorkspaceExecPlan({ request, projectPolicy, hostPolicy }) {
  const allowedKeys = new Set(['argv', 'cwd']);
  for (const key of Object.keys(request.parameters)) {
    assertBridge(allowedKeys.has(key), 'PARAMETER_DENIED', 'workspace-exec parameter is not allowed: ' + key);
  }

  const authority = resolveExecAuthority({
    repository: request.repository,
    projectPolicy,
    hostPolicy
  });
  return resolveExecPlan({
    parameters: request.parameters,
    authority,
    code: 'PARAMETER_DENIED'
  });
}

export async function runWorkspaceExec({ repoPath, plan }) {
  const context = createExecContext({ repoPath });
  try {
    return await runExecInWorkspace({ context, plan });
  } finally {
    context.cleanup();
  }
}
