import { assertBridge } from '../errors.mjs';

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRIDGE_PERMISSIONS = new Set(['read', 'run', 'publish', 'task-read']);
const LEVEL = Object.freeze({ read: 1, write: 2 });
const PERMISSION_PROFILES = Object.freeze({
  read: Object.freeze({ contents: 'read', actions: 'read' }),
  run: Object.freeze({ contents: 'write', actions: 'write' }),
  publish: Object.freeze({ contents: 'write', actions: 'write' }),
  'task-read': Object.freeze({ contents: 'read', issues: 'read' })
});

function installationId(value) {
  assertBridge(
    Number.isSafeInteger(value) && value > 0,
    'GITHUB_APP_CREDENTIAL_INVALID',
    'installationId must be a positive integer'
  );
  return value;
}

function repositoryName(value) {
  assertBridge(
    typeof value === 'string' && REPOSITORY_PATTERN.test(value),
    'GITHUB_APP_CREDENTIAL_INVALID',
    'repository must be owner/name'
  );
  return value;
}

function bridgePermission(value) {
  assertBridge(
    BRIDGE_PERMISSIONS.has(value),
    'GITHUB_APP_CREDENTIAL_INVALID',
    `unknown Bridge repository permission: ${value}`
  );
  return value;
}

function requiredPermissions(permission) {
  return { ...PERMISSION_PROFILES[bridgePermission(permission)] };
}

function assertReturnedPermissions(actual, required) {
  assertBridge(
    actual && typeof actual === 'object' && !Array.isArray(actual),
    'GITHUB_APP_CREDENTIAL_INVALID',
    'installation token response omitted permissions'
  );
  for (const [name, level] of Object.entries(required)) {
    const actualLevel = actual[name];
    assertBridge(
      LEVEL[actualLevel] >= LEVEL[level],
      'GITHUB_APP_AUTHORIZATION_DENIED',
      `GitHub App installation token lacks required ${name} permission`
    );
  }
}

function assertRepositoryScope(repositories, repository) {
  if (repositories === undefined || repositories === null) return;
  assertBridge(
    Array.isArray(repositories),
    'GITHUB_APP_CREDENTIAL_INVALID',
    'installation token repository scope is invalid'
  );
  const allowed = repositories.some(item => item?.full_name === repository);
  assertBridge(
    allowed,
    'GITHUB_APP_AUTHORIZATION_DENIED',
    `GitHub App installation token does not include repository: ${repository}`
  );
}

export class GitHubAppCredentialProvider {
  constructor({
    installations,
    clock = () => Date.now(),
    refreshSkewMs = 5 * 60 * 1000
  } = {}) {
    assertBridge(
      installations &&
        typeof installations.getInstallation === 'function' &&
        typeof installations.getRepositoryInstallation === 'function' &&
        typeof installations.createInstallationToken === 'function',
      'GITHUB_APP_CONFIG_INVALID',
      'GitHub App installation client is required'
    );
    assertBridge(typeof clock === 'function', 'GITHUB_APP_CONFIG_INVALID', 'clock is required');
    assertBridge(
      Number.isSafeInteger(refreshSkewMs) && refreshSkewMs >= 0,
      'GITHUB_APP_CONFIG_INVALID',
      'refreshSkewMs must be a non-negative integer'
    );
    this.installations = installations;
    this.clock = clock;
    this.refreshSkewMs = refreshSkewMs;
    this.cache = new Map();
  }

  async #assertInstallationScope(id, repository) {
    const installation = await this.installations.getInstallation(id);
    assertBridge(
      installation && installation.id === id,
      'GITHUB_APP_AUTHORIZATION_DENIED',
      'GitHub App installation is unavailable'
    );
    assertBridge(
      installation.suspended_at === null || installation.suspended_at === undefined,
      'GITHUB_APP_AUTHORIZATION_DENIED',
      'GitHub App installation is suspended'
    );

    const repositoryInstallation = await this.installations.getRepositoryInstallation(repository);
    assertBridge(
      repositoryInstallation && repositoryInstallation.id === id,
      'GITHUB_APP_AUTHORIZATION_DENIED',
      `repository is not authorized by GitHub App installation: ${repository}`
    );
    assertBridge(
      repositoryInstallation.suspended_at === null || repositoryInstallation.suspended_at === undefined,
      'GITHUB_APP_AUTHORIZATION_DENIED',
      'GitHub App repository installation is suspended'
    );
  }

  async acquire({ installationId: value, repository, permission } = {}) {
    const id = installationId(value);
    const repo = repositoryName(repository);
    const requestedPermission = bridgePermission(permission);
    const permissions = requiredPermissions(requestedPermission);

    // Revalidate installation and repository scope on every request so suspension,
    // revocation or repository removal cannot be hidden by a cached token.
    await this.#assertInstallationScope(id, repo);

    const cacheKey = `${id}:${repo}:${requestedPermission}`;
    const cached = this.cache.get(cacheKey);
    const now = this.clock();
    if (cached && cached.expiresAtMs - now > this.refreshSkewMs) {
      return cached.credential;
    }

    const issued = await this.installations.createInstallationToken({
      installationId: id,
      repository: repo,
      permissions
    });

    assertBridge(
      issued && typeof issued.token === 'string' && issued.token.length > 0,
      'GITHUB_APP_CREDENTIAL_INVALID',
      'GitHub App installation token response is invalid'
    );
    const expiresAtMs = Date.parse(issued.expires_at);
    assertBridge(
      Number.isFinite(expiresAtMs) && expiresAtMs > now,
      'GITHUB_APP_CREDENTIAL_INVALID',
      'GitHub App installation token expiry is invalid'
    );
    assertReturnedPermissions(issued.permissions, permissions);
    assertRepositoryScope(issued.repositories, repo);

    const credential = Object.freeze({
      token: issued.token,
      expiresAt: new Date(expiresAtMs).toISOString(),
      installationId: id,
      repository: repo,
      permission: requestedPermission
    });
    this.cache.set(cacheKey, { credential, expiresAtMs });
    return credential;
  }
}

export function githubPermissionsForBridgePermission(permission) {
  return requiredPermissions(permission);
}
