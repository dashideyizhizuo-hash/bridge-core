import { assertBridge, BridgeError } from '../errors.mjs';

// Bound while consuming, not after request.text()/arrayBuffer() has allocated
// an attacker-controlled body. Both declared and chunked lengths are checked.
export async function readBoundedBody(request,{maxBytes,code,message='request body exceeds limit',signal}) {
  assertBridge(Number.isSafeInteger(maxBytes) && maxBytes>0,code,'invalid request body limit');
  const declared=request.headers.get('content-length');
  if(declared!==null && (!/^[0-9]+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared)>maxBytes)) {
    await request.body?.cancel().catch(()=>{});
    throw new BridgeError(code,message);
  }
  if(!request.body) return new Uint8Array();
  if(signal?.aborted) {
    await request.body.cancel(signal.reason).catch(()=>{});
    signal.throwIfAborted();
  }
  const reader=request.body.getReader();
  let cancellation;
  const abort=()=>{cancellation=reader.cancel(signal.reason).catch(()=>{});};
  signal?.addEventListener('abort',abort,{once:true});
  const read=async()=>{signal?.throwIfAborted();const result=await reader.read();signal?.throwIfAborted();return result;};
  const finish=async()=>{signal?.removeEventListener('abort',abort);await cancellation;reader.releaseLock();};
  const declaredSize=declared===null ? null : Number(declared);
  if(declaredSize!==null) {
    const bytes=new Uint8Array(declaredSize);let offset=0;
    try {
      while(true) {
        const {value,done}=await read();
        if(done) break;
        assertBridge(offset+value.byteLength<=declaredSize,code,message);
        bytes.set(value,offset);offset+=value.byteLength;
      }
      assertBridge(offset===declaredSize,code,message);
      return bytes;
    } catch(error) {
      await reader.cancel().catch(()=>{});
      throw error;
    } finally {await finish();}
  }
  const chunks=[];let size=0;
  try {
    while(true) {
      const {value,done}=await read();
      if(done) break;
      size+=value.byteLength;
      assertBridge(size<=maxBytes,code,message);
      chunks.push(value);
    }
  } catch(error) {
    await reader.cancel().catch(()=>{});
    throw error;
  } finally {await finish();}
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return bytes;
}

export async function readBoundedText(request,options) {
  return new TextDecoder().decode(await readBoundedBody(request,options));
}
