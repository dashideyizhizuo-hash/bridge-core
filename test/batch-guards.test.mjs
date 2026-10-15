import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {makeTestDirectory as mkdtempSync} from './helpers/canonical-temp.mjs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { performance } from 'node:perf_hooks';
import { executeRequest } from '../src/runtime.mjs';
import { BATCH_LIMITS } from '../src/validate.mjs';

const repository = 'example/project';
function git(repo, ...args) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function fixture(t, { project = {}, host = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-batch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), out = join(root, 'out'), hostPath = join(root, 'host.json');
  mkdirSync(join(repo, '.bridge'), { recursive: true });
  writeFileSync(join(repo, 'tracked.txt'), 'original');
  const projectPolicy = { version: 1, project: { repository }, runners: { local: { class: 'test-runner' } }, capabilities: {}, workspaceExec: { enabled: true, runner: 'local', maxSeconds: 40, stdoutBytes: 4096, stderrBytes: 4096 }, ...project };
  const hostPolicy = { version: 1, host: { id: 'test-host' }, repositories: { [repository]: { runnerClasses: ['test-runner'], resources: {}, workspaceExec: { enabled: true, runnerClass: 'test-runner', serviceUser: userInfo().username, maxSeconds: 10, stdoutBytes: 4096, stderrBytes: 4096 }, ...host } } };
  writeFileSync(join(repo, '.bridge/project.json'), JSON.stringify(projectPolicy));
  writeFileSync(hostPath, JSON.stringify(hostPolicy));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Bridge Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'fixture');
  const sha = git(repo, 'rev-parse', 'HEAD');
  const requestPath = join(repo, '.bridge/request.json');
  const save = (steps, extra = {}) => {
    const request = { schemaVersion: 1, mode: 'batch', requestId: 'batch-test-0001', repository, target: { ref: 'main', sha }, policy: { ref: 'main', sha }, steps, ...extra };
    writeFileSync(requestPath, JSON.stringify(request));
    return request;
  };
  const run = async (steps, extra) => { save(steps, extra); return executeRequest({ requestPath, repoPath: repo, hostPolicyPath: hostPath, outputDir: out }); };
  return { root, repo, out, sha, hostPath, requestPath, projectPolicy, hostPolicy, save, run };
}
const exec = (id, code, extra = {}) => ({ id, type: 'exec', argv: [process.execPath, '-e', code], ...extra });
const success = id => exec(id, "process.stdout.write('ok')");
const mark = () => exec('first', "require('fs').writeFileSync('marker','ran')");
const states = result => result.steps.map(step => step.status);

test('nonzero exit preserves prior output and failing stdout/stderr, skips suffix', async t => {
  const s = fixture(t);
  const result = await s.run([success('ok'), exec('bad', "process.stdout.write('partial'); process.stderr.write('reason'); process.exitCode=7"), mark()]);
  assert.equal(result.status, 'FAILED');
  assert.deepEqual(states(result), ['SUCCEEDED', 'FAILED', 'SKIPPED']);
  assert.equal(result.steps[0].evidence.stdout, 'ok');
  assert.deepEqual(result.steps[1].evidence, { stdout: 'partial', stderr: 'reason' });
  assert.equal(result.steps[1].execution.exitCode, 7);
  assert.equal(result.steps[2].durationMs, 0);
  assert.equal(existsSync(join(s.repo, 'marker')), false);
});

test('invalid UTF-8 is an execution failure, preserves valid evidence, and stops the batch', async t => {
  const s = fixture(t);
  const result = await s.run([success('ok'), exec('encoding', "process.stdout.write(Buffer.from([0xd6,0xd0]));process.stderr.write('中文诊断');"), mark()]);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.error.code, 'OUTPUT_ENCODING_INVALID');
  assert.deepEqual(states(result), ['SUCCEEDED', 'FAILED', 'SKIPPED']);
  assert.deepEqual(result.steps[1].evidence, {stdout: '', stderr: '中文诊断'});
});

