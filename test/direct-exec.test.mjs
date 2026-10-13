import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import {makeTestDirectory as mkdtempSync} from './helpers/canonical-temp.mjs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { executeDirectExec, resolveDirectExecPlan, validateDirectExecRequest } from '../src/direct-exec.mjs';
import { validateHostPolicy } from '../src/validate.mjs';

function setup(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bridge-direct-'));
  const work = join(root, 'work');
  mkdirSync(work);
  const hostPolicy = {
    version: 1,
    host: { id: 'host-main' },
    repositories: {},
    directExec: {
      enabled: true,
      serviceUser: userInfo().username,
      root,
      maxArgv: 8,
      maxSeconds: 10,
      stdoutBytes: 4096,
      stderrBytes: 4096,
      ...overrides
    }
  };
  return { root, work, hostPolicy, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function request(extra = {}) {
  return {
    schemaVersion: 1,
    requestId: 'direct-1234',
    hostId: 'host-main',
    argv: [process.execPath, '-e', 'process.stdout.write("ok")'],
    ...extra
  };
}

test('direct host policy is valid without repository entries', () => {
  const s = setup();
  try {
    assert.equal(validateHostPolicy(s.hostPolicy), s.hostPolicy);
  } finally {
    s.cleanup();
  }
});

test('direct exec runs bounded argv without repository or project policy', async () => {
  const s = setup();
  try {
    const result = await executeDirectExec({ request: request(), hostPolicy: s.hostPolicy });
    assert.equal(result.transport, 'direct');
    assert.equal(result.status, 'SUCCEEDED');
    assert.equal(result.hostId, 'host-main');
    assert.equal(result.evidence.stdout, 'ok');
  } finally {
    s.cleanup();
  }
});

test('direct exec round-trips Chinese argv and fails explicitly for invalid output encoding', async () => {
  const s = setup();
  try {
    const good = await executeDirectExec({ request: request({ argv: [process.execPath, '-e', 'process.stdout.write(process.argv[1])', '中文文件🙂'] }), hostPolicy: s.hostPolicy });
    assert.equal(good.evidence.stdout, '中文文件🙂');
    await assert.rejects(executeDirectExec({ request: request({ argv: [process.execPath, '-e', 'process.stdout.write(Buffer.from([0xd6,0xd0]));process.stderr.write("有效诊断");'] }), hostPolicy: s.hostPolicy }), error => {
      assert.equal(error.code, 'OUTPUT_ENCODING_INVALID');
      assert.equal(error.details.status, 'FAILED');
      assert.equal(error.details.evidence.stdout, '');
      assert.equal(error.details.evidence.stderr, '有效诊断');
      return true;
    });
  } finally { s.cleanup(); }
});

test('direct exec allows only relative cwd inside host-owned root', async () => {
  const s = setup();
  try {
    const result = await executeDirectExec({
      request: request({
        cwd: 'work',
        argv: [process.execPath, '-e', 'process.stdout.write(process.cwd())']
      }),
      hostPolicy: s.hostPolicy
    });
    assert.equal(result.evidence.stdout, s.work);
    assert.throws(
      () => validateDirectExecRequest(request({ cwd: '../outside' })),
      error => error.code === 'DIRECT_EXEC_INVALID'
    );
    assert.throws(
      () => validateDirectExecRequest(request({ cwd: '/tmp' })),
      error => error.code === 'DIRECT_EXEC_INVALID'
    );
  } finally {
    s.cleanup();
  }
});

test('direct exec rejects shell-string shaped authority', () => {
  assert.throws(
    () => validateDirectExecRequest({
      ...request(),
      command: 'rm -rf /'
    }),
    error => error.code === 'DIRECT_EXEC_INVALID'
  );
});

test('direct exec enforces exact host identity and service user', () => {
  const s = setup();
  try {
    assert.throws(
      () => resolveDirectExecPlan({
        request: request({ hostId: 'other-host' }),
        hostPolicy: s.hostPolicy
      }),
      error => error.code === 'DIRECT_EXEC_DENIED'
    );
    assert.throws(
      () => resolveDirectExecPlan({
        request: request(),
        hostPolicy: {
          ...s.hostPolicy,
          directExec: { ...s.hostPolicy.directExec, serviceUser: 'definitely-not-current-user' }
        }
      }),
      error => error.code === 'DIRECT_EXEC_DENIED'
    );
  } finally {
    s.cleanup();
  }
});

test('direct exec enforces host argv limit', () => {
  const s = setup({ maxArgv: 2 });
  try {
    assert.throws(
      () => resolveDirectExecPlan({ request: request(), hostPolicy: s.hostPolicy }),
      error => error.code === 'DIRECT_EXEC_DENIED'
    );
  } finally {
    s.cleanup();
  }
});

test('direct exec exposes stable run identity to the child process', async () => {
  const s = setup();
  try {
    const result = await executeDirectExec({
      request: request({
        argv: [
          process.execPath,
          '-e',
          'process.stdout.write(process.env.BRIDGE_REQUEST_ID+"|"+process.env.BRIDGE_HOST_ID)'
        ]
      }),
      hostPolicy: s.hostPolicy
    });
    assert.equal(result.evidence.stdout, 'direct-1234|host-main');
  } finally {
    s.cleanup();
  }
});

test('direct exec strips token-like cloud credentials', async () => {
  const s = setup();
  const previous = process.env.GITHUB_TOKEN;
  try {
    process.env.GITHUB_TOKEN = 'must-not-leak';
    const result = await executeDirectExec({
      request: request({
        argv: [process.execPath, '-e', 'process.stdout.write(String(process.env.GITHUB_TOKEN))']
      }),
      hostPolicy: s.hostPolicy
    });
    assert.equal(result.evidence.stdout, 'undefined');
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous;
    s.cleanup();
  }
});




test('direct exec enforces D1-safe combined result budget', async () => {
  const s = setup({ stdoutBytes: 2_000_000, stderrBytes: 2_000_000, resultBytes: 1024 });
  try {
    await assert.rejects(
      ()=>executeDirectExec({
        request: request({
          argv: [process.execPath, '-e', 'process.stdout.write("x".repeat(5000))']
        }),
        hostPolicy: s.hostPolicy
      }),
      error=>error.code==='OUTPUT_LIMIT_EXCEEDED'
    );
  } finally {
    s.cleanup();
  }
});

test('direct exec can be canceled through an AbortSignal', async () => {
  const s = setup();
  try {
    const controller=new AbortController();
    setTimeout(()=>controller.abort(),50);
    await assert.rejects(
      ()=>executeDirectExec({
        request: request({
          argv: [process.execPath, '-e', 'setTimeout(()=>{},10000)']
        }),
        hostPolicy:s.hostPolicy,
        signal:controller.signal
      }),
      error=>error.code==='EXECUTION_CANCELED'
    );
  } finally {
    s.cleanup();
  }
});

test('bridge-runner direct-exec CLI needs no repository checkout', () => {
  const s = setup();
  try {
    const requestPath = join(s.root, 'request.json');
    const hostPath = join(s.root, 'host.json');
    const out = join(s.root, 'out');
    writeFileSync(requestPath, JSON.stringify(request()));
    writeFileSync(hostPath, JSON.stringify(s.hostPolicy));
    const result = spawnSync(
      process.execPath,
      [
        resolve('bin/bridge-runner.mjs'),
        'direct-exec',
        '--request', requestPath,
        '--host-policy', hostPath,
        '--output-dir', out
      ],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.ok, true);
    assert.equal(summary.transport, 'direct');
    const persisted = JSON.parse(readFileSync(join(out, 'bridge-result.json'), 'utf8'));
    assert.equal(persisted.status, 'SUCCEEDED');
    assert.equal(persisted.evidence.stdout, 'ok');
  } finally {
    s.cleanup();
  }
});


test('direct exec substitutes only exact verified asset placeholders',async()=>{
  const s=setup();
  try {
    const assetPath=join(s.root,'asset.png');
    writeFileSync(assetPath,'asset');
    const result=await executeDirectExec({
      request:request({
        argv:[
          process.execPath,
          '-e',
          'process.stdout.write(process.argv[1]+"|"+process.env.BRIDGE_ASSET_0+"|"+process.env.BRIDGE_ASSET_COUNT)',
          '{asset:0}'
        ],
        assets:[{
          assetId:'asset-12345678',
          fileName:'asset.png',
          mimeType:'image/png',
          sizeBytes:5,
          sha256:'a'.repeat(64)
        }]
      }),
      hostPolicy:s.hostPolicy,
      assetPaths:[assetPath]
    });
    assert.equal(result.evidence.stdout,`${assetPath}|${assetPath}|1`);
  } finally {
    s.cleanup();
  }
});

test('direct exec refuses missing or out-of-range asset staging',async()=>{
  const s=setup();
  try {
    const req=request({
      argv:[process.execPath,'-e','process.stdout.write(process.argv[1])','{asset:0}'],
      assets:[{
        assetId:'asset-12345678',
        fileName:'asset.png',
        mimeType:'image/png',
        sizeBytes:5,
        sha256:'a'.repeat(64)
      }]
    });
    await assert.rejects(
      ()=>executeDirectExec({request:req,hostPolicy:s.hostPolicy,assetPaths:[]}),
      error=>error.code==='DIRECT_ASSET_MISSING'
    );
    await assert.rejects(
      ()=>executeDirectExec({
        request:{...req,argv:[process.execPath,'-e','0','{asset:1}']},
        hostPolicy:s.hostPolicy,
        assetPaths:[join(s.root,'asset.png')]
      }),
      error=>error.code==='DIRECT_ASSET_MISSING'
    );
  } finally {
    s.cleanup();
  }
});


test('direct exec substitutes only declared export slots and exposes bounded export env',async()=>{
  const s=setup();
  try {
    const exportPath=join(s.root,'result.png');
    const result=await executeDirectExec({
      request:request({
        argv:[
          process.execPath,
          '-e',
          'require("fs").writeFileSync(process.argv[1],"output");process.stdout.write(process.argv[1]+"|"+process.env.BRIDGE_EXPORT_0+"|"+process.env.BRIDGE_EXPORT_COUNT)',
          '{export:0}'
        ],
        exports:[{
          fileName:'result.png',
          mimeType:'image/png',
          maxBytes:1024,
          required:true
        }]
      }),
      hostPolicy:s.hostPolicy,
      exportPaths:[exportPath]
    });
    assert.equal(result.status,'SUCCEEDED');
    assert.equal(result.evidence.stdout,`${exportPath}|${exportPath}|1`);
    assert.equal(readFileSync(exportPath,'utf8'),'output');
  } finally {
    s.cleanup();
  }
});

test('direct export descriptors reject path authority and out-of-range placeholders',async()=>{
  assert.throws(
    ()=>validateDirectExecRequest(request({
      exports:[{fileName:'../secret.txt',mimeType:'text/plain'}]
    })),
    error=>error.code==='DIRECT_EXEC_INVALID'
  );
  assert.throws(
    ()=>validateDirectExecRequest(request({
      exports:[{fileName:'secret.txt',mimeType:'text/plain',maxBytes:25*1024*1024+1}]
    })),
    error=>error.code==='DIRECT_EXEC_INVALID'
  );
  const s=setup();
  try {
    await assert.rejects(
      ()=>executeDirectExec({
        request:request({
          argv:[process.execPath,'-e','0','{export:1}'],
          exports:[{fileName:'result.txt',mimeType:'text/plain'}]
        }),
        hostPolicy:s.hostPolicy,
        exportPaths:[join(s.root,'result.txt')]
      }),
      error=>error.code==='DIRECT_EXPORT_MISSING'
    );
  } finally {
    s.cleanup();
  }
});
