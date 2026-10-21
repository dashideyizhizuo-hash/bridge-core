import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import {
  Client,
  StreamableHTTPClientTransport
} from '@modelcontextprotocol/client';
import { createBridgePrincipal } from '../src/auth/principal.mjs';
import { createCloudflareBridgeOAuthProvider } from '../src/cloudflare/oauth-provider-app.mjs';
import { upsertDurableTaskState } from '../src/task-github-state.mjs';

const RESOURCE='https://bridge.example/mcp';
const ISSUER='https://bridge.example';
const INSTALLATION_ID=12345;
const REPO='example/project';

function privateKeyPem() {
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  return privateKey.export({type:'pkcs8',format:'pem'});
}

function dummyDb() {
  return {
    prepare() {
      return {
        bind() { return this; },
        async run() { return {success:true}; },
        async first() { return null; },
        async all() { return {success:true,results:[]}; }
      };
    },
    async batch() { return []; }
  };
}

function dummyKv() {
  return {
    async get() { return null; },
    async put() {},
    async delete() {}
  };
}

function baseEnv(overrides={}) {
  return {
    DB:dummyDb(),
    OAUTH_KV:dummyKv(),
    BRIDGE_PUBLIC_URL:RESOURCE,
    BRIDGE_GITHUB_APP_ISSUER:'Iv1.bridge-client',
    BRIDGE_GITHUB_APP_PRIVATE_KEY:privateKeyPem(),
    BRIDGE_GITHUB_APP_CLIENT_ID:'Iv1.bridge-client',
    BRIDGE_GITHUB_APP_CLIENT_SECRET:'github-client-secret',
    BRIDGE_GITHUB_APP_SLUG:'runner-bridge',
    ...overrides
  };
}

function oauthRequest() {
  return {
    responseType:'code',
    clientId:'https://chatgpt.example/oauth-client.json',
    redirectUri:'https://chatgpt.example/callback',
    scope:['bridge'],
    state:'chatgpt-client-state',
    codeChallenge:'chatgpt-pkce-challenge',
    codeChallengeMethod:'S256',
    resource:RESOURCE,
    issuer:ISSUER
  };
}

function memoryAuthorizationStore() {
  const states=new Map();
  return {
    states,
    async put(record) {
      assert.equal(states.has(record.state),false);
      states.set(record.state,{...record,installationId:null,consented:false});
    },
    async bindInstallation({state,installationId,now}) {
      const record=states.get(state);
      if(
        !record ||
        record.expiresAt<=now ||
        record.installationId!==null
      ) return null;
      const next={
        ...record,
        installationId,
        consented:true
      };
      states.set(state,next);
      return {...next};
    },
    async take({state,now}) {
      const record=states.get(state);
      states.delete(state);
      if(!record || record.expiresAt<=now) return null;
      return {...record};
    }
  };
}

function identityStore({bridgeUserId='bridge-user-1'}={}) {
  const commits=[];
  const principal=createBridgePrincipal({
    bridgeUserId,
    externalProvider:'https://github.com/',
    externalSubject:'9001',
    githubUserId:'9001'
  });
  return {
    commits,
    principal,
    async ensurePrincipal({externalProvider,externalSubject}) {
      assert.equal(externalProvider,'https://github.com/');
      assert.equal(externalSubject,'9001');
      return principal;
    },
    async commitGitHubOnboarding(value) {
      commits.push(structuredClone(value));
    },
    async assert({principal:active,repository,permission}) {
      assert.equal(active.bridgeUserId,principal.bridgeUserId);
      assert.equal(repository,REPO);
      assert.ok(['read','run','publish'].includes(permission));
      return repository;
    },
    async resolve({principal:active,repository}) {
      assert.equal(active.bridgeUserId,principal.bridgeUserId);
      assert.equal(repository,REPO);
      return {installationId:INSTALLATION_ID};
    }
  };
}

function installations() {
  return {
    async getInstallation(id) {
      assert.equal(id,INSTALLATION_ID);
      return {
        id,
        suspended_at:null,
        account:{
          id:777,
          login:'example',
          type:'Organization'
        }
      };
    }
  };
}

function userAuth({installationIds=[INSTALLATION_ID]}={}) {
  const calls=[];
  return {
    calls,
    authorizationUrl({state,codeChallenge}) {
      calls.push({method:'authorizationUrl',state,codeChallenge});
      const url=new URL('https://github.com/login/oauth/authorize');
      url.searchParams.set('client_id','Iv1.bridge-client');
      url.searchParams.set('state',state);
      url.searchParams.set('code_challenge',codeChallenge);
      url.searchParams.set('code_challenge_method','S256');
      return url.href;
    },
    async exchangeCode({code,codeVerifier}) {
      calls.push({method:'exchangeCode',code,codeVerifier});
      return {
        token:'ghu_ephemeral_user_token',
        tokenType:'bearer'
      };
    },
    async getUser(token) {
      calls.push({method:'getUser',token});
      return {id:'9001',login:'octocat'};
    },
    async listInstallations(token) {
      calls.push({method:'listInstallations',token});
      assert.equal(token,'ghu_ephemeral_user_token');
      return installationIds.map(id=>({
        id,
        accountLogin:'example',
        accountId:'777',
        ownerType:'Organization',
        suspendedAt:null
      }));
    },
    async listInstallationRepositories(token,installationId) {
      calls.push({
        method:'listInstallationRepositories',
        token,
        installationId
      });
      assert.equal(token,'ghu_ephemeral_user_token');
      assert.equal(installationId,INSTALLATION_ID);
      return [{
        id:1,
        fullName:REPO,
        private:true,
        permissions:{
          admin:true,
          maintain:false,
          push:true,
          triage:true,
          pull:true
        }
      }];
    }
  };
}