test('spawn failure and invalid cwd return structured errors and stop', async t => {
  for (const bad of [{ id: 'bad', type: 'exec', argv: ['bridge-executable-does-not-exist'] }, { ...success('bad'), cwd: 'missing' }]) {
    const s = fixture(t); const result = await s.run([bad, mark()]);
    assert.notEqual(result.status, 'SUCCEEDED');
    assert.equal(result.steps[1].status, 'SKIPPED');
    assert.equal(existsSync(join(s.repo, 'marker')), false);
    assert.equal(JSON.stringify(result).includes(s.root), false);
  }
});

test('cwd is resolved at each step: created subdirectory works; symlink escape is denied', async t => {
  const s = fixture(t);
  const result = await s.run([
    exec('make', "require('fs').mkdirSync('later'); require('fs').writeFileSync('later/file','new')"),
    exec('read', "process.stdout.write(require('fs').readFileSync('file','utf8'))", { cwd: 'later' }),
    exec('escape', "require('fs').symlinkSync(require('path').resolve('..'),'escape',process.platform==='win32'?'junction':'dir')"),
    { ...success('outside'), cwd: 'escape' }, mark()
  ]);
  assert.equal(result.steps[1].evidence.stdout, 'new');
  assert.equal(result.status, 'DENIED');
  assert.deepEqual(states(result), ['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED', 'DENIED', 'SKIPPED']);
  assert.equal(existsSync(join(s.repo, 'marker')), false);
});

test('credentials and host cache paths are absent; ephemeral HOME is removed after failure', async t => {
  const s = fixture(t);
  const keys = ['GITHUB_TOKEN', 'AGENT_JOB_WRITE_TOKEN', 'UV_CACHE_DIR', 'VIRTUAL_ENV'];
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const key of keys) process.env[key] = 'not-for-target-code';
  try {
    const result = await s.run([
      exec('env', `process.stdout.write(JSON.stringify({home:process.env.HOME,leaks:${JSON.stringify(keys)}.filter(k=>process.env[k])}))`),
      exec('fail', 'process.exit(1)')
    ]);
    const report = JSON.parse(result.steps[0].evidence.stdout);
    assert.deepEqual(report.leaks, []);
    assert.equal(existsSync(report.home), false);
  } finally { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
});

test('HEAD drift is stale and does not execute remaining commands', async t => {
  const s = fixture(t);
  git(s.repo, 'commit', '--allow-empty', '-m', 'new target');
  const sha = git(s.repo, 'rev-parse', 'HEAD');
  const result = await s.run([{ id: 'move', type: 'exec', argv: ['git', 'checkout', '--detach', s.sha] }, mark()], { target: { ref: 'main', sha } });
  assert.equal(result.status, 'STALE');
  assert.equal(result.error.code, 'TARGET_STALE');
  assert.deepEqual(states(result), ['STALE', 'SKIPPED']);
  assert.equal(existsSync(join(s.repo, 'marker')), false);
});

