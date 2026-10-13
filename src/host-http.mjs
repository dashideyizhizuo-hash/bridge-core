import { BridgeError, assertBridge } from './errors.mjs';

export function hostEndpoint(value) {
  let url;
  try { url=new URL(value); }
  catch { throw new BridgeError('HOST_ENDPOINT_INVALID','Bridge endpoint must be an absolute HTTPS /mcp URL'); }
  assertBridge(url.protocol==='https:' && !url.username && !url.password &&
    !url.search && !url.hash && url.pathname==='/mcp',
  'HOST_ENDPOINT_INVALID','Bridge endpoint must be a clean HTTPS /mcp URL');
  return url;
}

// Pin discovery, registration, token exchange, MCP and claim to the selected
// Bridge origin. Neither redirects nor remote metadata can move credentials.
// Buffer bounded replies because the SDK also consumes response bodies itself.
export function boundedHostFetch(endpoint,options={}) {
  return boundedOriginFetch(hostEndpoint(endpoint).origin,options);
}

// Shared by every Runner entrypoint. Loopback HTTP is reserved for local
// development; production login still requires hostEndpoint's clean HTTPS URL.
export function boundedOriginFetch(value,{
  fetchImpl=globalThis.fetch,signal,timeoutMs=15_000,maxBytes=1_048_576
}={}) {
  const base=new URL(value);
  assertBridge(!base.username && !base.password && !base.search && !base.hash &&
    (base.protocol==='https:' || (base.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(base.hostname))),
    'HOST_ENDPOINT_INVALID','Bridge transport requires HTTPS or local loopback HTTP');
  assertBridge(Number.isInteger(timeoutMs) && timeoutMs>0 && timeoutMs<=300_000 &&
    Number.isInteger(maxBytes) && maxBytes>0 && maxBytes<=32*1024*1024,
    'HOST_LIMIT_INVALID','Bridge transport limits must be positive bounded integers');
  const origin=base.origin;
  return async (input,init={})=>{
    const url=new URL(input instanceof Request ? input.url : input);
    assertBridge(url.origin===origin && !url.username && !url.password && !url.hash,
      'HOST_ORIGIN_DENIED','Bridge transport may only contact the selected origin');
    const signals=[signal,init.signal,input instanceof Request ? input.signal : undefined,
      AbortSignal.timeout(timeoutMs)].filter(Boolean);
    try {
      const response=await fetchImpl(input,{...init,redirect:'manual',signal:AbortSignal.any(signals)});
      if(response.status>=300 && response.status<400) await response.body?.cancel();
      assertBridge(response.status<300 || response.status>=400,
        'HOST_REDIRECT_DENIED','Bridge returned an unexpected HTTP redirect');
      const declared=response.headers.get('content-length');
      if(declared!==null && (!/^\d+$/.test(declared) || Number(declared)>maxBytes)) await response.body?.cancel();
      if(declared!==null) assertBridge(/^\d+$/.test(declared) && Number(declared)<=maxBytes,
        'HOST_RESPONSE_TOO_LARGE','Bridge response exceeds the size limit');
      const chunks=[];
      let size=0;
      if(response.body) {
        const reader=response.body.getReader();
        try {
          while(true) {
            const {value,done}=await reader.read();
            if(done) break;
            size+=value.byteLength;
            assertBridge(size<=maxBytes,'HOST_RESPONSE_TOO_LARGE','Bridge response exceeds the size limit');
            chunks.push(value);
          }
        } catch(error) {
          await reader.cancel().catch(()=>{});
          throw error;
        } finally { reader.releaseLock(); }
      }
      const result=new Response([204,205,304].includes(response.status) ? null : Buffer.concat(chunks),{
        status:response.status,statusText:response.statusText,headers:response.headers
      });
      Object.defineProperty(result,'url',{value:response.url || url.href});
      return result;
    } catch(error) {
      if(error instanceof BridgeError) throw error;
      const wrapped=new BridgeError('HOST_NETWORK_FAILED',
        'Bridge request failed or timed out; account credentials were not printed or persisted');
      wrapped.cause=error;
      throw wrapped;
    }
  };
}
