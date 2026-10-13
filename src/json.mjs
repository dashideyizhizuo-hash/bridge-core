import { readFileSync } from 'node:fs';
import { BridgeError } from './errors.mjs';

export function parseJsonBytes(bytes, label) {
  try {
    return JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes));
  } catch (error) {
    throw new BridgeError('INVALID_JSON', `${label} is not valid JSON`, { cause: error.message });
  }
}

export function readJsonFile(path, label = path) {
  let bytes;
  try { bytes = readFileSync(path); }
  catch (error) { throw new BridgeError('FILE_READ_FAILED', `cannot read ${label}`, { path, cause: error.message }); }
  return parseJsonBytes(bytes, label);
}
