#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { connectDirectHost } from '../src/direct-connect-client.mjs';
import { runForeground } from '../src/host-runner.mjs';
import { doctor } from '../src/doctor.mjs';
import { errorEnvelope, BridgeError, assertBridge } from '../src/errors.mjs';
import { setupHost, hostConfigDir } from '../src/host-onboarding.mjs';
import { persistenceStatus, stopPersistence, setPersistenceAutostart } from '../src/host-persistence.mjs';
import { maintainHost } from '../src/host-maintenance.mjs';
import { HOST_VERSION, HOST_PACKAGE_NAME, DEFAULT_HOST_ENDPOINT } from '../src/host-package-spec.mjs';

const HELP=`Bridge Host ${HOST_VERSION}
Usage:
  bridge-host [setup] [--yes] [--foreground | --background | --no-service]
  bridge-host connect [--pairing-token TOKEN | --pairing-token-file FILE]
  bridge-host start [--poll-ms N] [--once]
  bridge-host doctor | status | stop
  bridge-host autostart on | off | status
  bridge-host upgrade | rollback | uninstall [--yes]
  bridge-host --help | --version

Run with npx ${HOST_PACKAGE_NAME}@${HOST_VERSION} (Node.js 22+ required).
Authorize in your browser and pair once. Windows: current-user login task;
macOS: user LaunchAgent; Linux/WSL: systemd USER service when available.
Without an available background manager, default setup runs in the foreground.
--foreground always keeps this terminal running; Ctrl+C stops it, not its identity.
--background requires background support and never silently falls back.
--no-service only pairs/configures; it does not start a runner (legacy behavior).
--yes consents to command execution with current-user rights and the chosen mode.
--no-browser prints an authorization URL to open on this same computer.
Advanced: --endpoint HTTPS_MCP_URL, --config-dir DIR, --login-timeout SECONDS.
Explicit-token connect only pairs. start uses an existing identity in foreground.
status shows current activity and automatic-start settings separately.
stop retains its existing behavior: stop the background service AND disable autostart.
autostart on/off changes future automatic startup only; it does not start/stop now.
No private repository, Cloudflare configuration, sudo or LocalSystem service.
Windows/macOS background execution requires a logged-in user session.
WSL must be running; Bridge does not start WSL, install Node, or enable linger.
`;

async function consent(yes,mode) {
  if(yes) return;
  if(!process.stdin.isTTY) throw new BridgeError('HOST_CONSENT_REQUIRED',
    'Setup needs an interactive terminal or explicit --yes consent. See --help');
  const terminal=createInterface({input:process.stdin,output:process.stderr});
  const behavior=mode==='auto' ? 'install/start a user background service if supported, otherwise keep this terminal running' :
    mode==='background' ? 'install/start a user background service' : mode==='foreground' ? 'keep this terminal running' : 'save the Host configuration only';
  try {
    const answer=await terminal.question(`Allow Bridge to execute commands as ${userInfo().username} and ${behavior}? [y/N] `);
    if(!/^y(es)?$/i.test(answer.trim())) throw new BridgeError('HOST_SETUP_CANCELED','Host setup was not authorized');
  } finally {terminal.close();}
}

