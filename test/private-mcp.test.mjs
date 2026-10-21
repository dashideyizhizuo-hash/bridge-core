import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  authenticatePrivateRequest,
  createPrivateMcpHttpServer,
  parsePrivateMcpConfig,
  parseRepositoryGrants
} from '../src/private-mcp.mjs';

const TOKEN='private-bridge-token-1234567890';

function fakeGateway(){
  return {
    async discover({repository}){ return {repository,policy:{ref:'main',sha:'a'.repeat(40)},capabilities:[],workspaceExec:{enabled:false},editing:{enabled:false}}; },
    async run(){ return {runId:'fake-run-123456'}; },
    async getRun({runId}){ return {runId,status:'QUEUED'}; },
    async getResult({runId}){ return {runId,status:'SUCCEEDED'}; },
    async publish({runId}){ return {runId,status:'PUBLISHED'}; }
  };
}

test('private config is loopback-only and repository grants are explicit',()=>{
  const config=parsePrivateMcpConfig({
    BRIDGE_MCP_TOKEN:TOKEN,
    BRIDGE_GITHUB_TOKEN:'github-token',
    BRIDGE_REPOSITORY_GRANTS:JSON.stringify({
      read:['example/project','example/read-only'],
      run:['example/project'],
      publish:['example/project']
    }),
    BRIDGE_MCP_PORT:'8787'
  });
  assert.equal(config.host,'127.0.0.1');
  assert.equal(config.port,8787);
  assert.deepEqual(config.grants.publish,['example/project']);

  assert.throws(
    ()=>parsePrivateMcpConfig({
      BRIDGE_MCP_TOKEN:TOKEN,
      BRIDGE_GITHUB_TOKEN:'github-token',
      BRIDGE_REPOSITORY_GRANTS:'{"read":[]}',
      BRIDGE_MCP_HOST:'0.0.0.0'
    }),
    error=>error.code==='PRIVATE_MCP_CONFIG_INVALID'
  );
});

test('publish grant cannot exist without read and run authority',()=>{
  assert.throws(
    ()=>parseRepositoryGrants('{"read":["example/project"],"run":[],"publish":["example/project"]}'),
    error=>error.code==='PRIVATE_MCP_CONFIG_INVALID'
  );
});

test('private bearer authentication uses a separate MCP token',()=>{
  const accepted=authenticatePrivateRequest(
    new Request('http://127.0.0.1/mcp',{headers:{authorization:`Bearer ${TOKEN}`}}),
    {bearerToken:TOKEN,clientId:'private-test'}
  );
  assert.equal(accepted.clientId,'private-test');
  assert.deepEqual(accepted.scopes,['bridge']);

  const rejected=authenticatePrivateRequest(
    new Request('http://127.0.0.1/mcp',{headers:{authorization:'Bearer wrong-token'}}),
    {bearerToken:TOKEN,clientId:'private-test'}
  );
  assert.ok(rejected instanceof Response);
  assert.equal(rejected.status,401);
  assert.match(rejected.headers.get('www-authenticate'),/^Bearer /);
});

test('private HTTP server rejects anonymous requests and serves MCP with bearer auth',async t=>{
  const service=createPrivateMcpHttpServer({
    gateway:fakeGateway(),
    bearerToken:TOKEN,
    clientId:'private-test'
  });
  const address=await service.listen({host:'127.0.0.1',port:0});
  assert.ok(address && typeof address==='object' && Number.isInteger(address.port));
  const url=new URL(`http://127.0.0.1:${address.port}/mcp`);

  const anonymous=await fetch(url,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:'{}'
  });
  assert.equal(anonymous.status,401);

  const transport=new StreamableHTTPClientTransport(url,{
    fetch:async(input,init)=>{
      const original=input instanceof Request ? new Request(input,init) : new Request(input,init);
      const headers=new Headers(original.headers);
      headers.set('authorization',`Bearer ${TOKEN}`);
      return fetch(new Request(original,{headers}));
    }
  });
  const client=new Client({name:'private-mcp-test',version:'0.1.0'});
  t.after(async()=>{
    await client.close();
    await service.close();
  });
  await client.connect(transport);

  const tools=await client.listTools();
  assert.deepEqual(tools.tools.map(tool=>tool.name),["bridge.list_hosts","bridge.create_host_pairing","bridge.pause_host","bridge.resume_host","bridge.run_host_command","bridge.import_file","bridge.create_file_upload","bridge.delete_file","bridge.get_repository_configuration","bridge.execute_repository_commands","bridge.verify_repository","bridge.edit_and_verify_repository","bridge.get_run","bridge.get_result","bridge.publish","bridge.task_transition","bridge.repository_tools_status"]);

  const discovered=await client.callTool({
    name:'bridge.get_repository_configuration',
    arguments:{repository:'example/project'}
  });
  assert.equal(discovered.isError,undefined);
});
