import { assertBridge } from './errors.mjs';
import { RepositoryAuthorizer } from './authorization.mjs';
import { BridgeGateway } from './gateway.mjs';
import {
  GitHubRestClient,
  GitHubTransport,
  parseRunId
} from './github-transport.mjs';
import { assertAuthenticatedPrincipal } from './auth/principal.mjs';

const PERMISSIONS = new Set(['read', 'run', 'publish']);

function permissionName(value) {
  assertBridge(
    PERMISSIONS.has(value),
    'CONTROL_PLANE_CONFIG_INVALID',
    `unknown repository permission: ${value}`
  );
  return value;
}

function installationId(value) {
  assertBridge(
    Number.isSafeInteger(value) && value > 0,
    'GITHUB_APP_AUTHORIZATION_DENIED',
    'principal repository installation is unavailable'
  );
  return value;
}

function assertPrincipalRepositoryAuthorizer(value) {
  assertBridge(
    value && typeof value.assert === 'function',
    'CONTROL_PLANE_CONFIG_INVALID',
    'principal repository authorizer is required'
  );
  return value;
}

function assertInstallationResolver(value) {
  assertBridge(
    value && typeof value.resolve === 'function',
    'CONTROL_PLANE_CONFIG_INVALID',
    'principal installation resolver is required'
  );
  return value;
}

function assertCredentialProvider(value) {
  assertBridge(
    value && typeof value.acquire === 'function',
    'CONTROL_PLANE_CONFIG_INVALID',
    'GitHub credential provider is required'
  );
  return value;
}

function exactRepositoryAuthorizer(repository, permission) {
  return new RepositoryAuthorizer({
    check: ({ repository: candidateRepository, permission: candidatePermission }) =>
      candidateRepository === repository && candidatePermission === permission
  });
}

function transportOptions({
  runWorkflow,
  publishWorkflow,
  pollIntervalMs,
  publishTimeoutMs,
  sleep
} = {}) {
  return {
    ...(runWorkflow === undefined ? {} : { runWorkflow }),
    ...(publishWorkflow === undefined ? {} : { publishWorkflow }),
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
    ...(publishTimeoutMs === undefined ? {} : { publishTimeoutMs }),
    ...(sleep === undefined ? {} : { sleep })
  };
}

export class RequestScopedGitHubTransport {
  constructor({
    principal,
    principalRepositoryAuthorizer,
    installationResolver,
    credentialProvider,
    fetchImpl = globalThis.fetch,
    apiBase = 'https://api.github.com',
    githubTransportOptions,
    taskLeaseValidator = null
  } = {}) {
    this.principal = assertAuthenticatedPrincipal(principal);
    this.principalRepositoryAuthorizer = assertPrincipalRepositoryAuthorizer(
      principalRepositoryAuthorizer
    );
    this.installationResolver = assertInstallationResolver(installationResolver);
    this.credentialProvider = assertCredentialProvider(credentialProvider);
    assertBridge(
      typeof fetchImpl === 'function',
      'CONTROL_PLANE_CONFIG_INVALID',
      'GitHub fetch implementation is required'
    );
    assertBridge(
      typeof apiBase === 'string' && apiBase.length > 0,
      'CONTROL_PLANE_CONFIG_INVALID',
      'GitHub API base is required'
    );
    this.fetchImpl = fetchImpl;
    this.apiBase = apiBase;
    this.githubTransportOptions = transportOptions(githubTransportOptions);
    this.taskLeaseValidator = taskLeaseValidator;
  }

  async #transportFor(repository, permission) {
    const requestedPermission = permissionName(permission);

    // Principal authorization is deliberately first. No installation lookup,
    // credential acquisition or repository GitHub API request may happen before it.
    const repo = await this.principalRepositoryAuthorizer.assert({
      principal: this.principal,
      repository,
      permission: requestedPermission
    });

    const resolved = await this.installationResolver.resolve({
      principal: this.principal,
      repository: repo
    });
    const resolvedInstallationId = installationId(resolved?.installationId);

    const credential = await this.credentialProvider.acquire({
      installationId: resolvedInstallationId,
      repository: repo,
      permission: requestedPermission
    });
    assertBridge(
      credential &&
        typeof credential.token === 'string' &&
        credential.token.length > 0 &&
        credential.installationId === resolvedInstallationId &&
        credential.repository === repo &&
        credential.permission === requestedPermission,
      'GITHUB_APP_CREDENTIAL_INVALID',
      'GitHub credential provider returned an incorrectly bound credential'
    );

    const github = new GitHubRestClient({
      token: credential.token,
      fetchImpl: this.fetchImpl,
      apiBase: this.apiBase
    });
    return new GitHubTransport({
      github,
      authorizer: exactRepositoryAuthorizer(repo, requestedPermission),
      ...this.githubTransportOptions,
      taskLeaseValidator:this.taskLeaseValidator
    });
  }

  async resolveRepository(repository) {
    return (await this.#transportFor(repository, 'read')).resolveRepository(repository);
  }

  async resolveTarget(repository, target) {
    return (await this.#transportFor(repository, 'read')).resolveTarget(repository, target);
  }

  async readProjectPolicy(repository, policySha) {
    return (await this.#transportFor(repository, 'read')).readProjectPolicy(repository, policySha);
  }

  async submitCapabilityRequest(request) {
    return (await this.#transportFor(request?.repository, 'run')).submitCapabilityRequest(request);
  }

  async submitEditRequest(request) {
    return (await this.#transportFor(request?.repository, 'run')).submitEditRequest(request);
  }

  async submitBatchRequest(request) {
    return (await this.#transportFor(request?.repository, 'run')).submitBatchRequest(request);
  }

  async getRun(runId) {
    const { repository } = parseRunId(runId);
    return (await this.#transportFor(repository, 'read')).getRun(runId);
  }

  async getResult(runId) {
    const { repository } = parseRunId(runId);
    return (await this.#transportFor(repository, 'read')).getResult(runId);
  }

  async publishVerified({ run, result }) {
    const { repository } = parseRunId(run?.runId);
    return (await this.#transportFor(repository, 'publish')).publishVerified({ run, result });
  }
}

export function createRequestScopedGateway(options = {}) {
  return new BridgeGateway({
    transport: new RequestScopedGitHubTransport(options),
    ...(options.directExec === undefined ? {} : {directExec:options.directExec}),
    ...(options.directAssets === undefined ? {} : {directAssets:options.directAssets}),
    ...(options.directPairing === undefined ? {} : {directPairing:options.directPairing}),
    ...(options.principal === undefined ? {} : {principal:options.principal}),
    ...(options.taskContext === undefined ? {} : {taskContext:options.taskContext}),
    ...(options.taskLifecycle === undefined ? {} : {taskLifecycle:options.taskLifecycle}),
    ...(options.taskActivity === undefined ? {} : {taskActivity:options.taskActivity})
  });
}
