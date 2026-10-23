import { assertBridge, BridgeError, errorEnvelope } from '../errors.mjs';
import { assertAuthenticatedPrincipal } from '../auth/principal.mjs';
import { createGitHubAppJwtProvider } from '../auth/github-app-jwt.mjs';
import { GitHubAppInstallationClient } from '../auth/github-installations.mjs';
import { GitHubAppCredentialProvider } from '../auth/github-app-credentials.mjs';
import { GitHubAppUserAuthClient } from '../auth/github-user-auth.mjs';
import { createRequestScopedGateway } from '../control-plane.mjs';
import { createBridgeMcpHandler } from '../mcp-server.mjs';
import {createRepositoryCatalogCache} from '../mcp-repository-catalog.mjs';
import { parseRemoteServiceConfig } from '../remote-service.mjs';
import { DurableTaskTransition } from '../task-transition.mjs';
import { D1BridgeIdentityStore } from './d1-identity-store.mjs';
import { D1AgentTaskStore } from './d1-agent-task-store.mjs';
import { D1TaskSessionStore } from './d1-task-session-store.mjs';
import { D1DirectExecStore } from './d1-direct-exec-store.mjs';
import { DirectPairingCodec } from './direct-pairing-codec.mjs';
import { DirectPairingService } from './direct-pairing-service.mjs';
import {
  DIRECT_ENROLL_CLAIM_PATH,
  createDirectPairingClaimHandler
} from './direct-pairing-api.mjs';
import { D1DirectAssetStore } from './d1-direct-asset-store.mjs';
import { DirectAssetService } from './direct-asset-service.mjs';
import { DirectAssetResourceCodec } from './direct-asset-resource-codec.mjs';
import {
  DIRECT_ASSET_UPLOAD_PREFIX,
  DIRECT_RUNNER_ASSET_PREFIX,
  DIRECT_RUNNER_EXPORT_PREFIX,
  cleanupDirectAssets,
  createDirectAssetHandler
} from './direct-asset-api.mjs';
import {
  DIRECT_RUNNER_CLAIM_PATH,
  DIRECT_RUNNER_HEARTBEAT_PATH,
  DIRECT_RUNNER_COMPLETE_PATH,
  createDirectRunnerHandler
} from './direct-runner-api.mjs';
import {
  DIRECT_ADMIN_REGISTER_HOST_PATH,
  DIRECT_ADMIN_SET_HOST_ENABLED_PATH,
  createDirectAdminHandler
} from './direct-admin-api.mjs';
import { createAuthorizedTaskState } from './task-github-reader.mjs';
import {
  DurableTaskControl,
  TASK_RUNTIME_CONTROL_PATH,
  createConfiguredTaskLauncher,
  createTaskRuntimeControlHandler
} from './task-runtime-control.mjs';
import {
  TASK_RUNTIME_ACTIVATE_PATH,
  activateTaskDispatch,
  taskRuntimeSessionForRequest,
  taskRuntimeSessionForToken
} from './task-runtime-session.mjs';
import { D1McpAuthorizationStore } from './oauth-authorization-store.mjs';
import { CloudflareGitHubAuthorizationCoordinator } from './oauth-github-authorization.mjs';

const STATE_COOKIE='__Host-bridge_oauth_state';
const REQUIRED_SCOPE='bridge';

function requiredString(value,label,{maximum=4096}={}) {
  assertBridge(
    typeof value==='string' && value.length>=1 && value.length<=maximum,
    'CLOUDFLARE_OAUTH_CONFIG_INVALID',
    `${label} is required`
  );
  return value;
}

function assertBindings(env) {
  assertBridge(
    env && typeof env==='object',
    'CLOUDFLARE_OAUTH_CONFIG_INVALID',
    'Cloudflare environment bindings are required'
  );
  assertBridge(
    env.DB && typeof env.DB.prepare==='function' && typeof env.DB.batch==='function',
    'CLOUDFLARE_OAUTH_CONFIG_INVALID',
    'DB D1 binding is required'
  );
  assertBridge(
    env.OAUTH_KV &&
      typeof env.OAUTH_KV.get==='function' &&
      typeof env.OAUTH_KV.put==='function',
    'CLOUDFLARE_OAUTH_CONFIG_INVALID',
    'OAUTH_KV binding is required'
  );
  return env;
}

