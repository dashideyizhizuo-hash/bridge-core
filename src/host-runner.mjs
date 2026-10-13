import { resolve } from 'node:path';
import { readHostFile } from './host-files.mjs';
import { readDirectRunnerEnv } from './direct-connect-client.mjs';
import { runDirectRunnerLoop } from './direct-runner-client.mjs';
import { hostEndpoint } from './host-http.mjs';
import { validateHostPolicy } from './validate.mjs';

export async function runHost({configDir,once=false,pollMs=5000,signal,fetchImpl=globalThis.fetch,onError=()=>{},onState=()=>{}}={}) {
  // Verify local credential and policy ownership on every launch, not only setup.
  validateHostPolicy(JSON.parse(readHostFile(resolve(configDir,'host.json'))));
  readHostFile(resolve(configDir,'direct-runner.env'));
  const local=readDirectRunnerEnv(resolve(configDir,'direct-runner.env'));
  onState({phase:'ready'});
  // The common Runner transport enforces control/asset bounds once, including
  // standalone CLI use. Keep production endpoint validation at the Host edge.
  hostEndpoint(local.endpoint);
  return runDirectRunnerLoop({endpoint:local.endpoint,token:local.token,
    hostPolicyPath:resolve(configDir,'host.json'),once,pollMs,signal,
    onContact:()=>onState({phase:'connected'}),
    onError:error=>{onState({phase:'retrying',code:error.code});onError(error);},
    fetchImpl});
}

export async function runForeground(options) {
  const controller=new AbortController();
  const shutdown=()=>controller.abort();
  const signals=process.platform==='win32' ? ['SIGINT','SIGTERM','SIGBREAK'] : ['SIGINT','SIGTERM','SIGHUP'];
  for(const signal of signals) process.on(signal,shutdown);
  try {
    return await runHost({...options,signal:options.signal ? AbortSignal.any([controller.signal,options.signal]) : controller.signal,
      onError:error=>process.stderr.write(JSON.stringify({code:/^[A-Z][A-Z0-9_]{2,63}$/.test(error.code ?? '') ? error.code : 'HOST_RUN_RETRY',
        message:'Host request failed; retrying without re-pairing'})+'\n')});
  } finally {for(const signal of signals) process.removeListener(signal,shutdown);options?.onState?.({phase:'stopped'});}
}
