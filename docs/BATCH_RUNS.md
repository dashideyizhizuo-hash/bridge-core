# Internal Batch Run v1 — Issue #39 contract

This is the protocol lock for the six implementation slices in #39, not a new
Bridge architecture. Slice 1 defines and tests the contract; later slices wire
it into execution, transport and the real Crypto consumer. A merged contract
alone does **not** mean the deployed MCP endpoint accepts batches.

## One Run, one workspace

One internal batch request describes bounded ordered work. The trusted workflow
materializes the exact target once. Every step uses that workspace; no step
checks out another tree or fetches another revision. Changes and scratch files
remain visible to later steps. The workspace is discarded as a unit when the
Run ends. A new Run starts clean from its own exact target SHA.

Git object reuse is permitted. Persistent dirty sessions, per-command worktrees,
DAGs, loops, conditions, retry languages and a custom cache manager are not.

Model callers use separate user-goal tools; see [the MCP contract](CHATGPT_PLUGIN.md):

```
bridge.execute_repository_commands
bridge.verify_repository
bridge.edit_and_verify_repository
bridge.get_run  bridge.get_result  bridge.publish  bridge.task_transition
```

## Request

The internal envelope contains `mode: "batch"`, exact repository/target/policy
identity and server-compiled `steps`. The public command tool accepts only
command records; the verification/edit tools obtain required checks from trusted
`mcp.verification`. Callers assert `expectedPolicySha` but cannot select another
authority source, supply mixed steps, Host paths, runner labels, environment
overrides or publication credentials. The mixed example below documents the
runner protocol; it is not an accepted public tool invocation.

Durable request (`schemas/batch-request.schema.json`):

```json
{
  "schemaVersion": 1,
  "mode": "batch",
  "requestId": "bridge-example-0001",
  "repository": "owner/project",
  "target": {"ref": "agent/task", "sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
  "policy": {"ref": "main", "sha": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
  "commitSubject": "Fix the small example",
  "steps": [
    {"id": "status", "type": "exec", "argv": ["git", "status", "--short"]},
    {"id": "inspect", "type": "preset", "capability": "dataset-status", "parameters": {}},
    {"id": "change", "type": "edit", "operations": [
      {"type": "replace-exact", "path": "src/example.py", "oldText": "return 1", "newText": "return 2"}
    ]},
    {"id": "verify", "type": "preset", "capability": "verify-offline", "parameters": {}}
  ]
}
```

`schemaVersion: 1` and `mode: "batch"` identify this internal contract.
Its shapes remain unambiguous:
capability requests contain `capability`, edit requests contain `operations`,
batch requests contain `mode: "batch"` and `steps`. Mixed shapes are invalid.

### Step types

**exec** takes an argv array, optional repository-relative `cwd` (default `.`),
optional `resources` (default `[]`) and optional `timeoutSeconds`. No shell-string
field, caller environment or arbitrary output/artifact path. An argv program can
write scratch files, but that does not grant publication or host administration
rights. A requested timeout can only lower the effective limit.

**preset** takes a trusted capability name and typed `parameters` (default `{}`).
Its argv, runner, logical resources and declared outputs come from the exact
trusted project policy. It compiles to the same command execution primitive as
exec; it is not another execution subsystem. A preset cannot override its argv,
resource bindings or limits through the cloud request. Existing dataset presets
remain project configuration, not Bridge core concepts.

**edit** contains the existing `replace-exact` / `apply-patch` operations and
mutates the current Run workspace. Keep existing path/branch/size/type restrictions
(including protected `.git`, `.github`, `.bridge` and gitmodule paths). V1 keeps
the existing restriction to text modifications of tracked regular files. A
single Run-level commit subject is required whenever an edit step is present.
There is no `publish` step; `bridge.publish(runId)` is separate authority.

### Hard bounds

| Item | Batch v1 ceiling |
| --- | --- |
| Steps | 1–16, unique IDs matching `[A-Za-z][A-Za-z0-9._-]{0,63}` |
| Exec argv | 1–64 nonempty strings; 4,096 UTF-8 bytes each; 32,768 bytes total |
| cwd | 1–512 characters, contained relative directory; resolve again at execution |
| Requested resources | 0–16 unique logical names |
| Edit operations | 64 across the entire batch, not 64 per step |
| Request | 262,144 UTF-8 bytes of compact JSON |
| Run execution time | At most 3,600 seconds; remaining deadline bounds each step |
| Combined result | At most 4,194,304 UTF-8 bytes including all evidence |

Project and host limits may lower these ceilings, never raise them. Existing
capability/edit request limits are not silently reduced by the new batch ceiling.
Per-step stdout/stderr/report/artifact limits still apply; their effective limits
also fit the remaining batch budget. No private data is implicitly uploaded.

## Authority and logical resources

Authorize **all** steps before running the first one. Resolve project policy once
at policy SHA, host policy once, and require one compatible runner class for the
whole batch. A later denied step must not leave an earlier edit half-executed.
Runtime path/resource checks still run at point of use; the preflight is not a
substitute for checking a symlink or stale file after preceding steps.

