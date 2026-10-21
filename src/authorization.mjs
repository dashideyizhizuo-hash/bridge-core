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
  constructor({ check, list }) {
    assertBridge(
      typeof check === 'function',
      'REPOSITORY_AUTHORIZATION_INVALID',
      'authorization check is required'
    );
    assertBridge(list===undefined || typeof list==='function',
      'REPOSITORY_AUTHORIZATION_INVALID','repository inventory hook must be a function');
    this.check = check;
    this.list = list;
  }

  async listRepositories() {
    if(this.list===undefined)return [];
    const repositories=await this.list();
    assertBridge(Array.isArray(repositories)&&repositories.length<=17,
      'REPOSITORY_AUTHORIZATION_INVALID','repository inventory must contain at most 17 entries');
    const names=[...new Set(repositories.map(repositoryName))].sort();
    for(const repository of names)await this.assertRepository(repository,'read');
    return names;
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
    check: ({ repository, permission }) => grants[permission].has(repository),
    // The extra entry is a sentinel: the catalog rejects all presets when
    // more than sixteen repositories are configured, never a truncated subset.
    list: () => [...grants.read].sort().slice(0,17)
  });
}
