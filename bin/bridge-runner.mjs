#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { executeRequest } from '../src/runtime.mjs';
import { doctor } from '../src/doctor.mjs';
import { prepareEditCandidate } from '../src/edit.mjs';
import { verifyEditCandidate } from '../src/verify-edit.mjs';
import { publishEditCandidate } from '../src/publish-edit.mjs';
import { errorEnvelope } from '../src/errors.mjs';
import { readJsonFile, parseJsonBytes } from '../src/json.mjs';
import { readTrustedProjectPolicyBytes } from '../src/git.mjs';
import { validateHostPolicy, validateProjectPolicy } from '../src/validate.mjs';
import { executeDirectExec } from '../src/direct-exec.mjs';
import { runDirectRunnerLoop } from '../src/direct-runner-client.mjs';
import { connectDirectHost, readDirectRunnerEnv } from '../src/direct-connect-client.mjs';
import { bootstrapProject } from '../src/bootstrap-project.mjs';

function usage() {
  process.stderr.write(`Usage:\n  bridge-runner execute --request FILE --repo PATH --host-policy FILE --output-dir DIR\n  bridge-runner direct-exec --request FILE --host-policy FILE --output-dir DIR\n  bridge-runner connect --endpoint URL [--pairing-token TOKEN|--pairing-token-file FILE] [--config-dir DIR]\n  bridge-runner direct-loop --host-policy FILE [--env-file FILE|--endpoint URL] [--poll-ms N] [--once]\n  bridge-runner bootstrap-project --repo PATH [--verify-argv JSON] [--repository owner/repo] [--host-policy FILE] [--runner-class NAME] [--service-user USER] --bridge-repository owner/repo [--bridge-sha SHA|current] [--force]\n  bridge-runner prepare-edit --request FILE --repo PATH --host-policy FILE --output-dir DIR\n  bridge-runner verify-edit --prepare-dir DIR --repo PATH --host-policy FILE --output-dir DIR\n  bridge-runner publish-edit --prepare-dir DIR --verification-dir DIR --repo PATH --output-dir DIR\n  bridge-runner doctor --host-policy FILE [--repository owner/repo]\n  bridge-runner validate-host-policy --host-policy FILE\n  bridge-runner validate-project-policy --repo PATH --policy-sha SHA --repository owner/repo\n`);
  process.exit(64);
}
const [command, ...rest] = process.argv.slice(2); if (!command) usage();
const common = { 'host-policy':{type:'string'}, repository:{type:'string'}, repo:{type:'string'}, 'policy-sha':{type:'string'}, request:{type:'string'}, 'prepare-dir':{type:'string'}, 'verification-dir':{type:'string'}, 'output-dir':{type:'string'}, endpoint:{type:'string'}, 'poll-ms':{type:'string'}, once:{type:'boolean'}, 'verify-argv':{type:'string'}, 'runner-class':{type:'string'}, 'service-user':{type:'string'}, 'bridge-sha':{type:'string'}, 'bridge-repository':{type:'string'}, force:{type:'boolean'}, 'pairing-token':{type:'string'}, 'pairing-token-file':{type:'string'}, 'config-dir':{type:'string'}, 'env-file':{type:'string'} };
try {
  const { values } = parseArgs({ args:rest, strict:true, options:common });
  if (command === 'connect') {
    if (!values.endpoint) usage();
    const sources=[
      values['pairing-token'],
      values['pairing-token-file'] ? readFileSync(resolve(values['pairing-token-file']),'utf8').trim() : undefined,
      process.env.BRIDGE_PAIRING_TOKEN
    ].filter(value=>typeof value==='string' && value.length>0);
    if(sources.length!==1) {
      throw new Error('provide exactly one pairing token source: --pairing-token, --pairing-token-file, or BRIDGE_PAIRING_TOKEN');
    }
    const result=await connectDirectHost({
      endpoint:values.endpoint,
      pairingToken:sources[0],
      ...(values['config-dir'] ? {configDir:resolve(values['config-dir'])} : {})
    });
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  } else if (command === 'execute') {
    if (!values.request || !values.repo || !values['host-policy'] || !values['output-dir']) usage();
    const result = await executeRequest({ requestPath:resolve(values.request), repoPath:resolve(values.repo), hostPolicyPath:resolve(values['host-policy']), outputDir:resolve(values['output-dir']) });
    const ok = result.status === 'SUCCEEDED' || result.status === 'VERIFIED';
    process.stdout.write(JSON.stringify({ok,status:result.status,requestId:result.requestId,capability:result.capability})+'\n');
    if (!ok) process.exitCode = 65;
  } else if (command === 'direct-exec') {
    if (!values.request || !values['host-policy'] || !values['output-dir']) usage();
    const requestPath=resolve(values.request);
    const requestBytes=readFileSync(requestPath);
    const request=parseJsonBytes(requestBytes,'direct exec request');
    const hostPolicy=readJsonFile(resolve(values['host-policy']),'host policy');
    const result=await executeDirectExec({request,requestBytes,hostPolicy});
    mkdirSync(resolve(values['output-dir']),{recursive:true});
    writeFileSync(resolve(values['output-dir'],'bridge-result.json'),JSON.stringify(result,null,2)+'\n');
    process.stdout.write(JSON.stringify({ok:true,status:result.status,requestId:result.requestId,hostId:result.hostId,transport:'direct'})+'\n');
  } else if (command === 'bootstrap-project') {
    if (!values.repo) usage();
    let verify;
    try { if(values['verify-argv']!==undefined)verify=JSON.parse(values['verify-argv']); }
    catch { throw new Error('--verify-argv must be a JSON argv array'); }
    const result=bootstrapProject({
      repoPath:resolve(values.repo),
      repository:values.repository,
      verify,
      bridgeSha:values['bridge-sha'] ?? 'current',
      bridgeRepository:values['bridge-repository'],
      runnerClass:values['runner-class'] ?? 'bridge',
      serviceUser:values['service-user'],
      hostPolicyPath:values['host-policy'] ? resolve(values['host-policy']) : null,
      force:values.force === true
    });
    process.stdout.write(JSON.stringify(result,null,2)+'\n');
  } else if (command === 'direct-loop') {
    if (!values['host-policy']) usage();
    const fileEnv=values['env-file']
      ? readDirectRunnerEnv(resolve(values['env-file']))
      : null;
    const endpoint=values.endpoint ?? fileEnv?.endpoint ?? process.env.BRIDGE_PUBLIC_URL;
    const token=fileEnv?.token ?? process.env.BRIDGE_DIRECT_RUNNER_TOKEN;
    const pollMs=values['poll-ms']===undefined ? 15000 : Number(values['poll-ms']);
    const result=await runDirectRunnerLoop({
      endpoint,
      token,
      hostPolicyPath:resolve(values['host-policy']),
      pollMs,
      once:values.once === true
    });
    process.stdout.write(JSON.stringify(result)+'\n');
  } else if (command === 'prepare-edit') {
    if (!values.request || !values.repo || !values['host-policy'] || !values['output-dir']) usage();
    const result = prepareEditCandidate({ requestPath:resolve(values.request), repoPath:resolve(values.repo), hostPolicyPath:resolve(values['host-policy']), outputDir:resolve(values['output-dir']) });
    process.stdout.write(JSON.stringify({ok:true,status:result.status,requestId:result.requestId,candidateSha:result.candidateSha})+'\n');
  } else if (command === 'verify-edit') {
    if (!values['prepare-dir'] || !values.repo || !values['host-policy'] || !values['output-dir']) usage();
    const result = await verifyEditCandidate({ prepareDir:resolve(values['prepare-dir']), repoPath:resolve(values.repo), hostPolicyPath:resolve(values['host-policy']), outputDir:resolve(values['output-dir']) });
    process.stdout.write(JSON.stringify({ok:true,status:result.status,requestId:result.requestId,candidateSha:result.candidateSha})+'\n');
  } else if (command === 'publish-edit') {
    if (!values['prepare-dir'] || !values['verification-dir'] || !values.repo || !values['output-dir']) usage();
    const result = publishEditCandidate({ prepareDir:resolve(values['prepare-dir']), verificationDir:resolve(values['verification-dir']), repoPath:resolve(values.repo), outputDir:resolve(values['output-dir']) });
    process.stdout.write(JSON.stringify({ok:true,status:result.status,requestId:result.requestId,candidateSha:result.candidateSha,published:result.published})+'\n');
  } else if (command === 'doctor') {
    if (!values['host-policy']) usage(); const result=doctor({hostPolicyPath:resolve(values['host-policy']),repository:values.repository}); process.stdout.write(JSON.stringify(result,null,2)+'\n'); process.exitCode=result.ok?0:66;
  } else if (command === 'validate-host-policy') {
    if (!values['host-policy']) usage(); validateHostPolicy(readJsonFile(resolve(values['host-policy']),'host policy')); process.stdout.write('{"ok":true}\n');
  } else if (command === 'validate-project-policy') {
    if (!values.repo || !values['policy-sha'] || !values.repository) usage(); const bytes=readTrustedProjectPolicyBytes(resolve(values.repo),values['policy-sha'],values.repository); validateProjectPolicy(parseJsonBytes(bytes,'project policy'),values.repository); process.stdout.write('{"ok":true}\n');
  } else usage();
} catch (error) {
  const envelope = { schemaVersion:1, status:'FAILED', error:errorEnvelope(error), completedAt:new Date().toISOString() };
  try {
    const {values}=parseArgs({args:rest,strict:false,options:common}); if(values['output-dir']) { mkdirSync(resolve(values['output-dir']),{recursive:true}); writeFileSync(resolve(values['output-dir'],'bridge-result.json'),JSON.stringify(envelope,null,2)+'\n'); }
  } catch {}
  process.stderr.write(JSON.stringify(envelope.error)+'\n'); process.exit(65);
}
