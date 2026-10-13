import { homedir, userInfo } from 'node:os';
import { accessSync, constants, existsSync, lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { validateHostPolicy } from './validate.mjs';
import { readJsonFile } from './json.mjs';

function baseFromPattern(pattern) {
  const star = pattern.indexOf('*');
  const prefix = star === -1 ? pattern : pattern.slice(0, star);
  return prefix.replace(/\/$/, '');
}
function contained(root, candidate) { return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : root + sep); }
function checkAccess(findings, { repo, name, root, pattern, mode }) {
  const base = baseFromPattern(pattern);
  const candidate = base ? resolve(root, base) : root;
  if (!contained(root, candidate)) return findings.push({ level:'error', code:'RESOURCE_PATTERN_ESCAPE', repository:repo, resource:name, pattern });
  if (!existsSync(candidate)) return findings.push({ level:'error', code:'RESOURCE_PATH_MISSING', repository:repo, resource:name, pattern, path:candidate });
  try {
    const real = realpathSync(candidate);
    if (!contained(root, real)) return findings.push({ level:'error', code:'RESOURCE_SYMLINK_ESCAPE', repository:repo, resource:name, pattern, path:candidate, real });
    accessSync(real, mode === 'write' ? constants.W_OK : constants.R_OK);
    findings.push({ level:'info', code:mode === 'write' ? 'RESOURCE_WRITE_OK' : 'RESOURCE_READ_OK', repository:repo, resource:name, pattern, path:real });
  } catch (error) { findings.push({ level:'error', code:mode === 'write' ? 'RESOURCE_WRITE_DENIED' : 'RESOURCE_READ_DENIED', repository:repo, resource:name, pattern, path:candidate, message:error.message }); }
}


function checkDirectDirectory(findings,{codePrefix,path,write=false}) {
  const candidate=resolve(path);
  if(!existsSync(candidate)) {
    findings.push({level:'warn',code:`${codePrefix}_MISSING`,path:candidate});
    return;
  }
  try {
    const real=realpathSync(candidate);
    if(!statSync(real).isDirectory()) {
      findings.push({level:'error',code:`${codePrefix}_NOT_DIRECTORY`,path:candidate});
      return;
    }
    accessSync(real,constants.R_OK|constants.X_OK|(write ? constants.W_OK : 0));
    findings.push({level:'info',code:`${codePrefix}_OK`,path:real});
  } catch(error) {
    findings.push({
      level:'error',
      code:`${codePrefix}_DENIED`,
      path:candidate,
      message:error.message
    });
  }
}

function checkDirectRuntime(findings,policy) {
  const direct=policy.directExec;
  if(direct?.enabled!==true) return;

  const actualUser=userInfo().username;
  if(actualUser!==direct.serviceUser) {
    findings.push({
      level:'warn',
      code:'DIRECT_EXEC_SERVICE_USER_NOT_ACTIVE',
      expected:direct.serviceUser,
      actual:actualUser
    });
  } else {
    findings.push({
      level:'info',
      code:'DIRECT_EXEC_SERVICE_USER_OK',
      user:actualUser
    });
  }

  checkDirectDirectory(findings,{
    codePrefix:'DIRECT_EXEC_ROOT',
    path:direct.root ?? homedir(),
    write:false
  });
  checkDirectDirectory(findings,{
    codePrefix:'DIRECT_EXEC_STATE_DIR',
    path:direct.stateDir ?? resolve(homedir(),'.local','state','bridge','direct-exec'),
    write:true
  });
  if(direct.assetDir!==undefined) {
    checkDirectDirectory(findings,{
      codePrefix:'DIRECT_EXEC_ASSET_DIR',
      path:direct.assetDir,
      write:true
    });
  }

  const ptracePath='/proc/sys/kernel/yama/ptrace_scope';
  if(existsSync(ptracePath)) {
    try {
      const value=Number(readFileSync(ptracePath,'utf8').trim());
      findings.push(
        Number.isInteger(value) && value>=1
          ? {level:'info',code:'DIRECT_EXEC_PTRACE_HARDENED',value}
          : {level:'error',code:'DIRECT_EXEC_PTRACE_UNSAFE',value}
      );
    } catch(error) {
      findings.push({
        level:'warn',
        code:'DIRECT_EXEC_PTRACE_UNKNOWN',
        message:error.message
      });
    }
  }
}

export function doctor({ hostPolicyPath, repository = undefined }) {
  const policy = validateHostPolicy(readJsonFile(hostPolicyPath, 'host policy'));
  const findings = [];
  checkDirectRuntime(findings,policy);
  const repos = repository ? [[repository, policy.repositories[repository]]] : Object.entries(policy.repositories);
  for (const [repo, entry] of repos) {
    if (!entry) { findings.push({ level:'error', code:'REPOSITORY_NOT_GRANTED', repository:repo }); continue; }

    if (entry.workspaceExec?.enabled) {
      const actualUser = userInfo().username;
      if (actualUser !== entry.workspaceExec.serviceUser) {
        findings.push({
          level: 'warn',
          code: 'WORKSPACE_EXEC_SERVICE_USER_NOT_ACTIVE',
          repository: repo,
          expected: entry.workspaceExec.serviceUser,
          actual: actualUser
        });
      } else {
        findings.push({ level: 'info', code: 'WORKSPACE_EXEC_SERVICE_USER_OK', repository: repo, user: actualUser });
        for (const deniedRoot of entry.workspaceExec.deniedRoots ?? []) {
          if (!existsSync(deniedRoot)) {
            findings.push({ level: 'info', code: 'WORKSPACE_EXEC_DENIED_ROOT_ABSENT', repository: repo, path: deniedRoot });
            continue;
          }
          try {
            accessSync(deniedRoot, constants.R_OK);
            findings.push({ level: 'error', code: 'WORKSPACE_EXEC_DENIED_ROOT_READABLE', repository: repo, path: deniedRoot });
          } catch {
            findings.push({ level: 'info', code: 'WORKSPACE_EXEC_DENIED_ROOT_OK', repository: repo, path: deniedRoot });
          }
        }
      }
    }
    for (const [name, resource] of Object.entries(entry.resources ?? {})) {
      try {
        const real = realpathSync(resource.root); const st = statSync(real);
        if (!st.isDirectory()) { findings.push({ level:'error', code:'RESOURCE_NOT_DIRECTORY', repository:repo, resource:name, root:resource.root }); continue; }
        if (lstatSync(resource.root).isSymbolicLink()) findings.push({ level:'warn', code:'RESOURCE_ROOT_SYMLINK', repository:repo, resource:name, root:resource.root, real });
        findings.push({ level:'info', code:'RESOURCE_OK', repository:repo, resource:name, root:resource.root, real });
        for (const pattern of resource.read ?? []) checkAccess(findings,{repo,name,root:real,pattern,mode:'read'});
        for (const pattern of resource.write ?? []) checkAccess(findings,{repo,name,root:real,pattern,mode:'write'});
      } catch (error) { findings.push({ level:'error', code:'RESOURCE_UNAVAILABLE', repository:repo, resource:name, root:resource.root, message:error.message }); }
    }
  }
  return { ok: !findings.some(x=>x.level==='error'), hostId: policy.host.id, findings };
}
