import { assertBridge } from '../errors.mjs';
import { assertAuthenticatedPrincipal } from '../auth/principal.mjs';

const APP_SLUG_PATTERN=/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
const STATE_PATTERN=/^[A-Za-z0-9_-]{32,256}$/;
const CODE_PATTERN=/^[A-Za-z0-9._-]{4,512}$/;
const VERIFIER_PATTERN=/^[A-Za-z0-9._~-]{43,128}$/;
const DEFAULT_GRANTS=Object.freeze({read:true,run:true,publish:true});
const GITHUB_PROVIDER='https://github.com/';

function assertAuthorizationStore(value) {
  assertBridge(
    value &&
      typeof value.put==='function' &&
      typeof value.bindInstallation==='function' &&
      typeof value.take==='function',
    'OAUTH_GITHUB_CONFIG_INVALID',
    'OAuth authorization store is required'
  );
  return value;
}

function assertIdentityStore(value) {
  assertBridge(
    value &&
      typeof value.ensurePrincipal==='function' &&
      typeof value.commitGitHubOnboarding==='function',
    'OAUTH_GITHUB_CONFIG_INVALID',
    'Bridge identity store is required'
  );
  return value;
}

function assertUserAuth(value) {
  assertBridge(
    value &&
      typeof value.authorizationUrl==='function' &&
      typeof value.exchangeCode==='function' &&
      typeof value.getUser==='function' &&
      typeof value.listInstallations==='function' &&
      typeof value.listInstallationRepositories==='function',
    'OAUTH_GITHUB_CONFIG_INVALID',
    'GitHub user authorization client is required'
  );
  return value;
}

function assertInstallations(value) {
  assertBridge(
    value && typeof value.getInstallation==='function',
    'OAUTH_GITHUB_CONFIG_INVALID',
    'GitHub App installation client is required'
  );
  return value;
}

function assertOauthHelpers(value) {
  assertBridge(
    value && typeof value.completeAuthorization==='function',
    'OAUTH_GITHUB_CONFIG_INVALID',
    'Cloudflare OAuth helpers are required'
  );
  return value;
}

function installationId(value) {
  assertBridge(
    Number.isSafeInteger(value) && value>0,
    'OAUTH_GITHUB_INVALID',
    'installationId must be a positive integer'
  );
  return value;
}

function stateValue(value) {
  assertBridge(
    typeof value==='string' && STATE_PATTERN.test(value),
    'OAUTH_GITHUB_INVALID',
    'authorization state is invalid'
  );
  return value;
}

function codeValue(value) {
  assertBridge(
    typeof value==='string' && CODE_PATTERN.test(value),
    'OAUTH_GITHUB_INVALID',
    'GitHub OAuth code is invalid'
  );
  return value;
}

function boundedClientName(value) {
  assertBridge(
    typeof value==='string' && value.length>=1 && value.length<=512,
    'OAUTH_GITHUB_INVALID',
    'OAuth client name is invalid'
  );
  return value;
}

function base64url(bytes) {
  let binary='';
  for(const byte of bytes) binary+=String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g,'-')
    .replace(/\//g,'_')
    .replace(/=+$/,'');
}

function randomOpaque(size,cryptoImpl) {
  const bytes=new Uint8Array(size);
  cryptoImpl.getRandomValues(bytes);
  return base64url(bytes);
}

async function pkceChallenge(verifier,cryptoImpl) {
  const digest=await cryptoImpl.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier)
  );
  return base64url(new Uint8Array(digest));
}

function safeInstallation(value,expectedId) {
  assertBridge(
    value &&
      value.id===expectedId &&
      (value.suspended_at===null || value.suspended_at===undefined) &&
      value.account &&
      Number.isSafeInteger(value.account.id) &&
      value.account.id>0 &&
      typeof value.account.login==='string' &&
      value.account.login.length>=1 &&
      typeof value.account.type==='string' &&
      value.account.type.length>=1,
    'OAUTH_GITHUB_DENIED',
    'GitHub App installation is unavailable or suspended'
  );
  return Object.freeze({
    installationId:expectedId,
    accountLogin:value.account.login,
    accountId:String(value.account.id),
    ownerType:value.account.type,
    suspendedAt:null
  });
}

function grantedScopes(oauthRequest) {
  const requested=Array.isArray(oauthRequest?.scope) ? oauthRequest.scope : [];
  const scopes=requested.filter(scope=>scope==='bridge');
  assertBridge(
    scopes.length===1,
    'OAUTH_GITHUB_DENIED',
    'Bridge OAuth authorization requires the bridge scope'
  );
  return Object.freeze(scopes);
}

