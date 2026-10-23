import { spawn } from 'node:child_process';
import { isUtf8 } from 'node:buffer';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { BridgeError } from './errors.mjs';

function decodeOutput(bytes, allowTruncatedTail) {
  if (isUtf8(bytes)) return { text: bytes.toString('utf8'), valid: true };
  // Limits may split the last code point. Preserve only a valid prefix; never
  // guess a locale encoding or silently insert replacement characters.
  if (allowTruncatedTail) {
    for (let trim = 1; trim <= Math.min(3, bytes.length); trim++) {
      const prefix = bytes.subarray(0, bytes.length - trim);
      if (isUtf8(prefix)) return { text: prefix.toString('utf8'), valid: false };
    }
  }
  return { text: '', valid: false };
}

export async function runBounded({
  cwd,
  argv,
  env,
  timeoutSeconds,
  stdoutBytes,
  stderrBytes,
  outputBudgetBytes,
  signal:abortSignal,
  onProgress
}) {
  if(abortSignal?.aborted) throw new BridgeError('EXECUTION_CANCELED','Execution canceled before spawn');
  return await new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0), exceeded = null, timedOut = false, aborted = false;
    let started=null,startedAt=null,observerError=null;
    const grouped = process.platform !== 'win32';
    const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: grouped, windowsHide:true, stdio: ['ignore','pipe','pipe'] });
    let escalation;
    const sendSignal = value => {
      try { if (grouped && child.pid) process.kill(-child.pid, value); else child.kill(value); } catch {}
    };
    let windowsStopping=false;
    const stop = () => {
      if(!grouped && child.pid) {
        if(windowsStopping) return;
        windowsStopping=true;
        // taskkill /T terminates active descendants as well as the direct child.
        // Never use a shell or an image-name-wide kill.
        const killer=spawn(join(process.env.SystemRoot || 'C:\\Windows','System32','taskkill.exe'),
          ['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:8000});
        killer.once('error',()=>sendSignal('SIGKILL'));
        killer.once('close',()=>sendSignal('SIGKILL'));
        return;
      }
      sendSignal('SIGTERM');
      if (!escalation) escalation = setTimeout(() => sendSignal('SIGKILL'), 2000);
    };
    const onAbort = () => {
      aborted = true;
      stop();
    };
    if (abortSignal?.aborted) onAbort();
    else abortSignal?.addEventListener?.('abort', onAbort, { once: true });

    const report=progress=>{
      try {onProgress?.(progress);} catch(error) {observerError=error;stop();}
    };
    child.once('spawn',()=>{
      // Successful OS spawn, not plan resolution, claim or file preparation,
      // starts process-duration evidence and the synchronous execution wait.
      started=performance.now();startedAt=new Date().toISOString();
      report({phase:'EXECUTING',executionElapsedMs:0});
    });
    // Preserve the caller's existing hard execution/batch deadline. It is
    // independent of the newly reported synchronous wait duration.
    const timer=setTimeout(()=>{timedOut=true;stop();},timeoutSeconds*1000);
    const cleanup = () => {
      clearTimeout(timer);
      clearTimeout(escalation);
      abortSignal?.removeEventListener?.('abort', onAbort);
      sendSignal('SIGKILL');
    };
    const collect = (which, chunk, limit) => {
      if (exceeded) return;
      const current = which === 'stdout' ? stdout : stderr;
      let next = Buffer.concat([current, chunk.subarray(0, Math.max(0, limit - current.length))]);
      if (current.length + chunk.length > limit) exceeded = which;
      if (outputBudgetBytes !== undefined) {
        const wireBytes = value => Buffer.byteLength(JSON.stringify({
          stdout: (which === 'stdout' ? value : stdout).toString('utf8'),
          stderr: (which === 'stderr' ? value : stderr).toString('utf8')
        }), 'utf8');
        if (wireBytes(next) > outputBudgetBytes) {
          let low = 0, high = next.length;
          while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (wireBytes(next.subarray(0, middle)) <= outputBudgetBytes) low = middle;
            else high = middle - 1;
          }
          next = next.subarray(0, low);
          exceeded = 'combined output';
        }
      }
      if (which === 'stdout') stdout = next; else stderr = next;
      if (exceeded) stop();
    };
    child.stdout.on('data', chunk => collect('stdout', chunk, stdoutBytes));
    child.stderr.on('data', chunk => collect('stderr', chunk, stderrBytes));
    child.on('error', error => {
      cleanup();
      reject(new BridgeError('EXECUTION_FAILED', `failed to spawn ${argv[0]}`, { cause: error.message }));
    });
    child.on('close', (code, childSignal) => {
      cleanup();
      const durationMs=started===null ? 0 : Math.max(0,Math.round(performance.now()-started));
      const completedAt=new Date().toISOString();
      // Wait for bounded close and group cleanup, including descendant-owned
      // output streams, before declaring that command execution has ended.
      if(started!==null) report({phase:'RETURNING_RESULT',executionElapsedMs:durationMs});
      const decodedStdout = decodeOutput(stdout, Boolean(exceeded));
      const decodedStderr = decodeOutput(stderr, Boolean(exceeded));
      const result = {
        exitCode: code,
        signal: childSignal,
        durationMs,
        startedAt,
        completedAt,
        stdout: decodedStdout.text,
        stderr: decodedStderr.text,
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length
      };
      if(observerError) return reject(observerError);
      if (exceeded) return reject(new BridgeError('OUTPUT_LIMIT_EXCEEDED', `${exceeded} exceeded configured limit`, result));
      if (timedOut) return reject(new BridgeError('EXECUTION_TIMEOUT', `capability exceeded ${timeoutSeconds}s timeout`, result));
      if (aborted) return reject(new BridgeError('EXECUTION_CANCELED', 'execution canceled by Bridge control plane', result));
      if (!decodedStdout.valid || !decodedStderr.valid) {
        const streams = [!decodedStdout.valid && 'stdout', !decodedStderr.valid && 'stderr'].filter(Boolean).join(' and ');
        return reject(new BridgeError('OUTPUT_ENCODING_INVALID', `${streams} must be UTF-8; configure the child process to emit UTF-8 or export binary output as a file. Invalid stream text was omitted.`, result));
      }
      resolve(result);
    });
  });
}
