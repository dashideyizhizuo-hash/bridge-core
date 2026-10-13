#!/usr/bin/env node
// Real native startup contract with an isolated fake identity; no production account.
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join, dirname } from 'node:path';
import { ensureHostDirectory, writeHostFile } from '../src/host-files.mjs';
import { hostServicePaths, stageHostRuntime } from '../src/host-service.mjs';
import { nativeServicePaths, installNativeService, stopNativeService } from '../src/host-native-service.mjs';
import { readRuntimeStatus } from '../src/host-runtime-status.mjs';
import { hostPowerShell } from '../src/host-platform.mjs';
import { windowsAction } from '../src/host-windows-action.mjs';
import { spawnSync } from 'node:child_process';

assert.ok(['win32','darwin'].includes(process.platform));
const base=process.env.BRIDGE_NATIVE_TEST_ROOT || tmpdir();
const root=realpathSync(mkdtempSync(join(base,'bridge-ready-fixture-')));
const owned=[];
try {
  for(const failImport of [false,true]) {
    const config=join(root,failImport?'failed':'healthy');ensureHostDirectory(config);
    const paths=nativeServicePaths(config);owned.push(paths);
    const daemonPath=stageHostRuntime(hostServicePaths(config,{env:{XDG_DATA_HOME:join(config,'data')}}));
    const stateDir=join(config,'state');ensureHostDirectory(stateDir);
    writeHostFile(join(config,'host.json'),JSON.stringify({version:1,host:{id:'host-isolated-readiness'},repositories:{},
      directExec:{enabled:true,serviceUser:userInfo().username,root:config,stateDir,maxSeconds:10,stdoutBytes:4096,stderrBytes:4096,resultBytes:4096}}));
    writeHostFile(join(config,'direct-runner.env'),'BRIDGE_PUBLIC_URL=https://bridge-readiness.invalid/mcp\nBRIDGE_DIRECT_RUNNER_TOKEN=readiness_test_only_abcdefghijklmnopqrstuvwxyz123456\n');
    if(failImport) unlinkSync(join(dirname(dirname(daemonPath)),'src','host-runner.mjs'));
    const options={daemonPath,startupAttempts:failImport?4:20,startupDelayMs:100,
      startupStatus:()=>{const r=readRuntimeStatus(config);return {...r,localReady:r.localReady && r.daemonPath===daemonPath};}};
    if(failImport) await assert.rejects(installNativeService(paths,options),e=>e.code==='HOST_SERVICE_FAILED');
    else {
      const installed=await installNativeService(paths,options);
      assert.equal(installed.runtime.localReady,true);
      assert.equal(installed.runtime.connected,false);
    }
    stopNativeService(paths);
  }
  console.log(JSON.stringify({platform:process.platform,stagedDaemonReadiness:true,failedImportRejected:true,
    supervisorAloneInsufficient:true,productionIdentity:false,productionNetwork:false}));
} finally {
  for(const paths of owned) {
    if(!existsSync(paths.receiptPath)) continue;
    const spec=JSON.parse(readFileSync(paths.receiptPath,'utf8'));
    if(process.platform==='win32') {
      assert.deepEqual(spec.action,windowsAction(spec));
      hostPowerShell(`$s=New-Object -ComObject 'Schedule.Service';$s.Connect();$f=$s.GetFolder('\\');$t=$f.GetTask($d.name);if($t.Definition.RegistrationInfo.Description -cne $d.marker){throw 'Foreign task'};$t.Enabled=$false;$t.Stop(0);for($i=0;$i -lt 100 -and $t.GetInstances(0).Count -gt 0;$i++){[Threading.Thread]::Sleep(100)};if($t.GetInstances(0).Count -gt 0){throw 'Fixture task is still stopping'};$f.DeleteTask($d.name,0);@{removed=$true}|ConvertTo-Json -Compress`,{name:paths.name,marker:spec.marker});
    } else {
      try {stopNativeService(paths);} catch {}
      const result=spawnSync('/bin/launchctl',['bootout',paths.domain+'/'+paths.name],{stdio:'ignore'});
      assert.ok(result.status===0 || result.status===3 || result.status===113);
      rmSync(paths.unitPath,{force:true});
    }
  }
  await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
}