export class CloudflareGitHubAuthorizationCoordinator {
  constructor({
    appSlug,
    authorizationStore,
    identityStore,
    userAuth,
    installations,
    githubBase='https://github.com',
    clock=()=>Date.now(),
    cryptoImpl=globalThis.crypto,
    stateTtlMs=15*60*1000
  }={}) {
    assertBridge(
      typeof appSlug==='string' && APP_SLUG_PATTERN.test(appSlug),
      'OAUTH_GITHUB_CONFIG_INVALID',
      'GitHub App slug is invalid'
    );
    this.appSlug=appSlug;
    this.authorizationStore=assertAuthorizationStore(authorizationStore);
    this.identityStore=assertIdentityStore(identityStore);
    this.userAuth=assertUserAuth(userAuth);
    this.installations=assertInstallations(installations);

    let base;
    try { base=new URL(githubBase); }
    catch {
      assertBridge(
        false,
        'OAUTH_GITHUB_CONFIG_INVALID',
        'GitHub web base must be an absolute URL'
      );
    }
    assertBridge(
      base.protocol==='https:' &&
        base.username==='' &&
        base.password==='' &&
        base.search==='' &&
        base.hash==='',
      'OAUTH_GITHUB_CONFIG_INVALID',
      'GitHub web base must be a clean HTTPS URL'
    );
    this.githubBase=base;

    assertBridge(
      typeof clock==='function',
      'OAUTH_GITHUB_CONFIG_INVALID',
      'clock is required'
    );
    this.clock=clock;
    assertBridge(
      cryptoImpl &&
        typeof cryptoImpl.getRandomValues==='function' &&
        cryptoImpl.subtle &&
        typeof cryptoImpl.subtle.digest==='function',
      'OAUTH_GITHUB_CONFIG_INVALID',
      'Web Crypto implementation is required'
    );
    this.crypto=cryptoImpl;
    assertBridge(
      Number.isSafeInteger(stateTtlMs) &&
        stateTtlMs>=60_000 &&
        stateTtlMs<=60*60*1000,
      'OAUTH_GITHUB_CONFIG_INVALID',
      'stateTtlMs must be between one minute and one hour'
    );
    this.stateTtlMs=stateTtlMs;
  }

  async #createTransaction({oauthRequest,clientName}={}) {
    assertBridge(
      oauthRequest && typeof oauthRequest==='object' && !Array.isArray(oauthRequest),
      'OAUTH_GITHUB_INVALID',
      'validated OAuth authorization request is required'
    );
    grantedScopes(oauthRequest);

    const state=randomOpaque(32,this.crypto);
    const codeVerifier=randomOpaque(32,this.crypto);
    assertBridge(
      VERIFIER_PATTERN.test(codeVerifier),
      'OAUTH_GITHUB_INVALID',
      'generated GitHub PKCE verifier is invalid'
    );
    const codeChallenge=await pkceChallenge(codeVerifier,this.crypto);
    const now=this.clock();

    await this.authorizationStore.put({
      state,
      oauthRequest,
      clientName:boundedClientName(clientName),
      codeVerifier,
      codeChallenge,
      createdAt:now,
      expiresAt:now+this.stateTtlMs
    });

