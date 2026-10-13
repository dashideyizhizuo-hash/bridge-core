import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, unlinkSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError, assertBridge } from './errors.mjs';
import { HOST_RUNTIME_FILES, HOST_VERSION } from './host-package-spec.mjs';

export const HOST_SERVICE_NAME='bridge-host.service';
const packageRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const digest=value=>createHash('sha256').update(value).digest('hex');

export { safeHostPath, ensureHostDirectory, readHostFile } from './host-files.mjs';
import { safeHostPath, ensureHostDirectory, readHostFile } from './host-files.mjs';

export function hostServicePaths(configDir,{env=process.env,home=homedir(),platform=process.platform,unitName=HOST_SERVICE_NAME}={}) {
  assertBridge(/^bridge-host(?:-test-[a-f0-9]+)?\.service$/.test(unitName),
    'HOST_SERVICE_INVALID','Invalid Bridge service name');
  return {
    configDir:safeHostPath(configDir),
    runtimeRoot:safeHostPath(platform==='win32' && !env.XDG_DATA_HOME ? resolve(configDir,'runtimes') :
      resolve(env.XDG_DATA_HOME || resolve(home,'.local/share'),'bridge','runtimes')),
    unitPath:safeHostPath(resolve(env.XDG_CONFIG_HOME || resolve(home,'.config'),'systemd/user',unitName)),
    receiptPath:safeHostPath(resolve(configDir,'service.json')),
    unitName
  };
}

function runSystemctl(args,{exec=spawnSync}={}) {
  const result=exec('systemctl',['--user',...args],{
    encoding:'utf8',timeout:10_000,maxBuffer:8192,shell:false,stdio:['ignore','pipe','pipe']
  });
  if(result.error) {
    const error=new BridgeError('HOST_SERVICE_UNAVAILABLE','Cannot contact the systemd user service manager');
    error.cause=result.error;throw error;
  }
  return result;
}

function ownedService(paths) {
  if(!existsSync(paths.unitPath)) return;
  assertBridge(existsSync(paths.receiptPath),'HOST_SERVICE_CONFLICT',
    'An existing bridge-host service is not managed by this configuration; it was not changed');
  const receipt=JSON.parse(readHostFile(paths.receiptPath));
  assertBridge(receipt.schemaVersion===1 && receipt.unitPath===paths.unitPath &&
    receipt.unitSha256===digest(readHostFile(paths.unitPath)),
  'HOST_SERVICE_CONFLICT','Existing service does not match its installation receipt; it was not changed');
}

export function preflightHostService(paths,{platform=process.platform,exec}={}) {
  assertBridge(platform==='linux','HOST_SERVICE_UNSUPPORTED',
    'Automatic background service currently supports Linux/WSL with systemd; use --no-service for manual operation');
  ownedService(paths);
  const state=runSystemctl(['is-system-running'],{exec});
  assertBridge(['running','degraded','starting','initializing'].includes(state.stdout.trim()),
    'HOST_SERVICE_UNAVAILABLE','systemd --user is unavailable. Start a user session, or use --no-service; no sudo is run');
  ensureHostDirectory(dirname(paths.unitPath),{privateDirectory:false});
  ensureHostDirectory(paths.runtimeRoot);
}

export function stageHostRuntime(paths,{sourceRoot=packageRoot}={}) {
  ensureHostDirectory(paths.runtimeRoot);
  const files=HOST_RUNTIME_FILES.map(path=>{
    const source=safeHostPath(resolve(sourceRoot,path));
    const stat=lstatSync(source);
    assertBridge(stat.isFile() && stat.size<=1_048_576,'HOST_RUNTIME_INVALID','Invalid Host runtime file');
    return [path,readFileSync(source)];
  });
  files.push(['package.json',Buffer.from(JSON.stringify({name:'bridge-host-runtime',version:HOST_VERSION,type:'module'})+'\n')]);
  const hash=createHash('sha256');
  for(const [path,bytes] of files) hash.update(path+'\0').update(bytes).update('\0');
  const runtime=resolve(paths.runtimeRoot,hash.digest('hex'));
  const verify=()=>{
    safeHostPath(runtime);
    for(const [path,bytes] of files) {
      const destination=safeHostPath(resolve(runtime,path));
      assertBridge(lstatSync(destination).isFile() && readFileSync(destination).equals(bytes),
        'HOST_RUNTIME_CONFLICT','Existing immutable Host runtime differs from the installed package');
    }
    return resolve(runtime,'bin/bridge-host-daemon.mjs');
  };
  if(existsSync(runtime)) return verify();
  const staging=resolve(paths.runtimeRoot,`.staging-${randomUUID()}`);
  mkdirSync(staging,{mode:0o700});
  try {
    for(const [path,bytes] of files) {
      const target=resolve(staging,path);
      mkdirSync(dirname(target),{recursive:true,mode:0o700});
      writeFileSync(target,bytes,{mode:0o600,flag:'wx'});
    }
    renameSync(staging,runtime);
    return verify();
  } finally { rmSync(staging,{recursive:true,force:true}); }
}

