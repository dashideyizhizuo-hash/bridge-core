import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeReporter, readRuntimeStatus } from '../src/host-runtime-status.mjs';
import { ensureHostDirectory, readHostFile } from '../src/host-files.mjs';
function fixture(t) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'bridge-status-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const dir=join(root,'config');ensureHostDirectory(dir);let now=100_000;
  const clock=()=>now;
  return {dir,clock,report:createRuntimeReporter({configDir:dir,daemonPath:join(root,'daemon.mjs'),clock}),
    advance:ms=>{now+=ms;},read:()=>readRuntimeStatus(dir,{clock,alive:()=>true})};
}
test('readiness and cloud contact are separate; stopped/dead/stale diagnostics are not healthy',t=>{
  const f=fixture(t);assert.equal(f.read().localReady,false);
  f.report({phase:'ready'});assert.equal(f.read().localReady,true);assert.equal(f.read().connected,false);
  f.advance(1000);f.report({phase:'connected'});assert.equal(f.read().connected,true);
  assert.equal(readRuntimeStatus(f.dir,{clock:f.clock,alive:()=>false}).localReady,false);
  f.advance(121000);assert.equal(f.read().localReady,false);
  f.report({phase:'stopped'});assert.equal(f.read().localReady,false);
});
test('retry diagnostics never persist remote messages or credentials; writes are throttled',t=>{
  const f=fixture(t);f.report({phase:'connected'});
  const before=readHostFile(join(f.dir,'runtime-status.json'));
  f.advance(1000);f.report({phase:'connected'});
  assert.equal(readHostFile(join(f.dir,'runtime-status.json')),before);
  f.report({phase:'retrying',code:'token=secret',message:'secret',argv:['private']});
  const raw=readHostFile(join(f.dir,'runtime-status.json'));assert.doesNotMatch(raw,/secret|argv|message/);
  assert.equal(f.read().code,'HOST_RUNTIME_FAILED');assert.equal(f.read().connected,false);
  f.advance(31000);f.report({phase:'connected'});assert.equal(f.read().connected,true);
});
test('invalid diagnostic timestamps fail closed',t=>{
  const f=fixture(t);f.report({phase:'ready'});const path=join(f.dir,'runtime-status.json');
  const data=JSON.parse(readHostFile(path));writeFileSync(path,JSON.stringify({...data,updatedAt:data.startedAt-1}));
  assert.throws(f.read,error=>error.code==='HOST_STATUS_INVALID');
});
