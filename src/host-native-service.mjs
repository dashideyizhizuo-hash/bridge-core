import { createHash } from 'node:crypto';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { hostPowerShell, xmlText } from './host-platform.mjs';
import { ensureHostDirectory, readHostFile, safeHostPath, writeHostFile } from './host-files.mjs';
import { BridgeError, assertBridge } from './errors.mjs';
import { windowsAction } from './host-windows-action.mjs';
export { windowsArgument } from './host-windows-action.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
export const taskAccountSidPowerShell=String.raw`
function AccountSid($value) {
  try {
    $value=[string]$value
    if($value -match '^S-1-[0-9-]+$'){return ([Security.Principal.SecurityIdentifier]::new($value)).Value}
    $account=$value
    if($account.IndexOf([char]92) -lt 0 -and $account.IndexOf('@') -lt 0){
      $currentName=[Security.Principal.WindowsIdentity]::GetCurrent().Name
      $separator=$currentName.IndexOf([char]92)
      if($separator -le 0){throw 'Current account authority is unavailable'}
      $account=$currentName.Substring(0,$separator)+([string][char]92)+$value
    }
    return ([Security.Principal.NTAccount]::new($account)).Translate([Security.Principal.SecurityIdentifier]).Value
  } catch {Conflict 'accountIdentity'}
}
`;
const TASK_SCRIPT=`
function Conflict($field='ownership') { @{failure='HOST_SERVICE_CONFLICT';field=$field}|ConvertTo-Json -Compress; exit }
${taskAccountSidPowerShell}
function Match($actual,$expected,$field) {if($actual -cne $expected){Conflict $field}}
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$svc=New-Object -ComObject 'Schedule.Service'
$svc.Connect()
$folder=$svc.GetFolder('\\')
if($d.operation -eq 'probe'){@{available=$true;sid=$sid}|ConvertTo-Json -Compress;exit}
$task=$null
try{$task=$folder.GetTask($d.name)}catch{
  if($_.Exception.HResult -ne -2147024894 -and $_.Exception.HResult -ne -2147216625){throw}
}
if($d.operation -eq 'inspect'){
  if($null -eq $task){@{installed=$false;active=$false;autostartEnabled=$false;sid=$sid}|ConvertTo-Json -Compress;exit}
  if(-not $d.spec){Conflict}
}
if($d.spec -and $d.spec.sid -ne $sid){Conflict}
if($task){
  if(-not $d.spec){Conflict}
  $def=$task.Definition
  Match $def.RegistrationInfo.Description $d.spec.marker 'marker'
  Match (AccountSid $def.Principal.UserId) $sid 'principal'
  Match $def.Principal.LogonType 3 'logonType'
  Match $def.Principal.RunLevel 0 'runLevel'
  Match $def.Actions.Count 1 'actionCount'
  Match $def.Triggers.Count 1 'triggerCount'
  $a=$def.Actions.Item(1);$t=$def.Triggers.Item(1)
  Match $a.Type 0 'actionType'
  Match $a.Path $d.spec.action.path 'executable'
  Match $a.Arguments $d.spec.action.arguments 'arguments'
  Match $a.WorkingDirectory $d.spec.configDir 'workingDirectory'
  Match $t.Type 9 'triggerType'
  Match $t.Enabled $true 'triggerEnabled'
  Match (AccountSid $t.UserId) $sid 'triggerIdentity'
  Match $def.Settings.MultipleInstances 2 'multipleInstances'
  Match ([Xml.XmlConvert]::ToTimeSpan($def.Settings.ExecutionTimeLimit)) ([TimeSpan]::Zero) 'executionLimit'
}
if($d.operation -eq 'install'){
  if(-not $task){
    $def=$svc.NewTask(0)
    $def.RegistrationInfo.Description=$d.spec.marker
    $def.Principal.UserId=$sid;$def.Principal.LogonType=3;$def.Principal.RunLevel=0
    $trigger=$def.Triggers.Create(9);$trigger.UserId=$sid;$trigger.Enabled=$true
    $a=$def.Actions.Create(0);$a.Path=$d.spec.action.path;$a.Arguments=$d.spec.action.arguments;$a.WorkingDirectory=$d.spec.configDir
    $def.Settings.Enabled=$true;$def.Settings.AllowDemandStart=$true;$def.Settings.StartWhenAvailable=$true
    $def.Settings.DisallowStartIfOnBatteries=$false;$def.Settings.StopIfGoingOnBatteries=$false
    $def.Settings.ExecutionTimeLimit='PT0S';$def.Settings.MultipleInstances=2
    $def.Settings.RestartCount=3;$def.Settings.RestartInterval='PT1M'
    $task=$folder.RegisterTaskDefinition($d.name,$def,2,$sid,$null,3,$null)
  }
  $task.Enabled=($d.start -ne $false)
  if($d.start -ne $false -and $task.State -ne 4){[void]$task.Run($null)}
}
if($d.operation -eq 'autostart' -and $task){$task.Enabled=[bool]$d.enabled}
if($d.operation -eq 'stop' -and $task){$task.Enabled=$false;$task.Stop(0)}
if($d.operation -eq 'remove' -and $task){$task.Enabled=$false;$task.Stop(0);$folder.DeleteTask($d.name,0);$task=$null}
@{installed=($null -ne $task);active=($null -ne $task -and $task.State -eq 4);autostartEnabled=($null -ne $task -and $task.Enabled);sid=$sid}|ConvertTo-Json -Compress
`;

