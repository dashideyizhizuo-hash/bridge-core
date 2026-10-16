import { chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, linkSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import { dirname, resolve } from 'node:path';
import { BridgeError, assertBridge } from './errors.mjs';
import { validateHostPolicy } from './validate.mjs';
import { hostEndpoint, boundedHostFetch } from './host-http.mjs';
import { ensureHostDirectory, writeHostFile, defaultHostConfigDirectory, assertSharedHostPath } from './host-files.mjs';

function endpoint(value) {
  try { return hostEndpoint(value); }
  catch(error) {
    const failure=new BridgeError('DIRECT_CONNECT_INVALID','Bridge endpoint must be a clean HTTPS /mcp URL');
    failure.cause=error;throw failure;
  }
}
function pairingToken(value) {
  // Signed hp1 capabilities include a principal, not just a short random token.
  assertBridge(typeof value==='string' && /^[A-Za-z0-9._~-]{32,1024}$/.test(value),
    'DIRECT_CONNECT_INVALID','pairing token is invalid');
  return value;
}
function defaultConfigDir() {
  return defaultHostConfigDirectory();
}
function defaultStateDir(configDir) {
  if(process.platform==='win32' && !process.env.XDG_STATE_HOME) return resolve(configDir,'direct-exec');
  return resolve(process.env.XDG_STATE_HOME || (process.platform==='win32' ? process.env.LOCALAPPDATA || resolve(homedir(),'AppData/Local') : resolve(homedir(),'.local','state')),'bridge','direct-exec');
}
const atomicSecretWrite=writeHostFile;
function minimalPolicy(hostId,configDir,owner) {
  const user=owner.username;
  assertBridge(owner.uid!==0 && user!=='root','DIRECT_CONNECT_DENIED','self-service connect must not run as root');
  const stateDir=defaultStateDir(configDir);
  return {version:1,host:{id:hostId},repositories:{},directExec:{
    enabled:true,serviceUser:user,root:homedir(),stateDir,assetDir:resolve(stateDir,'assets'),
    maxArgv:64,maxSeconds:3600,stdoutBytes:1048576,stderrBytes:1048576,resultBytes:1048576
  }};
}
function assertAbsent(path) {
  let stat;
  try { stat=lstatSync(path); } catch(error) { if(error.code!=='ENOENT') throw error; }
  assertBridge(!stat,'DIRECT_CONNECT_CONFLICT','Local Bridge configuration or an incomplete claim already exists; do not re-pair');
}

export async function connectDirectHost({endpoint:valueEndpoint,pairingToken:valuePairingToken,
  expectedHostId,configDir=defaultConfigDir(),fetchImpl=globalThis.fetch,
  randomToken=()=>randomBytes(32).toString('base64url'),user=userInfo(),
  sharedStorage=false,platform=process.platform,realpath
}={}) {
  assertBridge(typeof fetchImpl==='function' && typeof randomToken==='function',
    'DIRECT_CONNECT_INVALID','fetch implementation and random token generator are required');
  const bridge=endpoint(valueEndpoint);
  const pair=pairingToken(valuePairingToken);
  const policy=minimalPolicy('pending',configDir,user);
  // Validate all local settings before consuming the one-use remote claim.
  validateHostPolicy(policy);
  if(expectedHostId!==undefined) assertBridge(typeof expectedHostId==='string' && /^[A-Za-z0-9_.-]{1,128}$/.test(expectedHostId),
    'DIRECT_CONNECT_INVALID','expected host identity is invalid');
  const dir=resolve(configDir);
  const policyPath=resolve(dir,'host.json');
  const envPath=resolve(dir,'direct-runner.env');
  const pendingPath=resolve(dir,'.pending-runner.env');
  for(const path of [policyPath,envPath,pendingPath]) assertAbsent(path);
  // Preflight writable private storage before any remote mutation.
  for(let cursor=dir;cursor!==dirname(cursor);cursor=dirname(cursor)) {
    try { assertBridge(!lstatSync(cursor).isSymbolicLink(),'DIRECT_CONNECT_DENIED','Configuration path must not traverse symlinks'); }
    catch(error) { if(error.code!=='ENOENT') throw error; }
  }
  ensureHostDirectory(dir);
  // Initialize the configuration ACL before nested state creates its parent.
  // Protect execution journals/assets before consuming pairing or writing secrets.
  ensureHostDirectory(policy.directExec.stateDir);
  if(sharedStorage) {
    for(const path of [dir,policy.directExec.root,policy.directExec.stateDir,policy.directExec.assetDir,policy.directExec.exportDir].filter(Boolean))
      assertSharedHostPath(path,{platform,realpath});
  }
  const runnerToken=randomToken();
  assertBridge(typeof runnerToken==='string' && /^[A-Za-z0-9_-]{40,128}$/.test(runnerToken),
    'DIRECT_CONNECT_INVALID','local runner token generator returned invalid material');
  const runnerTokenSha256=createHash('sha256').update(runnerToken).digest('hex');
  // Durable before claim: a lost response must not discard the only credential
  // or allow a blind retry to create a second Host. Ambiguity fails closed.
  atomicSecretWrite(pendingPath,`BRIDGE_PUBLIC_URL=${bridge.href}\nBRIDGE_DIRECT_RUNNER_TOKEN=${runnerToken}\n`);
  const response=await boundedHostFetch(bridge.href,{fetchImpl})(
    new URL('/direct/enroll/claim',bridge),{
      method:'POST',headers:{authorization:`Bearer ${pair}`,'content-type':'application/json',accept:'application/json'},
      body:JSON.stringify({runnerTokenSha256})
    });
  let body;
  try { body=await response.json(); }
  catch(error) {
    const failure=new BridgeError('DIRECT_CONNECT_AMBIGUOUS','Bridge returned an invalid claim response; retain the private pending credential and reconcile before retrying');
    failure.cause=error;throw failure;
  }
  if(!response.ok) {
    // A definitive client rejection did not register this credential. Server
    // errors/timeouts may have committed; retain the pending credential then.
    if(response.status>=400 && response.status<500 && response.status!==408) unlinkSync(pendingPath);
    const code=typeof body?.error?.code==='string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(body.error.code)
      ? body.error.code : 'DIRECT_CONNECT_FAILED';
    throw new BridgeError(code,`Host pairing failed with HTTP ${response.status}`,{status:response.status});
  }
  assertBridge(body?.paired===true && typeof body.hostId==='string' && /^[A-Za-z0-9_.-]{1,128}$/.test(body.hostId) &&
    (expectedHostId===undefined || body.hostId===expectedHostId),
  'DIRECT_CONNECT_FAILED','Bridge returned an invalid or mismatched pairing receipt; retain pending state for reconciliation');
  const hostId=body.hostId;
  policy.host.id=hostId;
  validateHostPolicy(policy);
  atomicSecretWrite(policyPath,JSON.stringify(policy,null,2)+'\n');
  // link is create-only and atomic; never overwrite a concurrently created env.
  // On failure, retain both the Host ID and pending secret for local recovery.
  linkSync(pendingPath,envPath);
  unlinkSync(pendingPath);
  return {connected:true,hostId,endpoint:bridge.href,policyPath,envPath,
    serviceUser:policy.directExec.serviceUser,stateDir:policy.directExec.stateDir,
    next:{command:`bridge-runner direct-loop --host-policy ${JSON.stringify(policyPath)} --env-file ${JSON.stringify(envPath)}`,
      environmentFile:envPath}};
}

export function readDirectRunnerEnv(path) {
  const raw=readFileSync(resolve(path),'utf8');
  assertBridge(Buffer.byteLength(raw,'utf8')<=8192,'DIRECT_CONNECT_INVALID','Direct runner env file exceeds limit');
  const values={};
  for(const rawLine of raw.split(/\r?\n/)) {
    const line=rawLine.trim();
    if(line==='' || line.startsWith('#')) continue;
    const index=line.indexOf('=');
    assertBridge(index>0,'DIRECT_CONNECT_INVALID','Direct runner env line is invalid');
    const key=line.slice(0,index),value=line.slice(index+1);
    assertBridge(key==='BRIDGE_PUBLIC_URL' || key==='BRIDGE_DIRECT_RUNNER_TOKEN',
      'DIRECT_CONNECT_INVALID','unknown Direct runner env key');
    assertBridge(values[key]===undefined,'DIRECT_CONNECT_INVALID','duplicate Direct runner env key');
    values[key]=value;
  }
  endpoint(values.BRIDGE_PUBLIC_URL);
  assertBridge(typeof values.BRIDGE_DIRECT_RUNNER_TOKEN==='string' && /^[A-Za-z0-9._~-]{32,512}$/.test(values.BRIDGE_DIRECT_RUNNER_TOKEN),
    'DIRECT_CONNECT_INVALID','Direct runner env token is invalid');
  return Object.freeze({endpoint:values.BRIDGE_PUBLIC_URL,token:values.BRIDGE_DIRECT_RUNNER_TOKEN});
}
