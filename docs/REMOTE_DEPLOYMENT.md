# Remote Bridge deployment

Bridge uses an independent remote control plane. The product service does **not** require an inbound connection to the self-hosted host.

The canonical production topology has two execution planes:

```text
ChatGPT / Codex
  -> MCP OAuth 2.1
  -> Cloudflare OAuth Provider
  -> Bridge Worker
       |
       +-> Direct Exec -> D1 queue <- outbound HTTPS bridge-runner
       |
       +-> GitHub Exec -> GitHub App / Actions -> self-hosted runner
```

GitHub remains durable engineering truth for repository-backed work. D1 is the durable queue/current-state store for Direct Exec and the coordination store for Durable Task Runtime.

## 1. End-user experience

Your Bridge deployment runs as a service. Cloudflare, D1, R2, the GitHub App,
service secrets and deployment are its operator's concerns, separate from
connecting an end-user Host.

The connector flow is intentionally minimal:

```text
Connect Bridge in ChatGPT / Codex
  -> authorize Bridge OAuth / GitHub identity once
  -> ask Bridge to connect a host
  -> receive a short-lived pairing capability

On the customer host:
  bridge-host connect ...
  bridge-host doctor
  bridge-host start
```

End users do not:

- install Wrangler or sign in to Cloudflare;
- receive a Cloudflare API token or Direct admin secret;
- register a GitHub App;
- handle a GitHub App private key;
- create a PAT;
- enter an installation ID;
- create D1/KV/R2 resources;
- maintain repository-grant JSON merely to run Direct commands;
- expose a public IP or inbound port.

The customer host generates its runner credential locally. The raw runner credential never leaves that host.

Bridge operates one official service-owned GitHub App and one service-owned Cloudflare control plane. GitHub's native installation UI is used only when repository engineering authority is actually needed.

## 2. Runtime split

### Portable remote core

`src/remote-service.mjs` remains a platform-neutral fetch-native control-plane composition layer.

It does not depend on:

- `node:http`;
- local filesystems;
- process signals;
- WSL/runner paths;
- a listening TCP port.

### Cloudflare production composition

The product Cloudflare path is:

```text
src/cloudflare/worker-entry.mjs
  -> @cloudflare/workers-oauth-provider
  -> src/cloudflare/oauth-provider-app.mjs
  -> D1 identity / authorization stores
  -> GitHub App onboarding
  -> BridgeGateway / GitHubTransport
```

Cloudflare OAuth Provider owns:

- authorization-server metadata;
- protected-resource metadata;
- OAuth 2.1 authorization-code flow;
- PKCE validation;
- CIMD client discovery;
- DCR compatibility;
- access/refresh-token lifecycle;
- MCP bearer-token audience validation.

Bridge does not implement those protocol mechanisms itself.

### Node reference adapter

`src/node-remote-service.mjs` and `bin/bridge-remote-service.mjs` remain a reference deployment adapter for a normal Node host. They are not the preferred production product path.

## 3. Identity and authorization

The Cloudflare product path uses GitHub itself as the upstream user identity during Bridge authorization.

The effective authority remains:

```text
validated Bridge OAuth token
  ∩ Bridge principal
  ∩ GitHub App installation
  ∩ repository selected in GitHub
  ∩ Bridge read/run/publish grant
  ∩ trusted .bridge/project.json
  ∩ host policy
```

D1 stores identity/authorization plus the small Durable Task Runtime coordination record:

```text
BridgeUser
GitHubInstallation
UserInstallationGrant
RepositoryGrant
transient onboarding / OAuth authorization state
AgentTask current coordination state
```

The AgentTask row contains only current dispatch/lease/active-run/checkpoint pointers. GitHub remains the durable engineering journal and execution evidence store; D1 never becomes a second code/run history database.

## 4. GitHub authorization flow

When an MCP client reaches `/authorize`:

1. Cloudflare OAuth Provider parses and validates the MCP OAuth request.
2. Bridge stores only the bounded pending authorization transaction.
3. Bridge redirects to the official GitHub App installation page.
4. The user selects repositories in GitHub.
5. GitHub redirects to Bridge's setup URL with a candidate `installation_id`.
6. Bridge starts GitHub App user authorization with PKCE.
7. Bridge exchanges the callback code for an ephemeral GitHub user token.
8. Bridge verifies:
   - GitHub user identity;
   - installation is active;
   - the authenticated user can access the installation;
   - the repositories visible through that installation.
9. Bridge atomically persists principal / installation / repository grants.
10. Bridge calls Cloudflare `completeAuthorization(...)`.
11. The MCP client receives the Bridge authorization code/token and reconnects to `/mcp`.

The GitHub user token is never persisted and is never used as the MCP bearer token.

