import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { BridgeError, errorEnvelope } from '../src/errors.mjs';
import { createGitHubAppJwtProvider } from '../src/auth/github-app-jwt.mjs';
import { GitHubAppInstallationClient } from '../src/auth/github-installations.mjs';
import {
  GitHubAppCredentialProvider,
  githubPermissionsForBridgePermission
} from '../src/auth/github-app-credentials.mjs';

const REPO='example/project';
const INSTALLATION_ID=12345;

function decodeJson(segment) {
  return JSON.parse(Buffer.from(segment,'base64url').toString('utf8'));
}

test('GitHub App JWT uses RS256 with bounded GitHub claims',async()=>{
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const now=1_800_000_000_000;
  const provider=createGitHubAppJwtProvider({
    issuer:'Iv1.bridge-client',
    privateKey,
    clock:()=>now
  });
  const jwt=await provider.createJwt();
  const [headerSegment,payloadSegment,signatureSegment]=jwt.split('.');
  assert.deepEqual(decodeJson(headerSegment),{alg:'RS256',typ:'JWT'});
  assert.deepEqual(decodeJson(payloadSegment),{
    iat:Math.floor(now/1000)-60,
    exp:Math.floor(now/1000)+9*60,
    iss:'Iv1.bridge-client'
  });
  assert.equal(
    verify(
      'RSA-SHA256',
      Buffer.from(`${headerSegment}.${payloadSegment}`),
      publicKey,
      Buffer.from(signatureSegment,'base64url')
    ),
    true
  );
});

test('installation client scopes token request to one repository and omits response bodies from errors',async()=>{
  const calls=[];
  const jwt='app-jwt-secret-value';
  const client=new GitHubAppInstallationClient({
    jwtProvider:{async createJwt(){return jwt;}},
    fetchImpl:async(url,init)=>{
      calls.push({url:String(url),init});
      return new Response(JSON.stringify({
        token:'ghs_stateless_format_token_that_is_not_40_characters',
        expires_at:'2030-01-01T00:00:00Z',
        permissions:{contents:'read',actions:'read'},
        repositories:[{full_name:REPO}]
      }),{status:201,headers:{'content-type':'application/json'}});
    }
  });

  await client.createInstallationToken({
    installationId:INSTALLATION_ID,
    repository:REPO,
    permissions:{contents:'read',actions:'read'}
  });
  assert.equal(calls.length,1);
  assert.match(calls[0].url,/\/app\/installations\/12345\/access_tokens$/);
  assert.equal(calls[0].init.headers.Authorization,`Bearer ${jwt}`);
  assert.equal(calls[0].init.headers['User-Agent'],'runner-bridge');
  assert.deepEqual(JSON.parse(calls[0].init.body),{
    repositories:['project'],
    permissions:{contents:'read',actions:'read'}
  });

  const failing=new GitHubAppInstallationClient({
    jwtProvider:{async createJwt(){return jwt;}},
    fetchImpl:async()=>new Response(
      JSON.stringify({message:'failure',token:'server-secret-that-must-not-leak'}),
      {status:401,headers:{'content-type':'application/json'}}
    )
  });
  await assert.rejects(
    ()=>failing.getInstallation(INSTALLATION_ID),
    error=>{
      assert.equal(error.code,'GITHUB_APP_API_ERROR');
      assert.equal(JSON.stringify(errorEnvelope(error)).includes('server-secret-that-must-not-leak'),false);
      assert.equal(JSON.stringify(errorEnvelope(error)).includes(jwt),false);
      return true;
    }
  );
});

class FakeInstallations {
  constructor({clock}) {
    this.clock=clock;
    this.installation={id:INSTALLATION_ID,suspended_at:null};
    this.repositoryInstallation={id:INSTALLATION_ID,suspended_at:null};
    this.permissions=null;
    this.issueCount=0;
    this.installationChecks=0;
    this.repositoryChecks=0;
  }
  async getInstallation(id) {
    this.installationChecks++;
    assert.equal(id,INSTALLATION_ID);
    return this.installation;
  }
  async getRepositoryInstallation(repository) {
    this.repositoryChecks++;
    assert.equal(repository,REPO);
    return this.repositoryInstallation;
  }
  async createInstallationToken({installationId,repository,permissions}) {
    assert.equal(installationId,INSTALLATION_ID);
    assert.equal(repository,REPO);
    this.issueCount++;
    return {
      token:`ghs_installation_token_${this.issueCount}_with_stateless_length`,
      expires_at:new Date(this.clock()+60*60*1000).toISOString(),
      permissions:this.permissions ?? permissions,
      repositories:[{full_name:REPO}]
    };
  }
}

