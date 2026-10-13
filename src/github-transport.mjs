import { randomUUID } from 'node:crypto';
import { unzipSync } from 'fflate';
import { assertBridge, BridgeError } from './errors.mjs';
import { validateTaskBinding } from './task-runtime-binding.mjs';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REQUEST_PREFIX = 'bridge/requests/';
const PUBLISH_PREFIX = 'bridge/publish/';
const RUN_ID_PREFIX = 'gh1';

function repositoryName(value) {
  assertBridge(
    typeof value === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value),
    'GITHUB_TRANSPORT_INVALID',
    'repository must be owner/name'
  );
  return value;
}

function sha(value, label) {
  assertBridge(typeof value === 'string' && SHA_PATTERN.test(value), 'GITHUB_TRANSPORT_INVALID', `${label} must be a 40-hex SHA`);
  return value;
}

function requestId(value) {
  assertBridge(typeof value === 'string' && /^[A-Za-z0-9._-]{8,160}$/.test(value), 'GITHUB_TRANSPORT_INVALID', 'requestId is invalid');
  return value;
}

function encodeRunId(repository, id, controlSha) {
  return `${RUN_ID_PREFIX}:${repository}:${id}:${controlSha}`;
}

function parseRunId(value) {
  assertBridge(typeof value === 'string' && value.length <= 256, 'RUN_NOT_FOUND', 'runId invalid');
  const match = /^gh1:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+):([A-Za-z0-9._-]{8,160}):([0-9a-f]{40})$/.exec(value);
  assertBridge(match, 'RUN_NOT_FOUND', 'runId is not a GitHub Bridge run');
  return { repository: match[1], requestId: match[2], controlSha: match[3] };
}

function requestBranch(id) {
  return `${REQUEST_PREFIX}${id}`;
}

function requestPath(id) {
  return `.bridge/requests/${id}.json`;
}

function publishBranch(id) {
  return `${PUBLISH_PREFIX}${id}-${randomUUID()}`;
}

function kindForRequest(request) {
  if (request?.mode === 'batch') return 'batch';
  return Array.isArray(request?.operations) ? 'edit' : 'capability';
}

function decodeContent(payload, label) {
  assertBridge(payload && payload.encoding === 'base64' && typeof payload.content === 'string', 'GITHUB_EVIDENCE_INVALID', `${label} is not base64 file content`);
  return Buffer.from(payload.content.replace(/\n/g,''), 'base64');
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (error) {
    throw new BridgeError('GITHUB_EVIDENCE_INVALID', `${label} is not valid JSON`, { cause: error.message });
  }
}

function terminalStatus(run) {
  if (!run) return 'QUEUED';
  if (run.status !== 'completed') return run.status === 'in_progress' ? 'RUNNING' : 'QUEUED';
  if (run.conclusion === 'success') return 'SUCCEEDED';
  if (run.conclusion === 'cancelled') return 'CANCELED';
  return 'FAILED';
}

function findArchiveJson(entries, filename) {
  const names = Object.keys(entries).filter(name => name === filename || name.endsWith(`/${filename}`));
  assertBridge(names.length === 1, 'GITHUB_EVIDENCE_INVALID', `artifact must contain exactly one ${filename}`);
  return parseJson(entries[names[0]], filename);
}

function verifyResultBinding({ parsed, record, kind }) {
  assertBridge(parsed?.requestId === record.request.requestId, 'GITHUB_EVIDENCE_INVALID', 'result requestId binding mismatch');
  assertBridge(parsed.repository === record.repository, 'GITHUB_EVIDENCE_INVALID', 'result repository binding mismatch');
  if (kind === 'capability') {
    assertBridge(parsed.targetSha === record.request.target.sha, 'GITHUB_EVIDENCE_INVALID', 'result target SHA binding mismatch');
    assertBridge(parsed.policySha === record.request.policy.sha, 'GITHUB_EVIDENCE_INVALID', 'result policy SHA binding mismatch');
    return;
  }
  if (kind === 'batch') {
    assertBridge(parsed.mode === 'batch', 'GITHUB_EVIDENCE_INVALID', 'batch result mode mismatch');
    assertBridge(parsed.targetSha === record.request.target.sha, 'GITHUB_EVIDENCE_INVALID', 'batch target SHA binding mismatch');
    assertBridge(parsed.policySha === record.request.policy.sha, 'GITHUB_EVIDENCE_INVALID', 'batch policy SHA binding mismatch');
    if (parsed.status === 'VERIFIED' || parsed.candidateSha !== undefined) {
      assertBridge(parsed.status === 'VERIFIED', 'GITHUB_EVIDENCE_INVALID', 'batch candidate exists without VERIFIED status');
      assertBridge(parsed.baseSha === record.request.target.sha, 'GITHUB_EVIDENCE_INVALID', 'batch candidate base SHA binding mismatch');
      assertBridge(SHA_PATTERN.test(parsed.candidateSha ?? ''), 'GITHUB_EVIDENCE_INVALID', 'batch candidate SHA invalid');
    }
    return;
  }
  assertBridge(parsed.baseSha === record.request.target.sha, 'GITHUB_EVIDENCE_INVALID', 'verification base SHA binding mismatch');
  assertBridge(parsed.policySha === record.request.policy.sha, 'GITHUB_EVIDENCE_INVALID', 'verification policy SHA binding mismatch');
  assertBridge(parsed.status === 'VERIFIED' && SHA_PATTERN.test(parsed.candidateSha ?? ''), 'GITHUB_EVIDENCE_INVALID', 'edit result is not VERIFIED');
}