GitHub explicitly documents that a setup callback's `installation_id` must not be trusted by itself. Bridge therefore verifies it through the authenticated GitHub user's installation-repository endpoint before granting authority.

## 5. Browser-state binding

Bridge stores a short-lived opaque authorization state in D1 and binds the browser to it with:

```text
__Host-bridge_oauth_state
```

using:

- `HttpOnly`;
- `Secure`;
- `SameSite=Lax`;
- `Path=/`;
- bounded expiry.

The GitHub App installation URL also carries the opaque state.

If GitHub returns query state, it must match the cookie. If the setup redirect omits state, the host-bound cookie provides the browser correlation.

Installation binding and authorization-state consumption use atomic D1 `UPDATE ... RETURNING` / `DELETE ... RETURNING` transitions.

## 6. Public endpoints

The Cloudflare Worker exposes:

```text
/mcp
/authorize
/oauth/token
/oauth/register
/auth/github/setup
/auth/github/callback
/task-runtime/activate
/healthz
/readyz
```

Cloudflare OAuth Provider also serves the relevant well-known OAuth/MCP metadata endpoints.

The canonical MCP resource URL must be:

```text
https://<bridge-host>/mcp
```

## 6.1 Durable task Worker activation

A programmable Worker launched for an enrolled durable task activates its single-use dispatch at:

```text
POST /task-runtime/activate
```

The request contains only the durable task key and current dispatch ID. A successful activation returns a server-generated ephemeral Worker owner, current fencing epoch/expiry, canonical branch, execution mode, and the three task-session headers used on subsequent OAuth-protected `/mcp` requests.

The activation response contains no GitHub installation token, repository credential, OAuth bearer token, host path, or implementation handoff.

The dispatch ID is short-lived and single-use. Treat it like an authorization-code capability: do not log it broadly or place it in GitHub durable state. A stale/consumed dispatch returns a conflict and cannot mint another Worker session.

Task-session headers do not replace OAuth. The programmable Worker must still call `/mcp` through an authenticated Bridge principal whose repository grant permits the requested operation. Bridge additionally validates current lease epoch + Worker owner at task-aware Run submission, polling/evidence retrieval, publication and task-transition boundaries.

## 6.2 Durable task operator control

Durable task enrollment and manual watchdog ticks use an operator-only control endpoint:

```text
POST /task-runtime/control
Authorization: Bearer <BRIDGE_TASK_RUNTIME_ADMIN_TOKEN>
```

This endpoint is not an MCP tool and is absent (404) unless the admin secret is configured.

Enrollment requires an existing Bridge principal with repository `run` + `publish` grants and binds that principal to the D1 coordination row. It does not create repository authority.

The deployed Worker also has a five-minute Cloudflare Cron trigger. Automatic Cron processing is inert until `BRIDGE_TASK_LAUNCHER_URL` is configured. With a launcher configured, the scheduler performs deterministic Watchdog ticks and sends winning dispatches through the existing launcher CAS.

## 6.3 Cloud-hosted MCP task sessions

OpenAI-hosted ChatGPT/Plugin workers cannot rely on a local proxy or dynamically injected per-worker HTTP headers. For that path, durable-task activation also returns a short-lived opaque:

```text
taskSessionToken
```

The token is a transport capability only. It does not contain or replace:

- the Bridge OAuth access token;
- a GitHub App installation token;
- the task-runtime admin token;
- repository credentials.

Only a SHA-256 digest plus the minimum task/worker/epoch mapping is persisted in D1. The raw capability is returned only at activation time and expires with the stage lease.

Cloud-hosted workers pass this opaque capability through the task-aware MCP tool arguments:

```text
bridge.execute_repository_commands(..., taskSessionToken) / bridge.edit_and_verify_repository(..., taskSessionToken)
bridge.get_run(runId, taskSessionToken)
bridge.get_result(runId, taskSessionToken)
bridge.publish(runId, taskSessionToken)
bridge.task_transition(..., taskSessionToken)
```

The model does not supply `workerId` or `leaseEpoch`. Bridge resolves those server-side, verifies that the authenticated Bridge principal owns the enrolled durable task, and then reuses the existing D1 fencing checks. Successful current-owner task-bound operations transactionally slide the still-live lease and token to the same bounded expiry; unrelated traffic does not renew authority, and an expired or superseded capability is never revived. Watchdog renewal for a matching live bound Run extends the same still-live session capability to the renewed lease expiry.

Ordinary non-durable MCP calls remain unchanged.

For manual T8/operator flows, `bridge-task start` and `bridge-task activate` hide the capability by default. Use the explicit short-lived handoff flag only when the cloud Worker needs it:

```bash
bridge-task start owner/repo#123 --show-session-token
```

