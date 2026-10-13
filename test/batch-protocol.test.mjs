import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BATCH_LIMITS, validateBatchRequest, validateExecParameters, validateRequest, validateEditRequest } from '../src/validate.mjs';
import { MCP_TOOL_DEFINITIONS } from '../src/mcp-tools.mjs';

const identity = () => ({schemaVersion: 1, requestId: 'batch-request-0001', repository: 'owner/project', target: {ref: 'agent/task', sha: 'a'.repeat(40)}, policy: {ref: 'main', sha: 'b'.repeat(40)}});
const exec = (id = 'status') => ({id, type: 'exec', argv: ['git', 'status', '--short']});
const operation = () => ({type: 'replace-exact', path: 'src/example.py', oldText: 'return 1', newText: 'return 2'});
const request = (steps = [exec()]) => ({...identity(), mode: 'batch', steps});
const reject = value => assert.throws(() => validateBatchRequest(value), error => error.code === 'INVALID_REQUEST');

test('batch contract accepts ordered exec, preset and existing edit operations without mutating input', () => {
  const input = {...request([exec(), {id: 'inspect', type: 'preset', capability: 'dataset-inspect', parameters: {dataset_id: 'example'}}, {id: 'change', type: 'edit', operations: [operation()]}, {id: 'verify', type: 'preset', capability: 'verify-offline'}]), commitSubject: 'Fix example'};
  const before = JSON.stringify(input);
  assert.equal(validateBatchRequest(input), input);
  assert.equal(JSON.stringify(input), before);
});

test('batch preflight rejects empty, oversized, duplicate or invalid step identities', () => {
  for (const steps of [[], Array.from({length: 17}, (_, i) => exec(`step${i}`)), [exec(), exec()], [exec('../host')], [exec('a'.repeat(65))], [null]]) reject(request(steps));
  assert.equal(validateBatchRequest(request(Array.from({length: 16}, (_, i) => exec(`step${i}`)))).steps.length, 16);
});

test('batch cannot mix request modes, select extra authority or introduce an orchestrator', () => {
  for (const extra of [{mode: 'edit'}, {schemaVersion: 2}, {capability: 'dataset-status'}, {operations: []}, {policySha: 'c'.repeat(40)}, {runner: 'root'}, {publish: true}, {continueOnError: true}]) reject({...request(), ...extra});
  for (const type of ['publish', 'shell', 'verify', 'loop', 'parallel']) reject(request([{id: 'no', type}]));
  for (const extra of [{shell: 'true'}, {env: {TOKEN: 'no'}}, {when: 'always'}, {dependsOn: ['x']}, {outputPath: '/tmp/private'}]) reject(request([{...exec(), ...extra}]));
  reject({...request(), target: {ref: 'main', sha: 'A'.repeat(40)}});
  reject({...request(), policy: {ref: 'main', sha: 'b'.repeat(40), hostPath: '/etc'}});
});

test('exec rejects escaping paths, shell strings, invalid argv and excess UTF-8 bytes', () => {
  for (const cwd of ['/etc', '../host', 'src/../../host', 'C:/host', 'C:\\host', './src', 'src\0x', 'src\nx', '']) reject(request([{...exec(), cwd}]));
  for (const argv of ['git status', [], [''], ['ok\0no'], Array(65).fill('a'), ['汉'.repeat(1366)], Array(9).fill('x'.repeat(4096))]) reject(request([{...exec(), argv}]));
  validateBatchRequest(request([{...exec(), cwd: 'src', argv: ['x'.repeat(4096)]}]));
});

