#!/usr/bin/env node
// Real systemd user-service acceptance on an ephemeral CI machine. This fixture
// runs a harmless heartbeat process, never the production Host or its secrets.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { hostServicePaths, preflightHostService, installHostService,
  hostServiceStatus, stopHostService } from '../src/host-service.mjs';

assert.equal(process.platform,'linux','This acceptance requires Linux systemd');
assert.notEqual(process.getuid(),0,'The installer and test service must run as an ordinary user');
const root=mkdtempSync(join(tmpdir(),'bridge-user-service-'));
const name=`bridge-host-test-${randomBytes(8).toString('hex')}.service`;
// Real systemd must preserve these characters literally, not expand variables.
const configDir=join(root,'config ${HOME} %h $NAME');
const daemonPath=join(root,'daemon ${USER} %p $.mjs');
mkdirSync(configDir,{mode:0o700});
const paths=hostServicePaths(configDir,{
  env:{...process.env,XDG_DATA_HOME:join(root,'data')},home:homedir(),unitName:name
});
assert.equal(existsSync(paths.unitPath),false,'Never replace an existing user unit');
const marker=join(configDir,'heartbeat.json');
const hostId='host-isolated-systemd-test';
const credential=join(configDir,'identity-test.json');
writeFileSync(credential,JSON.stringify({hostId}),{mode:0o600});
const daemon=`import { writeFileSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const config=process.argv[3];
const output=join(config,'heartbeat.json');
const status=readFileSync('/proc/self/status','utf8');
const record={pid:process.pid,uid:process.getuid(),config,
  noNewPrivileges:/^NoNewPrivs:\\s+1$/m.test(status)};
writeFileSync(output+'.tmp',JSON.stringify(record),{mode:0o600});
renameSync(output+'.tmp',output);
setInterval(()=>{},1000);
`;
writeFileSync(daemonPath,daemon,{mode:0o600});
function systemctl(args) {
  const result=spawnSync('systemctl',['--user',...args],{
    encoding:'utf8',timeout:10_000,maxBuffer:16_384,stdio:['ignore','pipe','pipe']
  });
  assert.equal(result.error,undefined,result.error?.message);
  assert.equal(result.status,0,`systemctl ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
}
async function heartbeat(previousPid) {
  for(let attempt=0;attempt<80;attempt++) {
    if(existsSync(marker)) {
      const value=JSON.parse(readFileSync(marker,'utf8'));
      if(previousPid===undefined || value.pid!==previousPid) {
        assert.equal(value.uid,process.getuid());
        assert.equal(value.config,configDir);
        assert.equal(value.noNewPrivileges,true);
        return value;
      }
    }
    await delay(250);
  }
  throw new Error('Isolated user-service heartbeat did not arrive');
}
let installed=false;
try {
  preflightHostService(paths);
  const first=await installHostService(paths,{hostId,daemonPath});
  installed=true;
  assert.equal(first.active,true);
  const initial=await heartbeat();
  await installHostService(paths,{hostId,daemonPath});
  assert.equal((await heartbeat()).pid,initial.pid,'Repeat installation must not restart the running service');
  // Crash only this fixture unit's main process; auxiliary cgroup signaling
  // is unnecessary and unsupported by some WSL systemd environments.
  systemctl(['kill','--kill-whom=main','--signal=SIGKILL',name]);
  const recovered=await heartbeat(initial.pid);
  assert.notEqual(recovered.pid,initial.pid,'Restart=on-failure must actually restart the process');
  assert.equal(hostServiceStatus(paths).active,true);
  assert.equal(stopHostService(paths).credentialsRetained,true);
  assert.equal(hostServiceStatus(paths).active,false);
  assert.deepEqual(JSON.parse(readFileSync(credential,'utf8')),{hostId});
  await installHostService(paths,{hostId,daemonPath});
  const restarted=await heartbeat(recovered.pid);
  assert.notEqual(restarted.pid,recovered.pid);
  const evidence={node:process.version,realSystemdUserService:true,ordinaryUser:true,
    literalSpecialCharacterPaths:true,noNewPrivileges:true,idempotentInstall:true,
    crashRestart:true,stopAndRestart:true,identityRetained:true,
    productionHostUsed:false,productionCredentialsUsed:false,bootTest:false};
  const repository=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const output=join(repository,'dist/host-preview/systemd-verification.json');
  mkdirSync(dirname(output),{recursive:true});
  writeFileSync(output,JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence,null,2));
} finally {
  // This random, preflight-absent unit is the only service this fixture owns.
  // It never addresses bridge-host.service or any non-fixture unit.
  if(installed || existsSync(paths.unitPath)) {
    systemctl(['disable','--now',name]);
    rmSync(paths.unitPath,{force:true});
    systemctl(['daemon-reload']);
  }
  rmSync(root,{recursive:true,force:true});
}
