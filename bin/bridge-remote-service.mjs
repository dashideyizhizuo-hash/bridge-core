#!/usr/bin/env node
import { createNodeRemoteBridgeApplication } from '../src/node-remote-service.mjs';

function startupCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{3,96}$/.test(error.code)
    ? error.code
    : 'REMOTE_SERVICE_STARTUP_FAILED';
}

let application;
try {
  application=await createNodeRemoteBridgeApplication();
  await application.listen();
  process.stdout.write(`Bridge remote MCP ready at ${application.config.publicUrl}\n`);
} catch(error) {
  process.stderr.write(`Bridge remote MCP startup failed: ${startupCode(error)}\n`);
  process.exitCode=1;
}

let closing=false;
async function shutdown(signal) {
  if(closing || !application) return;
  closing=true;
  process.stdout.write(`Bridge remote MCP shutting down on ${signal}\n`);
  await application.close();
}

process.on('SIGINT',()=>{
  void shutdown('SIGINT').then(()=>process.exit(0));
});
process.on('SIGTERM',()=>{
  void shutdown('SIGTERM').then(()=>process.exit(0));
});
