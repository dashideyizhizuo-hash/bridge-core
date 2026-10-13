export class BridgeError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.details = details;
  }
}

export function assertBridge(condition, code, message, details = undefined) {
  if (!condition) throw new BridgeError(code, message, details);
}

export function errorEnvelope(error) {
  if (error instanceof BridgeError) {
    return { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
  }
  return { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) };
}
