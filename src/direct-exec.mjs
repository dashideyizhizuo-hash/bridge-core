import { homedir, userInfo } from 'node:os';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { assertBridge, BridgeError } from './errors.mjs';
import { sanitizedExecutionEnv } from './environment.mjs';
import { runBounded } from './execute.mjs';
import { validateHostPolicy } from './validate.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function contained(root, candidate) {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep);
}

function safeRelativePath(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 1024
    && !isAbsolute(value)
    && !value.includes('\\')
    && !value.includes('\0')
    && !value.split('/').includes('..');
}

function validateAssets(value) {
  if(value===undefined) return [];
  assertBridge(
    Array.isArray(value) && value.length>=1 && value.length<=8,
    'DIRECT_EXEC_INVALID',
    'direct exec assets must contain 1-8 entries'
  );
  const ids=new Set();
  return value.map((asset,index)=>{
    assertBridge(
      asset && typeof asset==='object' && !Array.isArray(asset),
      'DIRECT_EXEC_INVALID',
      `direct exec asset ${index} must be an object`
    );
    const allowed=new Set(['assetId','fileName','mimeType','sizeBytes','sha256']);
    for(const key of Object.keys(asset)) {
      assertBridge(allowed.has(key),'DIRECT_EXEC_INVALID',`unknown direct exec asset field: ${key}`);
    }
    assertBridge(
      typeof asset.assetId==='string' && /^asset-[A-Za-z0-9_-]{8,160}$/.test(asset.assetId),
      'DIRECT_EXEC_INVALID',
      `direct exec asset ${index} assetId invalid`
    );
    assertBridge(!ids.has(asset.assetId),'DIRECT_EXEC_INVALID','direct exec asset ids must be unique');
    ids.add(asset.assetId);
    assertBridge(
      typeof asset.fileName==='string' && asset.fileName.length>0 &&
        Buffer.byteLength(asset.fileName,'utf8')<=255 &&
        !asset.fileName.includes('/') && !asset.fileName.includes('\\') && !asset.fileName.includes('\0'),
      'DIRECT_EXEC_INVALID',
      `direct exec asset ${index} fileName invalid`
    );
    assertBridge(
      typeof asset.mimeType==='string' && asset.mimeType.length>0 && asset.mimeType.length<=192,
      'DIRECT_EXEC_INVALID',
      `direct exec asset ${index} mimeType invalid`
    );
    assertBridge(
      Number.isInteger(asset.sizeBytes) && asset.sizeBytes>0 && asset.sizeBytes<=25*1024*1024,
      'DIRECT_EXEC_INVALID',
      `direct exec asset ${index} sizeBytes invalid`
    );
    assertBridge(
      typeof asset.sha256==='string' && /^[0-9a-f]{64}$/.test(asset.sha256),
      'DIRECT_EXEC_INVALID',
      `direct exec asset ${index} sha256 invalid`
    );
    return {...asset};
  });
}

function validateExports(value) {
  if(value===undefined) return [];
  assertBridge(
    Array.isArray(value) && value.length>=1 && value.length<=8,
    'DIRECT_EXEC_INVALID',
    'direct exec exports must contain 1-8 entries'
  );
  return value.map((item,index)=>{
    assertBridge(
      item && typeof item==='object' && !Array.isArray(item),
      'DIRECT_EXEC_INVALID',
      `direct exec export ${index} must be an object`
    );
    const allowed=new Set(['fileName','mimeType','maxBytes','required']);
    for(const key of Object.keys(item)) {
      assertBridge(allowed.has(key),'DIRECT_EXEC_INVALID',`unknown direct exec export field: ${key}`);
    }
    assertBridge(
      typeof item.fileName==='string' && item.fileName.length>0 &&
        Buffer.byteLength(item.fileName,'utf8')<=255 &&
        !item.fileName.includes('/') && !item.fileName.includes('\\') && !item.fileName.includes('\0'),
      'DIRECT_EXEC_INVALID',
      `direct exec export ${index} fileName invalid`
    );
    assertBridge(
      typeof item.mimeType==='string' &&
        /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,127}$/.test(item.mimeType),
      'DIRECT_EXEC_INVALID',
      `direct exec export ${index} mimeType invalid`
    );
    const maxBytes=item.maxBytes ?? 25*1024*1024;
    assertBridge(
      Number.isInteger(maxBytes) && maxBytes>0 && maxBytes<=25*1024*1024,
      'DIRECT_EXEC_INVALID',
      `direct exec export ${index} maxBytes invalid`
    );
    assertBridge(
      item.required===undefined || typeof item.required==='boolean',
      'DIRECT_EXEC_INVALID',
      `direct exec export ${index} required invalid`
    );
    return {
      fileName:item.fileName,
      mimeType:item.mimeType.toLowerCase(),
      maxBytes,
      required:item.required ?? true
    };
  });
}

