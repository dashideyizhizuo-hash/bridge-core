# Bridge

Bridge is a policy-bound execution bridge between cloud AI agents and user-owned engineering infrastructure.

Its purpose is:

> Let an AI use configured compute, local/private data and development environments without giving the model SSH, arbitrary host filesystem authority, long-lived repository credentials or direct runner connectivity.

## Current architecture

Bridge exposes one MCP surface over two execution planes:

```text
ChatGPT / Codex
  -> MCP OAuth 2.1
  -> Cloudflare OAuth Provider
  -> Bridge MCP control plane
       |
       +-> Direct Exec -> D1 queue <- outbound host runner
       |
       +-> GitHub Exec -> GitHub API / Actions -> self-hosted runner
```

Direct Exec is the simple default for ordinary host commands and local tools. GitHub Exec remains the durable engineering path for source mutation, trusted verification and publication. Neither path requires an inbound public port on the host.

The public MCP surface is intentionally fixed at six tools:

```text
bridge.discover
bridge.run
bridge.get_run
bridge.get_result
bridge.publish
bridge.task_transition
```

## Authority model

Authority depends on the selected execution plane.

Direct Exec:

```text
validated Bridge OAuth token
  ∩ authenticated Bridge principal
  ∩ principal-owned Direct host
  ∩ authenticated runner token
  ∩ host-owned /etc/bridge/host.json directExec authority
  ∩ low-privilege OS service user
  ∩ runtime limits
```

GitHub engineering work:

```text
validated Bridge OAuth token
  ∩ authenticated Bridge principal
  ∩ GitHub App installation
  ∩ repository read/run/publish grant
  ∩ trusted .bridge/project.json
  ∩ host-owned /etc/bridge/host.json
  ∩ runtime and task-fencing rules
```

A candidate branch cannot grant itself new authority. Repository publication still requires repository publish authority, trusted project publication opt-in, VERIFIED evidence, exact target/base binding and current task fencing when applicable.

No one layer can replace another.

## Execution model

The canonical execution model is:

```text
one Run
  -> one exact-target ephemeral workspace
  -> ordered bounded steps
       - exec
       - preset
       - edit
  -> one structured result
```

- **exec** runs bounded argv in the Run workspace. It is never a caller-provided shell string.
- **preset** executes a trusted named capability such as `dataset-status`, `unit-test` or `verify-offline`.
- **edit** mutates the same Run workspace under trusted path/operation policy.
- logical resources are requested by name; host paths remain host-local.
- successful edit Runs require a final trusted verification tail before emitting a VERIFIED candidate.
- publication is a separate `bridge.publish(runId)` stage with no target-code execution.

Named capabilities are presets over the generic execution substrate, not a second execution engine.

Legacy capability/edit requests and the `workspace-exec` compatibility entry remain supported where existing callers still use them. New orchestration should prefer ordered batch Runs.

## Direct Exec

Bridge also provides a host-first Direct Exec plane for ordinary operations that do not need Git engineering semantics.

After one host is enrolled and its outbound runner loop is running, a single-host call can be as small as:

```text
bridge.run(
  mode = direct,
  argv = ["ai-artist", "feedback-snapshot", "--hours", "48"]
)
```

Direct mode does **not** require a repository, target SHA, `.bridge/project.json`, GitHub workflow or repository grant. It reuses `bridge.get_run` and `bridge.get_result`; Direct runs are never publishable.

The host needs no public IP. It polls the Cloudflare control plane outbound and executes through the same bounded argv/process substrate under one configured low-privilege service account.

GitHub-backed Bridge execution remains the path for source edits, trusted verification, candidate evidence, publication and Durable Task Runtime engineering state.

See [Direct Exec](docs/DIRECT_EXEC.md).

### Direct Assets and private files

Bounded files use one private R2-backed Bridge file plane rather than D1,
GitHub commits, public host ports or project-specific file servers.

The canonical ChatGPT path is MCP-native:

