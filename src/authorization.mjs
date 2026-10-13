import { assertBridge } from './errors.mjs';

const PERMISSIONS = new Set(['read','run','publish']);
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function repositoryName(value) {
  assertBridge(
    typeof value === 'string' && REPOSITORY_PATTERN.test(value),
    'REPOSITORY_AUTHORIZATION_INVALID',
    'repository must be owner/name'
  );
  return value;
}

function permissionName(value) {
  assertBridge(
    PERMISSIONS.has(value),
    'REPOSITORY_AUTHORIZATION_INVALID',
    `unknown repository permission: ${value}`
  );
  return value;
}

export class RepositoryAuthorizer {
  constructor({ check }) {
    assertBridge(
      typeof check === 'function',
      'REPOSITORY_AUTHORIZATION_INVALID',
      'authorization check is required'
    );
    this.check = check;
  }

  async assertRepository(repository, permission) {
    const repo = repositoryName(repository);
    const requestedPermission = permissionName(permission);
    const allowed = await this.check({ repository: repo, permission: requestedPermission });
    assertBridge(
      allowed === true,
      'REPOSITORY_DENIED',
      `${requestedPermission} access denied for repository: ${repo}`
    );
    return repo;
  }
}

export function createStaticRepositoryAuthorizer({ read = [], run = [], publish = [] } = {}) {
  const grants = {
    read: new Set(read),
    run: new Set(run),
    publish: new Set(publish)
  };
  return new RepositoryAuthorizer({
    check: ({ repository, permission }) => grants[permission].has(repository)
  });
}
