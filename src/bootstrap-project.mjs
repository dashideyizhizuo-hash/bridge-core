import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertBridge, BridgeError } from './errors.mjs';
import { validateHostPolicy, validateProjectPolicy } from './validate.mjs';

const SHA=/^[0-9a-f]{40}$/;
const REPO=/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CLASS=/^[A-Za-z0-9_.-]+$/;

function bridgeRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)),'..');
}

function git(cwd,args,label) {
  try {
    return execFileSync('git',['-C',cwd,...args],{encoding:'utf8'}).trim();
  } catch(error) {
    throw new BridgeError('BOOTSTRAP_INVALID',`${label} failed`,{
      cause:String(error?.stderr ?? error?.message ?? error).slice(0,1000)
    });
  }
}

function deriveRepository(repoPath) {
  const remote=git(repoPath,['remote','get-url','origin'],'origin lookup');
  const patterns=[
    /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/,
    /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/,
    /^ssh:\/\/git@github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/
  ];
  for(const pattern of patterns) {
    const match=pattern.exec(remote);
    if(match && REPO.test(match[1])) return match[1];
  }
  throw new BridgeError('BOOTSTRAP_INVALID','unable to derive GitHub owner/repo from origin');
}

function resolveBridgeSha(value) {
  if(value && value!=='current') {
    assertBridge(SHA.test(value),'BOOTSTRAP_INVALID','bridge SHA must be lowercase 40-hex');
    return value;
  }
  const sha=git(bridgeRoot(),['rev-parse','HEAD'],'Bridge HEAD lookup');
  assertBridge(SHA.test(sha),'BOOTSTRAP_INVALID','Bridge checkout HEAD is invalid');
  return sha;
}

function verifyArgv(value) {
  assertBridge(Array.isArray(value) && value.length>0 && value.length<=64,'BOOTSTRAP_INVALID','verify argv must contain 1-64 items');
  for(const arg of value) {
    assertBridge(typeof arg==='string' && arg.length>0 && arg.length<=4096 && !arg.includes('\0'),'BOOTSTRAP_INVALID','verify argv contains invalid argument');
  }
  return [...value];
}

function atomicWrite(path,content) {
  mkdirSync(dirname(path),{recursive:true});
  const temp=`${path}.bridge-bootstrap-${process.pid}`;
  writeFileSync(temp,content,{encoding:'utf8',mode:0o600,flag:'wx'});
  renameSync(temp,path);
}

function inspectManaged(path,content,{force=false}={}) {
  if(!existsSync(path)) return {path,content,changed:true};
  const existing=readFileSync(path,'utf8');
  if(existing===content) return {path,content,changed:false};
  assertBridge(force,'BOOTSTRAP_CONFLICT',`refusing to replace existing file: ${path}`);
  return {path,content,changed:true};
}

function writeManaged(plan) {
  if(plan.changed) atomicWrite(plan.path,plan.content);
  return {path:plan.path,changed:plan.changed};
}

function projectPolicy({repository,runnerClass,verify}) {
  return {
    version:1,
    project:{repository},
    runners:{default:{class:runnerClass}},
    capabilities:{
      verify:{
        class:'verify',
        runner:'default',
        command:{argv:verify},
        limits:{
          timeoutSeconds:1800,
          stdoutBytes:1048576,
          stderrBytes:1048576
        }
      }
    },
    workspaceExec:{
      enabled:true,
      runner:'default',
      maxArgv:64,
      maxSeconds:3600,
      stdoutBytes:1048576,
      stderrBytes:1048576
    },
    editing:{
      enabled:true,
      runner:'default',
      allowedBranches:['agent/**','codex/**'],
      allowedPaths:['**'],
      maxOperations:32,
      maxPatchBytes:1048576,
      commitSubjectPattern:'^(feat|fix|test|docs|chore|refactor|perf|build|ci): .+',
      publish:true
    }
  };
}

function renderGateway({runnerClass,bridgeSha,bridgeRepository}) {
  let value=readFileSync(resolve(bridgeRoot(),'examples','bridge-gateway.yml'),'utf8');
  value=value.replace(
    /runs-on: \[self-hosted, linux, x64, [^\]]+\]/,
    `runs-on: [self-hosted, linux, x64, ${runnerClass}]`
  );
  value=value.replace(
    /example\/bridge@[0-9a-f]{40}/g,
    `${bridgeRepository}@${bridgeSha}`
  );
  return value;
}

function renderPublish({bridgeSha,bridgeRepository}) {
  return readFileSync(resolve(bridgeRoot(),'examples','bridge-publish.yml'),'utf8')
    .replace(
      /example\/bridge@[0-9a-f]{40}/g,
      `${bridgeRepository}@${bridgeSha}`
    );
}