function credentialProvider() {
  return {
    async acquire({installationId,repository,permission}) {
      return {
        token:'installation-token-never-returned',
        expiresAt:'2030-01-01T00:00:00.000Z',
        installationId,
        repository,
        permission
      };
    }
  };
}

function taskRuntimeStore() {
  const calls=[];
  let current={
    taskKey:REPO+'#45',
    bridgeUserId:'bridge-user-1',
    repository:REPO,
    issueNumber:45,
    canonicalBranch:'agent/task-45',
    mode:'continuous',
    status:'RECOVERING',
    leaseOwner:'worker-session-1234',
    leaseEpoch:7,
    leaseExpiresAt:'2030-01-01T00:15:00.000Z',
    checkpointSha:'a'.repeat(40),
    stateCommentId:41
  };
  return {
    calls,
    async activate({taskKey,dispatchId,workerId}) {
      calls.push({method:'activate',taskKey,dispatchId,workerId});
      if(dispatchId==='stale-dispatch') return null;
      current={
        taskKey,
        bridgeUserId:'bridge-user-1',
        repository:REPO,
        issueNumber:45,
        canonicalBranch:'agent/task-45',
        mode:'continuous',
        status:'RECOVERING',
        leaseOwner:workerId,
        leaseEpoch:3,
        leaseExpiresAt:'2030-01-01T00:15:00.000Z',
        checkpointSha:'a'.repeat(40),
        stateCommentId:41
      };
      return structuredClone(current);
    },
    async getTask(taskKey) {
      calls.push({method:'getTask',taskKey});
      return current.taskKey===taskKey ? structuredClone(current) : null;
    },
    async assertCurrent(value) {
      calls.push({method:'assertCurrent',value});
      return structuredClone(current);
    },
    async bindRun(value) {
      calls.push({method:'bindRun',value});
      return {activeRunId:value.runId};
    },
    async completeStage(value) {
      calls.push({method:'completeStage',value});
      current={
        ...current,
        status:value.status,
        checkpointSha:value.checkpointSha,
        stateCommentId:value.stateCommentId,
        leaseOwner:null,
        leaseExpiresAt:null
      };
      return structuredClone(current);
    },
    async claimNextStage(value) {
      calls.push({method:'claimNextStage',value});
      current={
        ...current,
        status:'RECOVERING',
        leaseOwner:value.workerId,
        leaseEpoch:value.previousLeaseEpoch+1,
        leaseExpiresAt:'2030-01-01T00:30:00.000Z'
      };
      return structuredClone(current);
    },
    async releaseFailedClaim(value) {
      calls.push({method:'releaseFailedClaim',value});
      current={
        ...current,
        status:'READY',
        leaseOwner:null,
        leaseExpiresAt:null
      };
      return structuredClone(current);
    },
    async block(value) {
      calls.push({method:'block',value});
      current={
        ...current,
        status:'BLOCKED',
        leaseOwner:null,
        leaseExpiresAt:null
      };
      return structuredClone(current);
    },
    async reconcileExpired(value) {
      calls.push({method:'reconcileExpired',value});
      current={
        ...current,
        status:value.status,
        ...(value.status==='BLOCKED' ? {} : {
          checkpointSha:value.checkpointSha,
          stateCommentId:value.stateCommentId
        }),
        leaseOwner:null,
        leaseExpiresAt:null
      };
      return structuredClone(current);
    }
  };
}

function memoryTaskSessionStore() {
  const token='bts_'+('S'.repeat(43));
  const calls=[];
  return {
    token,
    calls,
    async issue(value) {
      calls.push({method:'issue',value});
      return token;
    },
    async resolve(value) {
      calls.push({method:'resolve',value});
      assert.equal(value,token);
      return {
        taskKey:REPO+'#45',
        workerId:'worker-session-1234',
        leaseEpoch:7,
        expiresAt:'2030-01-01T00:15:00.000Z'
      };
    },
    async renewSession(value) {
      calls.push({method:'renewSession',value});
      return {
        taskKey:value.taskKey,
        workerId:value.workerId,
        leaseEpoch:value.leaseEpoch,
        expiresAt:'2030-01-01T00:30:00.000Z'
      };
    }
  };
}

