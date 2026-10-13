import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,mkdirSync,existsSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {ensureHostDirectory,writeHostFile} from '../src/host-files.mjs';
import {hostServicePaths,installHostService} from '../src/host-service.mjs';
import {nativeServicePaths,installNativeService} from '../src/host-native-service.mjs';
import {persistenceStatus,setPersistenceAutostart,stopPersistence} from '../src/host-persistence.mjs';
function fixture(t){const root=realpathSync(mkdtempSync(join(tmpdir(),'bridge-autostart-')));t.after(()=>rmSync(root,{recursive:true,force:true}));const config=join(root,'config');ensureHostDirectory(config);return {root,config};}

test('systemd autostart is independent from running state and unknown status is not false',{skip:process.platform!=='linux'},async t=>{
  const f=fixture(t);let active=false,enabled=false,unknown=false;const calls=[];
  const options={platform:'linux',env:{},home:f.root,exec:(_exe,args)=>{
    calls.push(args);
    if(args.includes('enable')){enabled=true;if(args.includes('--now'))active=true;}
    if(args.includes('disable')){enabled=false;if(args.includes('--now'))active=false;}
    if(args.includes('is-active'))return {status:active?0:3,stdout:active?'active\n':'inactive\n'};
    if(args.includes('is-enabled'))return {status:enabled?0:1,stdout:unknown?'unexpected\n':enabled?'enabled\n':'disabled\n'};
    return {status:0,stdout:''};
  }};
  const paths=hostServicePaths(f.config,options);mkdirSync(dirname(paths.unitPath),{recursive:true,mode:0o700});
  await installHostService(paths,{...options,hostId:'fixture',daemonPath:join(f.root,'daemon.mjs')});
  let state=setPersistenceAutostart(f.config,false,options);
  assert.equal(state.active,true);assert.equal(state.autostart.enabled,false);
  assert.deepEqual(calls.filter(args=>args.includes('disable')).at(-1),['--user','disable',paths.unitName]);
  stopPersistence(f.config,options);
  state=setPersistenceAutostart(f.config,true,options);
  assert.equal(state.active,false);assert.equal(state.autostart.enabled,true);
  assert.equal(state.autostart.scope,'systemd-user-session');assert.match(state.autostart.condition,/WSL/);
  assert.deepEqual(calls.filter(args=>args.includes('enable')).at(-1),['--user','enable',paths.unitName]);
  unknown=true;assert.equal(persistenceStatus(f.config,options).autostart.enabled,null);
  assert.throws(()=>setPersistenceAutostart(f.config,true,options),e=>e.code==='HOST_SERVICE_FAILED');
  assert.equal(existsSync(join(f.config,'.setup-lock')),false);
  writeFileSync(paths.unitPath,'foreign unit',{mode:0o600});
  const before=calls.length;
  assert.throws(()=>setPersistenceAutostart(f.config,false,options),e=>e.code==='HOST_SERVICE_CONFLICT');assert.equal(calls.length,before);
});

test('Windows autostart preserves activity, validates ownership and respects setup lock',async t=>{
  const f=fixture(t);let registered=false,active=false,enabled=false;const calls=[];
  const options={platform:'win32',home:f.root,exec:(_exe,_args,opts)=>{
    const d=JSON.parse(opts.env.BRIDGE_HOST_DATA);calls.push(d.operation);
    if(d.operation==='install'){registered=true;enabled=d.start!==false;active=enabled;}
    if(d.operation==='autostart')enabled=d.enabled;
    if(d.operation==='stop'){enabled=false;active=false;}
    return JSON.stringify({sid:'S-1-5-21-fixture',available:true,installed:registered,active,autostartEnabled:enabled});
  }};
  const paths=nativeServicePaths(f.config,options),daemonPath=join(f.root,'daemon.mjs');
  await installNativeService(paths,{...options,daemonPath,start:false});
  let state=setPersistenceAutostart(f.config,true,options);assert.equal(state.active,false);assert.equal(state.autostart.enabled,true);
  await installNativeService(paths,{...options,daemonPath});
  state=setPersistenceAutostart(f.config,false,options);assert.equal(state.active,true);assert.equal(state.autostart.enabled,false);
  assert.equal(state.autostart.scope,'user-login');assert.match(state.autostart.condition,/signs in/);
  stopPersistence(f.config,options);state=persistenceStatus(f.config,options);assert.equal(state.active,false);assert.equal(state.autostart.enabled,false);
  const lock=join(f.config,'.setup-lock');mkdirSync(lock,{mode:0o700});const before=calls.length;
  assert.throws(()=>setPersistenceAutostart(f.config,true,options),e=>e.code==='HOST_SETUP_BUSY');assert.equal(calls.length,before);rmSync(lock,{recursive:true});
  writeHostFile(join(f.config,'maintenance-pending.json'),'{}');
  assert.throws(()=>setPersistenceAutostart(f.config,true,options),e=>e.code==='HOST_MAINTENANCE_INCOMPLETE');assert.equal(calls.length,before);
  assert.equal(existsSync(lock),false);
});

test('autostart CLI validates subcommands before accessing Host configuration',t=>{
  const f=fixture(t),cli=resolve('bin/bridge-host.mjs');
  for(const args of [['autostart'],['autostart','invalid'],['autostart','on','extra'],['autostart','on','--foreground']]){
    const result=spawnSync(process.execPath,[cli,...args,'--config-dir',f.config],{encoding:'utf8'});
    assert.equal(result.status,65);assert.equal(JSON.parse(result.stderr).code,'HOST_USAGE_INVALID');
  }
  const result=spawnSync(process.execPath,[cli,'autostart','status','--config-dir',f.config],{encoding:'utf8'});
  assert.equal(result.status,0);const status=JSON.parse(result.stdout);
  assert.equal(status.installed,false);assert.equal(status.autostart.enabled,false);
});
