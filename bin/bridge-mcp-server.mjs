#!/usr/bin/env node
import { buildPrivateGateway, createPrivateMcpHttpServer, parsePrivateMcpConfig } from '../src/private-mcp.mjs';

const config=parsePrivateMcpConfig(process.env);
const gateway=buildPrivateGateway({config});
const service=createPrivateMcpHttpServer({
  gateway,
  bearerToken:config.bearerToken,
  clientId:config.clientId
});

await service.listen({host:config.host,port:config.port});
process.stdout.write(`Bridge private MCP listening on http://${config.host}:${config.port}/mcp\n`);

let closing=false;
async function shutdown(signal) {
  if(closing) return;
  closing=true;
  process.stdout.write(`Bridge private MCP shutting down on ${signal}\n`);
  await service.close();
}

process.on('SIGINT',()=>{ void shutdown('SIGINT').then(()=>process.exit(0)); });
process.on('SIGTERM',()=>{ void shutdown('SIGTERM').then(()=>process.exit(0)); });
