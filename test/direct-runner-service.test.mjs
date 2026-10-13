import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('Direct Runner systemd template keeps credential/process hardening',()=>{
  const unit=readFileSync(
    new URL('../examples/bridge-direct-runner.service',import.meta.url),
    'utf8'
  );
  for(const required of [
    'User=bridge-runner',
    'NoNewPrivileges=true',
    'ProtectProc=ptraceable',
    'ProcSubset=pid',
    'CapabilityBoundingSet=',
    'AmbientCapabilities=',
    'RestrictSUIDSGID=true',
    'ProtectKernelTunables=true',
    'ProtectKernelModules=true',
    'ProtectControlGroups=true',
    'LockPersonality=true',
    'KillMode=control-group',
    'Restart=on-failure',
    'RestartPreventExitStatus=64 65 66',
    'UMask=0077'
  ]) {
    assert.ok(unit.includes(required),`missing systemd hardening: ${required}`);
  }
});
