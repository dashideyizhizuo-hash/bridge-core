import { createPrivateKey, sign } from 'node:crypto';
import { assertBridge } from '../errors.mjs';

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function normalizePrivateKey(value) {
  if (value && typeof value === 'object' && value.type === 'private') return value;
  return createPrivateKey(value);
}

export function createGitHubAppJwtProvider({
  issuer,
  privateKey,
  clock = () => Date.now()
} = {}) {
  assertBridge(
    (typeof issuer === 'string' && issuer.length >= 1 && issuer.length <= 256) ||
      (Number.isSafeInteger(issuer) && issuer > 0),
    'GITHUB_APP_CONFIG_INVALID',
    'GitHub App issuer is required'
  );
  assertBridge(
    privateKey !== undefined && privateKey !== null,
    'GITHUB_APP_CONFIG_INVALID',
    'GitHub App private key is required'
  );
  assertBridge(typeof clock === 'function', 'GITHUB_APP_CONFIG_INVALID', 'clock is required');

  let key;
  try {
    key = normalizePrivateKey(privateKey);
  } catch {
    assertBridge(false, 'GITHUB_APP_CONFIG_INVALID', 'GitHub App private key is invalid');
  }

  return Object.freeze({
    async createJwt() {
      const now = Math.floor(clock() / 1000);
      const header = { alg: 'RS256', typ: 'JWT' };
      const payload = {
        iat: now - 60,
        exp: now + 9 * 60,
        iss: issuer
      };
      const encodedHeader = base64url(JSON.stringify(header));
      const encodedPayload = base64url(JSON.stringify(payload));
      const signingInput = `${encodedHeader}.${encodedPayload}`;
      const signature = sign('RSA-SHA256', Buffer.from(signingInput), key).toString('base64url');
      return `${signingInput}.${signature}`;
    }
  });
}