function materializeAssetArgv(argv,assets,assetPaths) {
  if(assets.length===0) {
    assertBridge(
      assetPaths===undefined || assetPaths===null || assetPaths.length===0,
      'DIRECT_EXEC_INVALID',
      'asset paths supplied without request assets'
    );
    return [...argv];
  }
  assertBridge(
    Array.isArray(assetPaths) && assetPaths.length===assets.length,
    'DIRECT_ASSET_MISSING',
    'staged asset paths do not match Direct request assets'
  );
  return argv.map(arg=>{
    const match=/^\{asset:(\d+)\}$/.exec(arg);
    if(!match) return arg;
    const index=Number(match[1]);
    assertBridge(
      Number.isInteger(index) && index>=0 && index<assetPaths.length,
      'DIRECT_ASSET_MISSING',
      `asset placeholder index out of range: ${arg}`
    );
    return assetPaths[index];
  });
}

function materializeExportArgv(argv,exports,exportPaths) {
  if(exports.length===0) {
    assertBridge(
      exportPaths===undefined || exportPaths===null || exportPaths.length===0,
      'DIRECT_EXEC_INVALID',
      'export paths supplied without request exports'
    );
    return [...argv];
  }
  assertBridge(
    Array.isArray(exportPaths) && exportPaths.length===exports.length,
    'DIRECT_EXPORT_MISSING',
    'prepared export paths do not match Direct request exports'
  );
  return argv.map(arg=>{
    const match=/^\{export:(\d+)\}$/.exec(arg);
    if(!match) return arg;
    const index=Number(match[1]);
    assertBridge(
      Number.isInteger(index) && index>=0 && index<exportPaths.length,
      'DIRECT_EXPORT_MISSING',
      `export placeholder index out of range: ${arg}`
    );
    return exportPaths[index];
  });
}

export function validateDirectExecRequest(request) {
  assertBridge(isObject(request), 'DIRECT_EXEC_INVALID', 'direct exec request must be an object');
  const allowed = new Set(['schemaVersion','requestId','hostId','argv','cwd','timeoutSeconds','assets','exports']);
  for (const key of Object.keys(request)) {
    assertBridge(allowed.has(key), 'DIRECT_EXEC_INVALID', `unknown direct exec field: ${key}`);
  }
  assertBridge(request.schemaVersion === 1, 'DIRECT_EXEC_INVALID', 'direct exec schemaVersion must equal 1');
  assertBridge(
    typeof request.requestId === 'string' && /^[A-Za-z0-9._-]{8,160}$/.test(request.requestId),
    'DIRECT_EXEC_INVALID',
    'direct exec requestId is invalid'
  );
  assertBridge(
    typeof request.hostId === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(request.hostId),
    'DIRECT_EXEC_INVALID',
    'direct exec hostId is invalid'
  );
  assertBridge(
    Array.isArray(request.argv) && request.argv.length > 0 && request.argv.length <= 64,
    'DIRECT_EXEC_INVALID',
    'direct exec argv must contain 1-64 elements'
  );
  for (const arg of request.argv) {
    assertBridge(
      typeof arg === 'string' && arg.length > 0 && arg.length <= 8192 && !arg.includes('\0'),
      'DIRECT_EXEC_INVALID',
      'direct exec argv must contain bounded non-empty strings'
    );
  }
  const argvBytes = Buffer.byteLength(JSON.stringify(request.argv), 'utf8');
  assertBridge(argvBytes <= 65536, 'DIRECT_EXEC_INVALID', 'direct exec argv exceeds byte limit');
  if (request.cwd !== undefined) {
    assertBridge(safeRelativePath(request.cwd), 'DIRECT_EXEC_INVALID', 'direct exec cwd must be a safe relative path');
  }
  if (request.timeoutSeconds !== undefined) {
    assertBridge(
      Number.isInteger(request.timeoutSeconds) && request.timeoutSeconds > 0 && request.timeoutSeconds <= 3600,
      'DIRECT_EXEC_INVALID',
      'direct exec timeoutSeconds invalid'
    );
  }
  const assets=validateAssets(request.assets);
  const exports=validateExports(request.exports);
  return {
    ...request,
    ...(assets.length===0 ? {} : {assets}),
    ...(exports.length===0 ? {} : {exports})
  };
}