Treat the returned value as ephemeral capability material: do not commit it, persist it in Issues, or place it in long-lived logs.

## 7. Cloudflare resources

`wrangler.jsonc` declares:

```text
OAUTH_KV
DB
DIRECT_ASSETS (private R2 bucket)
```

without account-specific resource IDs so current Wrangler can auto-provision them.

Required compatibility flags include:

```text
nodejs_compat
global_fetch_strictly_public
```

The latter is required for secure CIMD document fetching.

D1 migrations live in `migrations/`.

## 8. Service-operator configuration

These steps happen once for the Bridge service, not once per user.

### Non-secret values

```text
BRIDGE_PUBLIC_URL=https://<bridge-host>/mcp
BRIDGE_GITHUB_APP_ISSUER=<GitHub App client ID or app ID>
BRIDGE_GITHUB_APP_CLIENT_ID=<GitHub App client ID>
BRIDGE_GITHUB_APP_SLUG=<GitHub App slug>
```

Optional:

```text
BRIDGE_GITHUB_API_BASE=https://api.github.com
BRIDGE_GITHUB_CALLBACK_URL=https://<bridge-host>/auth/github/callback
BRIDGE_TASK_LAUNCHER_URL=https://<programmable-worker-launcher>/launch
```

### Secrets

Store only in Cloudflare secret storage:

```text
BRIDGE_GITHUB_APP_PRIVATE_KEY
BRIDGE_GITHUB_APP_CLIENT_SECRET
BRIDGE_TASK_RUNTIME_ADMIN_TOKEN

# Optional service-operator break-glass control only.
# Normal customer Direct host enrollment does not use this secret.
BRIDGE_DIRECT_ADMIN_TOKEN

# Optional only when automatic Worker launching is enabled:
BRIDGE_TASK_LAUNCHER_TOKEN
```

Never place secret material in repository files, Wrangler vars, Issues, PR descriptions, logs or chat.

### GitHub App URLs

Configure the official Bridge GitHub App:

```text
Setup URL:
https://<bridge-host>/auth/github/setup

Callback URL:
https://<bridge-host>/auth/github/callback
```

Required repository permissions remain those already proven by `GitHubTransport`:

```text
Actions   read + write
Contents  read + write
Metadata  read
Issues    read
```

When `Issues: read` is newly added to the production GitHub App, existing installations must approve the permission change before durable task transition/reconciliation is operational. A merge or Worker deploy cannot grant this Provider authority by itself; the affected paths fail closed until approval.

Webhooks remain disabled unless a future feature explicitly needs them.

## 9. Cloudflare deployment

Install dependencies:

```bash
npm install
```

Create the private Direct Asset bucket once before the first deployment that includes the R2 binding:

```bash
npx wrangler r2 bucket create bridge-direct-assets
```

Do not enable an R2 public development URL or custom public domain for this bucket.

For an **existing production Bridge deployment**, upgrade in this order:

```bash
npm run cloudflare:migrate
npm run cloudflare:deploy
```

or use the equivalent guarded script:

```bash
npm run cloudflare:upgrade
```

The committed migrations are additive/backward-compatible with the previous Worker, so migrate-before-deploy avoids a window where new code is serving against an old D1 schema.

Do **not** let Cloudflare Git Integration auto-deploy this schema-changing release before the migrations have been applied. Pause/disable automatic production deployment for the upgrade, apply migrations, then deploy the accepted SHA and re-enable the normal delivery path if desired.

`wrangler.jsonc` sets `keep_vars: true`. This is intentional: Bridge's deployment-specific non-secret values may be managed in the Worker dashboard, and a code deploy must not silently delete them. Secrets remain in Cloudflare secret storage and are not committed to Wrangler vars.

If Bridge later moves all non-secret production values into version-controlled Wrangler `vars`, change this policy only as an explicit deployment migration rather than as an incidental cleanup.

For a **brand-new service** where Wrangler still needs to auto-provision the declared D1/KV resources, `npm run cloudflare:bootstrap` remains a first-bootstrap helper. It deploys once to provision resources and then migrates; do not attach clients or call that deployment production-ready until migration completes and `/readyz` succeeds.

Cloudflare Git integration may also import the repository and deploy it on pushes after schema/bootstrap acceptance. The Worker name must match `bridge-control-plane` from `wrangler.jsonc`.

## 10. Direct Exec host enrollment

### Normal customer flow

Normal Direct host enrollment is self-service through the authenticated Bridge connector. It does not require `BRIDGE_DIRECT_ADMIN_TOKEN`, Cloudflare access, Wrangler or D1 access on the customer machine.

The connector creates a short-lived pairing capability:

```json
{
  "mode": "connect"
}
```