    return Object.freeze({
      state,
      codeChallenge,
      expiresAt:new Date(now+this.stateTtlMs).toISOString()
    });
  }

  #installUrl(state) {
    const installUrl=new URL(
      `/apps/${this.appSlug}/installations/new`,
      this.githubBase
    );
    installUrl.searchParams.set('state',stateValue(state));
    return installUrl.href;
  }

  async begin({oauthRequest,clientName}={}) {
    const transaction=await this.#createTransaction({oauthRequest,clientName});
    return Object.freeze({
      state:transaction.state,
      authorizationUrl:this.userAuth.authorizationUrl({
        state:transaction.state,
        codeChallenge:transaction.codeChallenge
      }),
      expiresAt:transaction.expiresAt
    });
  }

  async acceptInstallation({state,installationId:value}={}) {
    const stateId=stateValue(state);
    const id=installationId(value);
    const record=await this.authorizationStore.bindInstallation({
      state:stateId,
      installationId:id,
      now:this.clock()
    });
    assertBridge(
      record &&
        record.state===stateId &&
        record.installationId===id &&
        record.consented===true &&
        typeof record.codeChallenge==='string',
      'OAUTH_GITHUB_DENIED',
      'OAuth authorization state is missing, expired or already bound'
    );

    return Object.freeze({
      authorizationUrl:this.userAuth.authorizationUrl({
        state:stateId,
        codeChallenge:record.codeChallenge
      })
    });
  }

  async cancel({
    state,
    error='access_denied',
    description='GitHub authorization was not completed'
  }={}) {
    const stateId=stateValue(state);
    const record=await this.authorizationStore.take({
      state:stateId,
      now:this.clock()
    });
    assertBridge(
      record && record.state===stateId,
      'OAUTH_GITHUB_DENIED',
      'OAuth authorization state is missing or expired'
    );
    assertBridge(
      typeof error==='string' && /^[a-z_]{3,64}$/.test(error),
      'OAUTH_GITHUB_INVALID',
      'OAuth error code is invalid'
    );
    assertBridge(
      typeof description==='string' &&
        description.length>=1 &&
        description.length<=512,
      'OAUTH_GITHUB_INVALID',
      'OAuth error description is invalid'
    );

    const redirect=new URL(record.oauthRequest.redirectUri);
    redirect.searchParams.set('error',error);
    redirect.searchParams.set('error_description',description);
    redirect.searchParams.set('state',record.oauthRequest.state);
    if(
      typeof record.oauthRequest.issuer==='string' &&
      record.oauthRequest.issuer.length>0
    ) {
      redirect.searchParams.set('iss',record.oauthRequest.issuer);
    }
    return Object.freeze({redirectTo:redirect.href});
  }

  async complete({state,code,oauthHelpers}={}) {
    const stateId=stateValue(state);
    const oauthCode=codeValue(code);
    const helpers=assertOauthHelpers(oauthHelpers);
    const record=await this.authorizationStore.take({
      state:stateId,
      now:this.clock()
    });

    assertBridge(
      record &&
        record.state===stateId &&
        typeof record.codeVerifier==='string',
      'OAUTH_GITHUB_DENIED',
      'OAuth authorization state is missing or expired'
    );

    const exchanged=await this.userAuth.exchangeCode({
      code:oauthCode,
      codeVerifier:record.codeVerifier
    });
    const githubUser=await this.userAuth.getUser(exchanged.token);

    let selectedInstallationId=record.installationId;
    if(selectedInstallationId===null || selectedInstallationId===undefined) {
      const accessibleInstallations=await this.userAuth.listInstallations(
        exchanged.token
      );

      if(accessibleInstallations.length===0) {
        const restarted=await this.#createTransaction({
          oauthRequest:record.oauthRequest,
          clientName:record.clientName
        });
        return Object.freeze({
          kind:'install',
          redirectTo:this.#installUrl(restarted.state),
          state:restarted.state,
          expiresAt:restarted.expiresAt
        });
      }

      assertBridge(
        accessibleInstallations.length===1,
        'OAUTH_GITHUB_DENIED',
        'Multiple Bridge GitHub App installations are accessible; choose one installation before continuing'
      );
      selectedInstallationId=accessibleInstallations[0].id;
    } else {
      assertBridge(
        record.consented===true,
        'OAUTH_GITHUB_DENIED',
        'OAuth authorization state is incomplete'
      );
    }

    const installation=safeInstallation(
      await this.installations.getInstallation(selectedInstallationId),
      selectedInstallationId
    );

    const repositories=await this.userAuth.listInstallationRepositories(
      exchanged.token,
      selectedInstallationId
    );

    const principal=assertAuthenticatedPrincipal(
      await this.identityStore.ensurePrincipal({
        externalProvider:GITHUB_PROVIDER,
        externalSubject:githubUser.id
      })
    );
    if(principal.githubUserId!==undefined) {
      assertBridge(
        principal.githubUserId===githubUser.id,
        'OAUTH_GITHUB_DENIED',
        'GitHub identity does not match the existing Bridge principal'
      );
    }

    await this.identityStore.commitGitHubOnboarding({
      principal,
      githubUser,
      installation,
      repositories:repositories.map(item=>item.fullName),
      permissions:DEFAULT_GRANTS
    });

    const scope=grantedScopes(record.oauthRequest);
    const {redirectTo}=await helpers.completeAuthorization({
      request:record.oauthRequest,
      userId:principal.bridgeUserId,
      metadata:{
        clientName:record.clientName
      },
      scope:[...scope],
      props:{
        bridgePrincipal:principal
      }
    });

    assertBridge(
      typeof redirectTo==='string' && redirectTo.length>=1,
      'OAUTH_GITHUB_INVALID',
      'OAuth provider returned an invalid authorization redirect'
    );

    return Object.freeze({
      kind:'complete',
      redirectTo,
      principal,
      githubLogin:githubUser.login,
      repositories:Object.freeze(repositories.map(item=>item.fullName)),
      grants:DEFAULT_GRANTS
    });
  }

}

export const cloudflareGitHubAuthorizationDefaults=Object.freeze({
  externalProvider:GITHUB_PROVIDER,
  repositoryGrants:DEFAULT_GRANTS
});