export class GitHubRestClient {
  constructor({
    token,
    fetchImpl = globalThis.fetch,
    apiBase = 'https://api.github.com',
    userAgent = 'runner-bridge'
  } = {}) {
    assertBridge(typeof token === 'string' && token.length > 0, 'GITHUB_CONFIG_INVALID', 'GitHub token is required');
    assertBridge(typeof fetchImpl === 'function', 'GITHUB_CONFIG_INVALID', 'fetch implementation is required');
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.apiBase = apiBase.replace(/\/$/,'');
    assertBridge(
      typeof userAgent === 'string' &&
        /^[\x20-\x7E]{1,256}$/.test(userAgent),
      'GITHUB_CONFIG_INVALID',
      'GitHub User-Agent is invalid'
    );
    this.userAgent = userAgent;
  }

  async request(method, path, { body, accept = 'application/vnd.github+json' } = {}) {
    const response = await this.fetchImpl(new URL(path, this.apiBase), {
      method,
      headers: {
        Accept: accept,
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': this.userAgent,
        ...(body === undefined ? {} : {'Content-Type':'application/json'})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (response.status === 204) return null;
    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    if (!response.ok) {
      throw new BridgeError('GITHUB_API_ERROR', `GitHub API ${method} ${path} failed with HTTP ${response.status}`, {
        status: response.status,
        response: typeof data === 'string' ? data.slice(0,4000) : data
      });
    }
    return data;
  }

  async download(path) {
    const response = await this.fetchImpl(new URL(path, this.apiBase), {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': this.userAgent
      },
      redirect: 'follow'
    });
    if (!response.ok) throw new BridgeError('GITHUB_API_ERROR', `GitHub artifact download failed with HTTP ${response.status}`, { status: response.status });
    return new Uint8Array(await response.arrayBuffer());
  }
}

export class GitHubTransport {
  constructor({
    github,
    authorizer,
    runWorkflow = 'bridge-gateway.yml',
    publishWorkflow = 'bridge-publish.yml',
    pollIntervalMs = 1000,
    publishTimeoutMs = 120000,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    taskLeaseValidator = null
  }) {
    assertBridge(github && typeof github.request === 'function' && typeof github.download === 'function', 'GITHUB_CONFIG_INVALID', 'github client is required');
    assertBridge(authorizer && typeof authorizer.assertRepository === 'function', 'GITHUB_CONFIG_INVALID', 'repository authorizer is required');
    assertBridge(typeof runWorkflow === 'string' && runWorkflow.length > 0, 'GITHUB_CONFIG_INVALID', 'run workflow is required');
    assertBridge(typeof publishWorkflow === 'string' && publishWorkflow.length > 0, 'GITHUB_CONFIG_INVALID', 'publish workflow is required');
    this.github = github;
    this.authorizer = authorizer;
    this.runWorkflow = runWorkflow;
    this.publishWorkflow = publishWorkflow;
    this.pollIntervalMs = pollIntervalMs;
    this.publishTimeoutMs = publishTimeoutMs;
    this.sleep = sleep;
    if(taskLeaseValidator !== null) {
      assertBridge(
        taskLeaseValidator &&
          typeof taskLeaseValidator.assertCurrent==='function' &&
          typeof taskLeaseValidator.bindRun==='function',
        'TASK_RUNTIME_CONFIG_INVALID',
        'task lease validator must provide assertCurrent and bindRun'
      );
    }
    this.taskLeaseValidator=taskLeaseValidator;
  }

  async #assertTaskLease(request) {
    if(request?.task === undefined) return null;
    const binding=validateTaskBinding(request.task,{
      repository:request.repository,
      target:request.target
    });
    assertBridge(
      this.taskLeaseValidator,
      'TASK_RUNTIME_UNAVAILABLE',
      'task-aware Bridge request requires the durable task runtime'
    );
    await this.taskLeaseValidator.assertCurrent({
      ...binding,
      repository:request.repository
    });
    return binding;
  }

  async #authorize(repository, permission) {
    return this.authorizer.assertRepository(repositoryName(repository), permission);
  }