function durableIssueFetch({status='READY',sha='b'.repeat(40),commentId=42}={}) {
  const body=upsertDurableTaskState('',{
    schemaVersion:1,
    taskKey:REPO+'#45',
    mode:'continuous',
    status,
    canonicalBranch:'agent/task-45',
    checkpoint:status==='BLOCKED'
      ? null
      : {stage:'test stage',sha,commentId},
    nextStage:status==='DONE' ? null : 'next stage',
    continuation:status==='DONE' || status==='BLOCKED' ? null : 'same-worker',
    pullRequest:null,
    updatedAt:'2030-01-01T00:00:00.000Z'
  });
  const checkpointBody=`<!-- bridge-stage-checkpoint:v1 -->
\`\`\`json
${JSON.stringify({
  schemaVersion:1,
  taskKey:REPO+'#45',
  canonicalBranch:'agent/task-45',
  stage:'test stage',
  sha,
  runId:null,
  nextStage:status==='DONE' ? null : 'next stage',
  continuation:status==='DONE' ? null : 'same-worker',
  pullRequest:null,
  summary:'test checkpoint',
  status
},null,2)}
\`\`\``;
  return async input=>{
    const url=new URL(input instanceof Request ? input.url : input);
    if(url.pathname===`/repos/${REPO}/issues/45`) return Response.json({body});
    if(url.pathname===`/repos/${REPO}/issues/comments/${commentId}`) {
      return Response.json({id:commentId,body:checkpointBody,user:{id:9001}});
    }
    if(url.pathname===`/repos/${REPO}/commits/agent%2Ftask-45`) {
      return Response.json({sha});
    }
    if(url.pathname===`/repos/${REPO}/compare/${'a'.repeat(40)}...${sha}`) {
      return Response.json({
        status:'ahead',
        ahead_by:1,
        merge_base_commit:{sha:'a'.repeat(40)},
        commits:[{sha,commit:{message:'test stage'}}],
        files:[]
      });
    }
    throw new Error(`unexpected direct GitHub fetch: ${url.pathname}`);
  };
}

class FakeAuthorizationError extends Error {
  constructor({
    code='invalid_request',
    description='invalid request',
    redirectUri,
    state,
    issuer
  }={}) {
    super(description);
    this.code=code;
    this.description=description;
    this.redirectUri=redirectUri;
    this.state=state;
    this.issuer=issuer;
  }
}

class FakeOAuthProvider {
  constructor(options) {
    this.options=options;
  }

  async fetch(request,env,ctx) {
    const url=new URL(request.url);
    const helpers=env.__oauthHelpers;
    const handlerEnv={...env,OAUTH_PROVIDER:helpers};

    if(url.pathname==='/mcp') {
      return this.options.apiHandler.fetch(
        request,
        handlerEnv,
        {props:env.__tokenProps}
      );
    }

    return this.options.defaultHandler.fetch(request,handlerEnv,ctx);
  }
}

function oauthHelpers({
  parsedRequest=oauthRequest(),
  completeRedirect='https://chatgpt.example/callback?code=bridge-code'
}={}) {
  const calls=[];
  return {
    calls,
    async parseAuthRequest() {
      calls.push({method:'parseAuthRequest'});
      return structuredClone(parsedRequest);
    },
    async lookupClient(clientId) {
      calls.push({method:'lookupClient',clientId});
      return {
        clientId,
        clientName:'ChatGPT'
      };
    },
    async completeAuthorization(options) {
      calls.push({
        method:'completeAuthorization',
        options:structuredClone(options)
      });
      return {redirectTo:completeRedirect};
    }
  };
}

function cookiePair(response) {
  const setCookie=response.headers.get('set-cookie');
  assert.ok(setCookie);
  return setCookie.split(';')[0];
}

function createApp({
  helpers=oauthHelpers(),
  store=identityStore(),
  authStore=memoryAuthorizationStore(),
  githubUserAuth=userAuth(),
  activeInstallations=installations(),
  taskStore=taskRuntimeStore(),
  taskSessionStore,
  activationRandomUUID=()=>'provider-fixed-uuid',
  gatewayFactory,
  directFetch=async()=>{ throw new Error('unexpected direct GitHub fetch'); }
}={}) {
  const env=baseEnv({
    __oauthHelpers:helpers,
    __tokenProps:{
      bridgePrincipal:store.principal
    }
  });
  const app=createCloudflareBridgeOAuthProvider({
    env,
    OAuthProviderClass:FakeOAuthProvider,
    AuthorizationErrorClass:FakeAuthorizationError,
    identityStore:store,
    authorizationStore:authStore,
    installations:activeInstallations,
    credentialProvider:credentialProvider(),
    userAuth:githubUserAuth,
    taskStore,
    ...(taskSessionStore===undefined ? {} : {taskSessionStore}),
    activationRandomUUID,
    ...(gatewayFactory===undefined ? {} : {gatewayFactory}),
    fetchImpl:directFetch
  });
  return {app,env,helpers,store,authStore,githubUserAuth,taskStore,taskSessionStore};
}

test('Cloudflare provider advertises one Bridge resource with CIMD and DCR fallback',()=>{
  const {app}=createApp();
  const options=app.provider.options;

  assert.equal(options.apiRoute,'/mcp');
  assert.equal(options.authorizeEndpoint,'/authorize');
  assert.equal(options.tokenEndpoint,'/oauth/token');
  assert.equal(options.clientRegistrationEndpoint,'/oauth/register');
  assert.deepEqual(options.scopesSupported,['bridge']);
  assert.equal(options.clientIdMetadataDocumentEnabled,true);
  assert.equal(app.config.taskActivationUrl,ISSUER+'/task-runtime/activate');
  assert.equal(app.config.taskControlUrl,ISSUER+'/task-runtime/control');
  assert.deepEqual(options.resourceMetadata,{
    resource:RESOURCE,
    authorization_servers:[ISSUER],
    scopes_supported:['bridge'],
    resource_name:'Bridge'
  });
});

