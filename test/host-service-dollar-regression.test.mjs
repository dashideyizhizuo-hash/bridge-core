import test from 'node:test';
import assert from 'node:assert/strict';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import { hostServiceUnit } from '../src/host-service.mjs';

test('systemd ExecStart preserves literal dollar-variable forms in user paths',{skip:process.platform==='win32'?'systemd path rendering is a Linux acceptance':false},()=>{
  const root=realpathSync(tmpdir());
  const unit=hostServiceUnit({daemonPath:root+'/$HOME/${USER}/daemon.mjs',
    configDir:root+'/${CREDENTIALS_DIRECTORY}/$NAME',home:root+'/$HOME'});
  const start=unit.split('\n').find(line=>line.startsWith('ExecStart='));
  assert.ok(start.includes(root+'/$$HOME/$${USER}/daemon.mjs'));
  assert.ok(start.includes(root+'/$${CREDENTIALS_DIRECTORY}/$$NAME'));
  const environment=unit.split('\n').find(line=>line.startsWith('Environment='));
  assert.ok(environment.includes(root+'/$HOME/.local/bin'));
  assert.equal(environment.includes('$$HOME'),false);
});
