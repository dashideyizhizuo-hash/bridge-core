import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { GitHubTransport } from '../src/github-transport.mjs';
import { createStaticRepositoryAuthorizer } from '../src/authorization.mjs';

function readYaml(path) {
  return YAML.parse(readFileSync(path,'utf8'));
}

function steps(workflow, job) {
  return workflow.jobs[job].steps;
}

function named(workflow, job, name) {
  return steps(workflow,job).find(step=>step.name===name);
}

function assertPinnedActions(workflow) {
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps ?? []) {
      if (!step.uses) continue;
      assert.match(step.uses,/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/,`action must use immutable commit SHA: ${step.uses}`);
    }
  }
}

test('reusable Bridge action keeps execute default and separates edit/publish modes',()=>{
  const action=readYaml('action.yml');
  assert.equal(action.inputs.mode.default,'execute');
  assert.equal(action.runs.using,'composite');
  const modes=action.runs.steps.map(step=>step.if).filter(Boolean);
  assert.deepEqual(modes,[
    "inputs.mode == 'execute'",
    "inputs.mode == 'edit-verify'",
    "inputs.mode == 'edit-verify'",
    "inputs.mode == 'publish'"
  ]);
  assert.match(action.runs.steps[0].run,/bridge-runner\.mjs" execute/);
  assert.match(action.runs.steps[1].run,/bridge-runner\.mjs" prepare-edit/);
  assert.match(action.runs.steps[2].run,/bridge-runner\.mjs" verify-edit/);
  assert.match(action.runs.steps[3].run,/bridge-runner\.mjs" publish-edit/);
});

test('gateway workflow binds trusted control ref to exact target and uploads only bounded evidence',()=>{
  const workflow=readYaml('examples/bridge-gateway.yml');
  assert.deepEqual(workflow.permissions,{contents:'read'});
  assert.ok(workflow.on.workflow_dispatch);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs),[
    'bridge_kind','bridge_request_id','bridge_request_path','bridge_target_sha'
  ]);
  assert.deepEqual(workflow.jobs.bridge['runs-on'],['self-hosted','linux','x64','bridge']);

  const setup=named(workflow,'bridge','Set up Node.js for Bridge runtime');
  assert.match(setup.uses,/^actions\/setup-node@[0-9a-f]{40}$/);
  assert.equal(setup.with['node-version'],22);

  const control=named(workflow,'bridge','Checkout trusted control ref');
  assert.equal(control.with.ref,'${{ github.sha }}');
  assert.equal(control.with['persist-credentials'],false);
  assert.equal(control.with['fetch-depth'],2);

  const target=named(workflow,'bridge','Checkout exact target SHA');
  assert.equal(target.with.ref,'${{ inputs.bridge_target_sha }}');
  assert.equal(target.with['persist-credentials'],false);
  assert.equal(target.with['fetch-depth'],1);

  const validation=named(workflow,'bridge','Validate trusted control binding').run;
  assert.match(validation,/control parent must equal trusted policy SHA/);
  assert.match(validation,/control commit must add only/);
  assert.match(validation,/request repository mismatch/);
  assert.match(validation,/target SHA mismatch/);

  const policyFetch=named(workflow,'bridge','Fetch exact trusted policy commit');
  assert.match(policyFetch.run,/--depth=1/);
  assert.match(policyFetch.run,/BRIDGE_POLICY_SHA/);
  assert.equal(workflow.jobs.bridge.steps.filter(step=>step.name==='Checkout exact target SHA').length,1);
  assert.equal(workflow.jobs.bridge.steps.some(step=>step.with?.['fetch-depth']===0),false);

  const execute=named(workflow,'bridge','Execute Bridge capability or batch');
  const edit=named(workflow,'bridge','Prepare and verify Bridge edit');
  assert.match(execute.uses,/^example\/bridge@[0-9a-f]{40}$/);
  assert.equal(execute.with.mode,'execute');
  assert.match(execute.if,/batch/);
  assert.equal(edit.uses,execute.uses);
  assert.equal(edit.with.mode,'edit-verify');

  const upload=named(workflow,'bridge','Upload bounded Bridge evidence');
  assert.notEqual(upload.with.path,'.bridge-result');
  assert.equal(upload.with['include-hidden-files'],true);
  for (const expected of [
    '.bridge-result/bridge-result.json',
    '.bridge-result/evidence/**',
    '.bridge-result/prepare/request.json',
    '.bridge-result/prepare/prepare-result.json',
    '.bridge-result/prepare/candidate.bundle',
    '.bridge-result/verification/verification-result.json'
  ]) assert.ok(upload.with.path.includes(expected),`missing bounded artifact path: ${expected}`);

  assertPinnedActions(workflow);
});

test('publish workflow has isolated write authority, runs hosted, and executes only publish mode',()=>{
  const workflow=readYaml('examples/bridge-publish.yml');
  assert.deepEqual(workflow.permissions,{actions:'read',contents:'write'});
  assert.equal(workflow.jobs.publish['runs-on'],'ubuntu-latest');

  const download=named(workflow,'publish','Download exact verified source evidence');
  assert.equal(download.with['run-id'],'${{ inputs.bridge_source_run_id }}');
  assert.equal(download.with.name,'${{ inputs.bridge_source_artifact }}');

  const validation=named(workflow,'publish','Validate verified evidence and expose exact base SHA').run;
  assert.match(validation,/source edit is not VERIFIED/);
  assert.match(validation,/verification identity mismatch/);

  const checkout=named(workflow,'publish','Checkout exact verified base without persisted credentials');
  assert.equal(checkout.with.ref,'${{ steps.evidence.outputs.base_sha }}');
  assert.equal(checkout.with['persist-credentials'],false);
  assert.equal(checkout.with['fetch-depth'],1);
  const policyFetch=named(workflow,'publish','Fetch exact trusted policy commit');
  assert.match(policyFetch.run,/--depth=1/);
  assert.match(policyFetch.run,/BRIDGE_POLICY_SHA/);
  assert.equal(workflow.jobs.publish.steps.some(step=>step.with?.['fetch-depth']===0),false);

  const publish=named(workflow,'publish','Publish verified Bridge candidate');
  assert.match(publish.uses,/^example\/bridge@[0-9a-f]{40}$/);
  assert.equal(publish.with.mode,'publish');
  assert.equal(publish.env.BRIDGE_PUBLISH_TOKEN,'${{ github.token }}');

  const upload=named(workflow,'publish','Upload publication receipt');
  assert.equal(upload.with.path,'.bridge-publish-result/publish-result.json');
  assert.equal(upload.with['include-hidden-files'],true);
  assertPinnedActions(workflow);
});

test('GitHub transport workflow defaults match the canonical target-repository templates',()=>{
  const transport=new GitHubTransport({
    github:{request:async()=>{},download:async()=>new Uint8Array()},
    authorizer:createStaticRepositoryAuthorizer()
  });
  assert.equal(transport.runWorkflow,'bridge-gateway.yml');
  assert.equal(transport.publishWorkflow,'bridge-publish.yml');
});
