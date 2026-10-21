import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OAuthError,
  OAuthErrorCode
} from '@modelcontextprotocol/server';
import {
  Client,
  StreamableHTTPClientTransport
} from '@modelcontextprotocol/client';
import { createBridgePrincipal } from '../src/auth/principal.mjs';
import {
  createBridgeOAuthMcpHandler,
  createBridgeOAuthVerifier
} from '../src/oauth-resource-server.mjs';

const RESOURCE='https://bridge.example/mcp';
const ISSUER='https://identity.example/';
const OAUTH_METADATA={
  issuer:ISSUER,
  authorization_endpoint:`${ISSUER}authorize`,
  token_endpoint:`${ISSUER}oauth/token`,
  response_types_supported:['code'],
  grant_types_supported:['authorization_code','refresh_token'],
  code_challenge_methods_supported:['S256'],
  token_endpoint_auth_methods_supported:['none'],
  scopes_supported:['bridge','offline_access']
};

function fakeGateway() {
  return {
    async discover({repository}) {
      return {
        repository,
        policy:{ref:'main',sha:'a'.repeat(40)},
        capabilities:[],
        workspaceExec:{enabled:false},
        editing:{enabled:false}
      };
    },
    async run() { return {runId:'fake-run-123456'}; },
    async getRun({runId}) { return {runId,status:'QUEUED'}; },
    async getResult({runId}) { return {runId,status:'SUCCEEDED'}; },
    async publish({runId}) { return {runId,status:'PUBLISHED'}; }
  };
}

function authInfo(token,{scopes=['bridge'],resource=RESOURCE,subject='user-1'}={}) {
  return {
    token,
    clientId:'chatgpt-oauth-client',
    scopes,
    expiresAt:Math.floor(Date.now()/1000)+3600,
    resource:new URL(resource),
    extra:{
      issuer:ISSUER,
      subject
    }
  };
}

function verifier() {
  return {
    async verifyAccessToken(token) {
      if(token==='invalid') {
        throw new OAuthError(OAuthErrorCode.InvalidToken,'invalid test access token');
      }
      if(token==='wrong-resource') {
        return authInfo(token,{resource:'https://other.example/mcp'});
      }
      if(token==='insufficient') {
        return authInfo(token,{scopes:[]});
      }
      if(token==='unknown-principal') {
        return authInfo(token,{subject:'unknown'});
      }
      return authInfo(token);
    }
  };
}

function principalResolver() {
  return {
    async resolve({authInfo:verified}) {
      if(verified.extra?.subject!=='user-1') return null;
      return createBridgePrincipal({
        bridgeUserId:'bridge-user-1',
        externalProvider:'https://identity.example/',
        externalSubject:'user-1',
        githubUserId:'1234'
      });
    }
  };
}

async function connectInProcess(t,service,token) {
  const transport=new StreamableHTTPClientTransport(
    new URL(RESOURCE),
    {
      fetch:async(input,init)=>{
        const original=input instanceof Request
          ? new Request(input,init)
          : new Request(input,init);
        const headers=new Headers(original.headers);
        headers.set('authorization',`Bearer ${token}`);
        return service.fetch(new Request(original,{headers}));
      }
    }
  );
  const client=new Client({name:'oauth-bridge-test',version:'0.1.0'});
  await client.connect(transport);
  t.after(async()=>{
    await client.close();
    await service.close();
  });
  return client;
}

test('OAuth resource server publishes RFC 9728 protected-resource metadata',async()=>{
  const service=createBridgeOAuthMcpHandler({
    verifier:verifier(),
    principalResolver:principalResolver(),
    resourceServerUrl:RESOURCE,
    oauthMetadata:OAUTH_METADATA,
    gatewayForPrincipal:()=>fakeGateway()
  });
  try {
    assert.equal(
      String(service.resourceMetadataUrl),
      'https://bridge.example/.well-known/oauth-protected-resource/mcp'
    );
    const response=await service.fetch(
      new Request(service.resourceMetadataUrl,{method:'GET'})
    );
    assert.equal(response.status,200);
    const metadata=await response.json();
    assert.equal(metadata.resource,RESOURCE);
    assert.deepEqual(metadata.authorization_servers,[ISSUER]);
  } finally {
    await service.close();
  }
});