function samePublicHost(request,publicUrl) {
  const url=new URL(request.url);
  if(url.protocol!=='https:' || url.host!==publicUrl.host) return false;
  const headerHost=request.headers.get('host');
  return headerHost===null || headerHost===url.host;
}

function parseCookie(request,name) {
  const raw=request.headers.get('cookie');
  if(!raw) return null;
  for(const part of raw.split(';')) {
    const index=part.indexOf('=');
    if(index<0) continue;
    const key=part.slice(0,index).trim();
    if(key!==name) continue;
    const value=part.slice(index+1).trim();
    try { return decodeURIComponent(value); }
    catch { return null; }
  }
  return null;
}

function stateCookie(value,maxAgeSeconds) {
  return [
    `${STATE_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax'
  ].join('; ');
}

function clearStateCookie() {
  return [
    `${STATE_COOKIE}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'Secure',
    'SameSite=Lax'
  ].join('; ');
}

function redirectWithCookie(location,cookie) {
  return new Response(null,{
    status:302,
    headers:{
      Location:location,
      'Set-Cookie':cookie,
      'Cache-Control':'no-store'
    }
  });
}

function browserState(request) {
  const cookie=parseCookie(request,STATE_COOKIE);
  assertBridge(
    typeof cookie==='string' && /^[A-Za-z0-9_-]{32,256}$/.test(cookie),
    'OAUTH_GITHUB_DENIED',
    'OAuth browser state is missing or invalid'
  );
  const url=new URL(request.url);
  const query=url.searchParams.get('state');
  if(query!==null) {
    assertBridge(
      query===cookie,
      'OAUTH_GITHUB_DENIED',
      'OAuth browser state does not match callback state'
    );
  }
  return cookie;
}

function positiveInteger(value,label) {
  const parsed=Number(value);
  assertBridge(
    Number.isSafeInteger(parsed) && parsed>0,
    'OAUTH_GITHUB_INVALID',
    `${label} must be a positive integer`
  );
  return parsed;
}

function oauthAuthorizationError(error,AuthorizationErrorClass) {
  if(
    typeof AuthorizationErrorClass!=='function' ||
    !(error instanceof AuthorizationErrorClass)
  ) throw error;
  if(!error.redirectUri) {
    return new Response(error.description,{status:400});
  }
  const redirect=new URL(error.redirectUri);
  redirect.searchParams.set('error',error.code);
  redirect.searchParams.set('error_description',error.description);
  if(error.state) redirect.searchParams.set('state',error.state);
  if(error.issuer) redirect.searchParams.set('iss',error.issuer);
  return Response.redirect(redirect.href,302);
}

function clientDisplayName(client,oauthRequest) {
  if(
    client &&
    typeof client.clientName==='string' &&
    client.clientName.length>=1 &&
    client.clientName.length<=512
  ) {
    return client.clientName;
  }
  const id=typeof oauthRequest?.clientId==='string'
    ? oauthRequest.clientId
    : 'MCP client';
  return id.length<=512 ? id : id.slice(0,512);
}

function callbackUrl(publicUrl) {
  return new URL('/auth/github/callback',publicUrl.origin).href;
}

function authorizationServerIssuer(publicUrl) {
  return publicUrl.origin;
}

