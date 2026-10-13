import {ensureHostDirectory} from '../src/host-files.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createBridgeMcpHandler } from '../src/mcp-server.mjs';
import { createBridgePrincipal } from '../src/auth/principal.mjs';
import { DirectPairingCodec } from '../src/cloudflare/direct-pairing-codec.mjs';
import { DirectPairingService } from '../src/cloudflare/direct-pairing-service.mjs';
import { createDirectPairingClaimHandler } from '../src/cloudflare/direct-pairing-api.mjs';
import { loginForHostPairing } from '../src/host-login.mjs';
import { setupHost } from '../src/host-onboarding.mjs';
import { readDirectRunnerEnv } from '../src/direct-connect-client.mjs';

// Only the WorkerEntrypoint host binding is shimmed. OAuth discovery,
// registration, PKCE, authorization code exchange, token crypto and bearer
// verification run in the real pinned Cloudflare library, not an auth mock.
const shim='data:text/javascript,'+encodeURIComponent('export class WorkerEntrypoint { constructor(ctx,env){this.ctx=ctx;this.env=env;} }');
const hooks=registerHooks({resolve(specifier,context,next){
  return specifier==='cloudflare:workers' ? {url:shim,shortCircuit:true} : next(specifier,context);
}});
let OAuthProvider;
try { ({default:OAuthProvider}=await import('@cloudflare/workers-oauth-provider')); }
finally { hooks.deregister(); }

