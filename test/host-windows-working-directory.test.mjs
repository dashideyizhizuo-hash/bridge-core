import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,win32} from 'node:path';
import {makeTestDirectory} from './helpers/canonical-temp.mjs';
import {hostPowerShell,powershellPath} from '../src/host-platform.mjs';
import {ensureHostDirectory,writeHostFile} from '../src/host-files.mjs';
import {nativeServicePaths,nativeServiceStatus,installNativeService} from '../src/host-native-service.mjs';
import {windowsAction} from '../src/host-windows-action.mjs';
import {maintainHost} from '../src/host-maintenance.mjs';

const systemDirectory=()=>win32.dirname(win32.dirname(win32.dirname(powershellPath())));
const code=value=>error=>error.code===value;

test('Windows scheduler action starts in trusted System32 while its Node child keeps the private cwd',()=>{
  const configDir='C:\\private Host fixture & 中文';
  const action=windowsAction({nodePath:'C:\\Node\\node.exe',daemonPath:configDir+'\\daemon.mjs',configDir});
  assert.equal(action.workingDirectory,systemDirectory());
  assert.notEqual(action.workingDirectory,configDir);
  const source=Buffer.from(action.arguments.split(' ').at(-1),'base64').toString('utf16le');
  assert.match(source,/\$s\.WorkingDirectory=\$p\.configDir/);
});

function taskScript(){
  let source;
  nativeServiceStatus({adapter:'windows-task',name:'in-memory-task-fixture',receiptPath:join(tmpdir(),randomUUID())},{
    exec:(_exe,args)=>{source=Buffer.from(args.at(-1),'base64').toString('utf16le');return '{"installed":false,"active":false}';}
  });
  const start=source.indexOf('function Conflict(');
  assert.ok(start>=0,'The captured production ownership script must be present');
  return source.slice(start);
}

// Exercise the actual ownership script against in-memory COM-shaped metadata.
// New-Object is shadowed only for Schedule.Service; no Task is registered/run.
const memoryTask=String.raw`
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$d.spec.sid=$sid
$fixtureAction=[pscustomobject]@{Type=0;Path=$d.spec.action.path;Arguments=$d.spec.action.arguments;WorkingDirectory=$d.actualWorkingDirectory}
$fixtureTrigger=[pscustomobject]@{Type=9;Enabled=$true;UserId=$sid}
$fixtureActions=[pscustomobject]@{Count=1}
$fixtureActions|Add-Member ScriptMethod Item {param($index);return $script:fixtureAction}
$fixtureTriggers=[pscustomobject]@{Count=1}
$fixtureTriggers|Add-Member ScriptMethod Item {param($index);return $script:fixtureTrigger}
$fixtureDefinition=[pscustomobject]@{
 RegistrationInfo=[pscustomobject]@{Description=$d.spec.marker}
 Principal=[pscustomobject]@{UserId=$sid;LogonType=3;RunLevel=0}
 Actions=$fixtureActions;Triggers=$fixtureTriggers
 Settings=[pscustomobject]@{MultipleInstances=2;ExecutionTimeLimit='PT0S'}
}
$fixtureTask=[pscustomobject]@{Definition=$fixtureDefinition;State=3;Enabled=$true}
$fixtureFolder=[pscustomobject]@{}
$fixtureFolder|Add-Member ScriptMethod GetTask {param($name);return $script:fixtureTask}
$fixtureService=[pscustomobject]@{}
$fixtureService|Add-Member ScriptMethod Connect {}
$fixtureService|Add-Member ScriptMethod GetFolder {param($path);return $script:fixtureFolder}
function New-Object {param([string]$ComObject);if($ComObject -cne 'Schedule.Service'){throw 'Unexpected fixture COM request'};return $script:fixtureService}
`;

for(const [label,declared,actual,accepted] of [
  ['legacy exact private cwd',undefined,'private',true],
  ['legacy refuses a system cwd substitution',undefined,'system',false],
  ['new exact system cwd','system','system',true],
  ['new refuses a private cwd substitution','system','private',false]
]) test(`Task ownership validates ${label}`,{skip:process.platform!=='win32'},()=>{
  const configDir='C:\\private fixture';
  const spec={sid:'set-only-inside-fixture',configDir,marker:'in-memory-owned-marker',
    action:{path:powershellPath(),arguments:'fixed-no-op-fixture-never-launched',
      ...(declared ? {workingDirectory:systemDirectory()} : {})}};
  const run=()=>hostPowerShell(memoryTask+taskScript(),{
    operation:'inspect',name:'in-memory-task-fixture',spec,
    actualWorkingDirectory:actual==='system'?systemDirectory():configDir
  });
  if(accepted)assert.equal(run().installed,true);
  else assert.throws(run,error=>error.code==='HOST_SERVICE_CONFLICT'&&error.details.field==='workingDirectory');
});

test('Task ownership treats differently cased WorkingDirectory as legacy metadata, not a cwd grant',
  {skip:process.platform!=='win32'},()=>{
  const configDir='C:\\private case-sensitive fixture';
  const spec={sid:'set-only-inside-fixture',configDir,marker:'in-memory-case-marker',
    action:{path:powershellPath(),arguments:'fixed-no-op-fixture-never-launched',WorkingDirectory:systemDirectory()}};
  assert.equal(Object.hasOwn(spec.action,'workingDirectory'),false);
  const run=actualWorkingDirectory=>hostPowerShell(memoryTask+taskScript(),{
    operation:'inspect',name:'in-memory-task-fixture',spec,actualWorkingDirectory
  });
  assert.throws(()=>run(systemDirectory()),error=>error.code==='HOST_SERVICE_CONFLICT'&&error.details.field==='workingDirectory');
  assert.equal(run(configDir).installed,true,'Case-variant metadata must retain the exact legacy private cwd');
});

