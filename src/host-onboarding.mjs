import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { resolve } from 'node:path';
import { connectDirectHost, readDirectRunnerEnv } from './direct-connect-client.mjs';
import { validateHostPolicy } from './validate.mjs';
import { doctor } from './doctor.mjs';
import { assertBridge, BridgeError } from './errors.mjs';
import { DEFAULT_HOST_ENDPOINT } from './host-package-spec.mjs';
import { hostEndpoint } from './host-http.mjs';
import { ensureHostDirectory, readHostFile, safeHostPath } from './host-files.mjs';
import { preparePersistence } from './host-persistence.mjs';

export function hostConfigDir(env=process.env,home=homedir()) {
  return resolve(env.XDG_CONFIG_HOME || (process.platform==='win32' ? env.LOCALAPPDATA || resolve(home,'AppData/Local') : resolve(home,'.config')),'bridge');
}

function existingConnection(dir,user) {
  assertBridge(!existsSync(resolve(dir,'.pending-runner.env')),'HOST_CONNECT_INCOMPLETE',
    'An earlier claim is incomplete or ambiguous. Retain the private pending credential and reconcile it; no new Host will be created');
  const policyPath=resolve(dir,'host.json');
  const envPath=resolve(dir,'direct-runner.env');
  const present=[policyPath,envPath].map(path=>existsSync(path));
  if(!present.some(Boolean)) return null;
  assertBridge(present.every(Boolean),'HOST_CONFIG_INCOMPLETE',
    'Host configuration is incomplete; restore its matching files instead of creating a new identity');
  const policy=JSON.parse(readHostFile(policyPath));
  readHostFile(envPath); // ownership/mode/symlink checks before the legacy parser
  const local=readDirectRunnerEnv(envPath);
  validateHostPolicy(policy);
  assertBridge(policy.directExec?.serviceUser===user.username,'HOST_USER_MISMATCH',
    'This Host configuration belongs to another OS user');
  return {connected:true,hostId:policy.host.id,endpoint:local.endpoint};
}

export async function setupHost({endpoint,configDir=hostConfigDir(),service=true,persistenceMode,pairingToken,
  onAuthorization,openBrowser=true,signal,timeoutMs,
  // Injectable OS/transport boundaries keep tests off the real account and service.
  login,connect=connectDirectHost,serviceOptions={},fetchImpl=globalThis.fetch,
  user=userInfo(),doctorImpl=doctor
}={}) {
  assertBridge(user.uid!==0 && user.username!=='root','HOST_ROOT_DENIED','Run Bridge Host as your ordinary user, not root');
  const dir=safeHostPath(resolve(configDir));
  ensureHostDirectory(dir);
  const lock=resolve(dir,'.setup-lock');
  try { mkdirSync(lock,{mode:0o700}); }
  catch(error) {
    if(error.code!=='EEXIST') throw error;
    throw new BridgeError('HOST_SETUP_BUSY',
      'Another setup owns this configuration. After an interrupted process, verify it has stopped before removing .setup-lock');
  }
  try {
    writeFileSync(resolve(lock,'owner.json'),JSON.stringify({pid:process.pid}),{mode:0o600,flag:'wx'});
    assertBridge(!existsSync(resolve(dir,'maintenance-pending.json')),'HOST_MAINTENANCE_INCOMPLETE',
      'An interrupted maintenance transaction must be reconciled before setup; retain the snapshot and identity');
    const existing=existingConnection(dir,user);
    const selected=hostEndpoint(endpoint ?? existing?.endpoint ?? DEFAULT_HOST_ENDPOINT).href;
    assertBridge(!existing || existing.endpoint===selected,'HOST_ENDPOINT_MISMATCH',
      'Existing Host belongs to a different Bridge endpoint; it was not re-paired');
    assertBridge(!existing || !pairingToken,'HOST_ALREADY_CONNECTED',
      'A Host is already paired here. Rerun without a pairing token to reuse it');
    const persistence=preparePersistence(dir,{...serviceOptions,
      mode:persistenceMode ?? (service ? 'background' : 'manual')});
    let connection=existing;
    if(!connection) {
      const authorize=pairingToken ? null : login ?? (await import('./host-login.mjs')).loginForHostPairing;
      const receipt=pairingToken ? {pairingToken,endpoint:selected} : await authorize({
        endpoint:selected,onAuthorization,openBrowser,signal,timeoutMs,fetchImpl
      });
      assertBridge(receipt.endpoint===selected,'HOST_ENDPOINT_MISMATCH','Pairing receipt endpoint does not match');
      connection=await connect({endpoint:selected,pairingToken:receipt.pairingToken,
        expectedHostId:receipt.hostId,configDir:dir,fetchImpl});
    }
    const checked=doctorImpl({hostPolicyPath:resolve(dir,'host.json')});
    assertBridge(checked.ok,'HOST_DOCTOR_FAILED',
      'Host is paired but local validation failed; repair the local configuration instead of re-pairing');
    const background=await persistence.install({hostId:connection.hostId});
    return {connected:true,hostId:connection.hostId,endpoint:connection.endpoint,configDir:dir,
      reused:existing!==null,mode:persistence.mode,service:background,remoteExecutionVerified:false};
  } finally { rmSync(lock,{recursive:true,force:true}); }
}
