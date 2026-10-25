import {policyProfile} from './default-project-policy.mjs';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertBridge, BridgeError } from './errors.mjs';
import { ensureCommit, git, readTrustedProjectPolicyBytes } from './git.mjs';
import { parseJsonBytes } from './json.mjs';
import { validateBatchRequest, validateEditRequest, validateProjectPolicy } from './validate.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const stable = value => JSON.stringify(value);

function patternMatches(value, pattern) {
  if (pattern === '**') return true;
  if (pattern.endsWith('/**')) {
    const prefix=pattern.slice(0,-3);
    return value===prefix || value.startsWith(prefix + '/');
  }
  return value===pattern;
}

function validatePrepare(prep) {
  assertBridge(prep?.schemaVersion===1 && prep.status==='PREPARED' && ['NO_TARGET_CODE','SHARED_WORKSPACE'].includes(prep.executionMode), 'INVALID_PREPARE', 'prepare result invalid');
  assertBridge(Array.isArray(prep.changedFiles) && prep.changedFiles.length>0, 'INVALID_PREPARE', 'prepare changedFiles invalid');
}

function validateVerification(ver, prep, prepareBytes) {
  assertBridge(ver?.schemaVersion===1 && ver.status==='VERIFIED', 'INVALID_VERIFICATION', 'verification result invalid');
  for (const field of ['requestId','repository','requestSha256','baseSha','policySha','candidateSha','treeSha','diffSha256']) {
    assertBridge(ver[field]===prep[field], 'VERIFICATION_BINDING_MISMATCH', `verification ${field} does not match prepare receipt`);
  }
  assertBridge(ver.prepareResultSha256===sha256(prepareBytes), 'VERIFICATION_BINDING_MISMATCH', 'verification does not bind exact prepare receipt');
  assertBridge(stable([...ver.changedFiles].sort())===stable([...prep.changedFiles].sort()), 'VERIFICATION_BINDING_MISMATCH', 'verification changed paths do not match prepare receipt');
  assertBridge(Array.isArray(ver.verifications) && ver.verifications.length>=1, 'INVALID_VERIFICATION', 'verification contains no successful steps');
}

function batchVerificationPlan(request, prep) {
  const expected = Array.isArray(prep.verification) ? prep.verification : [];
  assertBridge(expected.length >= 1 && expected.length <= 4, 'REQUEST_BINDING_MISMATCH', 'batch candidate receipt verification plan invalid');
  const firstId = expected[0]?.stepId;
  const firstVerify = request.steps.findIndex(step=>step.id===firstId);
  assertBridge(firstVerify >= 0, 'REQUEST_BINDING_MISMATCH', 'batch verification tail is not present in immutable request');
  const tail = request.steps.slice(firstVerify);
  assertBridge(tail.length === expected.length && tail.every(step=>step.type==='preset'), 'REQUEST_BINDING_MISMATCH', 'batch verification tail invalid');
  return tail.map(step=>({ stepId: step.id, capability: step.capability, parameters: step.parameters ?? {} }));
}

function parsePublicationRequest(requestBytes, prep) {
  const parsed = parseJsonBytes(requestBytes,'edit request');
  if (parsed?.mode === 'batch') {
    const request = validateBatchRequest(parsed);
    const verification = batchVerificationPlan(request, prep);
    assertBridge(stable(verification)===stable(prep.verification), 'REQUEST_BINDING_MISMATCH', 'batch verification plan changed after execution');
    return { request, verification, mode: 'batch' };
  }
  const request = validateEditRequest(parsed);
  assertBridge(stable(request.verification)===stable(prep.verification), 'REQUEST_BINDING_MISMATCH', 'verification plan changed after preparation');
  return { request, verification: request.verification, mode: 'legacy' };
}

function authHeader(token) {
  return token ? `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` : null;
}