function legacyReceiptFixture(t){
  const root=makeTestDirectory(join(tmpdir(),'bridge-legacy-cwd-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const config=join(root,'config');ensureHostDirectory(config);
  const paths=nativeServicePaths(config,{platform:'win32'}),sid='S-1-5-21-1000';
  const spec={schemaVersion:1,adapter:paths.adapter,name:paths.name,configDir:config,
    nodePath:process.execPath,daemonPath:join(root,'legacy-daemon.mjs'),sid};
  const action=windowsAction(spec);delete action.workingDirectory;
  spec.action=action;spec.marker='Bridge Host '+createHash('sha256').update(JSON.stringify(spec)).digest('hex');
  writeHostFile(paths.receiptPath,JSON.stringify(spec)+'\n');
  let installs=0,registered=true,active=false,enabled=false;
  const options={start:false,platform:'win32',home:root,env:{},runtimeStatus:()=>({localReady:false}),exec:(_exe,_args,options)=>{
    const data=JSON.parse(options.env.BRIDGE_HOST_DATA);
    if(data.operation==='probe')return JSON.stringify({available:true,sid});
    if(!registered&&data.operation==='inspect')return JSON.stringify({installed:false,active:false,autostartEnabled:false,sid});
    if(JSON.stringify(data.spec)!==JSON.stringify(spec))return '{"failure":"HOST_SERVICE_CONFLICT","field":"fixtureReceipt"}';
    if(data.operation==='install'){installs++;registered=true;active=data.start!==false;enabled=active;}
    if(data.operation==='stop'){active=false;enabled=false;}
    if(data.operation==='remove'){registered=false;active=false;enabled=false;}
    if(data.operation==='autostart')enabled=data.enabled;
    return JSON.stringify({installed:registered,active,autostartEnabled:enabled,sid});
  }};
  return {paths,spec,options,installs:()=>installs};
}

test('reinstalling a canonical legacy receipt reuses its exact action and marker for maintenance restore',async t=>{
  const f=legacyReceiptFixture(t),before=readFileSync(f.paths.receiptPath,'utf8');
  const state=await installNativeService(f.paths,{...f.options,nodePath:f.spec.nodePath,daemonPath:f.spec.daemonPath});
  assert.equal(state.installed,true);assert.equal(f.installs(),1);
  assert.equal(readFileSync(f.paths.receiptPath,'utf8'),before);
});

test('maintenance uninstall and rollback restore a legacy receipt without introducing new action fields',async t=>{
  const f=legacyReceiptFixture(t),before=readFileSync(f.paths.receiptPath,'utf8');
  assert.equal((await maintainHost(f.paths.configDir,'uninstall',f.options)).completed,true);
  assert.equal(nativeServiceStatus(f.paths,f.options).installed,false);
  assert.equal((await maintainHost(f.paths.configDir,'rollback',f.options)).completed,true);
  assert.equal(f.installs(),1);
  assert.equal(readFileSync(f.paths.receiptPath,'utf8'),before);
  assert.equal(Object.hasOwn(JSON.parse(before).action,'workingDirectory'),false);
});

for(const changed of ['nodePath','daemonPath'])test(`legacy action reuse rejects changed canonical ${changed}`,async t=>{
  const f=legacyReceiptFixture(t),before=readFileSync(f.paths.receiptPath,'utf8');
  const args={...f.options,nodePath:f.spec.nodePath,daemonPath:f.spec.daemonPath,[changed]:join(f.paths.configDir,'different-runtime')};
  await assert.rejects(installNativeService(f.paths,args),code('HOST_SERVICE_CONFLICT'));
  assert.equal(f.installs(),0);assert.equal(readFileSync(f.paths.receiptPath,'utf8'),before);
});

for(const value of [null,'','C:\\untrusted working directory'])test(`receipt refuses an explicitly invalid scheduler cwd ${JSON.stringify(value)}`,t=>{
  const f=legacyReceiptFixture(t);f.spec.action.workingDirectory=value;
  writeFileSync(f.paths.receiptPath,JSON.stringify(f.spec)+'\n');
  let calls=0;
  assert.throws(()=>nativeServiceStatus(f.paths,{exec:()=>{calls++;return '{"installed":true,"active":false}';}}),
    code('HOST_SERVICE_CONFLICT'));
  assert.equal(calls,0,'An invalid receipt cannot authorize a Task operation');
});

test('legacy action reuse refuses a different current SID before any registration mutation',async t=>{
  const f=legacyReceiptFixture(t),exec=f.options.exec;let mutations=0;
  const options={...f.options,exec:(exe,args,options)=>{
    const input=JSON.parse(options.env.BRIDGE_HOST_DATA);
    if(input.operation==='probe')return '{"available":true,"sid":"S-1-5-21-2000"}';
    if(input.operation==='install')mutations++;
    return exec(exe,args,options);
  }};
  await assert.rejects(installNativeService(f.paths,{...options,nodePath:f.spec.nodePath,daemonPath:f.spec.daemonPath}),code('HOST_SERVICE_CONFLICT'));
  assert.equal(mutations,0);
});
