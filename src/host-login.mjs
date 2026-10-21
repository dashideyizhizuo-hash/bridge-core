import { auth, Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { BridgeError, assertBridge } from './errors.mjs';
import { hostEndpoint, boundedHostFetch } from './host-http.mjs';
import { createHostCallback, openHostBrowser } from './host-loopback.mjs';
import { HOST_VERSION } from './host-package-spec.mjs';

export async function loginForHostPairing({endpoint,onAuthorization=()=>{},openBrowser=true,
  fetchImpl=globalThis.fetch,timeoutMs=300_000,signal}={}) {
  const bridge=hostEndpoint(endpoint);
  const callback=await createHostCallback({issuer:bridge.origin,timeoutMs});
  const deadline=AbortSignal.any([AbortSignal.timeout(timeoutMs),...(signal ? [signal] : [])]);
  const fetchFn=boundedHostFetch(bridge.href,{fetchImpl,signal:deadline});
  let clientInfo,tokens,verifier,discovery,client;
  const provider={
    redirectUrl:callback.redirectUrl,
    clientMetadata:{client_name:'Bridge Host',redirect_uris:[callback.redirectUrl],
      grant_types:['authorization_code'],response_types:['code'],
      token_endpoint_auth_method:'none',scope:'bridge'},
    state:()=>callback.state,
    clientInformation:()=>clientInfo,
    saveClientInformation:value=>{clientInfo=value;},
    tokens:()=>tokens,
    saveTokens:value=>{tokens=value;},
    saveCodeVerifier:value=>{verifier=value;},
    codeVerifier:()=>{
      assertBridge(typeof verifier==='string','HOST_LOGIN_INVALID','PKCE verifier is unavailable');
      return verifier;
    },
    discoveryState:()=>discovery,
    saveDiscoveryState:value=>{discovery=value;},
    async redirectToAuthorization(url) {
      assertBridge(url.origin===bridge.origin && url.pathname==='/authorize' &&
        url.searchParams.get('state')===callback.state &&
        url.searchParams.get('code_challenge_method')==='S256',
      'HOST_LOGIN_INVALID','Unexpected browser authorization request');
      await onAuthorization(url.href);
      if(openBrowser) await openHostBrowser(url.href);
    }
  };
  const cancel=()=>{void callback.close();};
  deadline.addEventListener('abort',cancel,{once:true});
  try {
    const begun=await auth(provider,{serverUrl:bridge.href,scope:'bridge',fetchFn});
    assertBridge(begun==='REDIRECT','HOST_LOGIN_INVALID','Expected interactive browser authorization');
    const response=await callback.result;
    const completed=await auth(provider,{serverUrl:bridge.href,scope:'bridge',fetchFn,...response});
    assertBridge(completed==='AUTHORIZED' && typeof tokens?.access_token==='string',
      'HOST_LOGIN_INVALID','Browser authorization did not produce an access token');
    client=new Client({name:'bridge-host',version:HOST_VERSION},{capabilities:{}});
    // Do not let a 401 trigger another browser flow or silently change identity.
    const transport=new StreamableHTTPClientTransport(bridge,{
      authProvider:{token:async()=>tokens.access_token},fetch:fetchFn
    });
    await client.connect(transport);
    const reply=await client.callTool({name:'bridge.create_host_pairing',arguments:{}});
    if(reply.isError) {
      const code=reply.structuredContent?.error?.code;
      throw new BridgeError(typeof code==='string'&&/^[A-Z][A-Z0-9_]{2,63}$/.test(code)?code:'HOST_PAIRING_REJECTED',
        'Bridge refused Host pairing. Check account access and service availability; no local identity was created.');
    }
    const receipt=reply.structuredContent;
    const fields={kind:receipt?.kind==='connect',
      hostId:typeof receipt?.hostId==='string' && /^host-[A-Za-z0-9-]{8,123}$/.test(receipt.hostId),
      pairingToken:typeof receipt?.pairingToken==='string' && /^hp1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(receipt.pairingToken) && receipt.pairingToken.length<=1024,
      endpoint:receipt?.endpoint===bridge.href,
      claimUrl:receipt?.claimUrl===new URL('/direct/enroll/claim',bridge).href,
      expiresAt:Number.isSafeInteger(receipt?.expiresAt) && receipt.expiresAt>Date.now()};
    const invalidFields=Object.keys(fields).filter(key=>!fields[key]);
    assertBridge(invalidFields.length===0,'HOST_PAIRING_INVALID',
      'Bridge did not return a valid, unexpired host pairing receipt',{invalidFields});
    return {hostId:receipt.hostId,pairingToken:receipt.pairingToken,endpoint:receipt.endpoint};
  } catch(error) {
    if(error instanceof BridgeError) throw error;
    const failure=new BridgeError('HOST_LOGIN_FAILED',
      'Bridge browser login failed. Check account authorization and service availability, then retry.');
    // Preserve diagnostics for debuggers without printing token-bearing remote text.
    failure.cause=error;
    throw failure;
  } finally {
    deadline.removeEventListener('abort',cancel);
    try { await client?.close(); }
    finally {
      await callback.close();
      clientInfo=tokens=verifier=discovery=undefined;
    }
  }
}
