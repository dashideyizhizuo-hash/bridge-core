import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

export const DEFAULT_BASE_URL=process.env.BRIDGE_TASK_ORIGIN ?? 'https://bridge.example.invalid';
export const ADMIN_TOKEN_FILENAME='admin-token';
export const CONFIG_FILENAME='config.json';

const PRODUCTION_ORIGIN=new URL(DEFAULT_BASE_URL).origin;
const CONTROL_PATH='/task-runtime/control';
const ACTIVATE_PATH='/task-runtime/activate';
const MAX_RESPONSE_BYTES=1024*1024;
const WINDOWS_ACL_SCRIPT=`
$ErrorActionPreference='Stop'
$paths=ConvertFrom-Json -InputObject $env:BRIDGE_TASK_ACL_PATHS
$userSid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$systemSid='S-1-5-18'
$allowedSids=@($userSid,$systemSid)

if($env:BRIDGE_TASK_ACL_ACTION -eq 'secure-directory') {
  $path=$paths[0]
  $acl=[System.IO.Directory]::GetAccessControl($path)
  $acl.SetAccessRuleProtection($true,$false)
  $rules=$acl.GetAccessRules(
    $true,$true,[System.Security.Principal.SecurityIdentifier]
  )
  foreach($rule in $rules) {
    [void]$acl.RemoveAccessRuleSpecific($rule)
  }
  $inheritance=[System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
    [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  $rights=[System.Security.AccessControl.FileSystemRights]::FullControl
  $propagation=[System.Security.AccessControl.PropagationFlags]::None
  $allow=[System.Security.AccessControl.AccessControlType]::Allow
  foreach($sid in $allowedSids) {
    $identity=[System.Security.Principal.SecurityIdentifier]::new($sid)
    $rule=[System.Security.AccessControl.FileSystemAccessRule]::new(
      $identity,$rights,$inheritance,$propagation,$allow
    )
    [void]$acl.AddAccessRule($rule)
  }
  [System.IO.Directory]::SetAccessControl($path,$acl)
}

foreach($path in $paths) {
  if([System.IO.Directory]::Exists($path)) {
    $acl=[System.IO.Directory]::GetAccessControl($path)
  } else {
    $acl=[System.IO.FileInfo]::new($path).GetAccessControl()
  }
  $rules=$acl.GetAccessRules(
    $true,$true,[System.Security.Principal.SecurityIdentifier]
  )
  $ownerSid=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if($allowedSids -notcontains $ownerSid) {
    throw 'Unexpected ACL owner.'
  }
  $userHasFullControl=$false
  foreach($rule in $rules) {
    $sid=$rule.IdentityReference.Value
    if($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
        $allowedSids -notcontains $sid) {
      throw 'Unexpected allow rule.'
    }
    if($sid -eq $userSid -and
        $rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
        ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq
          [System.Security.AccessControl.FileSystemRights]::FullControl) {
      $userHasFullControl=$true
    }
  }
  if(-not $userHasFullControl) {
    throw 'Current account does not have full control.'
  }
  if([System.IO.Directory]::Exists($path) -and -not $acl.AreAccessRulesProtected) {
    throw 'Configuration directory inherits its ACL.'
  }
}
`;
const SESSION_HEADER_NAMES=[
  'x-bridge-task-key',
  'x-bridge-task-epoch',
  'x-bridge-task-owner'
];
const INSPECT_FIELDS=[
  ['taskKey','taskKey'],
  ['status','status'],
  ['canonicalBranch','canonicalBranch'],
  ['mode','mode'],
  ['leaseEpoch','leaseEpoch'],
  ['leaseOwner','leaseOwner'],
  ['leaseExpiresAt','leaseExpiresAt'],
  ['dispatchId','dispatchId'],
  ['dispatchExpiresAt','dispatchExpiresAt'],
  ['activeRunId','activeRunId'],
  ['checkpointSha','checkpointSha'],
  ['lastTransitionReason','lastTransitionReason']
];

