import { assertBridge, BridgeError } from '../errors.mjs';

const STATE_PATTERN=/^[A-Za-z0-9_-]{32,256}$/;
const CODE_PATTERN=/^[A-Za-z0-9._-]{4,512}$/;
const VERIFIER_PATTERN=/^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE_PATTERN=/^[A-Za-z0-9_-]{43,128}$/;
const REPOSITORY_PATTERN=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function absoluteHttpsUrl(value,label) {
  let url;
  try {
    url=value instanceof URL ? new URL(value.href) : new URL(value);
  } catch {
    assertBridge(false,'GITHUB_USER_AUTH_CONFIG_INVALID',`${label} must be an absolute URL`);
  }
  assertBridge(
    url.protocol==='https:' &&
      url.username==='' &&
      url.password==='' &&
      url.hash==='',
    'GITHUB_USER_AUTH_CONFIG_INVALID',
    `${label} must be a clean HTTPS URL`
  );
  return url;
}

function boundedSecret(value,label) {
  assertBridge(
    typeof value==='string' && value.length>=1 && value.length<=4096,
    'GITHUB_USER_AUTH_CONFIG_INVALID',
    `${label} is required`
  );
  return value;
}

function opaque(value,pattern,label) {
  assertBridge(
    typeof value==='string' && pattern.test(value),
    'GITHUB_USER_AUTH_INVALID',
    `${label} is invalid`
  );
  return value;
}

function installationId(value) {
  assertBridge(
    Number.isSafeInteger(value) && value>0,
    'GITHUB_USER_AUTH_INVALID',
    'installationId must be a positive integer'
  );
  return value;
}

function parseResponseJson(text) {
  if(!text) return null;
  try { return JSON.parse(text); }
  catch { return null; }
}

function repository(value) {
  assertBridge(
    value &&
      Number.isSafeInteger(value.id) &&
      value.id>0 &&
      typeof value.full_name==='string' &&
      REPOSITORY_PATTERN.test(value.full_name),
    'GITHUB_USER_AUTH_INVALID',
    'GitHub returned an invalid repository identity'
  );
  return {
    id:value.id,
    fullName:value.full_name,
    private:value.private===true,
    permissions:value.permissions && typeof value.permissions==='object'
      ? {
          admin:value.permissions.admin===true,
          maintain:value.permissions.maintain===true,
          push:value.permissions.push===true,
          triage:value.permissions.triage===true,
          pull:value.permissions.pull===true
        }
      : null
  };
}

function userInstallation(value) {
  assertBridge(
    value &&
      Number.isSafeInteger(value.id) &&
      value.id>0 &&
      value.account &&
      Number.isSafeInteger(value.account.id) &&
      value.account.id>0 &&
      typeof value.account.login==='string' &&
      value.account.login.length>=1 &&
      typeof value.account.type==='string' &&
      value.account.type.length>=1,
    'GITHUB_USER_AUTH_INVALID',
    'GitHub returned an invalid App installation'
  );
  return {
    id:value.id,
    accountLogin:value.account.login,
    accountId:String(value.account.id),
    ownerType:value.account.type,
    suspendedAt:value.suspended_at ?? null
  };
}

export class GitHubAppUserAuthClient {
  constructor({
    clientId,
    clientSecret,
    callbackUrl,
    fetchImpl=globalThis.fetch,
    githubBase='https://github.com',
    apiBase='https://api.github.com',
    apiVersion='2022-11-28',
    userAgent='runner-bridge'
  }={}) {
    this.clientId=boundedSecret(clientId,'GitHub App clientId');
    this.clientSecret=boundedSecret(clientSecret,'GitHub App clientSecret');
    this.callbackUrl=absoluteHttpsUrl(callbackUrl,'GitHub App callbackUrl');
    assertBridge(
      typeof fetchImpl==='function',
      'GITHUB_USER_AUTH_CONFIG_INVALID',
      'fetch implementation is required'
    );
    this.fetchImpl=fetchImpl;
    this.githubBase=absoluteHttpsUrl(githubBase,'GitHub web base');
    this.apiBase=absoluteHttpsUrl(apiBase,'GitHub API base');
    assertBridge(
      typeof apiVersion==='string' && apiVersion.length>=1 && apiVersion.length<=64,
      'GITHUB_USER_AUTH_CONFIG_INVALID',
      'GitHub API version is invalid'
    );
    this.apiVersion=apiVersion;
    assertBridge(
      typeof userAgent==='string' &&
        /^[\x20-\x7E]{1,256}$/.test(userAgent),
      'GITHUB_USER_AUTH_CONFIG_INVALID',
      'GitHub User-Agent is invalid'
    );
    this.userAgent=userAgent;
  }

