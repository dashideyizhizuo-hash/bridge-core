import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { hostPowerShell } from '../src/host-platform.mjs';
import { taskAccountSidPowerShell } from '../src/host-native-service.mjs';
import { windowsAction } from '../src/host-windows-action.mjs';

const testEnvironment=()=>Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|^GH_|^GITHUB_)/i.test(key)));
function alive(pid) {try{process.kill(pid,0);return true;}catch{return false;}}

test('task conflict diagnostics expose a bounded field, never the registration payload',()=>{
  assert.throws(()=>hostPowerShell('',{},{exec:()=>JSON.stringify({failure:'HOST_SERVICE_CONFLICT',field:'principal'})}),
    error=>error.code==='HOST_SERVICE_CONFLICT' && error.details.field==='principal');
  assert.throws(()=>hostPowerShell('',{},{exec:()=>JSON.stringify({failure:'HOST_SERVICE_CONFLICT',field:'secret-token=bad'})}),
    error=>error.details.field==='ownership' && !JSON.stringify(error.details).includes('secret'));
});
test('Task Scheduler short account aliases resolve within current authority to the actual SID',
  {skip:process.platform!=='win32'},()=>{
  const script=`function Conflict($field='ownership'){@{failure='HOST_SERVICE_CONFLICT';field=$field}|ConvertTo-Json -Compress;exit}
${taskAccountSidPowerShell}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$definition=(New-Object -ComObject 'Schedule.Service').NewTask(0)
$definition.Principal.UserId=$sid
$trigger=$definition.Triggers.Create(9);$trigger.UserId=$sid
$principal=$definition.Principal.UserId;$triggerUser=$trigger.UserId
@{sid=$sid;principal=$principal;principalSid=(AccountSid $principal);trigger=$triggerUser;triggerSid=(AccountSid $triggerUser);
 systemSid=(AccountSid 'S-1-5-18');systemNameSid=(AccountSid 'NT AUTHORITY\\SYSTEM')}|ConvertTo-Json -Compress`;
  const result=hostPowerShell(script,{});
  assert.equal(result.principalSid,result.sid);
  assert.equal(result.triggerSid,result.sid);
  assert.notEqual(result.systemSid,result.sid);
  assert.equal(result.systemSid,'S-1-5-18');
  assert.equal(result.systemNameSid,'S-1-5-18');
  assert.equal(result.principal.includes('\\'),false,'Task Scheduler fixture must exercise its unqualified account representation');
  assert.equal(result.trigger.includes('\\'),false,'Task Scheduler fixture must exercise its unqualified account representation');
});
test('Task Scheduler short names that cannot resolve in current authority fail closed',
  {skip:process.platform!=='win32'},()=>{
  const missing=`CodexMissing_${randomUUID().replaceAll('-','')}`;
  const script=`function Conflict($field='ownership'){@{failure='HOST_SERVICE_CONFLICT';field=$field}|ConvertTo-Json -Compress;exit}
${taskAccountSidPowerShell}
[void](AccountSid '${missing}')`;
  assert.throws(()=>hostPowerShell(script,{}),error=>
    error.code==='HOST_SERVICE_CONFLICT' && error.details.field==='accountIdentity');
});
test('Windows action retries failed children with bounded backoff and a lifetime-owned Job',()=>{
  const action=windowsAction({nodePath:'C:\\Node\\node.exe',daemonPath:'C:\\user $HOME & 中文\\daemon.mjs',configDir:'C:\\user $HOME & 中文'});
  const source=Buffer.from(action.arguments.split(' ').at(-1),'base64').toString('utf16le');
  assert.equal(source.includes('C:\\Node'),false);assert.equal(source.includes('中文'),false);
  assert.ok(source.includes('$s.UseShellExecute=$false'));
  assert.ok(source.includes('$child.WaitForExit()'));
  assert.ok(source.includes('if($code -eq 0){exit 0}'));
  assert.ok(source.includes('[Threading.Thread]::Sleep($backoffMs)'));
  assert.ok(source.includes('[Math]::Min(30000,$backoffMs*2)'));
  assert.ok(source.includes('JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE'));
  assert.ok(source.includes('CreateJobObjectW(IntPtr.Zero,null)'));
  assert.ok(source.includes('AssignProcessToJobObject(job,GetCurrentProcess())'));
  assert.ok(source.indexOf('[BridgeHostJob]::Attach()')<source.indexOf('[Diagnostics.Process]::Start($s)'));
});
test('real Windows action retries a failed child, then honors its clean exit',
  {skip:process.platform!=='win32'},t=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'bridge-action-retry-')));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const daemonPath=join(root,'child $HOME & 中文.mjs'),count=join(root,'attempts');
  writeFileSync(daemonPath,`import {existsSync,readFileSync,writeFileSync} from 'node:fs'; const file=${JSON.stringify(count)}; const n=existsSync(file)?Number(readFileSync(file,'utf8'))+1:1; writeFileSync(file,String(n)); process.exit(n===1?7:0);`);
  const action=windowsAction({nodePath:process.execPath,daemonPath,configDir:root});
  const started=Date.now();
  const result=spawnSync(action.path,action.arguments.split(' '),{env:testEnvironment(),encoding:'utf8',timeout:20_000,maxBuffer:8192,windowsHide:true,stdio:['pipe','pipe','pipe'],input:''});
  assert.equal(result.error,undefined,result.error?.message);
  assert.equal(result.status,0,result.stderr);
  assert.equal(readFileSync(count,'utf8'),'2');
  assert.ok(Date.now()-started>=5000,'failed children must not spin in a tight restart loop');
});
test('force-killing a real Windows launcher terminates its child and grandchild through Job ownership',
  {skip:process.platform!=='win32'},async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'bridge-action-job-')));
  const daemonPath=join(root,'tree.mjs'),marker=join(root,'pids.json');
  writeFileSync(daemonPath,`import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(marker)},JSON.stringify({parent:process.pid,child:child.pid}));setInterval(()=>{},1000);`);
  const action=windowsAction({nodePath:process.execPath,daemonPath,configDir:root});
  const launcher=spawn(action.path,action.arguments.split(' '),{env:testEnvironment(),windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stderr='';launcher.stderr.on('data',chunk=>{stderr+=chunk.toString().slice(0,8192-stderr.length);});
  launcher.stdout.resume();launcher.stdin.end();
  const closed=new Promise((resolve,reject)=>{launcher.once('close',resolve);launcher.once('error',reject);});
  let pids={};
  try {
    for(let n=0;n<150 && !existsSync(marker);n++) await delay(100);
    assert.ok(existsSync(marker),'Native job-scoped child must start: '+stderr);
    pids=JSON.parse(readFileSync(marker,'utf8'));
    assert.ok(alive(pids.parent));assert.ok(alive(pids.child));
    launcher.kill('SIGKILL');await closed;
    for(let n=0;n<100 && (alive(pids.parent)||alive(pids.child));n++) await delay(100);
    assert.equal(alive(pids.parent),false,'Job handle closure must terminate Node');
    assert.equal(alive(pids.child),false,'Job handle closure must terminate its descendants');
  } finally {
    if(alive(launcher.pid)){launcher.kill('SIGKILL');await closed;}
    for(const pid of Object.values(pids)) if(alive(pid)) try{process.kill(pid,'SIGKILL');}catch{}
    rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});