function unitQuote(value,{escapeDollar=true}={}) {
  assertBridge(typeof value==='string' && !/[\x00-\x1f\x7f]/.test(value),
    'HOST_SERVICE_INVALID','Service values must not contain control characters');
  const escaped=value.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%');
  // A replacement string '$$' means ONE dollar in JavaScript. A callback
  // preserves the two literal dollars required by systemd ExecStart escaping.
  return '"'+(escapeDollar ? escaped.replaceAll('$',()=> '$$') : escaped)+'"';
}

export function hostServiceUnit({daemonPath,configDir,nodePath=process.execPath,home=homedir()}={}) {
  [daemonPath,configDir,nodePath,home].forEach(safeHostPath);
  // Do not persist npx's temporary PATH or any credential-bearing environment.
  const path=[dirname(nodePath),resolve(home,'.local/bin'),'/usr/local/bin','/usr/bin','/bin'].join(':');
  return [
    '# Managed by Bridge Host; credentials are NOT stored in this unit.',
    '[Unit]','Description=Bridge Host (current user)',
    '[Service]','Type=simple',
    `ExecStart=${[nodePath,daemonPath,'--config-dir',configDir].map(value=>unitQuote(value)).join(' ')}`,
    `Environment=${unitQuote('PATH='+path,{escapeDollar:false})}`,
    'Restart=on-failure','RestartSec=5','TimeoutStopSec=15','KillMode=control-group','NoNewPrivileges=yes',
    '[Install]','WantedBy=default.target',''
  ].join('\n');
}

export async function installHostService(paths,{hostId,daemonPath,exec,nodePath,home,startupStatus,start=true,
  startupAttempts=60,startupDelayMs=250}={}) {
  ownedService(paths);
  const unit=hostServiceUnit({daemonPath,configDir:paths.configDir,nodePath,home});
  const receipt={schemaVersion:1,hostId,unitPath:paths.unitPath,unitSha256:digest(unit)};
  if(existsSync(paths.receiptPath)) {
    assertBridge(readHostFile(paths.receiptPath)===JSON.stringify(receipt)+'\n',
      'HOST_SERVICE_CONFLICT','Another runtime is already installed; automatic replacement is intentionally disabled');
  } else {
    writeFileSync(paths.receiptPath,JSON.stringify(receipt)+'\n',{mode:0o600,flag:'wx'});
  }
  if(!existsSync(paths.unitPath)) writeFileSync(paths.unitPath,unit,{mode:0o600,flag:'wx'});
  ownedService(paths);
  for(const args of (start ? [['daemon-reload'],['enable','--now',paths.unitName]] : [['daemon-reload']])) {
    const result=runSystemctl(args,{exec});
    assertBridge(result.status===0,'HOST_SERVICE_FAILED',
      'Host is registered but its user service could not start. Fix the user service manager and rerun setup; do not re-pair');
  }
  if(!start) return {...hostServiceStatus(paths,{exec}),bootScope:'systemd-user-session'};
  let stable=0;
  for(let attempt=0;attempt<startupAttempts;attempt++) {
    const result=runSystemctl(['is-active',paths.unitName],{exec});
    const runtime=startupStatus?.();
    stable=result.status===0 && result.stdout.trim()==='active' && (!startupStatus || runtime?.localReady) ? stable+1 : 0;
    if(stable>=2) return {name:paths.unitName,active:true,...(runtime ? {runtime} : {}),bootScope:'systemd-user-session'};
    await delay(startupDelayMs);
  }
  throw new BridgeError('HOST_SERVICE_FAILED',
    'Host is registered but its daemon did not become ready. Inspect the local journal and runtime visibility; its Host ID is retained');
}

