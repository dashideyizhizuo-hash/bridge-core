# ChatGPT / Codex package

This document specifies the explicit-tool core release candidate. Host 0.5.0
is source preparation, not a claim that a registry package was published or a
particular self-hosted service was deployed. Build and inspect your local
artifact, choose your own endpoint and test its actual tool inventory.

## Package, deployment and authority

The three Skills teach when to use the configured Bridge MCP service. They do
not grant Host, repository, project or task authority. Follow
[Self-hosted configuration](SELF_HOSTED_CONFIGURATION.md) for operator settings
and [Host quickstart](HOST_QUICKSTART.md) for source-built installation.

The exported `.app.json` has no App binding. If you package the Skills for a
client that requires one, use your own verified connected App through the
existing package process. Preserve that identity on updates; never substitute
another deployment's App, endpoint, OAuth credentials or plugin identifiers.

The loopback private MCP harness and remote OAuth service expose the same
operation contracts, under their own configured principal and credentials.
See [Private MCP](PRIVATE_MCP.md) and
[Cloudflare OAuth Provider](CLOUDFLARE_OAUTH_PROVIDER.md). Neither transport
changes the policy, service-user, resource or exact-SHA execution boundaries.

## Seventeen fixed tools

Each tool represents one user goal, with a closed input schema and explicit
boolean safety annotations. No generic mode or arbitrary capability dispatch
is a model input.

| Goal | Tool | Principal input |
| --- | --- | --- |
| List owned computers | `bridge.list_hosts` | None |
| Prepare local pairing | `bridge.create_host_pairing` | Optional bounded lifetime |
| Pause Direct execution | `bridge.pause_host` | Owned logical `hostId` |
| Resume Direct execution | `bridge.resume_host` | Owned logical `hostId` |
| Run a Host command | `bridge.run_host_command` | `hostId`, argv and bounded command/file options |
| Import an attachment | `bridge.import_file` | Native `file`, optional temporary lifetime |
| Prepare byte upload | `bridge.create_file_upload` | Filename, MIME type, exact size and SHA-256 |
| Delete a permanent asset | `bridge.delete_file` | Owned `assetId` |
| Inspect repository setup | `bridge.get_repository_configuration` | Exact `repository` |
| Inspect project-tool availability | `bridge.repository_tools_status` | None |
| Run repository commands | `bridge.execute_repository_commands` | Repository/target, `expectedPolicySha`, command records |
| Run required project checks | `bridge.verify_repository` | Repository/target, `expectedPolicySha` |
| Edit and verify | `bridge.edit_and_verify_repository` | Same identities, bounded text edits, commit subject |
| Inspect task state | `bridge.get_run` | Actual `runId` |
| Read evidence and output files | `bridge.get_result` | Actual `runId` |
| Publish verified changes | `bridge.publish` | VERIFIED `runId` |
| Release a task stage | `bridge.task_transition` | READY/BLOCKED/DONE and matching checkpoint/blocker identity |

Inspect the actual deployment's descriptors and provider availability. A local
source build is not evidence that pairing, storage, GitHub credentials or an
Actions runner have been configured on a remote endpoint.

## Ordinary Host tasks

List Hosts and explicitly select a returned `hostId`. Use
`bridge.run_host_command` with bounded argv and a relative cwd. It waits up to
10 seconds by default; `waitSeconds: 0` returns an asynchronous receipt. A
response timeout or disconnect does not cancel or repeat the command. Once a
`runId` is available, inspect that same task with the getters before any new
submission. If the first response is lost, inspect actual execution and side
effects rather than assuming nothing ran.

This core does not accept a client `idempotencyKey` or promise persistent
submission deduplication. Internal request identities and the Host journal still
fence recognized execution/replay; they do not make two new submissions one task.

Source-built Host 0.5.0 requires your explicit HTTPS endpoint. It completes
browser OAuth, calls `bridge.create_host_pairing` and claims its short-lived
capability locally. Upgrades preserve saved Host identity, runner credential,
service settings and journal. Pairing material remains in the official flow
and private local storage, outside chat and ordinary logs.

Pause/resume change Direct Host execution permission. They do not undo completed
side effects or stop a separate GitHub Actions runner. A registration record
alone does not prove a live connection. Check actual Host status and last contact.

## Files in both directions

`bridge.import_file` declares a top-level native `file` through
`_meta["openai/fileParams"]: ["file"]`. Its inline closed object contains exactly
`download_url`, `file_id`, optional `mime_type` and optional `file_name`; the first
two are required. The server checks approved HTTPS delivery hosts, redirects,
size and SHA-256, then returns a READY temporary asset. Native import requires
no second caller-side PUT.