Keep existing policy format. Add a generic `exec` opt-in using the existing
workspaceExec limit/runner pattern, with logical resource declarations using
existing `{ "name": "resource-id", "env": "PROJECT_RESOURCE_DIR" }` bindings.
Project-declared exec resources and host repository resource grants must both
allow the resource. The caller supplies names only. Presets use their own trusted
resource declarations. Host physical mappings never appear in discovery or the
cloud protocol; stdout/stderr/reports/errors redact granted physical roots.

Both project **and** host must opt in to exec and editing. One owner-approved
runner/service account may serve exec, resources, edit and verify. This is not a
filesystem sandbox: the service account's OS permissions remain the outer
boundary. Resource omission and isolated HOME do not revoke existing OS access.
Do not silently convert a legacy low-privilege workspaceExec grant into a new
resource-bearing exec grant. No container platform is required by this contract.

## Step and result behavior

`bridge.get_run` retains the current queued/running/terminal transport lifecycle.
`bridge.get_result` returns terminal batch evidence, not a second scheduling API.

`schemas/batch-result.schema.json` defines a result with `mode: "batch"`, exact
request/target/policy identity, request digest, timestamps, total duration and a
`steps` array in **the original order**. Each entry has `id`, `type`, `status`,
`durationMs`, plus bounded execution/evidence or a stable `{code,message}` error.
No physical workspace path is a public result field.

Step statuses are `SUCCEEDED`, `FAILED`, `DENIED`, `STALE`, `CANCELED`, `SKIPPED`.
Run statuses are `SUCCEEDED`, `VERIFIED`, `FAILED`, `DENIED`, `STALE`, `CANCELED`.
Only `VERIFIED` includes a publishable candidate. `SUCCEEDED` alone is never
publication authority. Logical policy metadata describes permissions, not trust
in the content of execution output.

Fail-fast is mandatory in v1: keep every completed step result; retain bounded
failure evidence for the failing step; mark the suffix `SKIPPED`, duration 0.
Preflight rejection runs nothing: the offending step is denied and all other
steps are skipped. An overall binding failure may report all steps skipped plus
the top-level error. Unknown protocol fields/types/duplicate IDs are rejected as
`INVALID_REQUEST` before dispatch. Existing policy, identity, edit, timeout and
output error classes remain usable; do not make callers scrape logs.

## Edited workspace, verification and receipt

Edits and later verification see the same working tree. Verification is an
ordinary trusted preset with `class: "verify"`, not a separate executor. Arbitrary
caller-supplied `exec` success is useful evidence but cannot by itself mark a
candidate VERIFIED. All effective verification presets must execute after the
last edit, against the exact resulting state. Preserve the existing limit of up
to four trusted verification presets for edited publication.

A verification step must not change publishable files. A later mutation
invalidates earlier verification. Revalidate final allowed paths, exact base,
policy, candidate tree/diff and verification evidence before emitting a candidate.
A changed HEAD/index, failed step, incomplete verification, output overflow or
stale identity cannot yield a VERIFIED receipt. Edits are not rolled back within
a failed Run; its entire ephemeral workspace is discarded and nothing publishes.

Create one candidate commit/bundle and receipt after successful verification.
Reuse the existing candidate/publication format and validation where possible;
existing prepare/verification artifact filenames may remain as compatibility
packaging, **not** evidence of extra workspaces or jobs. A batch receipt must not
falsely claim `executionMode: "NO_TARGET_CODE"`; use an explicit shared-workspace
execution marker. Keep the original immutable request and its digest bound to
the candidate. Do not convert a batch to a new unbound publication request.

`bridge.publish(runId)` uses the existing separate publication job, executes no
target code, reloads trusted policy and revalidates exact request/base/policy/
candidate/tree/diff/verification bindings. Target branch is derived only from the
original Run. A moved branch fails `PUBLISH_STALE`; never rebase or redirect.

## Compatibility and removal order

- Existing `mode: "capability"` and `mode: "edit"` public inputs remain valid.
- Existing dataset-status/dataset-inspect parameter and result contracts remain.
- `workspace-exec` remains a compatibility alias; generic callers use exec.
- Normalize legacy requests into shared execution primitives where practical;
  retain legacy result envelopes rather than require all callers to migrate.
- Keep existing CLI adapters only as needed for compatibility. Remove duplicated
  worktree and command loops instead of maintaining two execution engines.
- Neither deployed endpoint support nor host permission is inferred from merged
  code. Discovery and real Crypto acceptance must prove them.

## Slice boundaries

1. Protocol/schema/negative tests only; no production authority or execution switch.
2. One-workspace ordered executor and exec; shared bounded result/fail-fast.
3. Logical resource binding and preset delegation; preserve dataset compatibility.
4. In-workspace edit/verify/candidate; shared separate publication authority.
5. Single target checkout, exact/shallow retrieval and thin reusable workflows.
6. Crypto policy/workflow/host adoption and real discover → batch → result → publish.

Do not declare #39 complete before the final real loop updates its bound Crypto
branch and the exact run/candidate/publish identities are recorded in the issue.