test('ChatGPT authorization starts GitHub user OAuth and binds browser state',async()=>{
  const {app,authStore}=createApp();

  const response=await app.fetch(
    new Request(ISSUER+'/authorize?client_id=test'),
    {}
  );
  assert.equal(response.status,302);

  const location=new URL(response.headers.get('location'));
  assert.equal(location.origin,'https://github.com');
  assert.equal(location.pathname,'/login/oauth/authorize');

  const state=location.searchParams.get('state');
  assert.match(state,/^[A-Za-z0-9_-]{32,256}$/);
  assert.equal(authStore.states.has(state),true);
  assert.equal(location.searchParams.get('code_challenge_method'),'S256');

  const setCookie=response.headers.get('set-cookie');
  assert.match(setCookie,/__Host-bridge_oauth_state=/);
  assert.match(setCookie,/HttpOnly/);
  assert.match(setCookie,/Secure/);
  assert.match(setCookie,/SameSite=Lax/);
});

test('first-time install creates a fresh transaction before Setup URL continuation',async()=>{
  const bundle=createApp({
    githubUserAuth:userAuth({installationIds:[]})
  });
  const started=await bundle.app.fetch(
    new Request(ISSUER+'/authorize?client_id=test'),
    {}
  );
  const initialCookie=cookiePair(started);
  const initialState=new URL(started.headers.get('location')).searchParams.get('state');

  const discoveryCallback=await bundle.app.fetch(new Request(
    ISSUER+
      '/auth/github/callback?state='+
      encodeURIComponent(initialState)+
      '&code=github-code-discovery',
    {headers:{cookie:initialCookie}}
  ),{});
  assert.equal(discoveryCallback.status,302);

  const installUrl=new URL(discoveryCallback.headers.get('location'));
  assert.equal(installUrl.origin,'https://github.com');
  assert.equal(installUrl.pathname,'/apps/runner-bridge/installations/new');
  const installState=installUrl.searchParams.get('state');
  assert.match(installState,/^[A-Za-z0-9_-]{32,256}$/);
  assert.notEqual(installState,initialState);

  const installCookie=cookiePair(discoveryCallback);
  const setup=await bundle.app.fetch(new Request(
    ISSUER+'/auth/github/setup?installation_id='+INSTALLATION_ID,
    {headers:{cookie:installCookie}}
  ),{});
  assert.equal(setup.status,302);

  const authorize=new URL(setup.headers.get('location'));
  assert.equal(authorize.origin,'https://github.com');
  assert.equal(authorize.pathname,'/login/oauth/authorize');
  assert.equal(authorize.searchParams.get('state'),installState);
  assert.equal(authorize.searchParams.get('code_challenge_method'),'S256');

  const completed=await bundle.app.fetch(new Request(
    ISSUER+
      '/auth/github/callback?state='+
      encodeURIComponent(installState)+
      '&code=github-code-after-install',
    {headers:{cookie:installCookie}}
  ),{});
  assert.equal(completed.status,302);
  assert.equal(
    completed.headers.get('location'),
    'https://chatgpt.example/callback?code=bridge-code'
  );
  assert.equal(bundle.store.commits.length,1);
});

test('existing GitHub App installation reconnects without Setup URL',async()=>{
  const bundle=createApp();
  const started=await bundle.app.fetch(
    new Request(ISSUER+'/authorize?client_id=test'),
    {}
  );
  const cookie=cookiePair(started);
  const state=new URL(started.headers.get('location')).searchParams.get('state');

  const callback=await bundle.app.fetch(new Request(
    ISSUER+
      '/auth/github/callback?state='+
      encodeURIComponent(state)+
      '&code=github-code-1234',
    {headers:{cookie}}
  ),{});

  assert.equal(callback.status,302);
  assert.equal(
    callback.headers.get('location'),
    'https://chatgpt.example/callback?code=bridge-code'
  );
  assert.match(callback.headers.get('set-cookie'),/Max-Age=0/);

  assert.equal(bundle.store.commits.length,1);
  assert.deepEqual(bundle.store.commits[0].repositories,[REPO]);
  assert.deepEqual(
    bundle.store.commits[0].permissions,
    {read:true,run:true,publish:true}
  );

  const installationDiscovery=bundle.githubUserAuth.calls.find(
    call=>call.method==='listInstallations'
  );
  assert.ok(installationDiscovery);

  const completed=bundle.helpers.calls.find(
    call=>call.method==='completeAuthorization'
  );
  assert.ok(completed);
  assert.equal(completed.options.userId,'bridge-user-1');
  assert.deepEqual(completed.options.scope,['bridge']);
  assert.equal(
    completed.options.props.bridgePrincipal.githubUserId,
    '9001'
  );

  const serialized=JSON.stringify({
    persisted:bundle.store.commits,
    oauth:completed.options
  });
  assert.equal(serialized.includes('ghu_ephemeral_user_token'),false);
  assert.equal(serialized.includes('github-client-secret'),false);
});

