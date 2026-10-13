# Private MCP deployment

Bridge includes a loopback/private Streamable HTTP MCP harness for controlled development and internal use.

**This is not the final product deployment architecture.** The final Bridge MCP is an independent remote control plane that talks to GitHub, while GitHub Actions talks to self-hosted runners. The product MCP service should not be colocated with the runner merely because this private harness can run there.

The canonical production architecture is documented in `docs/ARCHITECTURE.md`, `docs/REMOTE_DEPLOYMENT.md` and `docs/CLOUDFLARE_OAUTH_PROVIDER.md`.

Do not infer production distribution/authentication policy from this private harness.

## 1. Security model

The private deployment keeps four authorities separate:

```text
MCP caller bearer token
        |
        v
private Bridge MCP server
        |
        +-- repository grants: read / run / publish
        |
        +-- GitHub service credential
        v
GitHub control plane
        |
        v
trusted target-repository Bridge workflows
        |
        v
self-hosted runner / isolated publish job
```

The MCP bearer token is not a GitHub credential.

The GitHub service credential stays on the MCP host. It is not injected into target-code execution.

The private server binds only to loopback. Put TLS/authenticated reverse-proxy or tunnel infrastructure in front of it rather than binding Bridge directly to a public interface.

## 2. Target repository prerequisites

Each target repository must contain, on its trusted default branch:

```text
.bridge/project.json
.github/workflows/bridge-gateway.yml
.github/workflows/bridge-publish.yml
```

Canonical workflow templates are:

- `examples/bridge-gateway.yml`
- `examples/bridge-publish.yml`

Copy them into the target repository under the exact workflow names above.

For the gateway workflow, replace only the `runs-on` labels with the self-hosted runner labels that correspond to the repository's approved host policy.

Do not replace the pinned Bridge Action SHA with `@main` or another moving ref.

If Bridge is private, configure the Bridge repository's Actions access so the authorized target repository may use the private Bridge Action.

The host still needs its administrator-owned `/etc/bridge/host.json`.

## 3. Gateway workflow trust boundary

A normal run is not dispatched directly from the target branch.

The service:

1. resolves the repository default ref to exact trusted `policySha`;
2. resolves the requested target ref to exact `targetSha`;
3. creates the immutable Bridge request JSON;
4. creates a control commit whose parent is exactly `policySha`;
5. that commit adds only `.bridge/requests/<requestId>.json`;
6. creates a unique `bridge/requests/<requestId>` ref;
7. dispatches `bridge-gateway.yml` from that control ref.

The gateway workflow independently checks:

- its checked-out HEAD equals the workflow-dispatch SHA;
- the control commit parent equals `request.policy.sha`;
- the control commit added exactly one expected request file;
- request repository, ID, kind and exact target SHA match the dispatch envelope.

Only then does it checkout the exact target SHA and invoke Bridge.

Capability execution and edit prepare/verify have read-only GitHub permission.

## 4. Publish workflow trust boundary

Publication is separate.

`bridge-publish.yml`:

- runs on `ubuntu-latest`, not the privileged project runner;
- has `actions: read` and `contents: write`;
- downloads the exact source run artifact;
- requires a `VERIFIED` receipt;
- checks request/repository/base/policy/candidate binding;
- checks out the exact verified base with persisted credentials disabled;
- invokes only Bridge `publish-edit`;
- does not execute target project commands;
- uploads only `publish-result.json`.

Bridge still performs the final force-with-lease/base/candidate/tree/diff/trailer revalidation.

## 5. MCP host configuration

Install dependencies from a trusted Bridge checkout:

```bash
npm install --ignore-scripts --no-audit --no-fund
```

Required environment variables:

```bash
export BRIDGE_MCP_TOKEN='<random private bearer token, at least 24 characters>'
export BRIDGE_GITHUB_TOKEN='<repo-scoped GitHub credential>'
export BRIDGE_REPOSITORY_GRANTS='{
  "read": ["owner/project"],
  "run": ["owner/project"],
  "publish": []
}'
```