const origin='https://bridge.example';
const endpoint=origin+'/mcp';
function fixture() {
  const entries=new Map(),hosts=new Map(),requests=[],background=[];
  const principal=createBridgePrincipal({bridgeUserId:'bridge-user-integration',externalProvider:'https://github.com/',
    externalSubject:'9001',githubUserId:'9001'});
  const codec=new DirectPairingCodec({secret:'test-only-signing-key-never-production'});
  const pairing=new DirectPairingService({codec,publicUrl:endpoint});
  const claim=createDirectPairingClaimHandler({pairingCodec:codec,directExecStore:{
    async registerHost(value) {
      assert.equal(value.allowRotate,false);assert.equal(value.principal.bridgeUserId,principal.bridgeUserId);
      assert.deepEqual(Object.keys(value).sort(),['allowRotate','enabled','hostId','principal','runnerTokenSha256']);
      assert.equal(hosts.has(value.hostId),false);
      hosts.set(value.hostId,value);return {hostId:value.hostId,enabled:true};
    }
  }});
  const env={OAUTH_KV:{
    async get(key,options) {
      const entry=entries.get(key);if(!entry || entry.expiry<=Date.now()) return null;
      const type=typeof options==='string' ? options : options?.type;
      return type==='json' ? JSON.parse(entry.value) : entry.value;
    },
    async put(key,value,options={}) {entries.set(key,{value,expiry:options.expirationTtl ? Date.now()+options.expirationTtl*1000 : Infinity});},
    async delete(key) {entries.delete(key);},
    async list({prefix=''}={}) {return {keys:[...entries.keys()].filter(key=>key.startsWith(prefix)).map(name=>({name})),list_complete:true,cursor:''};}
  }};
  const ctx={waitUntil:promise=>{background.push(promise);},passThroughOnException(){}};
  const provider=new OAuthProvider({
    apiRoute:'/mcp',authorizeEndpoint:'/authorize',tokenEndpoint:'/oauth/token',clientRegistrationEndpoint:'/oauth/register',
    scopesSupported:['bridge'],resourceMetadata:{resource:endpoint,authorization_servers:[origin],scopes_supported:['bridge'],resource_name:'Bridge'},
    apiHandler:{async fetch(request,_env,context) {
      assert.equal(context.props.bridgePrincipal.bridgeUserId,principal.bridgeUserId);
      const fail=()=>{throw new Error('Unexpected gateway method in host-only login test');};
      const mcp=createBridgeMcpHandler({gateway:{discover:fail,getRun:fail,getResult:fail,publish:fail,
        run:async input=>{assert.deepEqual(input,{mode:'connect'});return pairing.create({principal:context.props.bridgePrincipal});}}});
      try {return await mcp.fetch(request);} finally {await mcp.close();}
    }},
    defaultHandler:{async fetch(request,activeEnv) {
      const url=new URL(request.url);
      if(url.pathname==='/direct/enroll/claim') return claim.fetch(request);
      if(url.pathname!=='/authorize') return new Response('Not found',{status:404});
      // Test consent substitutes only the external account-login interaction.
      const parsed=await activeEnv.OAUTH_PROVIDER.parseAuthRequest(request);
      assert.equal(parsed.codeChallengeMethod,'S256');
      assert.equal(new URL(parsed.redirectUri).hostname,'127.0.0.1');
      const authorized=await activeEnv.OAUTH_PROVIDER.completeAuthorization({
        request:parsed,userId:principal.bridgeUserId,scope:['bridge'],metadata:{clientName:'Bridge Host'},props:{bridgePrincipal:principal}
      });
      return Response.redirect(authorized.redirectTo,302);
    }}
  });
  const fetchImpl=async (input,init={})=>{
    const request=new Request(input,init);
    assert.equal(new URL(request.url).origin,origin);
    requests.push({path:new URL(request.url).pathname,method:request.method,
      body:['POST','PUT'].includes(request.method) ? await request.clone().text() : '',authorization:request.headers.get('authorization')});
    return provider.fetch(request,env,ctx);
  };
  const onAuthorization=async (url,mutate)=>{
    const response=await fetchImpl(url);
    assert.equal(response.status,302);
    const redirect=new URL(response.headers.get('location'));
    assert.equal(redirect.hostname,'127.0.0.1');
    mutate?.(redirect);
    await fetch(redirect,{redirect:'manual'});
  };
  return {fetchImpl,onAuthorization,hosts,requests,entries,background};
}
test('real OAuth provider + SDK PKCE + MCP connect + signed claim persists one local Host',async t=>{
  if(userInfo().uid===0) {t.skip('connect requires an ordinary OS user');return;}
  const f=fixture();const parent=mkdtempSync(join(tmpdir(),'bridge-browser-integration-'));
  const root=ensureHostDirectory(join(parent,'private'));
  t.after(()=>rmSync(parent,{recursive:true,force:true}));
  const options={endpoint,configDir:root,service:false,openBrowser:false,onAuthorization:f.onAuthorization,
    fetchImpl:f.fetchImpl,timeoutMs:5000,doctorImpl:()=>({ok:true})};
  const result=await setupHost(options);
  assert.equal(result.connected,true);assert.equal(f.hosts.size,1);
  const env=readDirectRunnerEnv(join(root,'direct-runner.env'));
  const registration=f.hosts.get(result.hostId);
  assert.equal(registration.runnerTokenSha256,createHash('sha256').update(env.token).digest('hex'));
  assert.equal(JSON.stringify(f.requests).includes(env.token),false);
  assert.equal(JSON.stringify(result).includes('hp1.'),false);
  assert.equal(existsSync(join(root,'.pending-runner.env')),false);
  const count=f.requests.length;
  assert.equal((await setupHost(options)).reused,true);assert.equal(f.requests.length,count);
  assert.equal(f.requests.filter(r=>r.path==='/direct/enroll/claim').length,1);
  assert.ok(f.requests.some(r=>r.path==='/oauth/register'));
  const exchange=f.requests.find(r=>r.path==='/oauth/token');
  assert.ok(new URLSearchParams(exchange.body).get('code_verifier'));
  assert.doesNotMatch(readFileSync(join(root,'host.json'),'utf8'),/access_token|refresh_token|hp1\./);
  await Promise.all(f.background);
});
test('real OAuth callback with wrong issuer never reaches token exchange or MCP',async()=>{
  const f=fixture();
  await assert.rejects(loginForHostPairing({endpoint,fetchImpl:f.fetchImpl,openBrowser:false,timeoutMs:5000,
    onAuthorization:url=>f.onAuthorization(url,redirect=>redirect.searchParams.set('iss','https://attacker.example'))}),
  error=>error.code==='HOST_ISSUER_DENIED');
  assert.equal(f.requests.some(r=>r.path==='/oauth/token'),false);assert.equal(f.hosts.size,0);
});
test('browser denial does not create a Host or print remote error descriptions',async()=>{
  const f=fixture();
  await assert.rejects(loginForHostPairing({endpoint,fetchImpl:f.fetchImpl,openBrowser:false,timeoutMs:5000,
    onAuthorization:url=>f.onAuthorization(url,redirect=>{
      redirect.searchParams.delete('code');redirect.searchParams.set('error','access_denied');
      redirect.searchParams.set('error_description','secret-do-not-print');
    })}),error=>error.code==='HOST_LOGIN_DENIED' && !error.message.includes('secret-do-not-print'));
  assert.equal(f.hosts.size,0);assert.equal(f.requests.some(r=>r.path==='/oauth/token'),false);
});