test('Cloudflare default fetch preserves the runtime receiver through existing-install reconnect',async(t)=>{
  const paths=[];
  t.mock.method(globalThis,'fetch',async function(input) {
    assert.equal(this,globalThis,'Worker fetch requires its global receiver');
    const path=new URL(input).pathname;
    paths.push(path);
    if(path==='/login/oauth/access_token') {
      return Response.json({access_token:'test-user-token',token_type:'bearer'});
    }
    if(path==='/user') return Response.json({id:9001,login:'octocat'});
    if(path==='/user/installations') {
      return Response.json({
        total_count:1,
        installations:[{
          id:INSTALLATION_ID,
          account:{id:777,login:'example',type:'Organization'},
          suspended_at:null
        }]
      });
    }
    if(path===`/user/installations/${INSTALLATION_ID}/repositories`) {
      return Response.json({repositories:[{id:1,full_name:REPO,private:true}]});
    }
    throw new Error(`Unexpected GitHub request: ${path}`);
  });
  const helpers=oauthHelpers();
  const store=identityStore();
  const app=createCloudflareBridgeOAuthProvider({
    env:baseEnv({__oauthHelpers:helpers}),
    OAuthProviderClass:FakeOAuthProvider,
    AuthorizationErrorClass:FakeAuthorizationError,
    identityStore:store,
    authorizationStore:memoryAuthorizationStore(),
    credentialProvider:credentialProvider(),
    installations:installations()
  });
  const started=await app.fetch(new Request(ISSUER+'/authorize'),{});
  const cookie=cookiePair(started);
  const state=new URL(started.headers.get('location')).searchParams.get('state');
  const callback=await app.fetch(new Request(
    ISSUER+'/auth/github/callback?state='+state+'&code=github-code-1234',
    {headers:{cookie}}
  ),{});
  assert.equal(callback.status,302);
  assert.deepEqual(paths,[
    '/login/oauth/access_token','/user','/user/installations',
    `/user/installations/${INSTALLATION_ID}/repositories`
  ]);
  assert.deepEqual(store.commits[0].repositories,[REPO]);
  assert.ok(helpers.calls.some(call=>call.method==='completeAuthorization'));
});

test('GitHub denial returns a standards-shaped error to the original MCP client and consumes state',async()=>{
  const bundle=createApp();
  const started=await bundle.app.fetch(
    new Request(ISSUER+'/authorize?client_id=test'),
    {}
  );
  const cookie=cookiePair(started);
  const state=new URL(started.headers.get('location')).searchParams.get('state');

  const denied=await bundle.app.fetch(new Request(
    ISSUER+
      '/auth/github/callback?state='+
      encodeURIComponent(state)+
      '&error=access_denied',
    {headers:{cookie}}
  ),{});

  assert.equal(denied.status,302);
  const redirect=new URL(denied.headers.get('location'));
  assert.equal(redirect.origin,'https://chatgpt.example');
  assert.equal(redirect.searchParams.get('error'),'access_denied');
  assert.equal(
    redirect.searchParams.get('state'),
    'chatgpt-client-state'
  );
  assert.equal(redirect.searchParams.get('iss'),ISSUER);
  assert.equal(bundle.authStore.states.has(state),false);
});

test('browser state mismatch is denied before GitHub installation binding',async()=>{
  const bundle=createApp();
  const started=await bundle.app.fetch(
    new Request(ISSUER+'/authorize?client_id=test'),
    {}
  );
  const cookie=cookiePair(started);

  await assert.rejects(
    ()=>bundle.app.fetch(new Request(
      ISSUER+
        '/auth/github/setup?installation_id='+
        INSTALLATION_ID+
        '&state='+
        'x'.repeat(43),
      {headers:{cookie}}
    ),{}),
    error=>error.code==='OAUTH_GITHUB_DENIED'
  );
});


test('authorization without bridge scope is denied before GitHub redirect',async()=>{
  const request=oauthRequest();
  request.scope=['profile'];
  const bundle=createApp({
    helpers:oauthHelpers({parsedRequest:request})
  });

  await assert.rejects(
    ()=>bundle.app.fetch(
      new Request(ISSUER+'/authorize?client_id=test'),
      {}
    ),
    error=>error.code==='OAUTH_GITHUB_DENIED'
  );
  assert.equal(bundle.authStore.states.size,0);
  assert.equal(
    bundle.helpers.calls.some(call=>call.method==='completeAuthorization'),
    false
  );
});