test('OAuth resource server returns standards-based bearer challenges before MCP handling',async()=>{
  let gatewayCalls=0;
  const service=createBridgeOAuthMcpHandler({
    verifier:verifier(),
    principalResolver:principalResolver(),
    resourceServerUrl:RESOURCE,
    oauthMetadata:OAUTH_METADATA,
    gatewayForPrincipal:()=>{
      gatewayCalls++;
      return fakeGateway();
    }
  });
  try {
    const anonymous=await service.fetch(new Request(RESOURCE,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:'{}'
    }));
    assert.equal(anonymous.status,401);
    assert.match(
      anonymous.headers.get('www-authenticate') ?? '',
      /resource_metadata="https:\/\/bridge\.example\/\.well-known\/oauth-protected-resource\/mcp"/
    );

    const invalid=await service.fetch(new Request(RESOURCE,{
      method:'POST',
      headers:{
        authorization:'Bearer invalid',
        'content-type':'application/json'
      },
      body:'{}'
    }));
    assert.equal(invalid.status,401);

    const insufficient=await service.fetch(new Request(RESOURCE,{
      method:'POST',
      headers:{
        authorization:'Bearer insufficient',
        'content-type':'application/json'
      },
      body:'{}'
    }));
    assert.equal(insufficient.status,403);
    assert.match(insufficient.headers.get('www-authenticate') ?? '',/insufficient_scope/);

    assert.equal(gatewayCalls,0);
  } finally {
    await service.close();
  }
});

test('OAuth verifier rejects wrong resource and unknown principal as invalid tokens',async()=>{
  const bridgeVerifier=createBridgeOAuthVerifier({
    verifier:verifier(),
    principalResolver:principalResolver(),
    resourceServerUrl:RESOURCE
  });

  await assert.rejects(
    ()=>bridgeVerifier.verifyAccessToken('wrong-resource'),
    error=>
      error instanceof OAuthError &&
      error.code===OAuthErrorCode.InvalidToken
  );
  await assert.rejects(
    ()=>bridgeVerifier.verifyAccessToken('unknown-principal'),
    error=>
      error instanceof OAuthError &&
      error.code===OAuthErrorCode.InvalidToken
  );
});

test('verified OAuth principal reaches gatewayForRequest with bounded task transition',async t=>{
  const seen=[];
  const service=createBridgeOAuthMcpHandler({
    verifier:verifier(),
    principalResolver:principalResolver(),
    resourceServerUrl:RESOURCE,
    oauthMetadata:OAUTH_METADATA,
    gatewayForPrincipal:({principal,requestInfo})=>{
      seen.push({principal,requestInfo});
      return fakeGateway();
    }
  });
  const client=await connectInProcess(t,service,'valid');

  const listed=await client.listTools();
  assert.deepEqual(
    listed.tools.map(tool=>tool.name),
    ["bridge.list_hosts","bridge.create_host_pairing","bridge.pause_host","bridge.resume_host","bridge.run_host_command","bridge.import_file","bridge.create_file_upload","bridge.delete_file","bridge.get_repository_configuration","bridge.execute_repository_commands","bridge.verify_repository","bridge.edit_and_verify_repository","bridge.get_run","bridge.get_result","bridge.publish","bridge.task_transition","bridge.repository_tools_status"]
  );
  const publish=listed.tools.find(tool=>tool.name==='bridge.publish');
  assert.deepEqual(Object.keys(publish.inputSchema.properties),['runId','taskSessionToken']);

  const result=await client.callTool({
    name:'bridge.get_repository_configuration',
    arguments:{repository:'example/project'}
  });
  assert.equal(result.isError,undefined);
  assert.ok(seen.length>=1);
  assert.ok(
    seen.every(entry=>
      entry.principal.bridgeUserId==='bridge-user-1' &&
      entry.principal.externalSubject==='user-1' &&
      entry.requestInfo instanceof Request
    )
  );
  assert.equal(JSON.stringify(seen).includes('valid'),false);
});
