import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { runHost } from '../src/host-runner.mjs';
import { ensureHostDirectory, writeHostFile } from '../src/host-files.mjs';

const endpoint='https://bridge.example/mcp',hostId='host-assets-regression-01';
function fixture(t) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'bridge-host-assets-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const configDir=join(root,'config'),state=join(root,'state');
  ensureHostDirectory(configDir);ensureHostDirectory(state);
  writeHostFile(join(configDir,'host.json'),JSON.stringify({version:1,host:{id:hostId},repositories:{},directExec:{enabled:true,
    serviceUser:userInfo().username,root,stateDir:state,assetDir:join(state,'assets'),maxSeconds:30,resultBytes:1048576}}));
  writeHostFile(join(configDir,'direct-runner.env'),`BRIDGE_PUBLIC_URL=${endpoint}\nBRIDGE_DIRECT_RUNNER_TOKEN=${'r'.repeat(43)}\n`);
  return {configDir};
}
test('shared Host runtime preserves the existing 25 MiB Direct Asset contract',async t=>{
  const f=fixture(t),bytes=Buffer.alloc(2*1024*1024,42);let completed;
  const asset={assetId:'asset-portable-fixture-01',fileName:'fixture.bin',mimeType:'application/octet-stream',
    sizeBytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  const request={schemaVersion:1,requestId:'portable-large-asset-01',hostId,timeoutSeconds:10,assets:[asset],
    argv:[process.execPath,'-e','console.log(require("node:fs").statSync(process.env.BRIDGE_ASSET_0).size)']};
  const result=await runHost({configDir:f.configDir,once:true,fetchImpl:async(url,options)=>{
    const path=new URL(url).pathname;
    if(path==='/direct/runner/claim') return Response.json({request,leaseOwner:'fixture-owner',runId:'fixture-asset-run'});
    if(path==='/direct/runner/assets/'+asset.assetId) return new Response(bytes,{headers:{'content-length':String(bytes.length),'x-bridge-sha256':asset.sha256}});
    completed=JSON.parse(options.body).result;return Response.json({ok:true});
  }});
  assert.equal(result.status,'SUCCEEDED');assert.equal(completed.evidence.stdout.trim(),String(bytes.length));
});
test('large asset support does not increase the control-response limit',async t=>{
  const f=fixture(t);
  await assert.rejects(runHost({configDir:f.configDir,once:true,
    fetchImpl:async()=>new Response('too large',{headers:{'content-length':String(2*1024*1024)}})}),error=>error.code==='HOST_RESPONSE_TOO_LARGE');
});
