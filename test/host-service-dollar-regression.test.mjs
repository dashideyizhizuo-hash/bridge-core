import test from 'node:test';
import assert from 'node:assert/strict';
import { hostServiceUnit } from '../src/host-service.mjs';

test('systemd ExecStart preserves literal dollar-variable forms in user paths',{skip:process.platform==='win32'?'systemd path rendering is a Linux acceptance':false},()=>{
  const unit=hostServiceUnit({daemonPath:'/tmp/$HOME/${USER}/daemon.mjs',
    configDir:'/tmp/${CREDENTIALS_DIRECTORY}/$NAME',home:'/tmp/$HOME'});
  const start=unit.split('\n').find(line=>line.startsWith('ExecStart='));
  assert.ok(start.includes('/tmp/$$HOME/$${USER}/daemon.mjs'));
  assert.ok(start.includes('/tmp/$${CREDENTIALS_DIRECTORY}/$$NAME'));
  const environment=unit.split('\n').find(line=>line.startsWith('Environment='));
  assert.ok(environment.includes('/tmp/$HOME/.local/bin'));
  assert.equal(environment.includes('$$HOME'),false);
});