test('suspended existing GitHub installation fails before authority persistence or OAuth completion',async()=>{
  const bundle=createApp({
    activeInstallations:{
      async getInstallation(id) {
        assert.equal(id,INSTALLATION_ID);
        return {
          id,
          suspended_at:'2026-09-19T00:00:00Z',
          account:{
            id:777,
            login:'example',
            type:'Organization'
          }
        };
      }
    }
  });
  const started=await bundle.app.fetch(
    new Request(ISSUER+'/authorize?client_id=test'),
    {}
  );
  const cookie=cookiePair(started);
  const state=new URL(started.headers.get('location')).searchParams.get('state');

  await assert.rejects(
    ()=>bundle.app.fetch(new Request(
      ISSUER+
        '/auth/github/callback?state='+
        encodeURIComponent(state)+
        '&code=github-code-1234',
      {headers:{cookie}}
    ),{}),
    error=>error.code==='OAUTH_GITHUB_DENIED'
  );

  assert.equal(bundle.store.commits.length,0);
  assert.equal(
    bundle.helpers.calls.some(call=>call.method==='completeAuthorization'),
    false
  );
});

test('existing installation repository proof failure cannot create Bridge grants or OAuth authorization',async()=>{
  const deniedUserAuth=userAuth();
  deniedUserAuth.listInstallationRepositories=async(token,installationId)=>{
    assert.equal(token,'ghu_ephemeral_user_token');
    assert.equal(installationId,INSTALLATION_ID);
    const error=new Error('installation inaccessible to authenticated user');
    error.code='GITHUB_USER_AUTH_ERROR';
    throw error;
  };
  const bundle=createApp({githubUserAuth:deniedUserAuth});
  const started=await bundle.app.fetch(
    new Request(ISSUER+'/authorize?client_id=test'),
    {}
  );
  const cookie=cookiePair(started);
  const state=new URL(started.headers.get('location')).searchParams.get('state');

  await assert.rejects(
    ()=>bundle.app.fetch(new Request(
      ISSUER+
        '/auth/github/callback?state='+
        encodeURIComponent(state)+
        '&code=github-code-1234',
      {headers:{cookie}}
    ),{}),
    error=>error.code==='GITHUB_USER_AUTH_ERROR'
  );

  assert.equal(bundle.store.commits.length,0);
  assert.equal(
    bundle.helpers.calls.some(call=>call.method==='completeAuthorization'),
    false
  );
});

test('multiple existing Bridge installations fail closed instead of silently widening authority',async()=>{
  const bundle=createApp({
    githubUserAuth:userAuth({installationIds:[INSTALLATION_ID,67890]})
  });
  const started=await bundle.app.fetch(
    new Request(ISSUER+'/authorize?client_id=test'),
    {}
  );
  const cookie=cookiePair(started);
  const state=new URL(started.headers.get('location')).searchParams.get('state');

  await assert.rejects(
    ()=>bundle.app.fetch(new Request(
      ISSUER+
        '/auth/github/callback?state='+
        encodeURIComponent(state)+
        '&code=github-code-1234',
      {headers:{cookie}}
    ),{}),
    error=>error.code==='OAUTH_GITHUB_DENIED'
  );
  assert.equal(bundle.store.commits.length,0);
});

test('OAuth-protected MCP path exposes execution tools plus bounded task transition',async t=>{
  const bundle=createApp();
  const transport=new StreamableHTTPClientTransport(
    new URL(RESOURCE),
    {
      fetch:async(input,init)=>{
        const request=input instanceof Request
          ? new Request(input,init)
          : new Request(input,init);
        return bundle.app.fetch(request,{});
      }
    }
  );
  const client=new Client({
    name:'cloudflare-provider-test',
    version:'0.1.0'
  });
  await client.connect(transport);
  t.after(async()=>client.close());

  const listed=await client.listTools();
  assert.deepEqual(
    listed.tools.map(tool=>tool.name),
    ["bridge.list_hosts","bridge.create_host_pairing","bridge.pause_host","bridge.resume_host","bridge.run_host_command","bridge.import_file","bridge.create_file_upload","bridge.delete_file","bridge.get_repository_configuration","bridge.execute_repository_commands","bridge.verify_repository","bridge.edit_and_verify_repository","bridge.get_run","bridge.get_result","bridge.publish","bridge.task_transition","bridge.repository_tools_status"]
  );
  const publish=listed.tools.find(tool=>tool.name==='bridge.publish');
  assert.deepEqual(
    Object.keys(publish.inputSchema.properties),
    ['runId','taskSessionToken']
  );
});


test('one-time dispatch activation is exposed outside MCP tools and returns no repository credential',async()=>{
  const runtimeStore=taskRuntimeStore();
  const {app}=createApp({taskStore:runtimeStore});
  const response=await app.fetch(new Request(
    ISSUER+'/task-runtime/activate',
    {
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({
        taskKey:REPO+'#45',
        dispatchId:'dispatch-12345678'
      })
    }
  ),{});

  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
  const body=await response.json();
  assert.equal(body.status,'ACTIVATED');
  assert.equal(body.taskKey,REPO+'#45');
  assert.equal(body.workerId,'worker-provider-fixed-uuid');
  assert.equal(body.leaseEpoch,3);
  assert.equal(body.canonicalBranch,'agent/task-45');
  assert.equal(body.mcpSession.headers['x-bridge-task-owner'],body.workerId);
  assert.equal(JSON.stringify(body).includes('installation-token-never-returned'),false);
  assert.equal(JSON.stringify(body).includes('github-client-secret'),false);
  assert.deepEqual(
    runtimeStore.calls.map(call=>call.method),
    ['activate']
  );
});