```text
ChatGPT file
-> bridge.run(mode="asset", file=<authorized file param>)
-> Bridge fetches + hashes + stores private R2
-> READY temporary assetId + expiresAt
-> bridge.run(mode="direct", assets=[assetId], argv=[..., "{asset:0}"])
-> runner verifies SHA-256 and stages locally
```

Host outputs use declared slots rather than arbitrary host paths:

```text
bridge.run(
  mode="direct",
  exports=[{fileName,mimeType,maxBytes,required}],
  argv=[..., "{export:0}"]
)
-> fresh Bridge-owned output slot
-> runner hashes + uploads under the live run lease
-> temporary private R2 asset (24h by default)
-> bridge.get_result resource_link
-> authenticated MCP resource read
```

Files imported/exported through the canonical agent path are reusable,
principal-owned private R2 objects. The older one-time upload-ticket + raw PUT
flow remains only as a low-level compatibility path.

Direct files are capped at 25 MiB each, with at most 8 input assets and 8 export
slots per Direct Run. See [Direct Assets](docs/DIRECT_ASSETS.md).

### Self-service host connect

Customers do not configure Cloudflare, Wrangler, GitHub PATs, SSH keys or Direct admin secrets.

An authenticated Bridge user creates a short-lived pairing capability:

```text
bridge.run(mode="connect")
```

On the customer machine, the minimal host client performs the one-time binding:

```bash
bridge-host connect --endpoint https://<bridge-host>/mcp --pairing-token-file <file>
bridge-host doctor
bridge-host start
```

The runner credential is generated locally and never leaves the host; Bridge receives only its SHA-256 digest. Host IDs are assigned server-side, and normal self-service pairing cannot rotate an existing host.

The repository contains a deterministic builder for the minimal public `@dashideyizhizuo/bridge-host` package. Publishing that package is a distribution operation, not a requirement for the Bridge protocol itself.

## Durable Task Runtime

Long-running engineering tasks use a separate coordination layer without changing the execution plane:

```text
GitHub = durable engineering truth
D1     = current coordination truth
Worker = disposable
Watchdog = deterministic
lease_epoch = fencing token
```

A stale Worker cannot publish task-bound work after a newer epoch takes over.

Cloud-hosted MCP workers carry an opaque, short-lived `taskSessionToken`. The model does not declare `workerId` or `leaseEpoch`; Bridge resolves those server-side and reuses the existing D1 fencing checks.

While the owner/epoch and exact task binding are still current, successful Run
submission, polling, evidence retrieval and publication slide both the lease and
that token to one bounded expiry. A task transition instead releases or rotates
the session. Watchdog renewal for a live bound Run extends the same still-live
task-session capabilities; expired capabilities are never revived.

After persisting a GitHub checkpoint or blocker, a task-aware Worker uses `bridge.task_transition` to release the current lease as READY, BLOCKED or DONE. If the Worker fails before that call, the Watchdog performs one GitHub durable-state reconciliation only after lease expiry; an advanced checkpoint is adopted, while unchanged durable state is treated as a crash and redispatched.

Header-based task sessions remain available for programmable clients that control MCP HTTP headers.

See [Durable Task Runtime](docs/DURABLE_TASK_RUNTIME.md).

## Canonical configuration

Target repository:

```text
.bridge/project.json
```

Runner host:

```text
/etc/bridge/host.json
```

Bridge uses JSON as the canonical policy format.

The project policy defines:

- repository identity;
- logical runners;
- trusted named capabilities;
- generic exec authority through the existing `workspaceExec` policy key;
- logical resources;
- editing limits, paths and publish policy.

The host policy independently defines:

- allowed repositories;
- real runner classes/service users;
- logical-resource-to-host-path mappings;
- host-side exec/edit limits.

Real host paths never belong in cloud requests or project policy.

See [Project integration](docs/PROJECT_INTEGRATION.md) and [Runner setup](docs/RUNNER_SETUP.md).