  authorizationUrl({state,codeChallenge}={}) {
    const safeState=opaque(state,STATE_PATTERN,'OAuth state');
    const safeChallenge=opaque(codeChallenge,CHALLENGE_PATTERN,'PKCE code challenge');
    const url=new URL('/login/oauth/authorize',this.githubBase);
    url.searchParams.set('client_id',this.clientId);
    url.searchParams.set('redirect_uri',this.callbackUrl.href);
    url.searchParams.set('state',safeState);
    url.searchParams.set('code_challenge',safeChallenge);
    url.searchParams.set('code_challenge_method','S256');
    return url.href;
  }

  async exchangeCode({code,codeVerifier}={}) {
    const safeCode=opaque(code,CODE_PATTERN,'OAuth code');
    const safeVerifier=opaque(codeVerifier,VERIFIER_PATTERN,'PKCE code verifier');
    const body=new URLSearchParams({
      client_id:this.clientId,
      client_secret:this.clientSecret,
      code:safeCode,
      redirect_uri:this.callbackUrl.href,
      code_verifier:safeVerifier
    });
    const response=await this.fetchImpl(new URL('/login/oauth/access_token',this.githubBase),{
      method:'POST',
      headers:{
        Accept:'application/json',
        'Content-Type':'application/x-www-form-urlencoded',
        'User-Agent':this.userAgent
      },
      body:body.toString()
    });
    const text=await response.text();
    const data=parseResponseJson(text);
    if(!response.ok || !data || typeof data.access_token!=='string' || data.access_token.length===0) {
      throw new BridgeError(
        'GITHUB_USER_AUTH_ERROR',
        `GitHub user authorization exchange failed with HTTP ${response.status}`,
        {status:response.status}
      );
    }
    return Object.freeze({
      token:data.access_token,
      expiresIn:Number.isSafeInteger(data.expires_in) ? data.expires_in : null,
      tokenType:typeof data.token_type==='string' ? data.token_type : null
    });
  }

  async #api(token,path) {
    assertBridge(
      typeof token==='string' && token.length>0,
      'GITHUB_USER_AUTH_INVALID',
      'GitHub user access token is required'
    );
    const response=await this.fetchImpl(new URL(path,this.apiBase),{
      headers:{
        Accept:'application/vnd.github+json',
        Authorization:`Bearer ${token}`,
        'X-GitHub-Api-Version':this.apiVersion,
        'User-Agent':this.userAgent
      }
    });
    const text=await response.text();
    const data=parseResponseJson(text);
    if(!response.ok) {
      throw new BridgeError(
        'GITHUB_USER_AUTH_ERROR',
        `GitHub user API GET ${path.split('?')[0]} failed with HTTP ${response.status}`,
        {status:response.status}
      );
    }
    return data;
  }

  async getUser(token) {
    const data=await this.#api(token,'/user');
    assertBridge(
      data &&
        Number.isSafeInteger(data.id) &&
        data.id>0 &&
        typeof data.login==='string' &&
        data.login.length>=1,
      'GITHUB_USER_AUTH_INVALID',
      'GitHub returned an invalid user identity'
    );
    return Object.freeze({
      id:String(data.id),
      login:data.login
    });
  }

  async listInstallations(token) {
    const installations=[];
    for(let page=1;page<=10;page++) {
      const data=await this.#api(
        token,
        `/user/installations?per_page=100&page=${page}`
      );
      assertBridge(
        data && Array.isArray(data.installations),
        'GITHUB_USER_AUTH_INVALID',
        'GitHub returned an invalid installation list'
      );
      for(const item of data.installations) installations.push(userInstallation(item));
      if(data.installations.length<100) break;
      assertBridge(
        page<10,
        'GITHUB_USER_AUTH_INVALID',
        'GitHub installation list exceeds Bridge onboarding bound'
      );
    }
    const seen=new Set();
    return Object.freeze(installations.filter(item=>{
      if(seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    }));
  }

  async listInstallationRepositories(token,value) {
    const id=installationId(value);
    const repositories=[];
    for(let page=1;page<=10;page++) {
      const data=await this.#api(
        token,
        `/user/installations/${id}/repositories?per_page=100&page=${page}`
      );
      assertBridge(
        data && Array.isArray(data.repositories),
        'GITHUB_USER_AUTH_INVALID',
        'GitHub returned an invalid installation repository list'
      );
      for(const item of data.repositories) repositories.push(repository(item));
      if(data.repositories.length<100) break;
      assertBridge(
        page<10,
        'GITHUB_USER_AUTH_INVALID',
        'GitHub installation repository list exceeds Bridge onboarding bound'
      );
    }
    const seen=new Set();
    return Object.freeze(repositories.filter(item=>{
      if(seen.has(item.fullName)) return false;
      seen.add(item.fullName);
      return true;
    }));
  }
}

export const githubUserAuthPatterns=Object.freeze({
  STATE_PATTERN,
  VERIFIER_PATTERN,
  CHALLENGE_PATTERN
});
