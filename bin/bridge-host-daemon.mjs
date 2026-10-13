#!/usr/bin/env node
// Dependency-free runtime shared by foreground and all OS supervisors.
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runForeground } from '../src/host-runner.mjs';
import { createRuntimeReporter } from '../src/host-runtime-status.mjs';
let report;
try {
  const {values}=parseArgs({options:{'config-dir':{type:'string'}},strict:true});
  if(!values['config-dir']) throw new Error('--config-dir is required');
  const configDir=resolve(values['config-dir']);
  report=createRuntimeReporter({configDir,daemonPath:fileURLToPath(import.meta.url)});
  await runForeground({configDir,onState:report});
} catch(error) {
  try {report?.({phase:'failed',code:error.code});} catch {}
  process.stderr.write(JSON.stringify({code:/^[A-Z][A-Z0-9_]{2,63}$/.test(error.code ?? '') ? error.code : 'HOST_DAEMON_FAILED',
    message:error.message==='--config-dir is required' ? error.message : 'Host daemon stopped; check local configuration and authorization'})+'\n');
  process.exitCode=65;
}