export class TaskCliError extends Error {
  constructor(message) {
    super(message);
    this.name='TaskCliError';
  }
}

export function getConfigPaths({
  env=process.env,
  homeDir=homedir()
}={}) {
  const configRoot=typeof env.XDG_CONFIG_HOME==='string' &&
      env.XDG_CONFIG_HOME.trim().length>0
    ? resolve(env.XDG_CONFIG_HOME)
    : join(homeDir,'.config');
  const dir=join(configRoot,'bridge-task');
  return {
    dir,
    configFile:join(dir,CONFIG_FILENAME),
    tokenFile:join(dir,ADMIN_TOKEN_FILENAME)
  };
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g,"'\\''") + "'";
}

export function assertPrivateMode(mode,target,expected,platform=process.platform) {
  if(platform==='win32') return;
  const actual=mode & 0o777;
  if(actual===expected) return;
  throw new TaskCliError(
    'Unsafe permissions on ' + target +
    ': expected ' + expected.toString(8) +
    '. Run: chmod ' + expected.toString(8) + ' ' + shellQuote(target)
  );
}

function invokeWindowsAcl(paths,action='verify') {
  try {
    execFileSync('powershell.exe',[
      '-NoLogo','-NoProfile','-NonInteractive','-Command',WINDOWS_ACL_SCRIPT
    ],{
      env:{
        ...process.env,
        BRIDGE_TASK_ACL_ACTION:action,
        BRIDGE_TASK_ACL_PATHS:JSON.stringify(paths)
      },
      stdio:'ignore',
      timeout:10000,
      windowsHide:true
    });
  } catch {
    throw new TaskCliError(
      'Could not verify or secure the Windows ACL for Bridge Task Runtime configuration. ' +
      'Restrict access to the current Windows account and SYSTEM, and ensure Windows PowerShell is available.'
    );
  }
}

function assertPrivateDirectory(paths,platform,{skipWindowsAcl=false}={}) {
  let info;
  try {
    info=lstatSync(paths.dir);
  } catch {
    throw new TaskCliError(
      'Configuration directory is missing: ' + paths.dir +
      '. Run bridge-task config init.'
    );
  }
  if(info.isSymbolicLink() || !info.isDirectory()) {
    throw new TaskCliError(
      'Configuration directory must be a real directory, not a symlink: ' + paths.dir
    );
  }
  if(platform==='win32' && !skipWindowsAcl) invokeWindowsAcl([paths.dir]);
  else assertPrivateMode(info.mode,paths.dir,0o700,platform);
}

function assertRegularFile(file,label) {
  let info;
  try {
    info=lstatSync(file);
  } catch (error) {
    if(error && error.code==='ENOENT') {
      throw new TaskCliError(label + ' is missing: ' + file);
    }
    throw new TaskCliError('Unable to inspect ' + label + ': ' + file);
  }
  if(info.isSymbolicLink() || !info.isFile()) {
    throw new TaskCliError(label + ' must be a regular file, not a symlink: ' + file);
  }
  return info;
}

function assertWindowsConfigPermissions(paths,includeToken=true) {
  assertPrivateDirectory(paths,'win32',{skipWindowsAcl:true});
  assertRegularFile(paths.configFile,'configuration file');
  const aclPaths=[paths.dir,paths.configFile];
  if(includeToken) {
    assertRegularFile(paths.tokenFile,'admin token file');
    aclPaths.push(paths.tokenFile);
  }
  invokeWindowsAcl(aclPaths);
}

function readRegularFile(file,label,platform,expectedMode,skipWindowsAcl=false) {
  const info=assertRegularFile(file,label);
  if(platform==='win32' && !skipWindowsAcl) invokeWindowsAcl([file]);
  else assertPrivateMode(info.mode,file,expectedMode,platform);
  try {
    return readFileSync(file,'utf8');
  } catch {
    throw new TaskCliError('Unable to read ' + label + ': ' + file);
  }
}

