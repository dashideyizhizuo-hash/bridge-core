import test from 'node:test';
import assert from 'node:assert/strict';
import { runBounded } from '../src/execute.mjs';
import { spawnSync } from 'node:child_process';
import { isUtf8 } from 'node:buffer';

const execute = (source, overrides = {}) => runBounded({
  cwd: process.cwd(), argv: [process.execPath, '-e', source], env: process.env,
  timeoutSeconds: 10, stdoutBytes: 4096, stderrBytes: 4096, ...overrides
});

test('execution preserves UTF-8 Chinese JSON, emoji, and ASCII', async () => {
  const expected = JSON.stringify({ text: '中文往返🙂', ascii: 'ok' });
  const result = await execute(`process.stdout.write(${JSON.stringify(expected)}); process.stderr.write('中文错误');`);
  assert.equal(result.stdout, expected);
  assert.equal(result.stderr, '中文错误');
  assert.equal(result.stdoutBytes, Buffer.byteLength(expected));
});

test('execution preserves UTF-8 characters split across child writes', async () => {
  const result = await execute("const b=Buffer.from('中文🙂');process.stdout.write(b.subarray(0,2));setTimeout(()=>process.stdout.write(b.subarray(2)),30)");
  assert.equal(result.stdout, '中文🙂');
});

for (const stream of ['stdout', 'stderr']) {
  test(`execution explicitly rejects non-UTF-8 ${stream}`, async () => {
    await assert.rejects(execute(`process.${stream}.write(Buffer.from([0xd6,0xd0,0xce,0xc4]));`), error => {
      assert.equal(error.code, 'OUTPUT_ENCODING_INVALID');
      assert.equal(error.details[stream], '');
      assert.ok(!JSON.stringify(error.details).includes('\uFFFD'));
      return true;
    });
  });
}

test('execution rejects incomplete UTF-8 at ordinary EOF', async () => {
  await assert.rejects(execute('process.stdout.write(Buffer.from([0xe4,0xb8]));'), { code: 'OUTPUT_ENCODING_INVALID' });
});

test('literal UTF-8 replacement character is valid output rather than an encoding failure', async () => {
  assert.equal((await execute("process.stdout.write('合法�文本');")).stdout, '合法�文本');
});

test('wire-budget clipping keeps valid UTF-8 and bounded serialized evidence', async () => {
  const budget = 48;
  await assert.rejects(execute("process.stdout.write('中文🙂'.repeat(100));", { outputBudgetBytes: budget }), error => {
    assert.equal(error.code, 'OUTPUT_LIMIT_EXCEEDED');
    const {stdout, stderr} = error.details;
    assert.ok(!stdout.includes('\uFFFD'));
    assert.ok(Buffer.byteLength(JSON.stringify({stdout, stderr})) <= budget);
    return true;
  });
});

test('output limit does not turn a truncated valid Chinese character into replacement text', async () => {
  await assert.rejects(execute("process.stdout.write('中文');", { stdoutBytes: 4 }), error => {
    assert.equal(error.code, 'OUTPUT_LIMIT_EXCEEDED');
    assert.equal(error.details.stdout, '中');
    assert.ok(error.details.stdoutBytes <= 4);
    return true;
  });
});

test('real Windows whoami output is explicit about encoding and supports a UTF-8 producer', {skip:process.platform!=='win32'}, async () => {
  const raw = spawnSync('whoami.exe', ['/user'], {windowsHide:true});
  assert.equal(raw.status, 0);
  const options={cwd:process.cwd(),env:process.env,timeoutSeconds:10,stdoutBytes:65536,stderrBytes:4096};
  if (isUtf8(raw.stdout)) {
    assert.equal((await runBounded({...options,argv:['whoami.exe','/user']})).stdout, raw.stdout.toString('utf8'));
  } else {
    await assert.rejects(runBounded({...options,argv:['whoami.exe','/user']}), {code:'OUTPUT_ENCODING_INVALID'});
  }
  const fixed = await runBounded({...options,argv:['cmd.exe','/d','/s','/c','chcp 65001 >nul & whoami /user']});
  assert.equal(fixed.exitCode, 0);
  assert.ok(fixed.stdout.length > 0);
  assert.ok(!fixed.stdout.includes('\uFFFD'));
});