test('credential provider revalidates installation scope and refreshes near expiry',async()=>{
  let now=1_800_000_000_000;
  const clock=()=>now;
  const installations=new FakeInstallations({clock});
  const provider=new GitHubAppCredentialProvider({
    installations,
    clock,
    refreshSkewMs:5*60*1000
  });

  const first=await provider.acquire({
    installationId:INSTALLATION_ID,
    repository:REPO,
    permission:'run'
  });
  assert.equal(first.token,'ghs_installation_token_1_with_stateless_length');
  assert.deepEqual(githubPermissionsForBridgePermission('run'),{
    contents:'write',
    actions:'write'
  });
  assert.deepEqual(githubPermissionsForBridgePermission('task-read'),{
    contents:'read',
    issues:'read'
  });

  const cached=await provider.acquire({
    installationId:INSTALLATION_ID,
    repository:REPO,
    permission:'run'
  });
  assert.equal(cached,first);
  assert.equal(installations.issueCount,1);
  assert.equal(installations.installationChecks,2);
  assert.equal(installations.repositoryChecks,2);

  now+=56*60*1000;
  const refreshed=await provider.acquire({
    installationId:INSTALLATION_ID,
    repository:REPO,
    permission:'run'
  });
  assert.notEqual(refreshed.token,first.token);
  assert.equal(installations.issueCount,2);
});

test('credential provider fails closed for wrong, suspended or revoked installation before token use',async()=>{
  let now=1_800_000_000_000;
  const clock=()=>now;

  const wrong=new FakeInstallations({clock});
  wrong.repositoryInstallation={id:INSTALLATION_ID+1,suspended_at:null};
  const wrongProvider=new GitHubAppCredentialProvider({installations:wrong,clock});
  await assert.rejects(
    ()=>wrongProvider.acquire({installationId:INSTALLATION_ID,repository:REPO,permission:'read'}),
    error=>error.code==='GITHUB_APP_AUTHORIZATION_DENIED'
  );
  assert.equal(wrong.issueCount,0);

  const suspended=new FakeInstallations({clock});
  suspended.installation={id:INSTALLATION_ID,suspended_at:'2026-09-18T00:00:00Z'};
  const suspendedProvider=new GitHubAppCredentialProvider({installations:suspended,clock});
  await assert.rejects(
    ()=>suspendedProvider.acquire({installationId:INSTALLATION_ID,repository:REPO,permission:'read'}),
    error=>error.code==='GITHUB_APP_AUTHORIZATION_DENIED'
  );
  assert.equal(suspended.issueCount,0);

  const revoked=new FakeInstallations({clock});
  revoked.getInstallation=async()=>{
    throw new BridgeError('GITHUB_APP_API_ERROR','GitHub App installation lookup failed',{status:404});
  };
  const revokedProvider=new GitHubAppCredentialProvider({installations:revoked,clock});
  await assert.rejects(
    ()=>revokedProvider.acquire({installationId:INSTALLATION_ID,repository:REPO,permission:'read'}),
    error=>error.code==='GITHUB_APP_API_ERROR'
  );
  assert.equal(revoked.issueCount,0);
});

test('credential provider rejects under-scoped token without leaking credential material',async()=>{
  const clock=()=>1_800_000_000_000;
  const installations=new FakeInstallations({clock});
  installations.permissions={contents:'read',actions:'read'};
  const provider=new GitHubAppCredentialProvider({installations,clock});
  let caught;
  try {
    await provider.acquire({
      installationId:INSTALLATION_ID,
      repository:REPO,
      permission:'run'
    });
  } catch(error) {
    caught=error;
  }
  assert.ok(caught);
  assert.equal(caught.code,'GITHUB_APP_AUTHORIZATION_DENIED');
  const envelope=JSON.stringify(errorEnvelope(caught));
  assert.equal(envelope.includes('ghs_installation_token_1_with_stateless_length'),false);
});