test('resources are logical, bounded, unique names; timeout can only request a bounded duration', () => {
  validateBatchRequest(request([{...exec(), resources: ['cql-data'], timeoutSeconds: 1}]));
  for (const resources of [['/data/cql'], ['../data'], ['C:\\data'], ['cql-data', 'cql-data'], Array.from({length: 17}, (_, i) => `data-${i}`), [{name: 'data', root: '/data'}]]) reject(request([{...exec(), resources}]));
  for (const timeoutSeconds of [0, -1, 3601, 0.5, '10']) reject(request([{...exec(), timeoutSeconds}]));
  assert.throws(() => validateExecParameters({argv: ['pwd'], resources: []}, {allowResources: false, code: 'PARAMETER_DENIED'}), error => error.code === 'PARAMETER_DENIED');
});

test('preset has no caller command, resource or environment override', () => {
  const preset = {id: 'data', type: 'preset', capability: 'dataset-status'};
  validateBatchRequest(request([preset]));
  for (const extra of [{argv: ['id']}, {resources: ['data']}, {env: {DATA: '/data'}}, {parameters: []}, {capability: '/data'}]) reject(request([{...preset, ...extra}]));
});

test('edit requires subject and existing safe operations, with one total operation budget', () => {
  const edit = {id: 'edit', type: 'edit', operations: [operation()]};
  reject(request([edit]));
  reject({...request(), commitSubject: 'No edits'});
  for (const commitSubject of ['x', 'bad\nsubject', 'bad\0subject']) reject({...request([edit]), commitSubject});
  for (const operations of [[], [{...operation(), path: '../host'}], [{...operation(), type: 'write-file'}], [{...operation(), root: '/data'}]]) reject({...request([{...edit, operations}]), commitSubject: 'Fix example'});
  reject({...request([{...edit, operations: Array.from({length: 33}, operation)}, {...edit, id: 'edit2', operations: Array.from({length: 32}, operation)}]), commitSubject: 'Fix example'});
});

test('batch has a whole-request byte budget even when individual fields are valid', () => {
  reject(request([{id: 'preset', type: 'preset', capability: 'dataset-inspect', parameters: {data: 'x'.repeat(BATCH_LIMITS.requestBytes)}}]));
  const parameters = {}; parameters.self = parameters;
  reject(request([{id: 'preset', type: 'preset', capability: 'dataset-inspect', parameters}]));
});

test('legacy capability/edit envelopes remain unchanged while task transition is additive', () => {
  const capability = {...identity(), capability: 'dataset-inspect', parameters: {dataset_id: 'example'}};
  const edit = {...identity(), operations: [operation()], verification: [{capability: 'verify-offline', parameters: {}}], commitSubject: 'Fix example'};
  assert.equal(validateRequest(capability), capability);
  assert.equal(validateEditRequest(edit), edit);
  assert.deepEqual(MCP_TOOL_DEFINITIONS.map(tool => tool.name), ['bridge.discover', 'bridge.run', 'bridge.get_run', 'bridge.get_result', 'bridge.publish', 'bridge.task_transition']);
  assert.deepEqual(MCP_TOOL_DEFINITIONS.find(tool => tool.name === 'bridge.publish').inputSchema.required, ['runId']);
});

test('published schemas lock request/result version, step bounds and terminal statuses', () => {
  const load = name => JSON.parse(readFileSync(new URL(`../schemas/${name}.schema.json`, import.meta.url), 'utf8'));
  const req = load('batch-request'), res = load('batch-result');
  assert.equal(req.additionalProperties, false);
  assert.equal(req.properties.schemaVersion.const, 1);
  assert.equal(req.properties.mode.const, 'batch');
  assert.equal(req.properties.steps.maxItems, BATCH_LIMITS.steps);
  assert.equal(req.$defs.exec.properties.resources.maxItems, BATCH_LIMITS.resources);
  assert.equal(res.properties.mode.const, 'batch');
  assert.deepEqual(res.properties.status.enum, ['SUCCEEDED', 'VERIFIED', 'FAILED', 'DENIED', 'STALE', 'CANCELED']);
  assert.equal(res.$defs.stepResult.properties.status.enum.at(-1), 'SKIPPED');
  assert.ok(res.allOf[0].then.required.includes('candidateSha'));
});