export function validateBaseUrl(value) {
  if(typeof value!=='string' || value.length===0) {
    throw new TaskCliError('config.json must contain a baseUrl string.');
  }

  let parsed;
  try {
    parsed=new URL(value);
  } catch {
    throw new TaskCliError('baseUrl must be a valid absolute URL.');
  }

  const localHosts=new Set(['localhost','127.0.0.1','[::1]']);
  const secure=parsed.protocol==='https:';
  const localHttp=parsed.protocol==='http:' && localHosts.has(parsed.hostname);
  if(!secure && !localHttp) {
    throw new TaskCliError(
      'baseUrl must use HTTPS. HTTP is allowed only for localhost.'
    );
  }
  if(parsed.username || parsed.password) {
    throw new TaskCliError('baseUrl must not include a username or password.');
  }
  if(parsed.search || parsed.hash) {
    throw new TaskCliError('baseUrl must not include a query string or fragment.');
  }
  if(parsed.pathname!=='/') {
    throw new TaskCliError('baseUrl must be an origin without a path.');
  }
  if(parsed.origin!==PRODUCTION_ORIGIN) {
    throw new TaskCliError(
      'baseUrl must use the Bridge production origin ' + PRODUCTION_ORIGIN +
      '; the admin token is restricted to this host.'
    );
  }

  return parsed.origin + '/';
}

function readConfigInternal(paths,platform,skipWindowsAcl) {
  const raw=readRegularFile(
    paths.configFile,
    'configuration file',
    platform,
    0o600,
    skipWindowsAcl
  );

  let config;
  try {
    config=JSON.parse(raw);
  } catch {
    throw new TaskCliError('config.json is not valid JSON: ' + paths.configFile);
  }
  if(!config || typeof config!=='object' || Array.isArray(config)) {
    throw new TaskCliError('config.json must contain a JSON object.');
  }
  const keys=Object.keys(config);
  if(keys.some(key=>key!=='baseUrl')) {
    throw new TaskCliError(
      'config.json may contain only baseUrl. Store the admin token in ' +
      paths.tokenFile + '.'
    );
  }
  return {baseUrl:validateBaseUrl(config.baseUrl)};
}

export function readConfig(paths=getConfigPaths(),{platform=process.platform}={}) {
  return readConfigInternal(paths,platform,false);
}

function readAdminTokenInternal(paths,platform,skipWindowsAcl) {
  const raw=readRegularFile(
    paths.tokenFile,'admin token file',platform,0o600,skipWindowsAcl
  );
  const token=raw.replace(/[\r\n]+$/,'');
  if(token.length<32) {
    throw new TaskCliError(
      'Admin token file must contain at least 32 characters: ' +
      paths.tokenFile + '. Store the token locally; do not pass it as an argument.'
    );
  }
  return token;
}

export function readAdminToken(paths=getConfigPaths(),{platform=process.platform}={}) {
  return readAdminTokenInternal(paths,platform,false);
}

export function loadLocalConfig(paths=getConfigPaths(),{
  platform=process.platform
}={}) {
  if(platform==='win32') {
    assertWindowsConfigPermissions(paths);
  } else assertPrivateDirectory(paths,platform);
  return {
    config:readConfigInternal(paths,platform,true),
    adminToken:readAdminTokenInternal(paths,platform,true)
  };
}