test('Run deadline is shared rather than refreshed for each exec step', async t => {
  const s = fixture(t, { project: { workspaceExec: { enabled: true, runner: 'local', maxSeconds: 4 } } });
  // Exercise the real batch -> exec -> runBounded deadline propagation without
  // spending its four-second budget on Git, process startup or CI scheduling.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let now = 0, awaitingChild, cleaning = false;
  const children = [], pending = [];
  t.mock.method(performance, 'now', () => now);
  const spawnMock = t.mock.method(childProcess, 'spawn', (file, args) => {
    assert.equal(file, process.execPath);
    assert.equal(args[0], '-e');
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.closed = false; child.signals = [];
    child.finish = (output = '', code = 0, signal = null) => {
      if (child.closed) return;
      child.closed = true;
      if (output) child.stdout.emit('data', Buffer.from(output));
      child.emit('close', code, signal);
    };
    child.kill = signal => {
      if (!child.closed) {
        child.signals.push(signal);
        queueMicrotask(() => child.finish('', null, signal));
      }
      return true;
    };
    children.push(child);
    if (awaitingChild) { const ready = awaitingChild; awaitingChild = null; ready(child); }
    else pending.push(child);
    if (cleaning) setImmediate(() => child.finish());
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { spawnMock.mock.restore(); syncBuiltinESMExports(); });
  const nextChild = () => pending.length ? Promise.resolve(pending.shift()) : new Promise(resolve => { awaitingChild = resolve; });
  const running = s.run([exec('one', "process.stdout.write('one')"), exec('two', "process.stdout.write('two')", { timeoutSeconds: 3600 }), mark()]);
  try {
    const first = await nextChild();
    now = 2400; t.mock.timers.tick(2400);
    assert.equal(first.closed, false);
    first.finish('one');
    const second = await nextChild();
    now = 3999; t.mock.timers.tick(1599);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(second.closed, false, 'the second step retains the remaining 1.6 seconds');
    now = 4000; t.mock.timers.tick(1);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(second.signals, ['SIGTERM'], 'the second step must end at the original Run deadline');
    const result = await running;
    assert.equal(result.error.code, 'EXECUTION_TIMEOUT');
    assert.deepEqual(states(result), ['SUCCEEDED', 'FAILED', 'SKIPPED']);
    assert.equal(result.steps[0].evidence.stdout, 'one');
    assert.equal(children.length, 2, 'the suffix must never spawn');
    assert.equal(result.durationMs, 4000);
  } finally {
    cleaning = true;
    for (const child of children) child.finish();
    await running;
  }
});

test('requested per-step timeout only lowers limits, not the whole Run deadline', async t => {
  const s = fixture(t);
  const result = await s.run([exec('quick', 'process.exit(0)', { timeoutSeconds: 1 }), exec('slow', "setTimeout(()=>process.stdout.write('ok'),1100)")]);
  assert.equal(result.status, 'SUCCEEDED');
});

test('per-stream output overflow keeps bounded partial evidence and fails fast', async t => {
  const s = fixture(t);
  const result = await s.run([success('ok'), exec('large', "process.stdout.write('x'.repeat(5000))"), mark()]);
  assert.equal(result.error.code, 'OUTPUT_LIMIT_EXCEEDED');
  assert.deepEqual(states(result), ['SUCCEEDED', 'FAILED', 'SKIPPED']);
  assert.equal(result.steps[1].execution.stdoutBytes, 4096);
  assert.equal(result.steps[1].evidence.stdout.length, 4096);
});

test('combined result includes JSON escaping and UTF-8 multibyte output within hard byte limit', async t => {
  const s = fixture(t, { project: { workspaceExec: { enabled: true, runner: 'local', stdoutBytes: 4*1024*1024, stderrBytes: 4*1024*1024 } }, host: { workspaceExec: { enabled: true, runnerClass: 'test-runner', serviceUser: userInfo().username, stdoutBytes: 4*1024*1024, stderrBytes: 4*1024*1024 } } });
  const steps = Array.from({ length: 16 }, (_, i) => exec(`step${i}`, i % 2 ? "process.stdout.write('中'.repeat(250000)); process.stderr.write(Buffer.alloc(250000,1))" : "process.stdout.write(Buffer.alloc(250000,0))"));
  const result = await s.run(steps);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.error.code, 'OUTPUT_LIMIT_EXCEEDED');
  assert.equal(result.steps[0].status, 'SUCCEEDED');
  assert.ok(result.steps.some(step => step.status === 'SKIPPED'));
  assert.ok(readFileSync(join(s.out, 'bridge-result.json')).length <= BATCH_LIMITS.resultBytes);
});