function gitRemote(repo,args,token,{maxBuffer=16*1024*1024}={}) {
  const argv=['-c','core.hooksPath=/dev/null'];
  const header=authHeader(token);
  if(header) argv.push('-c',`http.https://github.com/.extraheader=${header}`);
  argv.push('-C',repo,...args);
  const env={...process.env,GIT_TERMINAL_PROMPT:'0'};
  delete env.BRIDGE_PUBLISH_TOKEN;
  const r=spawnSync('git',argv,{encoding:'utf8',maxBuffer,env});
  if(r.error || r.status!==0) {
    throw new BridgeError('PUBLISH_GIT_FAILED', `git ${args[0] ?? ''} failed`, {status:r.status,stderr:String(r.stderr??'').slice(-4000)});
  }
  return String(r.stdout??'');
}

export function publishEditCandidate({ prepareDir, verificationDir, repoPath, outputDir, writeToken=process.env.BRIDGE_PUBLISH_TOKEN }) {
  const prepareBytes=readFileSync(resolve(prepareDir,'prepare-result.json'));
  const prep=parseJsonBytes(prepareBytes,'prepare result');
  validatePrepare(prep);

  const verificationBytes=readFileSync(resolve(verificationDir,'verification-result.json'));
  const verification=parseJsonBytes(verificationBytes,'verification result');
  validateVerification(verification,prep,prepareBytes);

  const requestBytes=readFileSync(resolve(prepareDir,'request.json'));
  assertBridge(sha256(requestBytes)===prep.requestSha256, 'REQUEST_DIGEST_MISMATCH', 'immutable edit request digest mismatch');
  const {request,verification:verificationPlan,mode:requestMode}=parsePublicationRequest(requestBytes,prep);
  assertBridge(request.requestId===prep.requestId && request.repository===prep.repository, 'REQUEST_BINDING_MISMATCH', 'edit request identity mismatch');
  assertBridge(request.target.sha===prep.baseSha && request.target.ref===prep.targetRef && request.policy.sha===prep.policySha, 'REQUEST_BINDING_MISMATCH', 'edit request target/policy mismatch');

  const repo=realpathSync(resolve(repoPath));
  ensureCommit(repo,prep.baseSha,'BASE_MISSING');
  ensureCommit(repo,prep.policySha,'POLICY_STALE');
  const projectPolicyBytes=readTrustedProjectPolicyBytes(repo, prep.policySha, prep.repository);
  const projectPolicy=validateProjectPolicy(parseJsonBytes(projectPolicyBytes,'trusted project policy'),prep.repository);
  const editing=projectPolicy.editing;
  assertBridge(editing?.enabled===true && editing.publish===true, 'PUBLISH_DENIED', 'trusted project policy does not enable edit publication');
  if(requestMode==='batch') {
    for(const step of verificationPlan) {
      assertBridge(projectPolicy.capabilities[step.capability]?.class==='verify', 'PUBLISH_DENIED', 'batch verification tail is not trusted verify capability: ' + step.capability);
    }
  }
  if(prep.projectPolicySha256) assertBridge(prep.projectPolicySha256===sha256(projectPolicyBytes), 'POLICY_STALE', 'candidate receipt does not bind exact trusted policy bytes');
  assertBridge(editing.allowedBranches.some(pattern=>patternMatches(prep.targetRef,pattern)), 'PUBLISH_DENIED', `target branch is not publishable by trusted policy: ${prep.targetRef}`);

  const remoteUrl=git(repo,['remote','get-url','origin']).trim();
  const githubHttps=/^https:\/\/github\.com\//.test(remoteUrl);
  const localRemote=remoteUrl.startsWith('/') || remoteUrl.startsWith('./') || remoteUrl.startsWith('../') || remoteUrl.startsWith('file://');
  assertBridge(githubHttps || localRemote, 'PUBLISH_DENIED', 'publish supports only GitHub HTTPS or local test remotes');
  if(githubHttps) assertBridge(typeof writeToken==='string' && writeToken.length>0, 'MISSING_WRITE_TOKEN', 'GitHub publication requires BRIDGE_PUBLISH_TOKEN');

  const remoteRef=`refs/bridge-publish/remote-${prep.requestId}`;
  const candidateRef=`refs/bridge-publish/candidate-${prep.requestId}`;
  try {
    gitRemote(repo,['fetch','--no-tags','--force','origin',`+refs/heads/${prep.targetRef}:${remoteRef}`],writeToken);
    const remoteHead=git(repo,['rev-parse',`${remoteRef}^{commit}`]).trim();
    assertBridge(remoteHead===prep.baseSha, 'PUBLISH_STALE', 'target branch moved after candidate preparation', {expected:prep.baseSha,actual:remoteHead});

    git(repo,['fetch','--force',resolve(prepareDir,'candidate.bundle'),`${prep.candidateSha}:${candidateRef}`],{maxBuffer:32*1024*1024});
    const candidateSha=git(repo,['rev-parse',`${candidateRef}^{commit}`]).trim();
    const parentSha=git(repo,['rev-parse',`${candidateSha}^`]).trim();
    const treeSha=git(repo,['rev-parse',`${candidateSha}^{tree}`]).trim();
    assertBridge(candidateSha===prep.candidateSha && parentSha===prep.baseSha && treeSha===prep.treeSha, 'CANDIDATE_BINDING_MISMATCH', 'candidate identity mismatch before publication');
    const diff=git(repo,['diff','--no-color','--binary',`${prep.baseSha}..${candidateSha}`,'--'],{maxBuffer:32*1024*1024});
    assertBridge(sha256(diff)===prep.diffSha256, 'CANDIDATE_BINDING_MISMATCH', 'candidate diff digest mismatch before publication');
    const changed=git(repo,['diff','--name-only','-z',`${prep.baseSha}..${candidateSha}`,'--']).split('\0').filter(Boolean).sort();
    assertBridge(stable(changed)===stable([...prep.changedFiles].sort()), 'CANDIDATE_BINDING_MISMATCH', 'candidate changed paths mismatch before publication');

    const message=git(repo,['show','-s','--format=%B',candidateSha]);
    for(const marker of [
      `Bridge-Request-Id: ${prep.requestId}`,
      `Bridge-Request-Base: ${prep.baseSha}`,
      `Bridge-Policy-SHA: ${prep.policySha}`,
      `Bridge-Request-SHA256: ${prep.requestSha256}`
    ]) assertBridge(message.includes(marker), 'CANDIDATE_BINDING_MISMATCH', `candidate commit trailer missing: ${marker}`);

    gitRemote(repo,[
      'push','--porcelain',
      `--force-with-lease=refs/heads/${prep.targetRef}:${prep.baseSha}`,
      'origin',
      `${candidateRef}:refs/heads/${prep.targetRef}`
    ],writeToken,{maxBuffer:32*1024*1024});

    const result={
      schemaVersion:1,
      status:'PUBLISHED',
      published:true,
      requestId:prep.requestId,
      repository:prep.repository,
      targetRef:prep.targetRef,
      baseSha:prep.baseSha,
      policySha:prep.policySha,
      candidateSha:prep.candidateSha,
      treeSha:prep.treeSha,
      diffSha256:prep.diffSha256,
      changedFiles:prep.changedFiles,
      prepareResultSha256:sha256(prepareBytes),
      verificationResultSha256:sha256(verificationBytes),
      requestSha256:prep.requestSha256,
      projectPolicySha256:sha256(projectPolicyBytes),
      policyProfile:policyProfile(JSON.parse(projectPolicyBytes)),
      completedAt:new Date().toISOString()
    };
    mkdirSync(outputDir,{recursive:true});
    writeFileSync(resolve(outputDir,'publish-result.json'),JSON.stringify(result,null,2)+'\n');
    return result;
  } finally {
    try { git(repo,['update-ref','-d',remoteRef]); } catch {}
    try { git(repo,['update-ref','-d',candidateRef]); } catch {}
  }
}
