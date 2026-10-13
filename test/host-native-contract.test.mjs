import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureHostDirectory } from '../src/host-files.mjs';
import { nativeServicePaths, preflightNativeService } from '../src/host-native-service.mjs';
import { preparePersistence } from '../src/host-persistence.mjs';

function fixture(t) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'bridge-native-contract-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const config=join(root,'config');ensureHostDirectory(config);
  return {root,config};
}
test('launchd preflight discards domain output but retains bounded scoped status',{skip:process.platform==='win32'},t=>{
  const {root,config}=fixture(t);
  const paths=nativeServicePaths(config,{platform:'darwin',home:root});
  const calls=[];
  const exec=(command,args,options)=>{
    assert.equal(command,'/bin/launchctl');calls.push(args);
    if(args[1]===paths.domain) {
      assert.equal(options.stdio[1],'ignore','do not buffer or disclose the whole login session');
      return {status:0,stdout:null};
    }
    assert.equal(options.stdio[1],'pipe');assert.equal(options.maxBuffer,32768);
    return {status:113,stdout:''};
  };
  assert.equal(preflightNativeService(paths,{exec}).available,true);
  assert.equal(calls.length,2);
});
test('auto foreground fallback never conceals a foreign Windows task',t=>{
  const {root,config}=fixture(t);
  const exec=(_command,_args,options)=>{
    const input=JSON.parse(options.env.BRIDGE_HOST_DATA);
    return JSON.stringify(input.operation==='probe' ? {available:true,sid:'S-1-5-21-1'} : {failure:'HOST_SERVICE_CONFLICT'});
  };
  assert.throws(()=>preparePersistence(config,{platform:'win32',home:root,exec}),error=>error.code==='HOST_SERVICE_CONFLICT');
});