test('existing CLI execute dispatches batch and retains full failure evidence with nonzero exit', t => {
  const s = fixture(t);
  s.save([success('ok'), exec('bad', 'process.exit(9)'), mark()]);
  const cli = spawnSync(process.execPath, [resolve('bin/bridge-runner.mjs'), 'execute', '--request', s.requestPath, '--repo', s.repo, '--host-policy', s.hostPath, '--output-dir', s.out], { encoding: 'utf8', timeout: 10000 });
  assert.equal(cli.status, 65, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).ok, false);
  const result = JSON.parse(readFileSync(join(s.out, 'bridge-result.json')));
  assert.deepEqual(states(result), ['SUCCEEDED', 'FAILED', 'SKIPPED']);
  assert.equal(result.steps[1].execution.exitCode, 9);
});

test('POSIX background child cannot continue mutating a later step', { skip: process.platform === 'win32' }, async t => {
  const s = fixture(t);
  const background = "setTimeout(()=>require('fs').writeFileSync('late-write','bad'),250)";
  const result = await s.run([
    exec('spawn', `const child=require('child_process').spawn(process.execPath,['-e',${JSON.stringify(background)}],{stdio:'ignore'}); child.unref();`),
    exec('check', "setTimeout(()=>process.stdout.write(String(require('fs').existsSync('late-write'))),500)")
  ]);
  assert.equal(result.status, 'SUCCEEDED');
  assert.equal(result.steps[1].evidence.stdout, 'false');
});

test('POSIX output overflow escalates even when target ignores SIGTERM', { skip: process.platform === 'win32' }, async t => {
  const s = fixture(t);
  const result = await s.run([exec('overflow', "process.on('SIGTERM',()=>{}); process.stdout.write('x'.repeat(5000)); setInterval(()=>{},1000)"), mark()]);
  assert.equal(result.error.code, 'OUTPUT_LIMIT_EXCEEDED');
  assert.deepEqual(states(result), ['FAILED', 'SKIPPED']);
  assert.ok(result.durationMs < 5000, result.durationMs);
});

test('large failed output retains the complete ordered receipt and bounded partial evidence', async t => {
  const s = fixture(t, { project: { workspaceExec: { enabled: true, runner: 'local', stdoutBytes: 4194304, stderrBytes: 4194304 } }, host: { workspaceExec: { enabled: true, runnerClass: 'test-runner', serviceUser: userInfo().username, stdoutBytes: 4194304, stderrBytes: 4194304 } } });
  const result = await s.run([success('ok'), exec('bad', "process.stdout.write(Buffer.alloc(900000,0),()=>{process.exitCode=9})"), mark()]);
  assert.equal(result.status, 'FAILED');
  assert.equal(result.error.code, 'OUTPUT_LIMIT_EXCEEDED');
  assert.deepEqual(states(result), ['SUCCEEDED', 'FAILED', 'SKIPPED']);
  assert.equal(result.steps[0].evidence.stdout, 'ok');
  assert.ok(result.steps[1].evidence.stdout.length > 0);
  assert.ok(readFileSync(join(s.out, 'bridge-result.json')).length <= BATCH_LIMITS.resultBytes);
});

test('large successful output becomes bounded failure without losing partial evidence', async t => {
  const s = fixture(t, { project: { workspaceExec: { enabled: true, runner: 'local', stdoutBytes: 4194304 } }, host: { workspaceExec: { enabled: true, runnerClass: 'test-runner', serviceUser: userInfo().username, stdoutBytes: 4194304 } } });
  const result = await s.run([exec('large', "process.stdout.write(Buffer.alloc(900000,1))"), mark()]);
  assert.equal(result.error.code, 'OUTPUT_LIMIT_EXCEEDED');
  assert.deepEqual(states(result), ['FAILED', 'SKIPPED']);
  assert.ok(result.steps[0].evidence.stdout.length > 0);
  assert.ok(readFileSync(join(s.out, 'bridge-result.json')).length <= BATCH_LIMITS.resultBytes);
});

