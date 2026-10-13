import { assertBridge } from '../errors.mjs';

function origin(value) {
  const url=value instanceof URL ? new URL(value.href) : new URL(value);
  assertBridge(
    url.protocol==='https:',
    'DIRECT_PAIRING_CONFIG_INVALID',
    'pairing public URL must use HTTPS'
  );
  return url.origin;
}

export class DirectPairingService {
  constructor({
    codec,
    publicUrl,
    randomUUID=()=>globalThis.crypto.randomUUID()
  }={}) {
    assertBridge(
      codec &&
        typeof codec.issue==='function' &&
        typeof codec.verify==='function',
      'DIRECT_PAIRING_CONFIG_INVALID',
      'Direct pairing codec is required'
    );
    assertBridge(
      typeof randomUUID==='function',
      'DIRECT_PAIRING_CONFIG_INVALID',
      'randomUUID required'
    );
    this.codec=codec;
    this.origin=origin(publicUrl);
    this.randomUUID=randomUUID;
  }

  async create({principal,ttlSeconds=600}={}) {
    assertBridge(
      Number.isInteger(ttlSeconds) && ttlSeconds>=60 && ttlSeconds<=1800,
      'DIRECT_PAIRING_INVALID',
      'ttlSeconds must be 60-1800'
    );
    const hostId=`host-${this.randomUUID()}`;
    const issued=await this.codec.issue({
      principal,
      hostId,
      ttlSeconds
    });
    return Object.freeze({
      kind:'connect',
      hostId,
      pairingToken:issued.token,
      endpoint:`${this.origin}/mcp`,
      claimUrl:`${this.origin}/direct/enroll/claim`,
      expiresAt:issued.expiresAt
    });
  }
}