  async resolveRepository(repository) {
    const repo = await this.#authorize(repository, 'read');
    const metadata = await this.github.request('GET', `/repos/${repo}`);
    assertBridge(typeof metadata?.default_branch === 'string' && metadata.default_branch.length > 0, 'GITHUB_TRANSPORT_INVALID', 'repository has no default branch');
    const commit = await this.github.request('GET', `/repos/${repo}/commits/${encodeURIComponent(metadata.default_branch)}`);
    return {
      repository: repo,
      defaultRef: metadata.default_branch,
      defaultSha: sha(commit?.sha, 'default branch SHA')
    };
  }

  async resolveTarget(repository, { ref, sha: assertedSha }) {
    const repo = await this.#authorize(repository, 'read');
    assertBridge(typeof ref === 'string' && ref.length > 0, 'GITHUB_TRANSPORT_INVALID', 'target ref is required');
    const commit = await this.github.request('GET', `/repos/${repo}/commits/${encodeURIComponent(ref)}`);
    const resolved = sha(commit?.sha, 'target SHA');
    if (assertedSha !== undefined) {
      sha(assertedSha, 'asserted target SHA');
      assertBridge(assertedSha === resolved, 'TARGET_STALE', 'caller target SHA does not match GitHub target ref', { expected: assertedSha, actual: resolved });
    }
    return { ref, sha: resolved };
  }

  async readProjectPolicy(repository, policySha) {
    const repo = await this.#authorize(repository, 'read');
    const exactSha = sha(policySha, 'policy SHA');
    const payload = await this.github.request('GET', `/repos/${repo}/contents/.bridge/project.json?ref=${exactSha}`);
    return parseJson(decodeContent(payload, 'trusted project policy'), 'trusted project policy');
  }

  async #createRequestControlRef(request) {
    const repo = request.repository;
    const parentSha = sha(request.policy?.sha, 'policy SHA');
    const id = requestId(request.requestId);
    const path = requestPath(id);
    const bytes = JSON.stringify(request, null, 2) + '\n';