export function hostServiceStatus(paths,{exec}={}) {
  ownedService(paths);
  if(!existsSync(paths.unitPath)) return {name:paths.unitName,installed:false,active:false,autostartEnabled:false};
  const result=runSystemctl(['is-active',paths.unitName],{exec});
  const enabled=runSystemctl(['is-enabled',paths.unitName],{exec});
  const state=enabled.stdout.trim();
  const autostartEnabled=enabled.status===0 && state==='enabled' ? true :
    ['disabled','masked','masked-runtime','not-found'].includes(state) ? false : null;
  return {name:paths.unitName,installed:true,active:result.status===0 && result.stdout.trim()==='active',autostartEnabled};
}

export function stopHostService(paths,{exec}={}) {
  ownedService(paths);
  assertBridge(existsSync(paths.unitPath),'HOST_SERVICE_UNAVAILABLE','No managed Host service is installed');
  const result=runSystemctl(['disable','--now',paths.unitName],{exec});
  assertBridge(result.status===0,'HOST_SERVICE_FAILED','Could not stop the managed Host service');
  return {stopped:true,credentialsRetained:true};
}

// Explicit maintenance only; preserve identity, immutable runtimes and journals.
export function removeHostService(paths,options={}) {
  ownedService(paths);
  assertBridge(existsSync(paths.unitPath) && existsSync(paths.receiptPath),'HOST_SERVICE_UNAVAILABLE','No owned service is installed');
  stopHostService(paths,options);
  unlinkSync(paths.unitPath);unlinkSync(paths.receiptPath);
  assertBridge(runSystemctl(['daemon-reload'],options).status===0,'HOST_SERVICE_FAILED','Could not reload removed user service');
}
export function resumeHostService(paths,options={}) {
  ownedService(paths);
  assertBridge(existsSync(paths.unitPath),'HOST_SERVICE_UNAVAILABLE','No owned service is installed');
  for(const args of [['daemon-reload'],['enable','--now',paths.unitName]])
    assertBridge(runSystemctl(args,options).status===0,'HOST_SERVICE_FAILED','Could not restore the owned user service');
}

export function hostServiceIdentity(paths) {
  ownedService(paths);
  const line=readHostFile(paths.unitPath).match(/^ExecStart=(.+)$/m)?.[1];
  const quoted=line?.match(/"(?:\\.|[^"\\])*"/g) ?? [];
  const values=quoted.map(value=>value.slice(1,-1).replace(/\\([\\"])/g,'$1').replaceAll('%%','%').replaceAll('$$','$'));
  assertBridge(values.length===4 && values[2]==='--config-dir' && values[3]===paths.configDir &&
    values.map(value=>unitQuote(value)).join(' ')===line,'HOST_SERVICE_CONFLICT','Owned service has an unrecognized execution identity');
  return {nodePath:safeHostPath(values[0]),daemonPath:safeHostPath(values[1])};
}

export function setHostServiceAutostart(paths,enabled,options={}) {
  assertBridge(typeof enabled==='boolean','HOST_USAGE_INVALID','Autostart must be on or off');
  ownedService(paths);
  assertBridge(existsSync(paths.unitPath) && existsSync(paths.receiptPath),'HOST_SERVICE_UNAVAILABLE','Run setup --background before changing autostart');
  // No --now: editing the next-session setting must not start or stop this process.
  assertBridge(runSystemctl([enabled ? 'enable' : 'disable',paths.unitName],options).status===0,
    'HOST_SERVICE_FAILED','Could not change user-service autostart');
  const state=hostServiceStatus(paths,options);
  assertBridge(state.autostartEnabled===enabled,'HOST_SERVICE_FAILED','Could not verify the user-service autostart setting');
  return state;
}