export function resolveDirectExecPlan({ request, hostPolicy, defaultRoot = homedir() }) {
  const validatedRequest = validateDirectExecRequest(request);
  const validatedHost = validateHostPolicy(hostPolicy);
  const policy = validatedHost.directExec;
  assertBridge(policy?.enabled === true, 'DIRECT_EXEC_DENIED', 'direct exec is not enabled by host policy');
  assertBridge(
    validatedRequest.hostId === validatedHost.host.id,
    'DIRECT_EXEC_DENIED',
    'direct exec host identity mismatch'
  );

  const actualUser = userInfo().username;
  assertBridge(
    policy.serviceUser === actualUser,
    'DIRECT_EXEC_DENIED',
    `direct exec requires service user ${policy.serviceUser}, actual user is ${actualUser}`
  );

  const maxArgv = policy.maxArgv ?? 64;
  assertBridge(validatedRequest.argv.length <= maxArgv, 'DIRECT_EXEC_DENIED', 'direct exec argv exceeds host limit');

  const configuredRoot = policy.root ?? defaultRoot;
  let root;
  try {
    root = realpathSync(resolve(configuredRoot));
  } catch (error) {
    throw new BridgeError('DIRECT_EXEC_DENIED', 'direct exec root is unavailable', { cause: error.message });
  }
  assertBridge(statSync(root).isDirectory(), 'DIRECT_EXEC_DENIED', 'direct exec root must be a directory');

  const requestedCwd = resolve(root, validatedRequest.cwd ?? '.');
  assertBridge(contained(root, requestedCwd), 'DIRECT_EXEC_DENIED', 'direct exec cwd escaped configured root');

  let cwd;
  try {
    cwd = realpathSync(requestedCwd);
  } catch (error) {
    throw new BridgeError('DIRECT_EXEC_DENIED', 'direct exec cwd is unavailable', { cause: error.message });
  }
  assertBridge(contained(root, cwd) && statSync(cwd).isDirectory(), 'DIRECT_EXEC_DENIED', 'direct exec cwd must remain inside configured root');

  return {
    request: validatedRequest,
    hostId: validatedHost.host.id,
    serviceUser: actualUser,
    root,
    cwd,
    argv: [...validatedRequest.argv],
    limits: {
      timeoutSeconds: Math.min(policy.maxSeconds ?? 900, validatedRequest.timeoutSeconds ?? policy.maxSeconds ?? 900),
      stdoutBytes: policy.stdoutBytes ?? 524288,
      stderrBytes: policy.stderrBytes ?? 262144,
      resultBytes: policy.resultBytes ?? 1048576
    }
  };
}

export async function executeDirectExec({
  request,
  requestBytes = null,
  hostPolicy,
  defaultRoot,
  signal = null,
  assetPaths = [],
  exportPaths = []
}) {
  const startedAt = new Date().toISOString();
  const plan = resolveDirectExecPlan({ request, hostPolicy, defaultRoot });
  const assets=plan.request.assets ?? [];
  const exports=plan.request.exports ?? [];
  let argv=materializeAssetArgv(plan.argv,assets,assetPaths);
  argv=materializeExportArgv(argv,exports,exportPaths);
  const assetEnv={};
  for(let index=0;index<assetPaths.length;index++) {
    assetEnv[`BRIDGE_ASSET_${index}`]=assetPaths[index];
  }
  const exportEnv={};
  for(let index=0;index<exportPaths.length;index++) {
    exportEnv[`BRIDGE_EXPORT_${index}`]=exportPaths[index];
  }
  const env = sanitizedExecutionEnv({
    BRIDGE_DIRECT_EXEC: '1',
    BRIDGE_REQUEST_ID: plan.request.requestId,
    BRIDGE_HOST_ID: plan.hostId,
    BRIDGE_ASSET_COUNT:String(assetPaths.length),
    BRIDGE_EXPORT_COUNT:String(exportPaths.length),
    ...assetEnv,
    ...exportEnv
  });
  let execution, executionError;
  try { execution = await runBounded({
    cwd: plan.cwd,
    argv,
    env,
    timeoutSeconds: plan.limits.timeoutSeconds,
    stdoutBytes: plan.limits.stdoutBytes,
    stderrBytes: plan.limits.stderrBytes,
    outputBudgetBytes: plan.limits.resultBytes,
    ...(signal === null ? {} : {signal})
  }); } catch(error) {
    // Retain bounded partial execution evidence for failed native commands.
    if(!(error instanceof BridgeError) || typeof error.details?.stdout!=='string' ||
      typeof error.details?.stderr!=='string') throw error;
    executionError=error;
    execution=error.details;
  }

  const result = {
    schemaVersion: 1,
    transport: 'direct',
    requestId: plan.request.requestId,
    status: !executionError && execution.exitCode === 0 ? 'SUCCEEDED' : 'FAILED',
    hostId: plan.hostId,
    requestSha256: hash(requestBytes ?? Buffer.from(JSON.stringify(plan.request), 'utf8')),
    execution: {
      exitCode: execution.exitCode,
      signal: execution.signal,
      durationMs: execution.durationMs,
      stdoutBytes: execution.stdoutBytes,
      stderrBytes: execution.stderrBytes
    },
    evidence: {
      stdout: execution.stdout,
      stderr: execution.stderr
    },
    startedAt,
    completedAt: new Date().toISOString()
  };
  if(executionError) {
    const wrapped=new BridgeError(executionError.code,executionError.message,result);
    wrapped.cause=executionError;
    throw wrapped;
  }
  if (execution.exitCode !== 0) {
    throw new BridgeError(
      'EXECUTION_FAILED',
      `direct exec exited with status ${execution.exitCode}`,
      result
    );
  }
  return result;
}