export function initializeConfig(paths=getConfigPaths(),{
  platform=process.platform
}={}) {
  const existed=existsSync(paths.dir);
  mkdirSync(paths.dir,{recursive:true,mode:0o700});
  const dirInfo=lstatSync(paths.dir);
  if(dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) {
    throw new TaskCliError(
      'Configuration directory must be a real directory, not a symlink: ' + paths.dir
    );
  }
  if(platform==='win32') {
    if(existed) invokeWindowsAcl([paths.dir]);
    else invokeWindowsAcl([paths.dir],'secure-directory');
  } else {
    if(existed) assertPrivateMode(dirInfo.mode,paths.dir,0o700,platform);
    else chmodSync(paths.dir,0o700);
  }
  if(existsSync(paths.configFile) || existsSync(paths.tokenFile)) {
    throw new TaskCliError(
      'Configuration already exists; config init never overwrites files: ' + paths.dir
    );
  }

  const configText=JSON.stringify({baseUrl:DEFAULT_BASE_URL},null,2)+'\n';
  try {
    writeFileSync(paths.configFile,configText,{flag:'wx',mode:0o600});
    writeFileSync(paths.tokenFile,'',{flag:'wx',mode:0o600});
    if(platform!=='win32') {
      chmodSync(paths.configFile,0o600);
      chmodSync(paths.tokenFile,0o600);
      assertPrivateMode(statSync(paths.configFile).mode,paths.configFile,0o600,platform);
      assertPrivateMode(statSync(paths.tokenFile).mode,paths.tokenFile,0o600,platform);
    } else invokeWindowsAcl([paths.dir,paths.configFile,paths.tokenFile]);
  } catch {
    throw new TaskCliError(
      'Unable to initialize configuration safely in ' + paths.dir +
      '. Existing files were not overwritten.'
    );
  }
  return paths;
}

export function parseTaskKey(value) {
  if(typeof value!=='string') {
    throw new TaskCliError('taskKey must use owner/repository#issue-number.');
  }
  const match=/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/.exec(value);
  if(!match) {
    throw new TaskCliError('taskKey must use owner/repository#issue-number.');
  }
  const issueNumber=Number(match[2]);
  if(!Number.isSafeInteger(issueNumber) || issueNumber<=0) {
    throw new TaskCliError('taskKey issue number must be a positive safe integer.');
  }
  return {
    taskKey:value,
    repository:match[1],
    issueNumber
  };
}

function validateDispatchId(value) {
  if(typeof value!=='string' || value.length<8 || value.length>256 ||
      !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new TaskCliError(
      'dispatchId must be 8-256 characters using letters, digits, dot, underscore, colon, or hyphen.'
    );
  }
  return value;
}

function requiredText(value,label,max=512) {
  if(typeof value!=='string' || value.trim().length===0 ||
      value.length>max || /[\u0000-\u001f]/.test(value)) {
    throw new TaskCliError(label + ' is required and must be valid text.');
  }
  return value.trim();
}

function requiredPositiveIntegerText(value,label) {
  if(typeof value!=='string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new TaskCliError(label + ' must be a positive integer.');
  }
  const parsed=Number(value);
  if(!Number.isSafeInteger(parsed)) {
    throw new TaskCliError(label + ' must be a positive safe integer.');
  }
  return parsed;
}

function validateEnrollment(values) {
  const identity=parseTaskKey(values.task);
  const githubUserId=requiredText(values['github-user-id'],'github-user-id',128);
  if(!/^[0-9]+$/.test(githubUserId)) {
    throw new TaskCliError('github-user-id must contain decimal digits only.');
  }
  const branch=requiredText(values.branch,'branch',255);
  const mode=values.mode;
  if(mode!=='continuous' && mode!=='supervised') {
    throw new TaskCliError('mode must be continuous or supervised.');
  }
  const checkpoint=requiredText(values.checkpoint,'checkpoint');
  if(!/^[0-9a-fA-F]{40}$/.test(checkpoint)) {
    throw new TaskCliError('checkpoint must be a 40-character hexadecimal SHA.');
  }
  const stateCommentId=requiredPositiveIntegerText(
    values['state-comment-id'],
    'state-comment-id'
  );
  return {
    taskKey:identity.taskKey,
    githubUserId,
    repository:identity.repository,
    issueNumber:identity.issueNumber,
    canonicalBranch:branch,
    mode,
    checkpointSha:checkpoint.toLowerCase(),
    stateCommentId
  };
}

