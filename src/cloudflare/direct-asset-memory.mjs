import { BridgeError } from '../errors.mjs';

let bufferedOperationActive=false;
export const DIRECT_ASSET_BUFFER_TIMEOUT_MS=60_000;

// A deadline aborts IO. It never unlocks memory while an operation still owns
// bytes: the operation must unwind, or the response consumer must cancel first.
export async function withDirectAssetBufferSlot(operation,{retain,timeoutMs=DIRECT_ASSET_BUFFER_TIMEOUT_MS,signal}={}) {
  if(typeof operation!=='function') throw new TypeError('operation is required');
  if(bufferedOperationActive) throw new BridgeError('DIRECT_ASSET_BUSY',
    'Direct Asset memory capacity is busy; retry this transfer shortly',{retryAfterSeconds:1});
  bufferedOperationActive=true;
  const controller=new AbortController();
  const operationSignal=signal ? AbortSignal.any([signal,controller.signal]) : controller.signal;
  const timer=setTimeout(()=>controller.abort(new BridgeError('DIRECT_ASSET_TIMEOUT','File transfer timed out')),timeoutMs);
  timer.unref?.();
  let released=false,retained=false;
  const release=()=>{if(!released){released=true;clearTimeout(timer);bufferedOperationActive=false;}};
  try {
    const result=await operation(operationSignal);
    operationSignal.throwIfAborted();
    if(retain){retain({release,signal:operationSignal});retained=true;}
    return result;
  } finally {if(!retained)release();}
}
