import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync } from 'node:fs';
import {makeTestDirectory as mkdtempSync} from './helpers/canonical-temp.mjs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { hostServicePaths, installHostService } from '../src/host-service.mjs';

function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'bridge-systemd-ready-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const paths=hostServicePaths(join(root,'config'),{home:root,env:{}});
  mkdirSync(paths.configDir,{recursive:true,mode:0o700});
  mkdirSync(dirname(paths.unitPath),{recursive:true,mode:0o700});
  return {paths,options:{hostId:'host-ready-test',daemonPath:join(root,'daemon.mjs'),home:root,
    exec:(_exe,args)=>({status:0,stdout:args.includes('is-active')?'active\n':''}),
    startupAttempts:3,startupDelayMs:0}};
}

test('systemd active alone cannot report daemon startup success',{skip:process.platform!=='linux'},async t=>{
  for(const state of [undefined,{localReady:false,phase:'unknown'},{localReady:false,phase:'failed'}]) {
    const f=fixture(t);
    await assert.rejects(installHostService(f.paths,{...f.options,startupStatus:()=>state}),
      error=>error.code==='HOST_SERVICE_FAILED');
  }
});
test('systemd waits for local readiness without requiring cloud connectivity',{skip:process.platform!=='linux'},async t=>{
  const f=fixture(t);let polls=0;
  const result=await installHostService(f.paths,{...f.options,
    startupStatus:()=>({localReady:++polls>=2,connected:false})});
  assert.equal(polls,3);assert.equal(result.runtime.localReady,true);assert.equal(result.runtime.connected,false);
});