try {
  const {values,positionals}=parseArgs({args:process.argv.slice(2),strict:true,allowPositionals:true,options:{
    help:{type:'boolean'},version:{type:'boolean'},yes:{type:'boolean'},foreground:{type:'boolean'},background:{type:'boolean'},
    endpoint:{type:'string'},'config-dir':{type:'string'},'pairing-token':{type:'string'},'pairing-token-file':{type:'string'},
    'no-browser':{type:'boolean'},'no-service':{type:'boolean'},'login-timeout':{type:'string'},'poll-ms':{type:'string'},once:{type:'boolean'}
  }});
  if(values.help) process.stdout.write(HELP);
  else if(values.version) process.stdout.write(HOST_VERSION+'\n');
  else {
    const command=positionals[0] ?? 'setup';
    assertBridge(positionals.length<=(command==='autostart' ? 2 : 1),'HOST_USAGE_INVALID','Unexpected command arguments');
    assertBridge(command!=='autostart' || ['on','off','status'].includes(positionals[1]),'HOST_USAGE_INVALID','Use autostart on, off or status');
    assertBridge(['setup','connect','start','doctor','status','stop','upgrade','rollback','uninstall','autostart'].includes(command),'HOST_USAGE_INVALID','Unknown command; see --help');
    assertBridge([values.foreground,values.background,values['no-service']].filter(Boolean).length<=1,
      'HOST_USAGE_INVALID','Choose only one of --foreground, --background and --no-service');
    const configDir=values['config-dir'] ? resolve(values['config-dir']) : hostConfigDir();
    const pollMs=values['poll-ms']===undefined ? 5000 : Number(values['poll-ms']);
    assertBridge(Number.isSafeInteger(pollMs) && pollMs>=1000 && pollMs<=60_000,'HOST_USAGE_INVALID','Poll interval must be 1000-60000 milliseconds');
    let result,foreground=false;
    if(command==='setup' || command==='connect') {
      const sources=[values['pairing-token'],values['pairing-token-file'] ?
        readFileSync(resolve(values['pairing-token-file']),'utf8').trim() : undefined,
      process.env.BRIDGE_PAIRING_TOKEN].filter(value=>typeof value==='string' && value.length>0);
      assertBridge(sources.length<=1,'HOST_USAGE_INVALID','Provide only one pairing-token source');
      delete process.env.BRIDGE_PAIRING_TOKEN;
      if(command==='connect' && sources.length===1) {
        const connected=await connectDirectHost({endpoint:values.endpoint ?? DEFAULT_HOST_ENDPOINT,pairingToken:sources[0],configDir});
        result={connected:connected.connected,hostId:connected.hostId,endpoint:connected.endpoint,configDir,next:'bridge-host start'};
      } else {
        const seconds=values['login-timeout']===undefined ? 300 : Number(values['login-timeout']);
        assertBridge(Number.isSafeInteger(seconds) && seconds>=1 && seconds<=600,'HOST_USAGE_INVALID','Login timeout must be 1-600 seconds');
        const mode=values.foreground ? 'foreground' : values.background ? 'background' : values['no-service'] ? 'manual' : 'auto';
        await consent(values.yes===true,mode);
        result=await setupHost({endpoint:values.endpoint,configDir,pairingToken:sources[0],persistenceMode:mode,
          openBrowser:values['no-browser']!==true,timeoutMs:seconds*1000,
          onAuthorization:url=>process.stderr.write(`Authorize this computer in your browser:\n${url}\n`)});
        foreground=result.mode==='foreground';
      }
    } else if(command==='autostart') {
      assertBridge(!values.foreground && !values.background && !values['no-service'],'HOST_USAGE_INVALID','Autostart settings do not select a run mode');
      result=positionals[1]==='status' ? persistenceStatus(configDir) : setPersistenceAutostart(configDir,positionals[1]==='on');
    } else if(['upgrade','rollback','uninstall'].includes(command)) {
      assertBridge(values.yes===true,'HOST_CONSENT_REQUIRED','Maintenance requires explicit --yes. Identity, credentials, journals and runtimes are retained; see HOST_QUICKSTART.md');
      result=await maintainHost(configDir,command);
    } else if(command==='start') {
      assertBridge(!values.background && !values['no-service'],'HOST_USAGE_INVALID','start is foreground-only; use setup --background for a service');
      assertBridge(!persistenceStatus(configDir).active,'HOST_ALREADY_RUNNING','Background Host is active; stop it before running foreground');
      foreground=true;
    } else if(command==='doctor') {
      result=doctor({hostPolicyPath:resolve(configDir,'host.json')});process.exitCode=result.ok ? 0 : 66;
    } else if(command==='status') result=persistenceStatus(configDir);
    else result=stopPersistence(configDir);
    if(result) process.stdout.write(JSON.stringify(result,null,2)+'\n');
    if(foreground) {
      process.stderr.write('Foreground Host: keep this terminal open. Ctrl+C stops execution; pairing and Host ID are retained.\n');
      const stopped=await runForeground({configDir,pollMs,once:values.once===true});
      process.stdout.write(JSON.stringify(stopped)+'\n');
    }
  }
} catch(error) {
  const envelope=error instanceof BridgeError ? errorEnvelope(error) : {
    code:'HOST_OPERATION_FAILED',message:'Host operation failed; check arguments, local paths and permissions'};
  process.stderr.write(JSON.stringify(envelope)+'\n');process.exitCode=65;
}
