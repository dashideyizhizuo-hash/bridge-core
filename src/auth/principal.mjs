import { assertBridge } from '../errors.mjs';

function boundedString(value, label, maximum = 256) {
  assertBridge(
    typeof value === 'string' && value.length >= 1 && value.length <= maximum,
    'AUTHENTICATION_INVALID',
    `${label} must be a non-empty string no longer than ${maximum} characters`
  );
  return value;
}

function normalizeGitHubUserId(value) {
  if (value === undefined || value === null) return null;
  if (Number.isSafeInteger(value) && value > 0) return String(value);
  assertBridge(
    typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value),
    'AUTHENTICATION_INVALID',
    'githubUserId is invalid'
  );
  return value;
}

export function createBridgePrincipal({
  bridgeUserId,
  externalProvider,
  externalSubject,
  githubUserId
} = {}) {
  const principal = {
    bridgeUserId: boundedString(bridgeUserId, 'bridgeUserId', 128),
    externalProvider: boundedString(externalProvider, 'externalProvider', 128),
    externalSubject: boundedString(externalSubject, 'externalSubject', 256)
  };
  const linkedGitHubUserId = normalizeGitHubUserId(githubUserId);
  if (linkedGitHubUserId !== null) principal.githubUserId = linkedGitHubUserId;
  return Object.freeze(principal);
}

export function assertAuthenticatedPrincipal(value) {
  assertBridge(
    value && typeof value === 'object' && !Array.isArray(value),
    'AUTHENTICATION_REQUIRED',
    'authenticated Bridge principal required'
  );
  return createBridgePrincipal(value);
}