export function createCloudflareBridgeOAuthProvider({
  env,
  fetchImpl=globalThis.fetch.bind(globalThis),
  OAuthProviderClass,
  AuthorizationErrorClass,
  identityStore,
  authorizationStore,
  installations,
  credentialProvider,
  userAuth,
  taskStore,
  taskSessionStore,
  directExecStore,
  directAssetStore,
  directPairingCodec,
  activationRandomUUID=()=>globalThis.crypto.randomUUID(),
  gatewayFactory=createRequestScopedGateway
}={}) {
  const bindings=assertBindings(env);
  assertBridge(
    typeof fetchImpl==='function',
    'CLOUDFLARE_OAUTH_CONFIG_INVALID',
    'fetch implementation is required'
  );
  assertBridge(
    typeof OAuthProviderClass==='function',
    'CLOUDFLARE_OAUTH_CONFIG_INVALID',
    'OAuthProvider constructor is required'
  );
  assertBridge(
    typeof AuthorizationErrorClass==='function',
    'CLOUDFLARE_OAUTH_CONFIG_INVALID',
    'AuthorizationError constructor is required'
  );

  const config=parseRemoteServiceConfig(bindings);
  const activeIdentityStore=identityStore ?? new D1BridgeIdentityStore({db:bindings.DB});
  const activeAuthorizationStore=authorizationStore ?? new D1McpAuthorizationStore({db:bindings.DB});
  const activeTaskStore=taskStore ?? new D1AgentTaskStore({db:bindings.DB});
  const activeTaskSessionStore=taskSessionStore ?? new D1TaskSessionStore({db:bindings.DB});
  const activeDirectExecStore=directExecStore ?? new D1DirectExecStore({db:bindings.DB});
  const activeDirectAssetStore=directAssetStore ?? new D1DirectAssetStore({db:bindings.DB});
  const activeDirectPairingCodec=directPairingCodec ?? new DirectPairingCodec({
    secret:requiredString(
      bindings.BRIDGE_GITHUB_APP_CLIENT_SECRET,
      'BRIDGE_GITHUB_APP_CLIENT_SECRET'
    )
  });
  const directPairing=new DirectPairingService({
    codec:activeDirectPairingCodec,
    publicUrl:config.publicUrl
  });
  const directPairingClaimHandler=createDirectPairingClaimHandler({
    pairingCodec:activeDirectPairingCodec,
    directExecStore:activeDirectExecStore
  });
  const directAssetResourceCodec=new DirectAssetResourceCodec({
    secret:requiredString(
      bindings.BRIDGE_GITHUB_APP_CLIENT_SECRET,
      'BRIDGE_GITHUB_APP_CLIENT_SECRET'
    )
  });
  const directAssets=
    bindings.DIRECT_ASSETS &&
    typeof bindings.DIRECT_ASSETS.put==='function' &&
    typeof bindings.DIRECT_ASSETS.get==='function'
      ? new DirectAssetService({
          store:activeDirectAssetStore,
          bucket:bindings.DIRECT_ASSETS,
          resourceCodec:directAssetResourceCodec,
          publicUrl:config.publicUrl,
          fetchImpl
        })
      : null;
  const directAssetHandler=
    directAssets===null
      ? null
      : createDirectAssetHandler({
          store:activeDirectAssetStore,
          bucket:bindings.DIRECT_ASSETS,
          directExecStore:activeDirectExecStore
        });
  assertBridge(
    activeTaskStore &&
      typeof activeTaskStore.activate==='function' &&
      typeof activeTaskStore.assertCurrent==='function' &&
      typeof activeTaskStore.bindRun==='function' &&
      typeof activeTaskStore.getTask==='function' &&
      typeof activeTaskStore.completeStage==='function' &&
      typeof activeTaskStore.claimNextStage==='function' &&
      typeof activeTaskStore.releaseFailedClaim==='function' &&
      typeof activeTaskStore.block==='function' &&
      typeof activeTaskStore.reconcileExpired==='function',
    'CLOUDFLARE_OAUTH_CONFIG_INVALID',
    'Durable task store is incomplete'
  );
  assertBridge(
    activeTaskSessionStore &&
      typeof activeTaskSessionStore.issue==='function' &&
      typeof activeTaskSessionStore.resolve==='function',
    'CLOUDFLARE_OAUTH_CONFIG_INVALID',
    'Durable task session store is incomplete'
  );
  assertBridge(
    activeDirectExecStore &&
      typeof activeDirectExecStore.submit==='function' &&
      typeof activeDirectExecStore.getRun==='function' &&
      typeof activeDirectExecStore.getResult==='function' &&
      typeof activeDirectExecStore.claimNext==='function' &&
      typeof activeDirectExecStore.complete==='function',
    'CLOUDFLARE_OAUTH_CONFIG_INVALID',
    'Direct Exec store is incomplete'
  );
  assertBridge(
    activeDirectAssetStore &&
      typeof activeDirectAssetStore.create==='function' &&
      typeof activeDirectAssetStore.createReady==='function' &&
      typeof activeDirectAssetStore.findReadyBySource==='function' &&
      typeof activeDirectAssetStore.getOwnedReady==='function' &&
      typeof activeDirectAssetStore.assertReady==='function' &&
      typeof activeDirectAssetStore.authorizeUpload==='function' &&
      typeof activeDirectAssetStore.authorizeRunnerDownload==='function',
    'CLOUDFLARE_OAUTH_CONFIG_INVALID',
    'Direct Asset store is incomplete'
  );
  assertBridge(
    typeof activationRandomUUID==='function',
    'CLOUDFLARE_OAUTH_CONFIG_INVALID',
    'task activation randomUUID is required'
  );
  assertBridge(
    typeof gatewayFactory==='function',
    'CLOUDFLARE_OAUTH_CONFIG_INVALID',
    'request-scoped gateway factory is required'
  );

  const jwtProvider=createGitHubAppJwtProvider({
    issuer:config.githubAppIssuer,
    privateKey:requiredString(
      bindings.BRIDGE_GITHUB_APP_PRIVATE_KEY,
      'BRIDGE_GITHUB_APP_PRIVATE_KEY'
    )
  });
  const activeInstallations=installations ?? new GitHubAppInstallationClient({
    jwtProvider,
    fetchImpl,
    apiBase:config.githubApiBase
  });
  const activeCredentialProvider=credentialProvider ?? new GitHubAppCredentialProvider({
    installations:activeInstallations
  });
  const activeLauncherCoordinator=createConfiguredTaskLauncher({
    taskStore:activeTaskStore,
    endpoint:bindings.BRIDGE_TASK_LAUNCHER_URL,
    token:bindings.BRIDGE_TASK_LAUNCHER_TOKEN,
    fetchImpl
  });
  const taskControlEnabled=
    (
      typeof bindings.BRIDGE_TASK_RUNTIME_ADMIN_TOKEN==='string' &&
      bindings.BRIDGE_TASK_RUNTIME_ADMIN_TOKEN.length>0
    ) ||
    activeLauncherCoordinator!==null;
  const taskControl=taskControlEnabled
    ? new DurableTaskControl({
        taskStore:activeTaskStore,
        identityStore:activeIdentityStore,
        credentialProvider:activeCredentialProvider,
        fetchImpl,
        apiBase:config.githubApiBase,
        gatewayFactory,
        launcherCoordinator:activeLauncherCoordinator
      })
    : null;
  const taskControlHandler=
    taskControl===null ||
    typeof bindings.BRIDGE_TASK_RUNTIME_ADMIN_TOKEN!=='string' ||
    bindings.BRIDGE_TASK_RUNTIME_ADMIN_TOKEN.length===0
      ? null
      : createTaskRuntimeControlHandler({
          control:taskControl,
          adminToken:bindings.BRIDGE_TASK_RUNTIME_ADMIN_TOKEN
        });
  const activeUserAuth=userAuth ?? new GitHubAppUserAuthClient({
    clientId:requiredString(
      bindings.BRIDGE_GITHUB_APP_CLIENT_ID,
      'BRIDGE_GITHUB_APP_CLIENT_ID',
      {maximum:256}
    ),
    clientSecret:requiredString(
      bindings.BRIDGE_GITHUB_APP_CLIENT_SECRET,
      'BRIDGE_GITHUB_APP_CLIENT_SECRET'
    ),
    callbackUrl:bindings.BRIDGE_GITHUB_CALLBACK_URL ?? callbackUrl(config.publicUrl),
    fetchImpl
  });
  const directRunnerHandler=createDirectRunnerHandler({
    store:activeDirectExecStore
  });
  const directAdminHandler=
    typeof bindings.BRIDGE_DIRECT_ADMIN_TOKEN==='string' &&
    bindings.BRIDGE_DIRECT_ADMIN_TOKEN.length>=32
      ? createDirectAdminHandler({
          store:activeDirectExecStore,
          identityStore:activeIdentityStore,
          adminToken:bindings.BRIDGE_DIRECT_ADMIN_TOKEN
        })
      : null;

  const authorization=new CloudflareGitHubAuthorizationCoordinator({
    appSlug:requiredString(
      bindings.BRIDGE_GITHUB_APP_SLUG,
      'BRIDGE_GITHUB_APP_SLUG',
      {maximum:100}
    ),
    authorizationStore:activeAuthorizationStore,
    identityStore:activeIdentityStore,
    userAuth:activeUserAuth,
    installations:activeInstallations
  });

  const apiHandler=Object.freeze({
    async fetch(request,_handlerEnv,ctx) {
      const principal=assertAuthenticatedPrincipal(ctx?.props?.bridgePrincipal);
      let taskSession;
      try {
        taskSession=await taskRuntimeSessionForRequest(request,{
          taskStore:activeTaskStore,
          bridgeUserId:principal.bridgeUserId
        });
      } catch(error) {
        const status=
          error?.code==='TASK_SESSION_INVALID' ? 400 :
          error?.code==='TASK_SESSION_PRINCIPAL_MISMATCH' ? 403 :
          error?.code==='TASK_NOT_FOUND' ? 404 :
          null;
        if(status===null) throw error;
        return Response.json(
          {error:errorEnvelope(error)},
          {status,headers:{'cache-control':'no-store'}}
        );
      }
      const buildGateway=session=>gatewayFactory({
        principal,
        principalRepositoryAuthorizer:activeIdentityStore,
        installationResolver:activeIdentityStore,
        credentialProvider:activeCredentialProvider,
        directExec:activeDirectExecStore,
        ...(directAssets===null ? {} : {directAssets}),
        directPairing,
        fetchImpl,
        apiBase:config.githubApiBase,
        ...(session===null
          ? {}
          : {
              taskContext:session.taskContext,
              taskLeaseValidator:session.taskLeaseValidator,
              ...(session.taskActivity===undefined ? {} : {taskActivity:session.taskActivity}),
              taskLifecycle:Object.freeze({
                transition:input=>new DurableTaskTransition({
                  taskStore:activeTaskStore,
                  taskSessionStore:activeTaskSessionStore,
                  durableStateFactory:task=>createAuthorizedTaskState({
                    principal,
                    repository:task.repository,
                    identityStore:activeIdentityStore,
                    credentialProvider:activeCredentialProvider,
                    fetchImpl,
                    apiBase:config.githubApiBase
                  })
                }).apply(session,input)
              })
            })
      });
      const gateway=buildGateway(taskSession);
      const mcp=createBridgeMcpHandler({
        gateway,
        repositoryCatalogCache:createRepositoryCatalogCache({kv:bindings.OAUTH_KV,owner:principal.bridgeUserId,origin:config.publicUrl.href}),
        gatewayForTool:async ({taskSessionToken}) => {
          assertBridge(
            taskSession===null,
            'TASK_SESSION_INVALID',
            'task session token cannot be combined with task session headers'
          );
          const tokenSession=await taskRuntimeSessionForToken(taskSessionToken,{
            taskStore:activeTaskStore,
            taskSessionStore:activeTaskSessionStore,
            bridgeUserId:principal.bridgeUserId
          });
          return buildGateway(tokenSession);
        }
      });
      try {
        return await mcp.fetch(request);
      } finally {
        await mcp.close();
      }
    }
  });

  const defaultHandler=Object.freeze({
    async fetch(request,handlerEnv) {
      if(!samePublicHost(request,config.publicUrl)) {
        return Response.json({error:'forbidden'},{status:403});
      }

      const url=new URL(request.url);
      if(request.method==='GET' && url.pathname==='/healthz') {
        return Response.json({status:'ok'});
      }
      if(request.method==='GET' && url.pathname==='/readyz') {
        try {
          // These zero/one-row probes compile against the current production
          // schema and catch a code-before-migration deployment immediately.
          await bindings.DB.prepare(
            'SELECT last_seen_at FROM direct_hosts LIMIT 1'
          ).first();
          await bindings.DB.prepare(
            'SELECT expires_at, cancel_reason FROM direct_runs LIMIT 1'
          ).first();
          await bindings.DB.prepare(
            'SELECT progress_phase, execution_elapsed_ms, progress_reported_at, phase_started_at FROM direct_runs LIMIT 0'
          ).first();
          await bindings.DB.prepare(
            'SELECT status, expires_at, persistent, source_kind FROM direct_assets LIMIT 1'
          ).first();
          await bindings.DB.prepare(
            'SELECT object_key, retired_at, retirement_token FROM direct_asset_object_retirements LIMIT 1'
          ).first();
          return Response.json({
            status:'ready',
            directAssets:directAssetHandler!==null,
            directAdmin:directAdminHandler!==null
          });
        } catch {
          return Response.json(
            {status:'not-ready',reason:'schema'},
            {status:503,headers:{'cache-control':'no-store'}}
          );
        }
      }

      if(
        url.pathname===DIRECT_RUNNER_CLAIM_PATH ||
        url.pathname===DIRECT_RUNNER_HEARTBEAT_PATH ||
        url.pathname===DIRECT_RUNNER_COMPLETE_PATH
      ) {
        return directRunnerHandler.fetch(request);
      }

      if(url.pathname===DIRECT_ENROLL_CLAIM_PATH) {
        return directPairingClaimHandler.fetch(request);
      }

      if(
        directAssetHandler!==null &&
        (
          url.pathname.startsWith(DIRECT_ASSET_UPLOAD_PREFIX) ||
          url.pathname.startsWith(DIRECT_RUNNER_ASSET_PREFIX) ||
          url.pathname.startsWith(DIRECT_RUNNER_EXPORT_PREFIX)
        )
      ) {
        return directAssetHandler.fetch(request);
      }

      if(
        url.pathname===DIRECT_ADMIN_REGISTER_HOST_PATH ||
        url.pathname===DIRECT_ADMIN_SET_HOST_ENABLED_PATH
      ) {
        if(directAdminHandler===null) return new Response('Not found',{status:404});
        return directAdminHandler.fetch(request);
      }

      if(url.pathname===TASK_RUNTIME_CONTROL_PATH) {
        if(taskControlHandler===null) return new Response('Not found',{status:404});
        return taskControlHandler.fetch(request);
      }

      if(request.method==='POST' && url.pathname===TASK_RUNTIME_ACTIVATE_PATH) {
        let activated;
        try {
          activated=await activateTaskDispatch({
            request,
            taskStore:activeTaskStore,
            taskSessionStore:activeTaskSessionStore,
            randomUUID:activationRandomUUID
          });
        } catch(error) {
          if(
            error?.code!=='TASK_ACTIVATION_INVALID' &&
            error?.code!=='TASK_SESSION_INVALID'
          ) throw error;
          return Response.json(
            {error:errorEnvelope(error)},
            {status:400,headers:{'cache-control':'no-store'}}
          );
        }
        if(!activated) {
          return Response.json(
            {
              error:{
                code:'TASK_DISPATCH_STALE',
                message:'dispatch is stale, expired, or already activated'
              }
            },
            {status:409,headers:{'cache-control':'no-store'}}
          );
        }
        return Response.json(
          activated,
          {headers:{'cache-control':'no-store'}}
        );
      }


      if(request.method==='GET' && url.pathname==='/authorize') {
        let oauthRequest;
        try {
          oauthRequest=await handlerEnv.OAUTH_PROVIDER.parseAuthRequest(request);
        } catch(error) {
          return oauthAuthorizationError(error,AuthorizationErrorClass);
        }

        const client=await handlerEnv.OAUTH_PROVIDER.lookupClient(oauthRequest.clientId);
        if(!client) {
          return new Response('Unknown OAuth client',{status:400});
        }

        const begun=await authorization.begin({
          oauthRequest,
          clientName:clientDisplayName(client,oauthRequest)
        });
        const maxAge=Math.max(
          60,
          Math.min(
            3600,
            Math.floor((Date.parse(begun.expiresAt)-Date.now())/1000)
          )
        );
        return redirectWithCookie(
          begun.authorizationUrl,
          stateCookie(begun.state,maxAge)
        );
      }

      if(request.method==='GET' && url.pathname==='/auth/github/setup') {
        const state=browserState(request);
        const accepted=await authorization.acceptInstallation({
          state,
          installationId:positiveInteger(
            url.searchParams.get('installation_id'),
            'installation_id'
          )
        });
        return redirectWithCookie(
          accepted.authorizationUrl,
          stateCookie(state,15*60)
        );
      }

      if(request.method==='GET' && url.pathname==='/auth/github/callback') {
        const state=browserState(request);
        if(url.searchParams.has('error')) {
          const cancelled=await authorization.cancel({
            state,
            error:'access_denied',
            description:'GitHub authorization was not completed'
          });
          return redirectWithCookie(cancelled.redirectTo,clearStateCookie());
        }

        const completed=await authorization.complete({
          state,
          code:url.searchParams.get('code'),
          oauthHelpers:handlerEnv.OAUTH_PROVIDER
        });
        if(completed.kind==='install') {
          const maxAge=Math.max(
            60,
            Math.min(
              3600,
              Math.floor((Date.parse(completed.expiresAt)-Date.now())/1000)
            )
          );
          return redirectWithCookie(
            completed.redirectTo,
            stateCookie(completed.state,maxAge)
          );
        }
        return redirectWithCookie(completed.redirectTo,clearStateCookie());
      }

      return new Response('Not found',{status:404});
    }
  });

  const issuer=authorizationServerIssuer(config.publicUrl);
  const provider=new OAuthProviderClass({
    apiRoute:'/mcp',
    apiHandler,
    defaultHandler,
    authorizeEndpoint:'/authorize',
    tokenEndpoint:'/oauth/token',
    clientRegistrationEndpoint:'/oauth/register',
    scopesSupported:[REQUIRED_SCOPE],
    resourceMetadata:{
      resource:config.publicUrl.href,
      authorization_servers:[issuer],
      scopes_supported:[REQUIRED_SCOPE],
      resource_name:'Bridge'
    },
    clientIdMetadataDocumentEnabled:true
  });

  return Object.freeze({
    provider,
    config:Object.freeze({
      publicUrl:config.publicUrl.href,
      authorizationServer:issuer,
      authorizeEndpoint:`${issuer}/authorize`,
      tokenEndpoint:`${issuer}/oauth/token`,
      clientRegistrationEndpoint:`${issuer}/oauth/register`,
      githubSetupUrl:`${issuer}/auth/github/setup`,
      githubCallbackUrl:bindings.BRIDGE_GITHUB_CALLBACK_URL ?? callbackUrl(config.publicUrl),
      taskActivationUrl:`${issuer}${TASK_RUNTIME_ACTIVATE_PATH}`,
      taskControlUrl:`${issuer}${TASK_RUNTIME_CONTROL_PATH}`,
      directRunnerClaimUrl:`${issuer}${DIRECT_RUNNER_CLAIM_PATH}`,
      directRunnerHeartbeatUrl:`${issuer}${DIRECT_RUNNER_HEARTBEAT_PATH}`,
      directRunnerCompleteUrl:`${issuer}${DIRECT_RUNNER_COMPLETE_PATH}`,
      directEnrollClaimUrl:`${issuer}${DIRECT_ENROLL_CLAIM_PATH}`,
      directAdminRegisterHostUrl:`${issuer}${DIRECT_ADMIN_REGISTER_HOST_PATH}`,
      directAdminSetHostEnabledUrl:`${issuer}${DIRECT_ADMIN_SET_HOST_ENABLED_PATH}`
    }),
    async fetch(request,ctx) {
      return provider.fetch(request,bindings,ctx);
    },
    async scheduled() {
      const failures=[];
      const lane=async(name,operation,fallback)=>{
        try {
          return await operation();
        } catch(error) {
          failures.push({
            lane:name,
            code:typeof error?.code==='string' ? error.code : 'INTERNAL_ERROR'
          });
          return fallback;
        }
      };

      // Maintenance lanes are deliberately independent. A temporary GitHub
      // launcher failure must not block D1/R2 retention, and R2 failure must
      // not block the Durable Task watchdog.
      const oauthState=await lane(
        'oauthState',
        ()=>typeof activeAuthorizationStore.pruneExpired==='function'
          ? activeAuthorizationStore.pruneExpired({limit:100})
          : Promise.resolve({removed:0}),
        {removed:0}
      );
      const taskSessions=await lane(
        'taskSessions',
        ()=>typeof activeTaskSessionStore.pruneExpired==='function'
          ? activeTaskSessionStore.pruneExpired({limit:100})
          : Promise.resolve({removed:0}),
        {removed:0}
      );
      const directReconciliation=await lane(
        'directReconciliation',
        ()=>typeof activeDirectExecStore.reconcileExpired==='function'
          ? activeDirectExecStore.reconcileExpired({limit:100})
          : Promise.resolve({canceledQueued:0,canceledRunning:0,requeued:0}),
        {canceledQueued:0,canceledRunning:0,requeued:0}
      );
      const directRuns=await lane(
        'directRuns',
        ()=>typeof activeDirectExecStore.pruneTerminal==='function'
          ? activeDirectExecStore.pruneTerminal({limit:100})
          : Promise.resolve({removed:0}),
        {removed:0}
      );
      const assets=await lane(
        'assets',
        ()=>directAssetHandler===null
          ? Promise.resolve({expired:0})
          : cleanupDirectAssets({
              store:activeDirectAssetStore,
              bucket:bindings.DIRECT_ASSETS,
              limit:100
            }),
        {expired:0}
      );
      const assetMetadata=await lane(
        'assetMetadata',
        ()=>directAssetHandler===null ||
            typeof activeDirectAssetStore.pruneExpiredMetadata!=='function'
          ? Promise.resolve({removed:0})
          : activeDirectAssetStore.pruneExpiredMetadata({limit:100}),
        {removed:0}
      );
      const tasks=await lane(
        'tasks',
        ()=>taskControl===null || activeLauncherCoordinator===null
          ? Promise.resolve({action:'SKIP',reason:'TASK_LAUNCHER_UNCONFIGURED'})
          : taskControl.tickAll({limit:100,launch:true}),
        {action:'ERROR'}
      );

      const result={
        tasks,
        oauthState,
        taskSessions,
        directReconciliation,
        directRuns,
        ...(directAssetHandler===null ? {} : {assets,assetMetadata})
      };

      if(failures.length>0) {
        throw new BridgeError(
          'SCHEDULED_MAINTENANCE_FAILED',
          'one or more scheduled Bridge maintenance lanes failed',
          {failures}
        );
      }

      const changed=
        oauthState.removed>0 ||
        taskSessions.removed>0 ||
        directRuns.removed>0 ||
        directReconciliation.canceledQueued>0 ||
        directReconciliation.canceledRunning>0 ||
        directReconciliation.requeued>0 ||
        assets.expired>0 ||
        assetMetadata.removed>0;

      return !changed &&
        directAssetHandler===null &&
        tasks.action==='SKIP'
        ? tasks
        : result;
    }
  });
}
