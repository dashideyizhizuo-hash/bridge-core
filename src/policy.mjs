import { realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { assertBridge, BridgeError } from './errors.mjs';

function within(root, candidate) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

export function resolveResourceBindings({ requirements = [], repoHost }) {
  const env = {};
  const resources = [];
  for (const requirement of requirements) {
    const mapping = repoHost.resources?.[requirement.name];
    assertBridge(mapping, 'HOST_RESOURCE_DENIED', 'host resource is not granted: ' + requirement.name);
    let root;
    try {
      root = realpathSync(mapping.root);
    } catch (error) {
      throw new BridgeError('HOST_RESOURCE_DENIED', 'host resource root unavailable: ' + requirement.name, { cause: error.message });
    }
    assertBridge(statSync(root).isDirectory(), 'HOST_RESOURCE_DENIED', 'host resource root is not a directory: ' + requirement.name);
    const resolved = resolve(root);
    assertBridge(within(root, resolved), 'HOST_RESOURCE_DENIED', 'host resource escaped its root: ' + requirement.name);
    env[requirement.env] = root;
    resources.push({
      name: requirement.name,
      root,
      read: mapping.read ?? [],
      write: mapping.write ?? []
    });
  }
  return { env, resources };
}

export function resolveExecutionPlan({ request, projectPolicy, hostPolicy }) {
  const capability = projectPolicy.capabilities[request.capability];
  assertBridge(capability, 'UNKNOWN_CAPABILITY', 'capability is not authorized by trusted project policy: ' + request.capability);
  const runner = projectPolicy.runners[capability.runner];
  const repoHost = hostPolicy.repositories[request.repository];
  assertBridge(repoHost, 'HOST_RESOURCE_DENIED', 'host policy does not authorize repository: ' + request.repository);
  assertBridge(repoHost.runnerClasses.includes(runner.class), 'HOST_RESOURCE_DENIED', 'runner class is not granted by host policy: ' + runner.class);

  const bindings = resolveResourceBindings({
    requirements: capability.resources ?? [],
    repoHost
  });

  return {
    capability,
    runner: { id: capability.runner, class: runner.class },
    env: bindings.env,
    resources: bindings.resources,
    hostId: hostPolicy.host.id
  };
}