export function nativeServicePaths(configDir,{platform=process.platform,home=homedir(),name}={}) {
  assertBridge(['win32','darwin'].includes(platform),'HOST_SERVICE_UNSUPPORTED','Native service platform is unsupported');
  const dir=safeHostPath(configDir),id=hash(dir).slice(0,20);
  const adapter=platform==='win32' ? 'windows-task' : 'launchd';
  const label=name ?? (platform==='win32' ? `BridgeHost-${id}` : `dev.runner-bridge.host.${id}`);
  assertBridge(/^(BridgeHost-[a-f0-9]{20}|dev\.runner-bridge\.host\.[a-f0-9]{20})$/.test(label),
    'HOST_SERVICE_INVALID','Invalid native Host service name');
  return {adapter,configDir:dir,name:label,receiptPath:resolve(dir,adapter+'.json'),
    ...(platform==='darwin' ? {unitPath:safeHostPath(resolve(home,'Library/LaunchAgents',label+'.plist')),
      domain:`gui/${process.getuid()}`} : {})};
}

function receipt(paths) {
  if(!existsSync(paths.receiptPath)) return null;
  const spec=JSON.parse(readHostFile(paths.receiptPath));
  assertBridge(spec.schemaVersion===1 && spec.name===paths.name && spec.configDir===paths.configDir && spec.adapter===paths.adapter,
    'HOST_SERVICE_CONFLICT','Native service receipt does not belong to this configuration');
  return spec;
}
function saveReceipt(paths,spec) {
  const old=receipt(paths);
  assertBridge(!old || JSON.stringify(old)===JSON.stringify(spec),'HOST_SERVICE_CONFLICT',
    'Another runtime is installed; automatic replacement is disabled');
  if(!old) writeHostFile(paths.receiptPath,JSON.stringify(spec)+'\n');
}
function launchctl(args,{exec=spawnSync,discardOutput=false}={}) {
  const result=exec('/bin/launchctl',args,{encoding:'utf8',timeout:15_000,maxBuffer:32_768,
    stdio:['ignore',discardOutput ? 'ignore' : 'pipe','pipe']});
  if(result.error) {const error=new BridgeError('HOST_SERVICE_UNAVAILABLE','Cannot contact the current user launchd session');error.cause=result.error;throw error;}
  return result;
}
function plist(spec) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>
<key>Label</key><string>${xmlText(spec.name)}</string>
<key>ProgramArguments</key><array>${[spec.nodePath,spec.daemonPath,'--config-dir',spec.configDir].map(x=>'<string>'+xmlText(x)+'</string>').join('')}</array>
<key>WorkingDirectory</key><string>${xmlText(spec.configDir)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>5</integer><key>ProcessType</key><string>Background</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xmlText(dirname(spec.nodePath)+':/usr/local/bin:/usr/bin:/bin')}</string></dict>
</dict></plist>\n`;
}
function checkPlist(paths,spec) {
  if(existsSync(paths.unitPath)) assertBridge(spec && readHostFile(paths.unitPath)===plist(spec),
    'HOST_SERVICE_CONFLICT','Existing LaunchAgent does not match its receipt; it was not changed');
}

export function nativeServiceStatus(paths,options={}) {
  const spec=receipt(paths);
  if(paths.adapter==='windows-task') {
    return {...hostPowerShell(TASK_SCRIPT,{operation:'inspect',name:paths.name,spec},options),adapter:paths.adapter,name:paths.name};
  }
  checkPlist(paths,spec);
  const state=launchctl(['print',paths.domain+'/'+paths.name],options);
  assertBridge(state.status!==0 || spec,'HOST_SERVICE_CONFLICT','An unowned LaunchAgent already uses this name');
  return {adapter:paths.adapter,name:paths.name,installed:!!spec,active:state.status===0 && /\bpid = \d+/.test(state.stdout),loaded:state.status===0};
}

export function preflightNativeService(paths,options={}) {
  const spec=receipt(paths);
  if(paths.adapter==='windows-task') {
    try {
      const available=hostPowerShell(TASK_SCRIPT,{operation:'probe'},options);
      nativeServiceStatus(paths,options);return available;
    } catch(cause) {
      if(spec || cause.code==='HOST_SERVICE_CONFLICT') throw cause;
      const error=new BridgeError('HOST_SERVICE_UNAVAILABLE','User Task Scheduler is unavailable; use foreground mode');error.cause=cause;throw error;
    }
  }
  checkPlist(paths,spec);
  assertBridge(launchctl(['print',paths.domain],{...options,discardOutput:true}).status===0,'HOST_SERVICE_UNAVAILABLE',
    'No graphical user launchd session; use foreground mode');
  nativeServiceStatus(paths,options);
  ensureHostDirectory(dirname(paths.unitPath),{privateDirectory:false});
  return {available:true};
}

export async function installNativeService(paths,{daemonPath,nodePath=process.execPath,startupStatus,start=true,
  startupAttempts=60,startupDelayMs=250,...options}={}) {
  [daemonPath,nodePath].forEach(safeHostPath);
  const spec={schemaVersion:1,adapter:paths.adapter,name:paths.name,configDir:paths.configDir,nodePath,daemonPath};
  if(paths.adapter==='windows-task') {
    spec.sid=hostPowerShell(TASK_SCRIPT,{operation:'probe'},options).sid;
    spec.action=windowsAction(spec);spec.marker='Bridge Host '+hash(JSON.stringify(spec));
    saveReceipt(paths,spec);
    hostPowerShell(TASK_SCRIPT,{operation:'install',name:paths.name,spec,start},options);
  } else {
    saveReceipt(paths,spec);checkPlist(paths,spec);
    if(!existsSync(paths.unitPath)) writeFileSync(paths.unitPath,plist(spec),{mode:0o600,flag:'wx'});
    if(!start) return nativeServiceStatus(paths,options);
    assertBridge(launchctl(['enable',paths.domain+'/'+paths.name],options).status===0,'HOST_SERVICE_FAILED','Could not enable the user LaunchAgent');
    if(!nativeServiceStatus(paths,options).loaded) {
      assertBridge(launchctl(['bootstrap',paths.domain,paths.unitPath],options).status===0,'HOST_SERVICE_FAILED','Could not load the user LaunchAgent');
    } else if(!nativeServiceStatus(paths,options).active) {
      assertBridge(launchctl(['kickstart',paths.domain+'/'+paths.name],options).status===0,'HOST_SERVICE_FAILED','Could not start the user LaunchAgent');
    }
  }
  if(!start) return nativeServiceStatus(paths,options);
  let stable=0;
  for(let attempt=0;attempt<startupAttempts;attempt++) {
    const state=nativeServiceStatus(paths,options);
    const runtime=startupStatus?.();
    stable=state.active && (!startupStatus || runtime?.localReady) ? stable+1 : 0;
    if(stable>=2) return {...state,...(runtime ? {runtime} : {}),bootScope:'user-login-session'};
    await delay(startupDelayMs);
  }
  throw new BridgeError('HOST_SERVICE_FAILED','Host is paired but its daemon did not become ready. Check runtime visibility and permissions; identity is retained. Repair or stop the task before foreground mode');
}

export function stopNativeService(paths,options={}) {
  const spec=receipt(paths);nativeServiceStatus(paths,options);
  assertBridge(spec,'HOST_SERVICE_UNAVAILABLE','No managed native service is installed');
  if(paths.adapter==='windows-task') hostPowerShell(TASK_SCRIPT,{operation:'stop',name:paths.name,spec},options);
  else {
    assertBridge(launchctl(['disable',paths.domain+'/'+paths.name],options).status===0,'HOST_SERVICE_FAILED','Could not disable LaunchAgent');
    if(nativeServiceStatus(paths,options).loaded) assertBridge(launchctl(['bootout',paths.domain+'/'+paths.name],options).status===0,
      'HOST_SERVICE_FAILED','Could not stop LaunchAgent');
  }
  return {stopped:true,credentialsRetained:true,adapter:paths.adapter};
}

export function removeNativeService(paths,options={}) {
  const spec=receipt(paths);nativeServiceStatus(paths,options);
  assertBridge(spec,'HOST_SERVICE_UNAVAILABLE','No owned native service is installed');
  stopNativeService(paths,options);
  if(paths.adapter==='windows-task') hostPowerShell(TASK_SCRIPT,{operation:'remove',name:paths.name,spec},options);
  else if(existsSync(paths.unitPath)) unlinkSync(paths.unitPath);
  unlinkSync(paths.receiptPath);
}

export function setNativeServiceAutostart(paths,enabled,options={}) {
  assertBridge(typeof enabled==='boolean','HOST_USAGE_INVALID','Autostart must be on or off');
  assertBridge(paths.adapter==='windows-task','HOST_SERVICE_UNSUPPORTED','Autostart controls currently support Windows and Linux only');
  const spec=receipt(paths),state=nativeServiceStatus(paths,options);
  assertBridge(spec && state.installed,'HOST_SERVICE_UNAVAILABLE','Run setup --background before changing autostart');
  // TASK_SCRIPT revalidates SID, action, trigger and marker before setting Enabled.
  // It deliberately calls neither Run nor Stop for this operation.
  const result=hostPowerShell(TASK_SCRIPT,{operation:'autostart',name:paths.name,spec,enabled},options);
  assertBridge(result.autostartEnabled===enabled,'HOST_SERVICE_FAILED','Could not verify the user-task autostart setting');
  return {...result,adapter:paths.adapter,name:paths.name};
}