Pass returned asset IDs to the Host command's `assets` list and use exact
`{asset:N}` argv placeholders. Declare bounded `exports` and `{export:N}` slots
for output. The caller never supplies physical Host input/output storage paths.
Only `bridge.get_result` adds principal-bound MCP resource links for READY files;
resource reads verify ownership, expiry, size and SHA-256.

New native transfers normally expire 24 hours after READY. Use actual returned
deadlines and save needed files before expiry. Reads are retryable rather than
delete-on-read acknowledgements. Existing permanent assets keep their lifecycle;
`bridge.delete_file` requires specific owner authority and deletes only an owned
permanent asset, not a local Host file or retained execution receipt.

Programmable clients uploading their own bytes can use
`bridge.create_file_upload`, then its protected upload mechanism. A ticket does
not prove READY. Keep upload credentials within that client and use the returned
ticket deadline; it differs from the native import/export expiry.

## Repository engineering

1. Read `bridge.get_repository_configuration` for the authorized repository.
   Retain its exact policy SHA as `expectedPolicySha`. Resolve the existing target
   ref and optionally assert `targetSha`; the server pins the actual target before
   admission. Changed policy fails closed.
2. Use `bridge.execute_repository_commands` for 1–16 records with unique IDs,
   argv, relative cwd, logical resources and bounded timeouts. It accepts commands
   only and produces no publishable candidate. It does not accept mixed steps.
3. The trusted default policy must declare `mcp.verification`: 1–4 fixed entries
   such as `{capability:"verify",parameters:{}}`, each referring to a declared
   `class:"verify"` preset with reviewed fixed parameters and the real quality gate.
   `bridge.verify_repository` runs that recipe. Missing or stale recipe is an error.
4. `bridge.edit_and_verify_repository` applies bounded `replace-exact` /
   `apply-patch` modifications to existing tracked text files and runs the same
   mandatory checks. The caller cannot substitute verification or authorize from
   a candidate branch. Require actual VERIFIED evidence.
5. `bridge.publish` separately publishes the exact verified candidate subject to
   current repository authority, policy, target and task fences. A stale target
   is rejected rather than force-overwritten.

Extra trusted observe/verify presets have independent upfront descriptors with
server-generated names and closed schemas. Use only actual tools in the current
list; configuration capability IDs are not executable tool names. The extra
catalog allows at most 16 authorized repositories and 46 presets. Overflow makes
the entire extra catalog unavailable instead of silently truncating it; fixed
Host tools stay available. `bridge.repository_tools_status` reports actual policy
or catalog faults. Refresh client tool discovery after an approved catalog change.
No additional named mixed-workflow feature is promised by this release.

The internal batch envelope remains the runner protocol, not public MCP input.
Each Run has its own bounded workspace; separate Runs do not share scratch state.
Current engineering templates use Linux/x64/Bash. Configure the Actions runner
and protected Host policy separately from Direct Host pairing. Pin Bridge Actions
to your accepted immutable runtime SHA, never a branch name or another repository.

## Durable sessions

Carry only the activation-issued `taskSessionToken` on task-aware repository,
evidence, publication and transition calls. The server resolves its owner and
fencing epoch; the model does not supply authoritative `workerId` or `leaseEpoch`.
Successful current-owner operations may renew the bounded lease/session, so
result getters are not marked read-only merely because they retrieve evidence.

Persist the authoritative GitHub checkpoint or blocker before
`bridge.task_transition`. READY/DONE require its exact checkpoint SHA and comment
ID. BLOCKED supplies the stable matching reason. Only a valid READY `same-worker`
continuation may claim the next already-authorized stage; independent review uses
handoff. Keep raw session tokens out of source, checkpoints and ordinary logs.

## Acceptance

Use real SDK clients and the deployment runtime to inspect the tool inventory,
closed schemas, annotations and native file fields. Test unauthorized inputs,
policy/target/session drift, same-run recovery, transfers in both directions,
verified publication, and Host identity/service persistence across upgrade.

Run the public-core boundary gate, full relevant CI and package checks for the
exact candidate. A previous API scan, valid archive or successful source build
does not prove that a fresh ChatGPT/Codex connection has run these operations.
See [repository bootstrap](GITHUB_BOOTSTRAP.md), [Direct Exec](DIRECT_EXEC.md),
[Direct files](DIRECT_ASSETS.md), [protocol](PROTOCOL.md) and
[durable tasks](DURABLE_TASK_RUNTIME.md) for the individual contracts.
