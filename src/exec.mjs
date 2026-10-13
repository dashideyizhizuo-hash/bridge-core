import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';
import { assertBridge, BridgeError } from './errors.mjs';
import { sanitizedExecutionEnv } from './environment.mjs';
import { runBounded } from './execute.mjs';
import { resolveResourceBindings } from './policy.mjs';
import { validateExecParameters } from './validate.mjs';

function contained(root, candidate) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

export function resolveExecAuthority({ repository, projectPolicy, hostPolicy }) {
  const project = projectPolicy.workspaceExec;
  assertBridge(project?.enabled === true, 'UNKNOWN_CAPABILITY', 'exec is not enabled by trusted project policy');

  const repoHost = hostPolicy.repositories[repository];
  assertBridge(repoHost, 'HOST_RESOURCE_DENIED', 'host policy does not authorize repository: ' + repository);
  const host = repoHost.workspaceExec;
  assertBridge(host?.enabled === true, 'HOST_RESOURCE_DENIED', 'exec is not enabled by host policy');

  const runner = projectPolicy.runners[project.runner];
  assertBridge(runner, 'PROJECT_POLICY_INVALID', 'workspaceExec references unknown project runner');
  assertBridge(repoHost.runnerClasses.includes(runner.class), 'HOST_RESOURCE_DENIED', 'exec runner class is not granted by host policy: ' + runner.class);
  assertBridge(host.runnerClass === runner.class, 'HOST_RESOURCE_DENIED', 'exec host runner class mismatch: expected ' + runner.class);

  const actualUser = userInfo().username;
  assertBridge(host.serviceUser === actualUser, 'HOST_RESOURCE_DENIED', 'exec requires service user ' + host.serviceUser + ', actual user is ' + actualUser);

  return {
    runner: { id: project.runner, class: runner.class },
    hostId: hostPolicy.host.id,
    serviceUser: actualUser,
    project,
    repoHost,
    limits: {
      maxArgv: Math.min(project.maxArgv ?? 32, host.maxArgv ?? 32),
      timeoutSeconds: Math.min(project.maxSeconds ?? 900, host.maxSeconds ?? 900),
      stdoutBytes: Math.min(project.stdoutBytes ?? 524288, host.stdoutBytes ?? 524288),
      stderrBytes: Math.min(project.stderrBytes ?? 262144, host.stderrBytes ?? 262144)
    }
  };
}

export function resolveExecPlan({ parameters, authority, code = 'PARAMETER_DENIED' }) {
  assertBridge(parameters && typeof parameters === 'object' && !Array.isArray(parameters), code, 'exec parameters must be an object');
  validateExecParameters(parameters, {
    maxArgv: authority.limits.maxArgv,
    allowResources: true,
    allowTimeout: true,
    code
  });

  const requested = parameters.resources ?? [];
  const allowed = new Map((authority.project.resources ?? []).map(requirement => [requirement.name, requirement]));
  const requirements = requested.map(name => {
    const requirement = allowed.get(name);
    assertBridge(requirement, 'HOST_RESOURCE_DENIED', 'exec resource is not authorized by trusted project policy: ' + name);
    return requirement;
  });
  const bindings = resolveResourceBindings({ requirements, repoHost: authority.repoHost });

  return {
    runner: authority.runner,
    hostId: authority.hostId,
    serviceUser: authority.serviceUser,
    argv: [...parameters.argv],
    cwd: parameters.cwd ?? '.',
    env: bindings.env,
    resources: bindings.resources,
    limits: {
      timeoutSeconds: Math.min(authority.limits.timeoutSeconds, parameters.timeoutSeconds ?? authority.limits.timeoutSeconds),
      stdoutBytes: authority.limits.stdoutBytes,
      stderrBytes: authority.limits.stderrBytes
    }
  };
}

export function createExecContext({ repoPath, isolateHome = true }) {
  const workspace = realpathSync(resolve(repoPath));
  const baseEnv = sanitizedExecutionEnv();

  if (!isolateHome) {
    return {
      workspace,
      env: { ...baseEnv, BRIDGE_EXEC: '1' },
      cleanup() {}
    };
  }

  const tempBase = process.env.RUNNER_TEMP && isAbsolute(process.env.RUNNER_TEMP)
    ? process.env.RUNNER_TEMP
    : tmpdir();
  const container = mkdtempSync(resolve(tempBase, 'bridge-exec-'));
  const home = resolve(container, 'home');
  const temp = resolve(container, 'tmp');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(temp, { recursive: true, mode: 0o700 });

  delete baseEnv.VIRTUAL_ENV;
  delete baseEnv.UV_CACHE_DIR;
  baseEnv.HOME = home;
  baseEnv.XDG_CACHE_HOME = resolve(home, '.cache');
  baseEnv.XDG_CONFIG_HOME = resolve(home, '.config');
  baseEnv.XDG_DATA_HOME = resolve(home, '.local/share');
  baseEnv.TMPDIR = temp;
  baseEnv.TMP = temp;
  baseEnv.TEMP = temp;
  baseEnv.BRIDGE_EXEC = '1';
  baseEnv.BRIDGE_WORKSPACE_EXEC = '1';

  return {
    workspace,
    env: baseEnv,
    cleanup() {
      rmSync(container, { recursive: true, force: true });
    }
  };
}

export async function runExecInWorkspace({ context, plan }) {
  const requestedCwd = resolve(context.workspace, plan.cwd);
  assertBridge(contained(context.workspace, requestedCwd), 'PARAMETER_DENIED', 'exec cwd escaped Run workspace');

  let realCwd;
  try {
    realCwd = realpathSync(requestedCwd);
  } catch (error) {
    throw new BridgeError('PARAMETER_DENIED', 'exec cwd does not exist', { cause: error.message });
  }
  assertBridge(
    contained(context.workspace, realCwd) && statSync(realCwd).isDirectory(),
    'PARAMETER_DENIED',
    'exec cwd must resolve to a directory inside the Run workspace'
  );

  return await runBounded({
    cwd: realCwd,
    argv: plan.argv,
    env: { ...context.env, ...(plan.env ?? {}) },
    timeoutSeconds: plan.limits.timeoutSeconds,
    stdoutBytes: plan.limits.stdoutBytes,
    stderrBytes: plan.limits.stderrBytes,
    outputBudgetBytes: plan.limits.outputBudgetBytes
  });
}
