import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createBridgePrincipal } from '../src/auth/principal.mjs';
import { createRequestScopedGateway } from '../src/control-plane.mjs';

const REPO='example/project';
const INSTALLATION_ID=12345;
const BASE='a'.repeat(40);
const TARGET='b'.repeat(40);
const POLICY_TREE='c'.repeat(40);
const BLOB='d'.repeat(40);
const REQUEST_TREE='e'.repeat(40);
const CONTROL='f'.repeat(40);

function fixturePolicy() {
  return JSON.parse(
    readFileSync(resolve('test/fixtures/project/.bridge/project.json'),'utf8')
  );
}

function principal(id='alice') {
  return createBridgePrincipal({
    bridgeUserId:id,
    externalProvider:'test',
    externalSubject:`subject-${id}`
  });
}

function authorizerForAlice() {
  return {
    async assert({principal:activePrincipal,repository,permission}) {
      const allowed=
        activePrincipal?.bridgeUserId==='alice' &&
        repository===REPO &&
        (permission==='read' || permission==='run');
      if(!allowed) {
        const error=new Error(`${permission} access denied for repository: ${repository}`);
        error.code='REPOSITORY_DENIED';
        throw error;
      }
      return repository;
    }
  };
}

function createInstallationResolver() {
  const calls=[];
  return {
    calls,
    async resolve({principal:activePrincipal,repository}) {
      calls.push({principal:activePrincipal,repository});
      assert.equal(activePrincipal.bridgeUserId,'alice');
      assert.equal(repository,REPO);
      return {installationId:INSTALLATION_ID};
    }
  };
}

function createCredentialProvider() {
  const calls=[];
  return {
    calls,
    async acquire({installationId,repository,permission}) {
      calls.push({installationId,repository,permission});
      assert.equal(installationId,INSTALLATION_ID);
      assert.equal(repository,REPO);
      return {
        token:`credential-${permission}`,
        expiresAt:'2030-01-01T00:00:00.000Z',
        installationId,
        repository,
        permission
      };
    }
  };
}

function jsonResponse(value,{status=200}={}) {
  return new Response(JSON.stringify(value),{
    status,
    headers:{'content-type':'application/json'}
  });
}

function bridgeGitHubFetch(policy=fixturePolicy()) {
  const calls=[];
  const fetchImpl=async(input,init={})=>{
    const url=input instanceof URL ? input : new URL(input);
    const method=init.method ?? 'GET';
    const authorization=init.headers?.Authorization;
    const body=init.body ? JSON.parse(init.body) : undefined;
    const call={
      method,
      pathname:url.pathname,
      search:url.search,
      authorization,
      body
    };
    calls.push(call);

    if(method==='GET' && url.pathname===`/repos/${REPO}`) {
      return jsonResponse({default_branch:'main'});
    }
    if(method==='GET' && url.pathname===`/repos/${REPO}/commits/main`) {
      return jsonResponse({sha:BASE});
    }
    if(
      method==='GET' &&
      url.pathname===`/repos/${REPO}/contents/.bridge/project.json` &&
      url.search===`?ref=${BASE}`
    ) {
      return jsonResponse({
        encoding:'base64',
        content:Buffer.from(JSON.stringify(policy)).toString('base64')
      });
    }
    if(
      method==='GET' &&
      decodeURIComponent(url.pathname)===`/repos/${REPO}/commits/agent/test`
    ) {
      return jsonResponse({sha:TARGET});
    }
    if(method==='GET' && url.pathname===`/repos/${REPO}/git/commits/${BASE}`) {
      return jsonResponse({tree:{sha:POLICY_TREE}});
    }
    if(method==='POST' && url.pathname===`/repos/${REPO}/git/blobs`) {
      return jsonResponse({sha:BLOB},{status:201});
    }
    if(method==='POST' && url.pathname===`/repos/${REPO}/git/trees`) {
      return jsonResponse({sha:REQUEST_TREE},{status:201});
    }
    if(method==='POST' && url.pathname===`/repos/${REPO}/git/commits`) {
      return jsonResponse({sha:CONTROL},{status:201});
    }
    if(method==='POST' && url.pathname===`/repos/${REPO}/git/refs`) {
      return jsonResponse({ref:body.ref},{status:201});
    }
    if(
      method==='POST' &&
      url.pathname===`/repos/${REPO}/actions/workflows/bridge-gateway.yml/dispatches`
    ) {
      return new Response(null,{status:204});
    }
    throw new Error(`unexpected GitHub request: ${method} ${url.pathname}${url.search}`);
  };
  return {calls,fetchImpl};
}

test('request-scoped control plane denies principal before installation, credential or GitHub access',async()=>{
  const installationResolver=createInstallationResolver();
  const credentialProvider=createCredentialProvider();
  let githubCalls=0;
  const gateway=createRequestScopedGateway({
    principal:principal('bob'),
    principalRepositoryAuthorizer:authorizerForAlice(),
    installationResolver,
    credentialProvider,
    fetchImpl:async()=>{
      githubCalls++;
      throw new Error('GitHub must not be called');
    }
  });

  await assert.rejects(
    ()=>gateway.discover({repository:REPO}),
    error=>error.code==='REPOSITORY_DENIED'
  );
  assert.equal(installationResolver.calls.length,0);
  assert.equal(credentialProvider.calls.length,0);
  assert.equal(githubCalls,0);
});

