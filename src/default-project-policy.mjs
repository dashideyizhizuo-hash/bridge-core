import {assertBridge} from './errors.mjs';

// Versioned operator implementation, never supplied by the candidate checkout.
export function defaultProjectPolicy(repository,policySha){
  assertBridge(typeof repository==='string'&&/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)&&typeof policySha==='string'&&/^[0-9a-f]{40}$/.test(policySha),
    'PROJECT_POLICY_INVALID','Default policy requires exact repository and commit identity');
  return {
    version:1,project:{repository},bridgeDefaultProfile:{version:1,policySha,verification:'patch-integrity',projectTestsRun:false},
    runners:{default:{class:'bridge'}},
    capabilities:{'patch-integrity':{class:'verify',runner:'default',command:{argv:['git','diff','--check',policySha,'--']},limits:{timeoutSeconds:60,stdoutBytes:262144,stderrBytes:262144}}},
    mcp:{verification:[{capability:'patch-integrity',parameters:{}}]},
    workspaceExec:{enabled:true,runner:'default',maxArgv:32,maxSeconds:900,stdoutBytes:524288,stderrBytes:262144},
    editing:{enabled:true,runner:'default',allowedBranches:['agent/**','codex/**'],allowedPaths:['**'],maxOperations:16,maxPatchBytes:262144,publish:true}
  };
}
export const defaultProjectPolicyBytes=(repository,sha)=>JSON.stringify(defaultProjectPolicy(repository,sha))+'\n';
export function policyProfile(policy){
  const marker=policy?.bridgeDefaultProfile;
  if(marker?.version===1&&typeof marker.policySha==='string'&&/^[0-9a-f]{40}$/.test(marker.policySha)&&typeof policy.project?.repository==='string'&&/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(policy.project.repository)&&JSON.stringify(policy)===JSON.stringify(defaultProjectPolicy(policy.project.repository,marker.policySha)))
    return {source:'builtin',version:1,verification:'patch-integrity',projectTestsRun:false};
  return {source:'repository'};
}