## GitHub transport and workflows

The canonical target-repository workflows are:

- `examples/bridge-gateway.yml` — capability, edit and ordered batch execution on the self-hosted runner;
- `examples/bridge-publish.yml` — isolated verified publication on a hosted runner.

The gateway:

- binds the trusted control/policy identity;
- checks out the exact target SHA once;
- fetches the exact trusted policy commit shallowly when necessary;
- uses no persisted checkout credential for target execution;
- uploads only bounded result/evidence paths.

The publish workflow:

- has narrow GitHub write authority;
- executes no target project commands;
- downloads the exact VERIFIED source evidence;
- revalidates base/candidate/policy identity;
- fails closed if the target moved.

Target repositories should pin the Bridge action to an accepted commit SHA, not `@main`.

## Production and reference compositions

### Cloudflare product path

```text
src/cloudflare/worker-entry.mjs
  -> @cloudflare/workers-oauth-provider
  -> src/cloudflare/oauth-provider-app.mjs
  -> D1 identity / authorization / task coordination
  -> GitHub App credentials
  -> BridgeGateway / GitHubTransport
```

See [Remote deployment](docs/REMOTE_DEPLOYMENT.md) and [Cloudflare OAuth Provider](docs/CLOUDFLARE_OAUTH_PROVIDER.md).

### Node reference adapter

`src/node-remote-service.mjs` and `bin/bridge-remote-service.mjs` remain a supported reference composition for a normal Node host.

### Private MCP harness

`src/private-mcp.mjs` and `bin/bridge-mcp-server.mjs` remain a loopback/private development harness. They are not the production multi-user authority path.

See [Private MCP](docs/PRIVATE_MCP.md).

## Runner CLI

Requires Node.js 22+.

```bash
node bin/bridge-runner.mjs validate-host-policy \
  --host-policy /etc/bridge/host.json

node bin/bridge-runner.mjs validate-project-policy \
  --repo /path/to/checkout \
  --policy-sha <trusted-sha> \
  --repository owner/repo

node bin/bridge-runner.mjs doctor \
  --host-policy /etc/bridge/host.json \
  --repository owner/repo

node bin/bridge-runner.mjs execute \
  --request .bridge/requests/<id>.json \
  --repo . \
  --host-policy /etc/bridge/host.json \
  --output-dir .bridge-result
```

Legacy `prepare-edit`, `verify-edit` and `publish-edit` CLI stages remain for compatibility with the existing isolated edit workflow.

## Chat worker launcher

`bridge-chat` uses OpenCLI's Browser Bridge to create or continue an ordinary
ChatGPT web conversation in the operator's already-authenticated Chrome
session. It returns the exact conversation identity without echoing the prompt:

```bash
node bin/bridge-chat.mjs launch \
  --task owner/repository#147 \
  --dispatch dispatch-... \
  --prompt "Recover from the durable GitHub pointers and continue." \
  --json

node bin/bridge-chat.mjs create \
  --prompt "Read the durable GitHub task and wait for activation." \
  --json

node bin/bridge-chat.mjs send \
  --conversation 6ab1e2e4-dc48-83ec-b9d5-23e0c4c6625c \
  --prompt "Continue from the durable checkpoint." \
  --json

node bin/bridge-chat.mjs activate \
  --task owner/repository#147 \
  --dispatch dispatch-... \
  --conversation 6ab1e2e4-dc48-83ec-b9d5-23e0c4c6625c \
  --prompt "Recover from the durable GitHub pointers and continue." \
  --json
```

Use `--prompt-stdin` instead of `--prompt` for sensitive recovery text so the
outer wrapper command line does not carry it. Internally, `bridge-chat` sends
all OpenCLI arguments through a bounded stdin channel.