function parseCommandArgs(args,options,allowPositionals=true) {
  try {
    return parseArgs({
      args,
      options,
      allowPositionals,
      strict:true
    });
  } catch {
    throw new TaskCliError('Invalid command arguments. Run bridge-task help.');
  }
}

function isRecord(value) {
  return value!==null && typeof value==='object' && !Array.isArray(value);
}

function sanitizedPart(value,token) {
  if(typeof value!=='string') return '';
  let result=value;
  if(token) result=result.split(token).join('[REDACTED]');
  result=result.replace(/Bearer\s+[^\s,;"}]+/gi,'Bearer [REDACTED]');
  return result.slice(0,500);
}

function safeTerminalText(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,character=>
    '\\u'+character.charCodeAt(0).toString(16).padStart(4,'0')
  );
}

async function readBoundedResponse(response) {
  if(!response.body) return '';
  let reader;
  try {
    reader=response.body.getReader();
  } catch {
    throw new TaskCliError('Unable to read the Bridge response.');
  }
  const decoder=new TextDecoder();
  let byteCount=0;
  let text='';
  try {
    while(true) {
      const {done,value}=await reader.read();
      if(done) break;
      byteCount+=value.byteLength;
      if(byteCount>MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch {}
        throw new TaskCliError('Bridge response exceeded the 1 MiB size limit.');
      }
      text+=decoder.decode(value,{stream:true});
    }
    return text+decoder.decode();
  } catch(error) {
    if(error instanceof TaskCliError) throw error;
    throw new TaskCliError('Unable to read the Bridge response.');
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

async function postJson({
  config,
  path,
  body,
  token=null,
  fetchImpl=globalThis.fetch
}) {
  if(typeof fetchImpl!=='function') {
    throw new TaskCliError('Fetch is unavailable in this Node.js runtime.');
  }

  const base=new URL(config.baseUrl);
  const endpoint=new URL(path,base);
  if(endpoint.origin!==base.origin) {
    throw new TaskCliError('Refusing to send a request outside the configured host.');
  }

  const headers={
    accept:'application/json',
    'content-type':'application/json'
  };
  if(token!==null) headers.authorization='Bearer '+token;

  let response;
  try {
    response=await fetchImpl(endpoint.toString(),{
      method:'POST',
      headers,
      body:JSON.stringify(body),
      redirect:'error'
    });
  } catch {
    throw new TaskCliError(
      'Bridge request failed (network, TLS, or redirect error).'
    );
  }

  const text=await readBoundedResponse(response);

  let payload=null;
  try {
    payload=JSON.parse(text);
  } catch {
    if(response.ok) {
      throw new TaskCliError('Bridge returned invalid JSON.');
    }
  }

  if(!response.ok) {
    const errorRecord=isRecord(payload?.error) ? payload.error : payload;
    const code=sanitizedPart(
      typeof errorRecord?.code==='string' ? errorRecord.code : 'HTTP_ERROR',
      token
    );
    const rawMessage=typeof errorRecord?.message==='string'
      ? errorRecord.message
      : text;
    const message=sanitizedPart(rawMessage,token) || 'Request failed.';
    throw new TaskCliError(
      'HTTP ' + response.status + ' (' + code + '): ' + message
    );
  }

  if(!isRecord(payload)) {
    throw new TaskCliError('Bridge returned an invalid response object.');
  }
  return payload;
}

export function postControl({config,adminToken,body,fetchImpl=globalThis.fetch}) {
  const baseUrl=validateBaseUrl(config?.baseUrl);
  return postJson({
    config:{...config,baseUrl},
    path:CONTROL_PATH,
    body,
    token:adminToken,
    fetchImpl
  });
}

export function postActivation({config,body,fetchImpl=globalThis.fetch}) {
  return postJson({
    config,
    path:ACTIVATE_PATH,
    body,
    fetchImpl
  });
}

function responseTask(payload) {
  return isRecord(payload?.task) ? payload.task : payload;
}

function displayValue(value) {
  if(value===undefined || value===null || value==='') return '-';
  if(typeof value==='object') return JSON.stringify(value);
  return safeTerminalText(value);
}

function sanitizeValue(value,token) {
  if(typeof value==='string') return sanitizedPart(value,token);
  if(Array.isArray(value)) return value.map(item=>sanitizeValue(item,token));
  if(isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key,item])=>[sanitizedPart(key,token),sanitizeValue(item,token)]));
  }
  return value;
}
function writeFields(stream,record,fields) {
  for(const [label,key] of fields) {
    stream.write(label + ': ' + displayValue(record?.[key]) + '\n');
  }
}