test('request-scoped discover uses only a read-scoped installation credential',async()=>{
  const installationResolver=createInstallationResolver();
  const credentialProvider=createCredentialProvider();
  const github=bridgeGitHubFetch();
  const gateway=createRequestScopedGateway({
    principal:principal(),
    principalRepositoryAuthorizer:authorizerForAlice(),
    installationResolver,
    credentialProvider,
    fetchImpl:github.fetchImpl
  });

  const discovered=await gateway.discover({repository:REPO});
  assert.equal(discovered.repository,REPO);
  assert.deepEqual(discovered.policy,{ref:'main',sha:BASE});
  assert.deepEqual(
    credentialProvider.calls.map(call=>call.permission),
    ['read','read']
  );
  assert.ok(github.calls.length>=3);
  assert.ok(github.calls.every(call=>call.authorization==='Bearer credential-read'));
});

test('request-scoped run upgrades only the submission phase to run authority',async()=>{
  const installationResolver=createInstallationResolver();
  const credentialProvider=createCredentialProvider();
  const github=bridgeGitHubFetch();
  const gateway=createRequestScopedGateway({
    principal:principal(),
    principalRepositoryAuthorizer:authorizerForAlice(),
    installationResolver,
    credentialProvider,
    fetchImpl:github.fetchImpl
  });

  const started=await gateway.run({
    repository:REPO,
    targetRef:'agent/test',
    mode:'capability',
    capability:'inspect-data',
    parameters:{dataset_id:'demo'}
  });

  assert.equal(started.repository,REPO);
  assert.equal(started.target.sha,TARGET);
  assert.equal(started.policy.sha,BASE);
  assert.match(started.runId,new RegExp(`^gh1:${REPO}:bridge-.*:${CONTROL}$`));

  assert.deepEqual(
    credentialProvider.calls.map(call=>call.permission),
    ['read','read','read','run']
  );

  const readCalls=github.calls.filter(call=>call.authorization==='Bearer credential-read');
  const runCalls=github.calls.filter(call=>call.authorization==='Bearer credential-run');
  assert.ok(readCalls.length>=4);
  assert.ok(runCalls.length>=6);
  assert.ok(runCalls.some(call=>call.pathname.endsWith('/git/refs')));
  assert.ok(
    runCalls.some(call=>call.pathname.endsWith('/bridge-gateway.yml/dispatches'))
  );
  assert.equal(
    github.calls.some(
      call=>
        call.method==='POST' &&
        call.authorization!=='Bearer credential-run'
    ),
    false
  );
});

test('request-scoped batch run delegates submission with run authority',async()=>{
  const installationResolver=createInstallationResolver();
  const credentialProvider=createCredentialProvider();
  const github=bridgeGitHubFetch();
  const gateway=createRequestScopedGateway({
    principal:principal(),
    principalRepositoryAuthorizer:authorizerForAlice(),
    installationResolver,
    credentialProvider,
    fetchImpl:github.fetchImpl
  });

  const started=await gateway.run({
    repository:REPO,
    targetRef:'agent/test',
    mode:'batch',
    steps:[
      {
        id:'inspect',
        type:'preset',
        capability:'inspect-data',
        parameters:{dataset_id:'demo'}
      }
    ]
  });

  assert.equal(started.kind,'batch');
  assert.equal(started.repository,REPO);
  assert.equal(started.target.sha,TARGET);
  assert.equal(started.policy.sha,BASE);
  assert.equal(started.stepCount,1);
  assert.ok(started.runId.startsWith(`gh1:${REPO}:bridge-`));
  assert.ok(started.runId.endsWith(`:${CONTROL}`));

  assert.deepEqual(
    credentialProvider.calls.map(call=>call.permission),
    ['read','read','read','run']
  );

  const dispatch=github.calls.find(
    call=>
      call.method==='POST' &&
      call.pathname.endsWith('/bridge-gateway.yml/dispatches')
  );
  assert.equal(dispatch.authorization,'Bearer credential-run');
  assert.equal(dispatch.body.inputs.bridge_kind,'batch');
});

test('incorrectly bound installation credential fails before repository GitHub access',async()=>{
  const installationResolver=createInstallationResolver();
  let githubCalls=0;
  const gateway=createRequestScopedGateway({
    principal:principal(),
    principalRepositoryAuthorizer:authorizerForAlice(),
    installationResolver,
    credentialProvider:{
      async acquire({installationId,repository,permission}) {
        return {
          token:'credential-read',
          expiresAt:'2030-01-01T00:00:00.000Z',
          installationId,
          repository:'example/wrong',
          permission
        };
      }
    },
    fetchImpl:async()=>{
      githubCalls++;
      throw new Error('GitHub must not be called');
    }
  });

  await assert.rejects(
    ()=>gateway.discover({repository:REPO}),
    error=>error.code==='GITHUB_APP_CREDENTIAL_INVALID'
  );
  assert.equal(githubCalls,0);
});