    const parent = await this.github.request('GET', `/repos/${repo}/git/commits/${parentSha}`);
    const treeSha = sha(parent?.tree?.sha, 'policy tree SHA');
    const blob = await this.github.request('POST', `/repos/${repo}/git/blobs`, {
      body: { content: bytes, encoding: 'utf-8' }
    });
    const tree = await this.github.request('POST', `/repos/${repo}/git/trees`, {
      body: {
        base_tree: treeSha,
        tree: [{ path, mode: '100644', type: 'blob', sha: sha(blob?.sha, 'request blob SHA') }]
      }
    });
    const commit = await this.github.request('POST', `/repos/${repo}/git/commits`, {
      body: {
        message: `bridge: durable request ${id}`,
        tree: sha(tree?.sha, 'request tree SHA'),
        parents: [parentSha]
      }
    });
    const controlSha = sha(commit?.sha, 'request control SHA');
    const branch = requestBranch(id);
    await this.github.request('POST', `/repos/${repo}/git/refs`, {
      body: { ref: `refs/heads/${branch}`, sha: controlSha }
    });
    return { controlSha, branch, path };
  }

  async #submit(request, kind) {
    const repo = await this.#authorize(request?.repository, 'run');
    assertBridge(request?.repository === repo, 'GITHUB_TRANSPORT_INVALID', 'request repository mismatch');
    assertBridge(kind === kindForRequest(request), 'GITHUB_TRANSPORT_INVALID', 'request kind mismatch');
    const taskBinding=await this.#assertTaskLease(request);
    const control = await this.#createRequestControlRef(request);
    const runId=encodeRunId(repo, request.requestId, control.controlSha);
    if(taskBinding) {
      try {
        await this.taskLeaseValidator.bindRun({
          ...taskBinding,
          repository:repo,
          runId
        });
      } catch(error) {
        await this.#deleteBranch(repo,control.branch);
        throw error;
      }
    }
    await this.github.request('POST', `/repos/${repo}/actions/workflows/${encodeURIComponent(this.runWorkflow)}/dispatches`, {
      body: {
        ref: control.branch,
        inputs: {
          bridge_kind: kind,
          bridge_request_id: request.requestId,
          bridge_request_path: control.path,
          bridge_target_sha: request.target.sha
        }
      }
    });
    return { runId };
  }

  async submitCapabilityRequest(request) {
    return this.#submit(request, 'capability');
  }

  async submitEditRequest(request) {
    return this.#submit(request, 'edit');
  }

  async submitBatchRequest(request) {
    return this.#submit(request, 'batch');
  }

  async #loadRecord(runId, permission = 'read') {
    const identity = parseRunId(runId);
    const repo = await this.#authorize(identity.repository, permission);
    const path = requestPath(identity.requestId);
    const payload = await this.github.request('GET', `/repos/${repo}/contents/${path}?ref=${identity.controlSha}`);
    const request = parseJson(decodeContent(payload, 'durable Bridge request'), 'durable Bridge request');
    assertBridge(request?.repository === repo && request?.requestId === identity.requestId, 'GITHUB_EVIDENCE_INVALID', 'durable request identity mismatch');
    assertBridge(request?.policy?.sha && SHA_PATTERN.test(request.policy.sha), 'GITHUB_EVIDENCE_INVALID', 'durable request policy identity invalid');
    assertBridge(request?.target?.sha && SHA_PATTERN.test(request.target.sha), 'GITHUB_EVIDENCE_INVALID', 'durable request target identity invalid');
    if(request.task !== undefined) validateTaskBinding(request.task,{repository:repo,target:request.target});
    return { ...identity, repository: repo, request, kind: kindForRequest(request), branch: requestBranch(identity.requestId), runId };
  }

  async #findWorkflowRun(record, workflow = this.runWorkflow) {
    const query = new URLSearchParams({
      event: 'workflow_dispatch',
      branch: record.branch,
      per_page: '10'
    });
    const payload = await this.github.request('GET', `/repos/${record.repository}/actions/workflows/${encodeURIComponent(workflow)}/runs?${query}`);
    const runs = Array.isArray(payload?.workflow_runs) ? payload.workflow_runs : [];
    return runs.find(run => run?.head_sha === record.controlSha && run?.head_branch === record.branch) ?? null;
  }

  async getRun(runId) {
    const record = await this.#loadRecord(runId, 'read');
    const workflowRun = await this.#findWorkflowRun(record);
    return {
      runId,
      kind: record.kind,
      repository: record.repository,
      targetRef: record.request.target.ref,
      status: terminalStatus(workflowRun),
      request: record.request,
      ...(record.request.task === undefined ? {} : {task:record.request.task}),
      github: workflowRun ? {
        workflowRunId: workflowRun.id,
        htmlUrl: workflowRun.html_url ?? null,
        headSha: workflowRun.head_sha,
        headBranch: workflowRun.head_branch,
        conclusion: workflowRun.conclusion ?? null
      } : {
        workflowRunId: null,
        htmlUrl: null,
        headSha: record.controlSha,
        headBranch: record.branch,
        conclusion: null
      }
    };
  }

  async #downloadArtifactJson(repository, workflowRunId, artifactName, filename) {
    const listed = await this.github.request('GET', `/repos/${repository}/actions/runs/${workflowRunId}/artifacts?per_page=100`);
    const artifacts = Array.isArray(listed?.artifacts) ? listed.artifacts : [];
    const artifact = artifacts.find(item => item?.name === artifactName && item?.expired !== true);
    assertBridge(artifact && Number.isInteger(artifact.id), 'GITHUB_EVIDENCE_INVALID', `required artifact not found: ${artifactName}`);
    const archive = await this.github.download(`/repos/${repository}/actions/artifacts/${artifact.id}/zip`);
    let entries;
    try { entries = unzipSync(archive); }
    catch (error) { throw new BridgeError('GITHUB_EVIDENCE_INVALID', 'GitHub artifact is not a valid ZIP archive', { cause: error.message }); }
    return findArchiveJson(entries, filename);
  }

  async getResult(runId) {
    const record = await this.#loadRecord(runId, 'read');
    const workflowRun = await this.#findWorkflowRun(record);
    if (!workflowRun || workflowRun.status !== 'completed') {
      return {
        runId,
        status: terminalStatus(workflowRun),
        repository: record.repository,
        targetSha: record.request.target.sha,
        policySha: record.request.policy.sha,
        ...(record.request.task === undefined ? {} : {task:record.request.task})
      };
    }
    if (workflowRun.conclusion !== 'success' && record.kind !== 'batch') {
      return {
        runId,
        status: terminalStatus(workflowRun),
        repository: record.repository,
        targetSha: record.request.target.sha,
        policySha: record.request.policy.sha,
        ...(record.request.task === undefined ? {} : {task:record.request.task}),
        github: { workflowRunId: workflowRun.id, conclusion: workflowRun.conclusion ?? null }
      };
    }

    const filename = record.kind === 'edit' ? 'verification-result.json' : 'bridge-result.json';
    let parsed;
    try {
      parsed = await this.#downloadArtifactJson(
        record.repository,
        workflowRun.id,
        `bridge-result-${workflowRun.id}`,
        filename
      );
    } catch (error) {
      if (
        record.kind === 'batch' &&
        workflowRun.conclusion !== 'success' &&
        error?.code === 'GITHUB_EVIDENCE_INVALID' &&
        String(error.message).startsWith('required artifact not found:')
      ) {
        return {
          runId,
          status: terminalStatus(workflowRun),
          repository: record.repository,
          targetSha: record.request.target.sha,
          policySha: record.request.policy.sha,
          ...(record.request.task === undefined ? {} : {task:record.request.task}),
          github: { workflowRunId: workflowRun.id, conclusion: workflowRun.conclusion ?? null }
        };
      }
      throw error;
    }
    verifyResultBinding({ parsed, record, kind: record.kind });
    return {
      ...parsed,
      runId,
      ...(record.request.task === undefined ? {} : {task:record.request.task}),
      github: { workflowRunId: workflowRun.id, htmlUrl: workflowRun.html_url ?? null, conclusion: workflowRun.conclusion ?? null }
    };
  }

  async #createPublishRef(record) {
    const branch = publishBranch(record.requestId);
    await this.github.request('POST', `/repos/${record.repository}/git/refs`, {
      body: { ref: `refs/heads/${branch}`, sha: record.controlSha }
    });
    return branch;
  }

  async #deleteBranch(repository, branch) {
    try {
      await this.github.request('DELETE', `/repos/${repository}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`);
    } catch {}
  }

  async publishVerified({ run, result }) {
    const record = await this.#loadRecord(run?.runId, 'publish');
    await this.#assertTaskLease(record.request);
    assertBridge((record.kind === 'edit' || record.kind === 'batch') && run?.kind === record.kind, 'PUBLISH_DENIED', 'only edit or edited batch runs can be published');
    assertBridge(result?.status === 'VERIFIED' && result?.candidateSha, 'PUBLISH_DENIED', 'edit run is not verified');
    verifyResultBinding({ parsed: result, record, kind: 'edit' });

    const sourceRun = await this.#findWorkflowRun(record);
    assertBridge(sourceRun?.status === 'completed' && sourceRun.conclusion === 'success' && Number.isInteger(sourceRun.id), 'PUBLISH_DENIED', 'source edit workflow is not successfully completed');

    const branch = await this.#createPublishRef(record);
    const dispatchedAt = Date.now();
    try {
      await this.github.request('POST', `/repos/${record.repository}/actions/workflows/${encodeURIComponent(this.publishWorkflow)}/dispatches`, {
        body: {
          ref: branch,
          inputs: {
            bridge_request_id: record.requestId,
            bridge_source_run_id: String(sourceRun.id),
            bridge_source_artifact: `bridge-result-${sourceRun.id}`
          }
        }
      });

      const publishRecord = { ...record, branch };
      while (Date.now() - dispatchedAt <= this.publishTimeoutMs) {
        const workflowRun = await this.#findWorkflowRun(publishRecord, this.publishWorkflow);
        if (workflowRun?.status === 'completed') {
          assertBridge(workflowRun.conclusion === 'success', 'PUBLISH_DENIED', 'GitHub publish workflow failed', { conclusion: workflowRun.conclusion });
          const published = await this.#downloadArtifactJson(
            record.repository,
            workflowRun.id,
            `bridge-publish-${workflowRun.id}`,
            'publish-result.json'
          );
          assertBridge(published?.status === 'PUBLISHED' && published?.requestId === record.requestId, 'GITHUB_EVIDENCE_INVALID', 'publish result identity invalid');
          assertBridge(published.repository === record.repository && published.candidateSha === result.candidateSha, 'GITHUB_EVIDENCE_INVALID', 'publish result binding mismatch');
          return { ...published, runId: run.runId, github: { workflowRunId: workflowRun.id, htmlUrl: workflowRun.html_url ?? null } };
        }
        await this.sleep(this.pollIntervalMs);
      }
      throw new BridgeError('PUBLISH_TIMEOUT', 'GitHub publish workflow did not complete before timeout');
    } finally {
      await this.#deleteBranch(record.repository, branch);
    }
  }
}

export { encodeRunId, parseRunId };