function safeActivation(payload,{includeTaskSessionToken=false}={}) {
  const output={};
  for(const key of [
    'status','taskKey','workerId','leaseEpoch','leaseExpiresAt',
    'canonicalBranch','mode'
  ]) {
    if(Object.hasOwn(payload,key)) output[key]=payload[key];
  }
  const sourceHeaders=payload?.mcpSession?.headers;
  const headers={};
  if(isRecord(sourceHeaders)) {
    for(const name of SESSION_HEADER_NAMES) {
      if(typeof sourceHeaders[name]==='string') headers[name]=sourceHeaders[name];
    }
  }
  output.mcpSession={headers};
  if(includeTaskSessionToken===true && typeof payload?.taskSessionToken==='string') {
    if(!/^bts_[A-Za-z0-9_-]{43,128}$/.test(payload.taskSessionToken)) {
      throw new TaskCliError('Bridge returned an invalid taskSessionToken.');
    }
    output.taskSessionToken=payload.taskSessionToken;
  }
  return output;
}

function writeActivation(stream,payload,token) {
  const value=sanitizeValue(payload,token);
  writeFields(stream,value,[
    ['status','status'],
    ['taskKey','taskKey'],
    ['workerId','workerId'],
    ['leaseEpoch','leaseEpoch'],
    ['leaseExpiresAt','leaseExpiresAt'],
    ['canonicalBranch','canonicalBranch'],
    ['mode','mode'],
    ['taskSessionToken','taskSessionToken']
  ]);
  stream.write('MCP session headers:\n');
  for(const [name,headerValue] of Object.entries(value.mcpSession.headers)) {
    stream.write('  ' + safeTerminalText(name) + ': ' + displayValue(headerValue) + '\n');
  }
}

function writeInspect(stream,payload,token) {
  writeFields(stream,sanitizeValue(responseTask(payload),token),INSPECT_FIELDS);
}

function writeTick(stream,payload,token) {
  const safe=sanitizeValue(payload,token);
  const decision=isRecord(safe?.decision) ? safe.decision : safe;
  stream.write('decision: ' + displayValue(decision?.action) + '\n');
  if(decision?.action==='DISPATCH') {
    stream.write('dispatchId: ' + displayValue(decision.dispatchId) + '\n');
    stream.write(
      'dispatchExpiresAt: ' + sanitizedPart(displayValue(decision.dispatchExpiresAt),token) + '\n'
    );
  } else if(decision?.action==='NOOP') {
    stream.write('reason: ' + sanitizedPart(displayValue(decision.reason),token) + '\n');
  } else {
    throw new TaskCliError('Bridge returned an unknown tick decision.');
  }
}

function writeUsage(stream) {
  stream.write(
    'Usage:\n' +
    '  bridge-task inspect <taskKey> [--json]\n' +
    '  bridge-task enroll --task <taskKey> --github-user-id <id> --branch <branch> --mode <continuous|supervised> --checkpoint <sha> --state-comment-id <id> [--json]\n' +
    '  bridge-task tick <taskKey> [--json]\n' +
    '  bridge-task activate <taskKey> <dispatchId> [--json] [--show-session-token]\n' +
    '  bridge-task start <taskKey> [--json] [--show-session-token]\n' +
    '  bridge-task config init|check\n' +
    '  bridge-task help\n'
  );
}

