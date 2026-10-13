import { cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { BridgeError, assertBridge } from './errors.mjs';

function contained(root, target) { return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep); }
function safeExisting(workspace, rel) {
  const raw = resolve(workspace, rel);
  assertBridge(contained(workspace, raw), 'EVIDENCE_INVALID', `output path escapes workspace: ${rel}`);
  let real;
  try { real = realpathSync(raw); } catch (error) { throw new BridgeError('EVIDENCE_INVALID', `declared output does not exist: ${rel}`, { cause: error.message }); }
  assertBridge(contained(workspace, real), 'EVIDENCE_INVALID', `output resolves outside workspace: ${rel}`);
  assertBridge(!lstatSync(raw).isSymbolicLink(), 'EVIDENCE_INVALID', `symlink output denied: ${rel}`);
  return real;
}
function walk(root, current = root, list = []) {
  for (const name of readdirSync(current)) {
    const path = join(current, name); const st = lstatSync(path);
    if (st.isSymbolicLink()) throw new BridgeError('EVIDENCE_INVALID', `symlink artifact denied: ${relative(root,path)}`);
    if (st.isDirectory()) walk(root, path, list); else if (st.isFile()) list.push(path); else throw new BridgeError('EVIDENCE_INVALID', `non-regular artifact denied: ${relative(root,path)}`);
  }
  return list;
}

export function collectOutputs({ workspace, outputs = {}, limits, outputDir }) {
  const result = { report: undefined, artifacts: [] };
  mkdirSync(outputDir, { recursive: true });
  if (outputs.report) {
    const path = safeExisting(workspace, outputs.report);
    const st = statSync(path); assertBridge(st.isFile(), 'EVIDENCE_INVALID', 'report must be regular file');
    assertBridge(st.size <= limits.reportBytes, 'OUTPUT_LIMIT_EXCEEDED', 'structured report exceeds configured size');
    const bytes = readFileSync(path); result.report = { path: outputs.report, bytes: st.size, content: bytes.toString('utf8') };
  }
  let total = 0;
  for (const pattern of outputs.artifacts ?? []) {
    const relRoot = pattern.endsWith('/**') ? pattern.slice(0,-3) : pattern;
    const path = safeExisting(workspace, relRoot);
    const files = statSync(path).isDirectory() ? walk(path) : [path];
    for (const file of files) {
      const st = statSync(file); total += st.size;
      assertBridge(total <= limits.artifactBytes, 'OUTPUT_LIMIT_EXCEEDED', 'artifact bytes exceed configured limit');
      const rel = statSync(path).isDirectory() ? join(relRoot, relative(path,file)) : relRoot;
      const dest = resolve(outputDir, 'artifacts', rel);
      assertBridge(contained(resolve(outputDir, 'artifacts'), dest), 'EVIDENCE_INVALID', 'artifact destination escaped staging root');
      mkdirSync(dirname(dest), { recursive: true }); cpSync(file, dest);
      result.artifacts.push({ path: rel.split(sep).join('/'), bytes: st.size, staged: relative(outputDir,dest).split(sep).join('/') });
    }
  }
  return result;
}
