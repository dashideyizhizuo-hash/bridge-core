import { assertBridge } from '../errors.mjs';
import { GitHubRestClient } from '../github-transport.mjs';
import { GitHubDurableTaskState } from '../task-github-state.mjs';

export async function createAuthorizedTaskState({
  principal,
  repository,
  identityStore,
  credentialProvider,
  fetchImpl=globalThis.fetch,
  apiBase='https://api.github.com'
}={}) {
  assertBridge(
    identityStore &&
      typeof identityStore.assert==='function' &&
      typeof identityStore.resolve==='function',
    'TASK_RUNTIME_CONFIG_INVALID',
    'task GitHub reader requires repository authorization and installation resolution'
  );
  assertBridge(
    credentialProvider && typeof credentialProvider.acquire==='function',
    'TASK_RUNTIME_CONFIG_INVALID',
    'task GitHub reader requires a credential provider'
  );
  assertBridge(
    typeof fetchImpl==='function',
    'TASK_RUNTIME_CONFIG_INVALID',
    'task GitHub reader fetch implementation is required'
  );
  assertBridge(
    typeof principal?.githubUserId==='string' && /^[1-9][0-9]{0,31}$/.test(principal.githubUserId),
    'TASK_OWNER_MISSING',
    'durable task owner has no verified GitHub user identity'
  );
  const authorized=await identityStore.assert({
    principal,
    repository,
    permission:'read'
  });
  const resolved=await identityStore.resolve({principal,repository:authorized});
  assertBridge(
    Number.isSafeInteger(resolved?.installationId) && resolved.installationId>0,
    'GITHUB_APP_AUTHORIZATION_DENIED',
    'principal repository installation is unavailable'
  );
  const credential=await credentialProvider.acquire({
    installationId:resolved.installationId,
    repository:authorized,
    permission:'task-read'
  });
  assertBridge(
    credential &&
      typeof credential.token==='string' &&
      credential.token.length>0 &&
      credential.installationId===resolved.installationId &&
      credential.repository===authorized &&
      credential.permission==='task-read',
    'GITHUB_APP_CREDENTIAL_INVALID',
    'GitHub credential provider returned an incorrectly bound task-state credential'
  );
  return new GitHubDurableTaskState({
    github:new GitHubRestClient({
      token:credential.token,
      fetchImpl,
      apiBase
    }),
    expectedAuthorId:principal.githubUserId
  });
}