test('stale dispatch activation is conflict and cannot mint task session headers',async()=>{
  const runtimeStore=taskRuntimeStore();
  const {app}=createApp({taskStore:runtimeStore});
  const response=await app.fetch(new Request(
    ISSUER+'/task-runtime/activate',
    {
      method:'POST',
      body:JSON.stringify({
        taskKey:REPO+'#45',
        dispatchId:'stale-dispatch'
      })
    }
  ),{});

  assert.equal(response.status,409);
  const body=await response.json();
  assert.equal(body.error.code,'TASK_DISPATCH_STALE');
  assert.equal(body.mcpSession,undefined);
});

test('OAuth-protected MCP task session wires owner-bound lease validation and task transition',async t=>{
  const runtimeStore=taskRuntimeStore();
  const gateways=[];
  const gatewayFactory=options=>{
    gateways.push(options);
    const unused=async()=>{ throw new Error('tool invocation is not expected'); };
    return {
      discover:unused,
      run:unused,
      getRun:unused,
      getResult:unused,
      publish:unused
    };
  };
  const bundle=createApp({
    taskStore:runtimeStore,
    gatewayFactory,
    directFetch:durableIssueFetch()
  });
  const transport=new StreamableHTTPClientTransport(
    new URL(RESOURCE),
    {
      fetch:async(input,init)=>{
        const base=input instanceof Request
          ? new Request(input,init)
          : new Request(input,init);
        const headers=new Headers(base.headers);
        headers.set('x-bridge-task-key',REPO+'#45');
        headers.set('x-bridge-task-epoch','7');
        headers.set('x-bridge-task-owner','worker-session-1234');
        return bundle.app.fetch(new Request(base,{headers}),{});
      }
    }
  );
  const client=new Client({
    name:'cloudflare-task-session-test',
    version:'0.1.0'
  });
  await client.connect(transport);
  t.after(async()=>client.close());

  const listed=await client.listTools();
  assert.deepEqual(
    listed.tools.map(tool=>tool.name),
    ["bridge.list_hosts","bridge.create_host_pairing","bridge.pause_host","bridge.resume_host","bridge.run_host_command","bridge.import_file","bridge.create_file_upload","bridge.delete_file","bridge.get_repository_configuration","bridge.execute_repository_commands","bridge.verify_repository","bridge.edit_and_verify_repository","bridge.get_run","bridge.get_result","bridge.publish","bridge.task_transition","bridge.repository_tools_status"]
  );
  assert.ok(gateways.length>=1);
  const scoped=gateways.at(-1);
  assert.deepEqual(scoped.taskContext,{
    taskKey:REPO+'#45',
    leaseEpoch:7
  });
  assert.equal(typeof scoped.taskLeaseValidator.assertCurrent,'function');
  assert.equal(typeof scoped.taskLeaseValidator.bindRun,'function');
  assert.equal(typeof scoped.taskLifecycle.transition,'function');

  await scoped.taskLeaseValidator.assertCurrent({
    taskKey:REPO+'#45',
    leaseEpoch:7,
    repository:REPO,
    canonicalBranch:'agent/task-45',
    baseSha:'a'.repeat(40)
  });
  assert.equal(
    runtimeStore.calls.at(-1).value.workerId,
    'worker-session-1234'
  );

  const transitioned=await scoped.taskLifecycle.transition({
    outcome:'READY',
    checkpointSha:'b'.repeat(40),
    stateCommentId:42,
    continue:false
  });
  assert.equal(transitioned.action,'STOP');
  assert.equal(transitioned.status,'READY');
  assert.deepEqual(
    runtimeStore.calls.slice(-3).map(call=>call.method),
    ['getTask','assertCurrent','completeStage']
  );

  const run=listed.tools.find(tool=>tool.name==='bridge.edit_and_verify_repository');
  assert.equal(Object.hasOwn(run.inputSchema.properties,'task'),false);
  const publish=listed.tools.find(tool=>tool.name==='bridge.publish');
  assert.deepEqual(Object.keys(publish.inputSchema.properties),['runId','taskSessionToken']);
});

test('opaque task session token executes the bounded transition through the deployed composition',async t=>{
  const runtimeStore=taskRuntimeStore();
  const sessions=memoryTaskSessionStore();
  const bundle=createApp({
    taskStore:runtimeStore,
    taskSessionStore:sessions,
    directFetch:durableIssueFetch()
  });
  const transport=new StreamableHTTPClientTransport(
    new URL(RESOURCE),
    {
      fetch:async(input,init)=>{
        const request=input instanceof Request
          ? new Request(input,init)
          : new Request(input,init);
        return bundle.app.fetch(request,{});
      }
    }
  );
  const client=new Client({
    name:'cloudflare-task-transition-test',
    version:'0.1.0'
  });
  await client.connect(transport);
  t.after(async()=>client.close());

  const result=await client.callTool({
    name:'bridge.task_transition',
    arguments:{
      outcome:'READY',
      checkpointSha:'b'.repeat(40),
      stateCommentId:42,
      continue:false,
      taskSessionToken:sessions.token
    }
  });
  assert.equal(result.isError,undefined);
  assert.equal(result.structuredContent.action,'STOP');
  assert.deepEqual(
    runtimeStore.calls.map(call=>call.method),
    ['getTask','getTask','assertCurrent','completeStage']
  );
  assert.deepEqual(sessions.calls.map(call=>call.method),['resolve']);
});

