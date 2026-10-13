import {ensureHostDirectory} from '../src/host-files.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import {
  connectDirectHost,
  readDirectRunnerEnv
} from '../src/direct-connect-client.mjs';

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

const PAIR='pairing_token_abcdefghijklmnopqrstuvwxyz123456';
const RUNNER='R'.repeat(43);

function fixture() {
  const parent=mkdtempSync(join(tmpdir(),'bridge-connect-'));
  const root=ensureHostDirectory(join(parent,'private'));
  return {root,cleanup:()=>rmSync(parent,{recursive:true,force:true})};
}

test('connect generates runner token locally and persists only local credential',async()=>{
  if(userInfo().username==='root') return;
  const f=fixture();
  try {
    let requestBody;
    const result=await connectDirectHost({
      endpoint:'https://bridge.example/mcp',
      pairingToken:PAIR,
      configDir:f.root,
      randomToken:()=>RUNNER,
      fetchImpl:async (_url,init)=>{
        assert.equal(init.headers.authorization,`Bearer ${PAIR}`);
        requestBody=JSON.parse(init.body);
        return Response.json({
          paired:true,
          pairingId:'pair-1234567890abcdef',
          hostId:'host-server-assigned-1234',
          enabled:true,
          rotated:false
        });
      }
    });

    assert.deepEqual(Object.keys(requestBody),['runnerTokenSha256']);
    assert.equal(requestBody.runnerTokenSha256,digest(RUNNER));
    assert.equal(JSON.stringify(requestBody).includes(RUNNER),false);
    assert.equal(result.connected,true);
    assert.equal(result.hostId,'host-server-assigned-1234');
    assert.equal(JSON.stringify(result).includes(RUNNER),false);

    const policy=JSON.parse(readFileSync(result.policyPath,'utf8'));
    assert.equal(policy.host.id,'host-server-assigned-1234');
    assert.equal(policy.directExec.serviceUser,userInfo().username);
    assert.equal(policy.directExec.enabled,true);

    const env=readDirectRunnerEnv(result.envPath);
    assert.equal(env.endpoint,'https://bridge.example/mcp');
    assert.equal(env.token,RUNNER);
    if(process.platform!=='win32') {
      assert.equal(statSync(result.policyPath).mode & 0o777,0o600);
      assert.equal(statSync(result.envPath).mode & 0o777,0o600);
    }
    assert.match(result.next.command,/--env-file/);
  } finally {
    f.cleanup();
  }
});

test('connect does not persist local secrets when remote pairing fails',async()=>{
  if(userInfo().username==='root') return;
  const f=fixture();
  try {
    await assert.rejects(
      ()=>connectDirectHost({
        endpoint:'https://bridge.example/mcp',
        pairingToken:PAIR,
        configDir:f.root,
        randomToken:()=>RUNNER,
        fetchImpl:async()=>Response.json(
          {error:{code:'DIRECT_PAIRING_DENIED',message:'expired'}},
          {status:403}
        )
      }),
      error=>error.code==='DIRECT_PAIRING_DENIED'
    );
    assert.equal(existsSync(join(f.root,'host.json')),false);
    assert.equal(existsSync(join(f.root,'direct-runner.env')),false);
  } finally {
    f.cleanup();
  }
});

test('connect refuses to overwrite existing local runner configuration',async()=>{
  if(userInfo().username==='root') return;
  const f=fixture();
  try {
    writeFileSync(join(f.root,'host.json'),'existing',{mode:0o600});
    await assert.rejects(
      ()=>connectDirectHost({
        endpoint:'https://bridge.example/mcp',
        pairingToken:PAIR,
        configDir:f.root,
        randomToken:()=>RUNNER,
        fetchImpl:async()=>Response.json({
          paired:true,
          pairingId:'pair-1234567890abcdef',
          hostId:'laptop-main',
          enabled:true,
          rotated:false
        })
      }),
      error=>error.code==='DIRECT_CONNECT_CONFLICT'
    );
    assert.equal(readFileSync(join(f.root,'host.json'),'utf8'),'existing');
    assert.equal(existsSync(join(f.root,'direct-runner.env')),false);
  } finally {
    f.cleanup();
  }
});

test('runner env parser rejects shell-like/unknown configuration',()=>{
  const f=fixture();
  try {
    const path=join(f.root,'env');
    writeFileSync(
      path,
      'BRIDGE_PUBLIC_URL=https://bridge.example/mcp\nBRIDGE_DIRECT_RUNNER_TOKEN='+RUNNER+'\nEVIL=$(id)\n'
    );
    assert.throws(
      ()=>readDirectRunnerEnv(path),
      error=>error.code==='DIRECT_CONNECT_INVALID'
    );
  } finally {
    f.cleanup();
  }
});