function getSettings(paths,platform,needAdminToken=true) {
  if(platform==='win32') {
    assertWindowsConfigPermissions(paths,needAdminToken);
  } else assertPrivateDirectory(paths,platform);
  const config=readConfigInternal(paths,platform,true);
  const adminToken=needAdminToken
    ? readAdminTokenInternal(paths,platform,true)
    : null;
  return {config,adminToken};
}

function printJson(stream,value,token) {
  stream.write(JSON.stringify(sanitizeValue(value,token),null,2)+'\n');
}

async function runConfigCommand(args,dependencies) {
  const [subcommand,...rest]=args;
  if(rest.length!==0) {
    throw new TaskCliError('config init/check takes no additional arguments.');
  }
  const paths=dependencies.paths;
  if(subcommand==='init') {
    const created=initializeConfig(paths,{platform:dependencies.platform});
    dependencies.stdout.write(
      'Created config: ' + safeTerminalText(created.configFile) + '\n' +
      'Created empty admin token file: ' + safeTerminalText(created.tokenFile) + '\n' +
      'Add the token locally, then run bridge-task config check.\n'
    );
    return;
  }
  if(subcommand==='check') {
    const settings=loadLocalConfig(paths,{platform:dependencies.platform});
    dependencies.stdout.write(
      'Config: valid (' + safeTerminalText(paths.configFile) + ')\n' +
      'Base URL: ' + safeTerminalText(settings.config.baseUrl) + '\n' +
      'Admin token: present; value not shown\n'
    );
    return;
  }
  throw new TaskCliError('Use bridge-task config init or bridge-task config check.');
}