test('partial task session headers fail closed before request-scoped Gateway construction',async()=>{
  let gatewayCalls=0;
  const bundle=createApp({
    gatewayFactory:()=>{
      gatewayCalls++;
      throw new Error('gateway must not be constructed');
    }
  });
  const response=await bundle.app.provider.options.apiHandler.fetch(
    new Request(RESOURCE,{
      method:'POST',
      headers:{
        'x-bridge-task-key':REPO+'#45',
        'x-bridge-task-epoch':'7'
      },
      body:'{}'
    }),
    {},
    {props:{bridgePrincipal:bundle.store.principal}}
  );
  assert.equal(response.status,400);
  const body=await response.json();
  assert.equal(body.error.code,'TASK_SESSION_INVALID');
  assert.equal(gatewayCalls,0);
});

test('task session headers cannot cross the authenticated Bridge principal boundary',async()=>{
  const store=identityStore({bridgeUserId:'bridge-user-2'});
  const bundle=createApp({store});
  const response=await bundle.app.provider.options.apiHandler.fetch(
    new Request(RESOURCE,{
      method:'POST',
      headers:{
        'x-bridge-task-key':REPO+'#45',
        'x-bridge-task-epoch':'7',
        'x-bridge-task-owner':'worker-session-1234'
      },
      body:'{}'
    }),
    {},
    {props:{bridgePrincipal:store.principal}}
  );
  assert.equal(response.status,403);
  const body=await response.json();
  assert.equal(body.error.code,'TASK_SESSION_PRINCIPAL_MISMATCH');
});


test('durable task operator control is absent by default and scheduled watchdog skips without launcher',async()=>{
  const {app}=createApp();
  const response=await app.fetch(new Request(
    ISSUER+'/task-runtime/control',
    {
      method:'POST',
      body:JSON.stringify({action:'inspect',taskKey:REPO+'#45'})
    }
  ),{});
  assert.equal(response.status,404);
  assert.deepEqual(
    await app.scheduled(),
    {action:'SKIP',reason:'TASK_LAUNCHER_UNCONFIGURED'}
  );
});


test('Cloudflare OAuth reconnect never downgrades publish authority for an onboarded repository',async()=>{
  const bundle=createApp();

  async function reconnect(code) {
    const started=await bundle.app.fetch(
      new Request(ISSUER+'/authorize?client_id=test'),
      {}
    );
    const cookie=cookiePair(started);
    const state=new URL(started.headers.get('location')).searchParams.get('state');
    const callback=await bundle.app.fetch(new Request(
      ISSUER+
        '/auth/github/callback?state='+
        encodeURIComponent(state)+
        '&code='+
        encodeURIComponent(code),
      {headers:{cookie}}
    ),{});
    assert.equal(callback.status,302);
  }

  await reconnect('github-code-first');
  await reconnect('github-code-second');

  assert.equal(bundle.store.commits.length,2);
  assert.deepEqual(
    bundle.store.commits.map(commit=>commit.permissions),
    [
      {read:true,run:true,publish:true},
      {read:true,run:true,publish:true}
    ]
  );
});


test('readyz compiles the deployed Direct schema instead of returning unconditional ready',async()=>{
  const bundle=createApp();
  const response=await bundle.app.fetch(new Request(ISSUER+'/readyz'),{});
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.status,'ready');
  assert.equal(body.directAssets,false);
  assert.equal(body.directAdmin,false);
});

for (const missingTable of ['direct_hosts','direct_asset_object_retirements'])
test(`readyz fails closed when production ${missingTable} migration is missing`,async()=>{
  const failingDb={
    prepare(sql) {
      if(String(sql).includes(missingTable)) {
        return {
          bind(){ return this; },
          async first(){ throw new Error('no such table: direct_hosts'); },
          async run(){ return {success:true}; },
          async all(){ return {success:true,results:[]}; }
        };
      }
      return {
        bind(){ return this; },
        async first(){ return null; },
        async run(){ return {success:true}; },
        async all(){ return {success:true,results:[]}; }
      };
    },
    async batch(){ return []; }
  };
  const helpers=oauthHelpers();
  const store=identityStore();
  const app=createCloudflareBridgeOAuthProvider({
    env:baseEnv({
      DB:failingDb,
      __oauthHelpers:helpers,
      __tokenProps:{bridgePrincipal:store.principal}
    }),
    OAuthProviderClass:FakeOAuthProvider,
    AuthorizationErrorClass:FakeAuthorizationError,
    identityStore:store,
    authorizationStore:memoryAuthorizationStore(),
    installations:installations(),
    credentialProvider:credentialProvider(),
    userAuth:userAuth(),
    taskStore:taskRuntimeStore(),
    fetchImpl:async()=>{ throw new Error('unexpected GitHub request'); }
  });
  const response=await app.fetch(new Request(ISSUER+'/readyz'),{});
  assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{status:'not-ready',reason:'schema'});
});