Prefer `launch` for a Durable Task Runtime dispatch. It provisions a fresh
ordinary Chat and asks it to complete a harmless `bridge.discover` call before
activation. The nonce-bound response is an availability screen, not trusted
authorization evidence; Bridge fencing remains the authority boundary. A
missing, failed, or ambiguous probe is rejected before dispatch consumption.
The launcher then keeps the returned task-session token off process command
lines while sending the activation through a bounded stdin channel. `create`,
`send`, and `activate` remain lower-level diagnostic and continuation commands.
If browser delivery fails after activation, wait for lease expiry instead of
retrying the consumed dispatch.

Wait for every launcher command to reach a terminal process result. In
particular, Runtime `RECOVERING` proves only that `activate` consumed the
dispatch; it does not prove browser delivery. Confirm delivery from the terminal
`activated-and-sent` result for the expected conversation identity. If the
command runner yields a session ID, retain it and resume that session instead of
treating the partial call as success.

The command is local operator tooling. It is not part of the Bridge MCP surface,
does not expose task-session tokens or browser cookies in its result or child
process command line. Browser authentication remains inside the local
OpenCLI/browser bridge.
It requires OpenCLI's Browser Bridge extension to be installed and connected.
Supervisor-to-Worker activation uses `send` so the continuation follows the
same ChatGPT web path as an operator typing into that conversation; Codex's
cross-thread messaging is not part of this launch path.

## Distribution package

The repository contains the private package binding plus its Skills:

```text
plugin.json
.app.json
.agents/plugins/marketplace.json
skills/
  runner-bridge/
  bridge-project-onboarding/
  continuous-github-development/
```

`plugin.json` references `.app.json`, which binds the package to the already-registered production Bridge ChatGPT app. The private marketplace entry installs the repository-backed `runner-bridge` plugin from this repository. These packaging files do not create a second MCP server, OAuth flow or authority model.

The Skill layer teaches agents how to use Bridge; it does not grant execution authority. A fresh ChatGPT acceptance still needs to prove that the installed/attached package exposes the existing Skills and six-tool Remote MCP in the client.

## Security invariants

Bridge is not:

- a general remote administration shell;
- SSH-as-a-service;
- a host filesystem browser;
- a way for a candidate branch to self-authorize;
- a reason to inject GitHub or cloud credentials into target commands;
- a replacement for project CI/release policy;
- a second durable engineering-history database.

See [Security](docs/SECURITY.md).

## Canonical documents

- [Architecture](docs/ARCHITECTURE.md) — current system structure and intentional compatibility layers.
- [Protocol](docs/PROTOCOL.md) — stable transport-independent request/result contract.
- [Batch Run v1](docs/BATCH_RUNS.md) — canonical ordered batch contract.
- [Security](docs/SECURITY.md) — authority and security invariants.
- [Remote deployment](docs/REMOTE_DEPLOYMENT.md) — production operations.
- [Cloudflare OAuth Provider](docs/CLOUDFLARE_OAUTH_PROVIDER.md) — production OAuth/onboarding flow.
- [Runner setup](docs/RUNNER_SETUP.md) — host setup and workflow contract.
- [Project integration](docs/PROJECT_INTEGRATION.md) — trusted project policy.
- [Durable Task Runtime](docs/DURABLE_TASK_RUNTIME.md) — continuous task coordination/fencing.
- [Private MCP](docs/PRIVATE_MCP.md) — intentional private/reference harness.
- [ChatGPT / Codex package](docs/CHATGPT_PLUGIN.md) — distribution and agent-facing behavior.
- [Roadmap](docs/ROADMAP.md) — historical program progression and deferred work.

Historical implementation decisions and checkpoints belong in GitHub Issues rather than being copied into the current architecture documents.

## Design principle

**Make the convenient path the safe path.**

## License and deployment

Source-available under [Elastic License 2.0](LICENSE), not OSI open source. The unmodified license governs permitted uses; this project does not add a blanket ban on commercial use. Third-party dependencies retain their licenses. For your own deployment, see [self-hosted configuration](docs/SELF_HOSTED_CONFIGURATION.md).