test('POSIX descendants holding output pipes stop at the batch timeout', { skip: process.platform === 'win32' }, async t => {
  const s = fixture(t);
  const result = await s.run([exec('child', "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},3200)'],{stdio:'inherit'}); setInterval(()=>{},1000)", { timeoutSeconds: 1 }), mark()]);
  assert.equal(result.error.code, 'EXECUTION_TIMEOUT');
  assert.deepEqual(states(result), ['FAILED', 'SKIPPED']);
  assert.ok(result.durationMs < 2500, result.durationMs);
});

test('preset-only batches retain structured dataset-style evidence without exec opt-in', async t => {
  const capability = { class: 'observe', runner: 'local', command: { argv: [process.execPath, '-e', 'process.stdout.write(JSON.stringify({available:true}))'] }, outputs: { structuredStdout: 'json' } };
  const s = fixture(t, { project: { workspaceExec: { enabled: false }, capabilities: { 'dataset-status': capability, 'dataset-inspect': capability } } });
  const result = await s.run([{ id: 'status', type: 'preset', capability: 'dataset-status' }, { id: 'inspect', type: 'preset', capability: 'dataset-inspect' }]);
  assert.equal(result.status, 'SUCCEEDED');
  assert.deepEqual(states(result), ['SUCCEEDED', 'SUCCEEDED']);
  for (const step of result.steps) assert.deepEqual(JSON.parse(step.evidence.report.content), { available: true });
});

test('preset report duplication is bounded after collection without losing previous evidence', async t => {
  const capability = { class: 'observe', runner: 'local', command: { argv: [process.execPath, '-e', "process.stdout.write(JSON.stringify('a'.repeat(2200000)))"] }, outputs: { structuredStdout: 'json' }, limits: { stdoutBytes: 4194304, reportBytes: 4194304 } };
  const s = fixture(t, { project: { capabilities: { 'large-report': capability } } });
  const result = await s.run([success('ok'), { id: 'report', type: 'preset', capability: 'large-report' }, mark()]);
  assert.deepEqual(states(result), ['SUCCEEDED', 'FAILED', 'SKIPPED']);
  assert.equal(result.error.code, 'OUTPUT_LIMIT_EXCEEDED');
  assert.equal(result.steps[0].evidence.stdout, 'ok');
  assert.ok(result.steps[1].evidence.stdout.length > 0);
  assert.equal(result.steps[1].evidence.reportOmitted, true);
  assert.equal(result.steps[1].evidence.report, undefined);
  assert.ok(readFileSync(join(s.out, 'bridge-result.json')).length <= BATCH_LIMITS.resultBytes);
});

test('resource redaction expansion cannot exceed final success or failure receipt budgets', async t => {
  const name = 'data-' + 'x'.repeat(58);
  for (const exitCode of [0, 9]) {
    const s = fixture(t, { project: { workspaceExec: { enabled: true, runner: 'local', stdoutBytes: 4194304, resources: [{ name, env: 'LOCAL_DATA' }] } }, host: { workspaceExec: { enabled: true, runnerClass: 'test-runner', serviceUser: userInfo().username, stdoutBytes: 4194304 } } });
    s.hostPolicy.repositories[repository].resources[name] = { root: s.root, read: ['data/**'] };
    writeFileSync(s.hostPath, JSON.stringify(s.hostPolicy));
    const result = await s.run([success('ok'), exec('resource', `process.stdout.write(process.env.LOCAL_DATA.repeat(60000),()=>{process.exitCode=${exitCode}})`, { resources: [name] }), mark()]);
    assert.deepEqual(states(result), ['SUCCEEDED', 'FAILED', 'SKIPPED']);
    assert.equal(result.error.code, 'OUTPUT_LIMIT_EXCEEDED');
    assert.equal(result.steps[0].evidence.stdout, 'ok');
    assert.equal(result.steps[1].evidence.truncated, true);
    const bytes = readFileSync(join(s.out, 'bridge-result.json'));
    assert.ok(bytes.length <= BATCH_LIMITS.resultBytes);
    assert.equal(bytes.includes(Buffer.from(s.root)), false);
  }
});
