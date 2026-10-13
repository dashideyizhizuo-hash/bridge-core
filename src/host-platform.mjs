import { execFileSync } from 'node:child_process';
import { win32 } from 'node:path';
import { BridgeError, assertBridge } from './errors.mjs';

export function powershellPath(env=process.env) {
  const root=env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
  assertBridge(/^[A-Za-z]:\\[^\x00-\x1f]*$/.test(root),'HOST_PLATFORM_INVALID','Invalid Windows system directory');
  return win32.join(root,'System32','WindowsPowerShell','v1.0','powershell.exe');
}

// Only constant scripts are executed; variable values are JSON data, never
// interpolated PowerShell source. No shell, profile, elevation, policy change,
// or account/runner secret is passed to these native OS helpers.
const PRELUDE=String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$PSModuleAutoLoadingPreference='None'
foreach($module in @('Microsoft.PowerShell.Utility','Microsoft.PowerShell.Management','Microsoft.PowerShell.Security')) {
  Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules',$module,($module+'.psd1'))) -ErrorAction Stop
}
$d=ConvertFrom-Json $env:BRIDGE_HOST_DATA
`;

export function hostPowerShell(script,data,{exec=execFileSync}={}) {
  const env={BRIDGE_HOST_DATA:JSON.stringify(data)};
  for(const key of ['SystemRoot','SYSTEMROOT','SystemDrive','WINDIR','TEMP','TMP',
    'USERPROFILE','LOCALAPPDATA','APPDATA','ProgramData','ALLUSERSPROFILE','PUBLIC',
    'ProgramFiles','ProgramFiles(x86)','ProgramW6432','CommonProgramFiles',
    'CommonProgramFiles(x86)','CommonProgramW6432','HOMEDRIVE','HOMEPATH',
    'USERNAME','USERDOMAIN','USERDOMAIN_ROAMINGPROFILE','COMPUTERNAME',
    'PROCESSOR_ARCHITECTURE','PROCESSOR_IDENTIFIER','PROCESSOR_LEVEL',
    'PROCESSOR_REVISION','NUMBER_OF_PROCESSORS','OS']) {
    if(process.env[key]!==undefined) env[key]=process.env[key];
  }
  const system=win32.dirname(win32.dirname(win32.dirname(powershellPath())));
  const psHome=win32.dirname(powershellPath());
  env.PATH=[system,psHome].join(';');
  env.PSModulePath=win32.join(psHome,'Modules');
  env.ComSpec=win32.join(system,'cmd.exe');
  try {
    const output=exec(powershellPath(),['-NoLogo','-NoProfile','-NonInteractive','-InputFormat','Text','-OutputFormat','Text','-EncodedCommand',
      Buffer.from(PRELUDE+script,'utf16le').toString('base64')],
    {env,encoding:'utf8',timeout:20_000,maxBuffer:64*1024,windowsHide:true,stdio:['pipe','pipe','pipe'],input:''});
    const result=JSON.parse(output.trim().replace(/^\uFEFF/,''));
    if(result.failure==='HOST_SERVICE_CONFLICT') throw new BridgeError('HOST_SERVICE_CONFLICT','Existing Windows task is not owned by this Host configuration',
      {field:/^[A-Za-z]{1,32}$/.test(result.field ?? '') ? result.field : 'ownership'});
    return result;
  } catch(cause) {
    if(cause instanceof BridgeError) throw cause;
    const error=new BridgeError('HOST_PLATFORM_FAILED','Windows operation failed; no credential or remote response was printed');
    error.cause=cause;throw error;
  }
}

export function xmlText(value) {
  assertBridge(typeof value==='string' && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value),
    'HOST_SERVICE_INVALID','Invalid property-list string');
  return value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')
    .replaceAll('"','&quot;').replaceAll("'",'&apos;');
}
