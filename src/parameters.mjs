import { BridgeError, assertBridge } from './errors.mjs';

export function validateAndDefaultParameters(specs = {}, input = {}) {
  const output = {};
  for (const key of Object.keys(input)) assertBridge(Object.hasOwn(specs, key), 'PARAMETER_DENIED', `unknown parameter: ${key}`);
  for (const [name, spec] of Object.entries(specs)) {
    let value = input[name];
    if (value === undefined && Object.hasOwn(spec, 'default')) value = spec.default;
    if (value === undefined) {
      if (spec.required === false) continue;
      throw new BridgeError('PARAMETER_DENIED', `missing required parameter: ${name}`);
    }
    if (spec.type === 'string') {
      assertBridge(typeof value === 'string', 'PARAMETER_DENIED', `${name} must be string`);
      if (spec.minLength !== undefined) assertBridge(value.length >= spec.minLength, 'PARAMETER_DENIED', `${name} too short`);
      if (spec.maxLength !== undefined) assertBridge(value.length <= spec.maxLength, 'PARAMETER_DENIED', `${name} too long`);
      if (spec.pattern !== undefined) assertBridge(new RegExp(spec.pattern).test(value), 'PARAMETER_DENIED', `${name} does not match required pattern`);
    } else if (spec.type === 'integer') {
      assertBridge(Number.isInteger(value), 'PARAMETER_DENIED', `${name} must be integer`);
      if (spec.minimum !== undefined) assertBridge(value >= spec.minimum, 'PARAMETER_DENIED', `${name} below minimum`);
      if (spec.maximum !== undefined) assertBridge(value <= spec.maximum, 'PARAMETER_DENIED', `${name} above maximum`);
    } else if (spec.type === 'boolean') assertBridge(typeof value === 'boolean', 'PARAMETER_DENIED', `${name} must be boolean`);
    output[name] = value;
  }
  return output;
}

export function interpolateArgv(argv, params) {
  return argv.map((arg) => arg.replace(/\{params\.([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => {
    assertBridge(Object.hasOwn(params, name), 'PARAMETER_DENIED', `argv references missing parameter: ${name}`);
    return String(params[name]);
  }));
}