Optional:

```bash
export BRIDGE_MCP_HOST='127.0.0.1'
export BRIDGE_MCP_PORT='8787'
export BRIDGE_MCP_CLIENT_ID='bridge-private'
```

Then start:

```bash
node bin/bridge-mcp-server.mjs
```

Endpoint:

```text
http://127.0.0.1:8787/mcp
```

The process refuses non-loopback binds.

## 6. Repository grants

`BRIDGE_REPOSITORY_GRANTS` is the service-side allowlist.

Example:

```json
{
  "read": [
    "owner/read-only-project",
    "owner/runnable-project"
  ],
  "run": [
    "owner/runnable-project"
  ],
  "publish": [
    "owner/runnable-project"
  ]
}
```

Rules:

- `run` requires `read`;
- `publish` requires both `read` and `run`;
- unlisted repositories fail before GitHub API access;
- `bridge.publish` still accepts only `runId`; grants do not let a caller redirect the target branch.

For a read/run-only deployment, keep `publish: []`.

## 7. GitHub service credential

Prefer a GitHub App installation token for a durable deployment.

For a small private deployment, a fine-grained token may be used if it is restricted to the exact approved repositories.

The service needs enough repository authority to:

- read repository metadata/commits/policy files;
- create/delete Bridge control and temporary publish refs;
- dispatch the trusted workflows;
- list workflow runs/artifacts;
- download result artifacts.

In GitHub permission terms this normally means repository-scoped Contents read/write and Actions read/write, plus metadata read.

This credential remains on the MCP server. Target capability commands do not receive it.

The publish workflow uses its own job-scoped `GITHUB_TOKEN` only inside the isolated publication job.

## 8. MCP caller authentication

The private server requires:

```http
Authorization: Bearer <BRIDGE_MCP_TOKEN>
```

The token is compared in constant time and is separate from `BRIDGE_GITHUB_TOKEN`.

This private bearer mode is intended for controlled deployments. The production multi-user path uses the Cloudflare OAuth Provider and principal-scoped GitHub App authority rather than one shared static bearer secret.

## 9. Exposing the private development endpoint

The built-in process is intentionally loopback-only.

For a temporary/private remote MCP client:

```text
ChatGPT / Codex
      |
      | HTTPS + deployment authentication
      v
reverse proxy / approved tunnel
      |
      | loopback
      v
127.0.0.1:8787/mcp
```

The proxy/tunnel should:

- terminate TLS;
- restrict who can reach the endpoint;
- forward the Bridge bearer token only through an approved secret mechanism;
- connect to Bridge over loopback;
- rewrite the upstream Host header to the loopback origin so the MCP SDK's localhost Host/Origin guards remain effective.

Do not expose port 8787 directly to the Internet.

## 10. Validation before real use

Before authorizing a repository:

1. validate `.bridge/project.json`;
2. install the two exact workflow templates;
3. set the gateway runner labels deliberately;
4. confirm the Bridge private Action is usable by the target repository;
5. run one observe/verify capability;
6. inspect `bridge.get_result`;
7. for editing, run prepare/verify before enabling the repository in the `publish` grant;
8. only then test `bridge.publish`.

Production MCP distribution metadata must point at the real authenticated Bridge endpoint and must not embed the private harness bearer/GitHub credentials.

## 11. Relationship to the final remote control plane

This file describes the existing private harness only.

The final product target is:

```text
ChatGPT/Codex
  -> remote Bridge MCP control plane
  -> GitHub API / Actions
  -> self-hosted runner
```

The remote control plane owns caller authentication, principal-scoped repository authorization and GitHub App credential acquisition. The runner owns host-local policy and resources only.

Do not evolve the loopback bearer-token harness into the production multi-user authority model. Follow `docs/ARCHITECTURE.md`, `docs/REMOTE_DEPLOYMENT.md` and `docs/CLOUDFLARE_OAUTH_PROVIDER.md` instead.