export async function runTaskCli(args,options={}) {
  const dependencies={
    env:options.env ?? process.env,
    homeDir:options.homeDir ?? homedir(),
    platform:options.platform ?? process.platform,
    paths:options.paths ?? null,
    fetchImpl:options.fetchImpl ?? globalThis.fetch,
    stdout:options.stdout ?? process.stdout,
    stderr:options.stderr ?? process.stderr
  };
  dependencies.paths=dependencies.paths ?? getConfigPaths({
    env:dependencies.env,
    homeDir:dependencies.homeDir
  });

  const [command,...rest]=args;
  if(!command || command==='help' || rest.includes('--help') || command==='--help') {
    writeUsage(dependencies.stdout);
    return;
  }
  if(command==='config') {
    return runConfigCommand(rest,dependencies);
  }

  let parsed;
  let taskKey;
  let dispatchId;
  let enrollment;
  let json=false;
  let showSessionToken=false;

  if(command==='enroll') {
    parsed=parseCommandArgs(rest,{
      task:{type:'string'},
      'github-user-id':{type:'string'},
      branch:{type:'string'},
      mode:{type:'string'},
      checkpoint:{type:'string'},
      'state-comment-id':{type:'string'},
      json:{type:'boolean'}
    },false);
    const values=parsed.values;
    enrollment=validateEnrollment(values);
    json=values.json===true;
  } else if(command==='inspect' || command==='tick' || command==='start') {
    parsed=parseCommandArgs(rest,{
      json:{type:'boolean'},
      'show-session-token':{type:'boolean'}
    },true);
    if(parsed.positionals.length!==1) {
      throw new TaskCliError(command + ' requires exactly one taskKey.');
    }
    taskKey=parseTaskKey(parsed.positionals[0]).taskKey;
    json=parsed.values.json===true;
    showSessionToken=parsed.values['show-session-token']===true;
  } else if(command==='activate') {
    parsed=parseCommandArgs(rest,{
      json:{type:'boolean'},
      'show-session-token':{type:'boolean'}
    },true);
    if(parsed.positionals.length!==2) {
      throw new TaskCliError('activate requires taskKey and dispatchId.');
    }
    taskKey=parseTaskKey(parsed.positionals[0]).taskKey;
    dispatchId=validateDispatchId(parsed.positionals[1]);
    json=parsed.values.json===true;
    showSessionToken=parsed.values['show-session-token']===true;
  } else {
    throw new TaskCliError('Unknown command. Run bridge-task help.');
  }

  const settings=getSettings(dependencies.paths,dependencies.platform,command!=="activate");
  const control=(body)=>postControl({
    config:settings.config,
    adminToken:settings.adminToken,
    body,
    fetchImpl:dependencies.fetchImpl
  });
  const activate=(body)=>postActivation({
    config:settings.config,
    body,
    fetchImpl:dependencies.fetchImpl
  });

  if(command==='inspect') {
    const payload=await control({action:'inspect',taskKey});
    if(json) printJson(dependencies.stdout,payload,settings.adminToken);
    else writeInspect(dependencies.stdout,payload,settings.adminToken);
    return payload;
  }

  if(command==='enroll') {
    const payload=await control({action:'enroll',task:enrollment});
    if(json) printJson(dependencies.stdout,payload,settings.adminToken);
    else {
      dependencies.stdout.write('action: ' + sanitizedPart(displayValue(payload.action),settings.adminToken) + '\n');
      writeInspect(dependencies.stdout,payload,settings.adminToken);
    }
    return payload;
  }

  if(command==='tick') {
    const payload=await control({action:'tick',taskKey,launch:false});
    if(json) printJson(dependencies.stdout,payload,settings.adminToken);
    else writeTick(dependencies.stdout,payload,settings.adminToken);
    return payload;
  }

  if(command==='activate') {
    const payload=await activate({taskKey,dispatchId});
    const safe=safeActivation(payload,{includeTaskSessionToken:showSessionToken});
    if(json) printJson(dependencies.stdout,safe,settings.adminToken);
    else writeActivation(dependencies.stdout,safe,settings.adminToken);
    return safe;
  }

  if(command==='start') {
    const tick=await control({action:'tick',taskKey,launch:false});
    const decision=tick?.decision;
    if(!isRecord(decision)) {
      throw new TaskCliError('Bridge returned an invalid tick response.');
    }
    if(decision.action==='NOOP') {
      const result={action:'START',decision,activation:null};
      if(json) printJson(dependencies.stdout,result,settings.adminToken);
      else {
        dependencies.stdout.write('decision: NOOP\n');
        dependencies.stdout.write('reason: ' + displayValue(sanitizedPart(displayValue(decision.reason),settings.adminToken)) + '\n');
        dependencies.stdout.write('No activation was performed.\n');
      }
      return result;
    }
    if(decision.action!=='DISPATCH') {
      throw new TaskCliError('Bridge returned an invalid dispatch decision.');
    }
    const dispatchId=validateDispatchId(decision.dispatchId);
    const activated=await activate({taskKey,dispatchId});
    const safe=safeActivation(activated,{includeTaskSessionToken:showSessionToken});
    const result={action:'START',decision,activation:safe};
    if(json) printJson(dependencies.stdout,result,settings.adminToken);
    else {
      dependencies.stdout.write('decision: DISPATCH\n');
      dependencies.stdout.write('dispatchId: ' + displayValue(sanitizedPart(dispatchId,settings.adminToken)) + '\n');
      dependencies.stdout.write(
        'dispatchExpiresAt: ' + displayValue(sanitizedPart(displayValue(decision.dispatchExpiresAt),settings.adminToken)) + '\n'
      );
      writeActivation(dependencies.stdout,safe,settings.adminToken);
    }
    return result;
  }

  throw new TaskCliError('Unknown command.');
}

export async function main(args=process.argv.slice(2),options={}) {
  const stderr=options.stderr ?? process.stderr;
  try {
    await runTaskCli(args,options);
    return 0;
  } catch(error) {
    const message=error instanceof TaskCliError
      ? error.message
      : 'Command failed without exposing internal details.';
    stderr.write('bridge-task: ' + safeTerminalText(message) + '\n');
    return 1;
  }
}