function mergeHostPolicy({policy,repository,runnerClass,serviceUser}) {
  validateHostPolicy(policy);
  const current=policy.repositories[repository];
  if(current) {
    if(current.workspaceExec?.enabled) {
      assertBridge(
        current.workspaceExec.runnerClass===runnerClass &&
        current.workspaceExec.serviceUser===serviceUser,
        'BOOTSTRAP_CONFLICT',
        'existing repository workspaceExec uses another runner/service user'
      );
    }
    if(current.editing?.enabled) {
      assertBridge(
        current.editing.runnerClass===runnerClass &&
        current.editing.serviceUser===serviceUser,
        'BOOTSTRAP_CONFLICT',
        'existing repository editing uses another runner/service user'
      );
    }
  }
  const entry=current ? structuredClone(current) : {runnerClasses:[]};
  entry.runnerClasses=[...new Set([...(entry.runnerClasses ?? []),runnerClass])].sort();
  entry.workspaceExec=entry.workspaceExec ?? {
    enabled:true,
    runnerClass,
    serviceUser,
    maxArgv:64,
    maxSeconds:3600,
    stdoutBytes:1048576,
    stderrBytes:1048576
  };
  entry.editing=entry.editing ?? {
    enabled:true,
    runnerClass,
    serviceUser,
    maxOperations:32,
    maxPatchBytes:1048576
  };
  const next=structuredClone(policy);
  next.repositories[repository]=entry;
  validateHostPolicy(next);
  return next;
}

export function bootstrapProject({
  repoPath,
  repository,
  verify,
  bridgeSha='current',
  bridgeRepository,
  runnerClass='bridge',
  serviceUser='bridge-runner',
  hostPolicyPath=null,
  force=false
}={}) {
  const root=resolve(repoPath);
  assertBridge(existsSync(root),'BOOTSTRAP_INVALID','target repository path does not exist');
  git(root,['rev-parse','--is-inside-work-tree'],'target Git repository validation');

  const repo=repository ?? deriveRepository(root);
  assertBridge(REPO.test(repo),'BOOTSTRAP_INVALID','repository must be owner/repo');
  assertBridge(typeof runnerClass==='string' && CLASS.test(runnerClass),'BOOTSTRAP_INVALID','runner class invalid');
  assertBridge(
    typeof serviceUser==='string' && /^[A-Za-z_][A-Za-z0-9._-]{0,63}\$?$/.test(serviceUser),
    'BOOTSTRAP_INVALID',
    'service user invalid'
  );
  assertBridge(typeof bridgeRepository==='string'&&REPO.test(bridgeRepository)&&!bridgeRepository.startsWith('example/'),
    'BOOTSTRAP_INVALID','Provide --bridge-repository owner/repo for your accessible Bridge runtime repository');
  const exactBridgeSha=resolveBridgeSha(bridgeSha);
  const argv=verifyArgv(verify);
  const policy=projectPolicy({repository:repo,runnerClass,verify:argv});
  validateProjectPolicy(policy,repo);

  const filePlans=[
    inspectManaged(
      resolve(root,'.bridge','project.json'),
      JSON.stringify(policy,null,2)+'\n',
      {force}
    ),
    inspectManaged(
      resolve(root,'.github','workflows','bridge-gateway.yml'),
      renderGateway({runnerClass,bridgeSha:exactBridgeSha,bridgeRepository}),
      {force}
    ),
    inspectManaged(
      resolve(root,'.github','workflows','bridge-publish.yml'),
      renderPublish({bridgeSha:exactBridgeSha,bridgeRepository}),
      {force}
    )
  ];

  let hostPlan=null;
  if(hostPolicyPath!==null) {
    const path=resolve(hostPolicyPath);
    const existing=readFileSync(path,'utf8');
    const current=JSON.parse(existing);
    const next=mergeHostPolicy({
      policy:current,
      repository:repo,
      runnerClass,
      serviceUser
    });
    const serialized=JSON.stringify(next,null,2)+'\n';
    hostPlan={
      path,
      existing,
      serialized,
      changed:serialized!==existing,
      backup:`${path}.bridge-bootstrap.bak`
    };
  }

  // All conflict/authority validation above completes before the first write.
  const files=filePlans.map(writeManaged);

  let hostPolicy=null;
  if(hostPlan!==null) {
    if(hostPlan.changed) {
      if(!existsSync(hostPlan.backup)) {
        writeFileSync(hostPlan.backup,hostPlan.existing,{mode:0o600,flag:'wx'});
      }
      atomicWrite(hostPlan.path,hostPlan.serialized);
      hostPolicy={path:hostPlan.path,changed:true,backup:hostPlan.backup};
    } else {
      hostPolicy={path:hostPlan.path,changed:false};
    }
  }

  return {
    repository:repo,
    bridgeSha:exactBridgeSha,
    runnerClass,
    serviceUser,
    verifyArgv:argv,
    files,
    hostPolicy,
    next:[
      'commit generated repository files to the default branch',
      'ensure the Bridge GitHub App/repository grant includes this repository',
      'ensure a self-hosted GitHub runner with the declared runner class is online',
      'run bridge.discover(repository) acceptance'
    ]
  };
}
