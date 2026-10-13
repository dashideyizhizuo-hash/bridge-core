import { BridgeError } from './errors.mjs';

function replacements(resources) {
  return (resources ?? [])
    .filter(resource => resource && typeof resource.name === 'string' && typeof resource.root === 'string' && resource.root.length > 1)
    .map(resource => ({
      root: resource.root.replace(/\/+$/,''),
      marker: `<bridge-resource:${resource.name}>`
    }))
    .sort((a,b)=>b.root.length-a.root.length);
}

export function redactResourceText(value, resources) {
  if (typeof value !== 'string' || value.length === 0) return value;
  let output=value;
  for (const {root,marker} of replacements(resources)) {
    // Preset reports/stdout can contain JSON text. Match JSON.stringify's
    // escaped representation before the raw path (not arbitrary encodings).
    const jsonRoot=JSON.stringify(root).slice(1,-1);
    if(jsonRoot!==root) output=output.split(jsonRoot).join(marker);
    output=output.split(root).join(marker);
  }
  return output;
}

export function redactResourceValue(value, resources) {
  if (typeof value === 'string') return redactResourceText(value,resources);
  if (Array.isArray(value)) return value.map(item=>redactResourceValue(item,resources));
  if (value && typeof value === 'object') {
    const output={};
    for (const [key,item] of Object.entries(value)) output[key]=redactResourceValue(item,resources);
    return output;
  }
  return value;
}

export function redactBridgeError(error, resources) {
  if (!(error instanceof BridgeError)) return error;
  return new BridgeError(
    error.code,
    redactResourceText(error.message,resources),
    redactResourceValue(error.details,resources)
  );
}
