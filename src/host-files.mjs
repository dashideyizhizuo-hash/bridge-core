import { lstatSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { hostPowerShell } from './host-platform.mjs';
import { assertBridge } from './errors.mjs';

export function defaultHostConfigDirectory(env=process.env,home=homedir(),platform=process.platform) {
  if(env.XDG_CONFIG_HOME)return resolve(env.XDG_CONFIG_HOME,'bridge');
  if(platform==='win32') {
    const legacy=resolve(env.LOCALAPPDATA || resolve(home,'AppData/Local'),'bridge');
    // Preserve paired, partial and busy legacy installations. Packaged apps
    // can virtualize newly created AppData directories, hiding them from tasks.
    if(existsSync(legacy))return legacy;
  }
  return resolve(home,'.config','bridge');
}

export function assertSharedHostPath(value,{platform=process.platform,realpath=realpathSync.native}={}) {
  if(platform!=='win32')return;
  let path=safeHostPath(value);
  while(!existsSync(path) && path!==dirname(path))path=dirname(path);
  let physical=realpath(path);
  // Normalize only a local Win32 drive prefix. Shares, device paths and
  // junctions retain the existing rejection.
  if(typeof physical==='string' && /^\\\\\?\\[A-Za-z]:\\/.test(physical))physical=physical.slice(4);
  assertBridge(typeof physical==='string' && safeHostPath(physical).toLowerCase()===path.toLowerCase(),
    'HOST_PATH_NOT_SHARED',
    'Background Host storage must be visible outside this terminal app. Use a non-virtualized directory under your user profile; retain existing identity files and do not re-pair.');
}

// Same current-user + SYSTEM allow-list as the durable-task credential store.
// Applied BEFORE secrets are created; mode=0600 is not an ACL on Windows.
const ACL_SCRIPT=`
$path=$d.path
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$item=Get-Item -LiteralPath $path -Force
if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Reparse point denied'}
$acl=Get-Acl -LiteralPath $path
if($d.create){
  $acl.SetAccessRuleProtection($true,$false)
  foreach($r in @($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))){[void]$acl.RemoveAccessRuleSpecific($r)}
  $acl.SetOwner($sid)
  $inherit=if($item.PSIsContainer){[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}else{[Security.AccessControl.InheritanceFlags]::None}
  foreach($id in @($sid,$system)){
    $r=[Security.AccessControl.FileSystemAccessRule]::new($id,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
    [void]$acl.AddAccessRule($r)
  }
  Set-Acl -LiteralPath $path -AclObject $acl
  $acl=Get-Acl -LiteralPath $path
}
$owner=$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
if($owner -ne $sid.Value -and $owner -ne $system.Value){throw 'Unexpected owner'}
$full=$false
foreach($r in @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))){
  if($r.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow){
    if($r.IdentityReference.Value -ne $sid.Value -and $r.IdentityReference.Value -ne $system.Value){throw 'Unexpected ACL reader'}
    if($r.IdentityReference.Value -eq $sid.Value -and ($r.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl){$full=$true}
  }
}
if(-not $full){throw 'Current user needs control'}
@{ok=$true;sid=$sid.Value}|ConvertTo-Json -Compress
`;

export function safeHostPath(value) {
  assertBridge(typeof value==='string' && isAbsolute(value) && !/[\x00-\x1f\x7f]/.test(value),
    'HOST_PATH_INVALID','Host paths must be absolute and contain no control characters');
  const path=resolve(value);
  if(process.platform==='win32') {
    assertBridge(/^[A-Za-z]:\\/.test(path) && !path.startsWith('\\\\') &&
      !/[<>:"|?*]/.test(path.slice(3)) && !path.slice(3).split('\\').some(part=>
        /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)),
    'HOST_PATH_INVALID','Host state requires a normal local Windows path, not a device, share, or alternate data stream');
  }
  for(let cursor=path;cursor!==dirname(cursor);cursor=dirname(cursor)) {
    try { assertBridge(!lstatSync(cursor).isSymbolicLink(),'HOST_PATH_DENIED','Host paths must not traverse links or junctions'); }
    catch(error) { if(error.code!=='ENOENT') throw error; }
  }
  return path;
}

export function ensureHostDirectory(value,{privateDirectory=true}={}) {
  const path=safeHostPath(value);
  let created=false;
  try {mkdirSync(path,{mode:0o700});created=true;}
  catch(error) {
    if(error.code==='ENOENT') {
      mkdirSync(dirname(path),{recursive:true,mode:0o700});
      try {mkdirSync(path,{mode:0o700});created=true;}
      catch(race) {if(race.code!=='EEXIST') throw race;}
    }
    else if(error.code!=='EEXIST') throw error;
  }
  const stat=lstatSync(path);
  assertBridge(stat.isDirectory(),'HOST_PATH_DENIED','Host directory is not a directory');
  if(process.platform==='win32') {
    if(privateDirectory) hostPowerShell(ACL_SCRIPT,{path,create:created});
  } else {
    assertBridge(stat.uid===process.getuid() && (stat.mode & (privateDirectory ? 0o077 : 0o022))===0,
      'HOST_PATH_DENIED','Host directory must be owned by the current user with safe permissions');
  }
  return path;
}

export function readHostFile(value) {
  const path=safeHostPath(value),stat=lstatSync(path);
  assertBridge(stat.isFile() && stat.size<=1_048_576,'HOST_PATH_DENIED','Host state must be a bounded regular file');
  if(process.platform==='win32') hostPowerShell(ACL_SCRIPT,{path,create:false});
  else assertBridge(stat.uid===process.getuid() && (stat.mode&0o077)===0,
    'HOST_PATH_DENIED','Host configuration must be private and owned by the current user');
  return readFileSync(path,'utf8');
}

export function writeHostFile(value,content) {
  const path=safeHostPath(value);
  ensureHostDirectory(dirname(path));
  // A new Windows file inherits its DACL but not its parent's owner. An
  // elevated caller's default owner can be Administrators. Initialize ONLY
  // this exclusively created empty file before writing any secret bytes;
  // validation of existing files never normalizes or broadens their ACLs.
  const fd=openSync(path,'wx',0o600);
  try {
    if(process.platform==='win32') hostPowerShell(ACL_SCRIPT,{path,create:true});
    writeFileSync(fd,content,{encoding:'utf8'});
  } finally {closeSync(fd);}
}
