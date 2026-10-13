import { assertBridge, BridgeError } from '../errors.mjs';

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function installationId(value) {
  assertBridge(
    Number.isSafeInteger(value) && value > 0,
    'GITHUB_APP_CONFIG_INVALID',
    'installationId must be a positive integer'
  );
  return value;
}

function repositoryName(value) {
  assertBridge(
    typeof value === 'string' && REPOSITORY_PATTERN.test(value),
    'GITHUB_APP_CONFIG_INVALID',
    'repository must be owner/name'
  );
  return value;
}

function permissionsObject(value) {
  assertBridge(
    value && typeof value === 'object' && !Array.isArray(value),
    'GITHUB_APP_CONFIG_INVALID',
    'GitHub App permissions must be an object'
  );
  return value;
}

export class GitHubAppInstallationClient {
  constructor({
    jwtProvider,
    fetchImpl = globalThis.fetch,
    apiBase = 'https://api.github.com',
    apiVersion = '2022-11-28',
    userAgent = 'runner-bridge'
  } = {}) {
    assertBridge(
      jwtProvider && typeof jwtProvider.createJwt === 'function',
      'GITHUB_APP_CONFIG_INVALID',
      'GitHub App JWT provider is required'
    );
    assertBridge(typeof fetchImpl === 'function', 'GITHUB_APP_CONFIG_INVALID', 'fetch implementation is required');
    assertBridge(typeof apiBase === 'string' && apiBase.length > 0, 'GITHUB_APP_CONFIG_INVALID', 'apiBase is required');
    assertBridge(typeof apiVersion === 'string' && apiVersion.length > 0, 'GITHUB_APP_CONFIG_INVALID', 'apiVersion is required');
    this.jwtProvider = jwtProvider;
    this.fetchImpl = fetchImpl;
    this.apiBase = apiBase.replace(/\/$/, '');
    this.apiVersion = apiVersion;
    assertBridge(
      typeof userAgent === 'string' &&
        /^[\x20-\x7E]{1,256}$/.test(userAgent),
      'GITHUB_APP_CONFIG_INVALID',
      'GitHub User-Agent is invalid'
    );
    this.userAgent = userAgent;
  }

  async #request(method, path, { body } = {}) {
    const jwt = await this.jwtProvider.createJwt();
    assertBridge(typeof jwt === 'string' && jwt.length > 0, 'GITHUB_APP_CREDENTIAL_INVALID', 'GitHub App JWT provider returned an invalid token');

    const response = await this.fetchImpl(new URL(path, this.apiBase), {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${jwt}`,
        'X-GitHub-Api-Version': this.apiVersion,
        'User-Agent': this.userAgent,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });

    if (response.status === 204) return null;

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }

    if (!response.ok) {
      throw new BridgeError(
        'GITHUB_APP_API_ERROR',
        `GitHub App API ${method} ${path} failed with HTTP ${response.status}`,
        { status: response.status }
      );
    }
    return data;
  }

  async getInstallation(value) {
    const id = installationId(value);
    return this.#request('GET', `/app/installations/${id}`);
  }

  async getRepositoryInstallation(repository) {
    const repo = repositoryName(repository);
    return this.#request('GET', `/repos/${repo}/installation`);
  }

  async createInstallationToken({ installationId: value, repository, permissions } = {}) {
    const id = installationId(value);
    const repo = repositoryName(repository);
    const [, name] = repo.split('/');
    return this.#request('POST', `/app/installations/${id}/access_tokens`, {
      body: {
        repositories: [name],
        permissions: permissionsObject(permissions)
      }
    });
  }
}