Bridge allocates a globally unique logical host ID and returns:

- the Bridge `/mcp` endpoint;
- the reserved host ID;
- a short-lived signed pairing capability;
- expiry.

The customer host then uses the minimal host client:

```bash
bridge-host connect \
  --endpoint https://<bridge-host>/mcp \
  --pairing-token-file <temporary-file>

bridge-host doctor
bridge-host start
```

The host client:

1. refuses root;
2. generates a 256-bit runner token locally;
3. sends only its SHA-256 digest through `POST /direct/enroll/claim`;
4. accepts only the server-reserved host identity;
5. writes local policy and runner environment with mode 0600;
6. never returns or uploads the raw runner token.

The signed pairing capability carries the authenticated Bridge principal, reserved host ID, issuance/expiry and nonce. It is stateless and does not add a D1 migration. A replay after successful enrollment cannot rotate the already-created host because self-service registration is create-only.

After connection, inspect owned Hosts with `bridge.list_hosts()`. Pause the
chosen Host through:

```text
bridge.pause_host(hostId=<returned owned host ID>)
```

Use `bridge.resume_host` for an explicitly authorized resume. These are separate
operations, not a mode or enablement parameter on a generic executor.

Disabling the host reuses the existing Direct kill-switch semantics and cancels queued/running work.

### Service-operator break-glass controls

`BRIDGE_DIRECT_ADMIN_TOKEN` and the `/direct/admin/*` endpoints are service-operator break-glass controls only. They are not part of customer onboarding.

Credential rotation/recovery of an already-enrolled host must be treated as an explicit recovery operation rather than silently granting rotation through a normal pairing.

### Host distribution

The repository can build a minimal public customer package:

```bash
npm run host:package
```

which produces the allowlisted `@dashideyizhizuo/bridge-host` client, including browser pairing, foreground execution, current-user services and local maintenance. The package includes its Host license and one pinned MCP client dependency; the staged background daemon uses Node built-ins. It excludes server configuration, credentials and deployment tooling. See `HOST_QUICKSTART.md` for the candidate version and installation limits. Publishing the generated package to a public registry is a separate service-release action and requires package-registry publication authority.

### Direct Asset acceptance

After the existing Direct Asset service is deployed:

1. call `bridge.create_file_upload(fileName, mimeType, sizeBytes, sha256)`;
2. PUT the exact raw bytes to the returned one-time upload URL;
3. verify `bridge.get_result(da1:...)` reports `READY`;
4. submit a Direct Run with `assets:[assetId]` and exact `{asset:0}` argv;
5. verify the runner privately downloads and validates size/SHA-256.

No Cloudflare credential or public host IP is involved in this customer flow.

## 11. Health and readiness

```text
GET /healthz
GET /readyz
```

`/healthz` is liveness only. `/readyz` compiles probes against the Direct Exec/Asset production schema and returns HTTP 503 if required migrations are missing. A successful readiness response also reports whether Direct Assets and the Direct admin endpoint are configured.

No endpoint exposes credentials, installation tokens, repository-grant internals or runner paths.

## 12. Production acceptance checklist

A deployed Bridge control plane should be considered operational only when all applicable checks pass:

1. the deployed Worker revision corresponds to an accepted Bridge `main` revision;
2. all committed D1 migrations have been applied in order, without rewriting historical migrations;
3. required non-secret values and secrets are present;
4. `GET /healthz` and `GET /readyz` succeed;
5. unauthenticated `/mcp` returns the expected OAuth challenge rather than executing a tool;
6. GitHub App user/install/repository proof succeeds for an authorized repository;
7. the connected MCP client sees the explicit fixed tool registry and only fully
   declared permitted preset tools; repository_tools_status reports catalog faults;
8. an authenticated `discover -> run -> get_run/get_result` flow succeeds through GitHubTransport;
9. a VERIFIED edit candidate can be published only when repository grant + project publication policy + stale-base/fencing checks all pass;
10. reconnect/onboarding does not downgrade repository grants;
11. Dashboard-managed non-secret Worker variables survive code deployment;
12. no credential, installation token or physical host-resource path is exposed in normal results/errors;
13. if Direct Exec is enabled, one registered host can complete a real `bridge.run_host_command -> get_run/get_result` flow without a repository;
14. a Direct Exec run cannot be passed to `bridge.publish` and runner-token mismatch/stale completion fail closed.

Durable Task Runtime acceptance additionally requires current-epoch activation, active READY/BLOCKED/DONE transition, expiry-only GitHub reconciliation, crash/takeover recovery and stale-worker rejection.

See `docs/CLOUDFLARE_OAUTH_PROVIDER.md` for OAuth/onboarding details and `docs/DURABLE_TASK_RUNTIME.md` for task fencing.
