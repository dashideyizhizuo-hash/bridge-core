# Bridge protocol v1

Bridge keeps one stable public MCP surface while supporting two compatible internal request shapes:

- [Batch Run v1](BATCH_RUNS.md) is the canonical request/result contract for new execution: one Run, one shared exact-target workspace, ordered `exec` / `preset` / `edit` steps.
- The capability/edit request described below remains the supported compatibility contract for existing callers and the legacy isolated edit workflow.

The six public MCP tool names are independent of those internal request shapes. `bridge.task_transition` is the only task-lifecycle tool; it does not add execution authority.

## MCP request budgets

HTTP MCP JSON-RPC request bodies are limited to **2 MiB**, including the envelope
and JSON escaping. Declared and streamed lengths are checked before JSON parsing;
oversized or inconsistent lengths receive HTTP413 and the source is canceled.
Tool arguments are additionally limited to **10,000 total array elements and
object keys** before schema validation. Oversized argument structures return a
tool error without reaching a gateway. Authentication and project/host policy
checks still apply to requests within these budgets.

These are transport/admission limits, separate from the smaller limits on Direct
argv, batch requests and trusted editing policy. A custom project may allow a
4MiB edit or a long capability string, but that does not raise the HTTP limit;
split large work into independently valid requests. Binary file payloads use the
bounded asset transfer endpoints, not a JSON-RPC body. Keep a fresh Server per
request and exact resource/audience validation; do not supply an unchecked
`parsedBody` to bypass the SDK's byte guard.

## 1. Request lifecycle

Statuses:

```text
QUEUED
CLAIMED
RUNNING
SUCCEEDED
FAILED
DENIED
STALE
CANCELED
```

`DENIED` means policy rejected the request before target execution.
`STALE` means an exact identity binding no longer matches.

## 2. Run request

Conceptual shape:

```json
{
  "schemaVersion": 1,
  "requestId": "01J...",
  "repository": "owner/repo",
  "target": {
    "ref": "codex/my-work",
    "sha": "40-hex-sha"
  },
  "policy": {
    "ref": "main",
    "sha": "40-hex-sha"
  },
  "capability": "dataset-inspect",
  "parameters": {
    "dataset_id": "..."
  }
}
```

Rules:

1. `repository` is explicit.
2. `target.sha` is mandatory for execution.
3. `policy.sha` is mandatory and must contain the capability definition.
4. `parameters` must validate against the capability schema.
5. Callers cannot provide host paths, shell fragments, environment overrides, runner labels, GitHub tokens, artifact paths or executable substitutions unless the capability schema explicitly defines a safe typed parameter for that purpose.

## 3. Capability resolution

The runtime loads the capability from the trusted `policy.sha`, not the target SHA.

Resolution:

```text
request capability
  -> trusted project policy
  -> required logical resources
  -> host repository grant
  -> host logical resource mappings
  -> effective execution plan
```

Any missing element is a denial.

## 4. Command representation

Privileged capabilities use argv arrays.

Good:

```yaml
argv:
  - uv
  - run
  - cql
  - dataset-inspect
  - --dataset-id
  - "{params.dataset_id}"
```

Not permitted as the canonical format:

```yaml
shell: "uv run cql dataset-inspect --dataset-id $WHATEVER && ..."
```

Parameter interpolation produces exactly one argv element. It never re-parses into shell syntax.

## 5. Resource representation

Project policy names resources:

```yaml
resources:
  - name: cql-data
    env: CQL_DATA_DIR
```

Host policy maps them:

```yaml
resources:
  cql-data:
    root: /data/cql
```

The caller never supplies the root.

## 6. Output contract

Every execution emits `bridge-result.json`.

Minimum fields:

```json
{
  "schemaVersion": 1,
  "requestId": "...",
  "status": "SUCCEEDED",
  "repository": "owner/repo",
  "targetSha": "...",
  "policySha": "...",
  "capability": "dataset-inspect",
  "runner": {
    "class": "cql-research"
  },
  "execution": {
    "exitCode": 0,
    "durationMs": 1234
  },
  "evidence": {
    "stdoutBytes": 123,
    "stderrBytes": 0,
    "artifacts": []
  }
}
```

A capability may additionally designate one small structured report file to inline in the cloud-facing result.

## 7. Output bounds

Bounds are part of policy, not caller preference.

At minimum:

- stdout maximum;
- stderr maximum;
- artifact maximum total bytes;
- maximum artifact file count;
- timeout;
- structured report maximum.

On overflow the runtime either truncates according to declared policy or fails closed. Raw private datasets are never implicitly uploaded.

## 8. Failure classes

Stable classes should include:

- `INVALID_REQUEST`
- `UNKNOWN_CAPABILITY`
- `PARAMETER_DENIED`
- `POLICY_STALE`
- `TARGET_STALE`
- `HOST_RESOURCE_DENIED`
- `RUNNER_UNAVAILABLE`
- `EXECUTION_TIMEOUT`
- `EXECUTION_FAILED`
- `OUTPUT_LIMIT_EXCEEDED`
- `OUTPUT_ENCODING_INVALID` — child stdout/stderr is not UTF-8; invalid stream text is omitted rather than silently replaced
- `WORKSPACE_MUTATED` when mutation is forbidden
- `EVIDENCE_INVALID`
- `PUBLISH_DENIED`
- `PUBLISH_STALE`

Agents should reason from these classes rather than scraping arbitrary logs.

## 9. Transport envelope

The default GitHub transport persists the logical request as an immutable JSON object, binds it to exact control/target/policy identities and dispatches the trusted gateway workflow.

Reference/private transports may carry the same logical contract through another adapter.

Transport metadata must not broaden or change request authority. In particular it cannot replace the trusted policy SHA, host policy, repository grant or task-fencing identity.

## 10. Direct file object contract

Direct Exec files use a private object plane orthogonal to GitHub engineering
artifacts.

A caller-visible file object is identified by:

```text
assetId
principal owner
filename
MIME
exact size
SHA-256
lifecycle (transient or persistent)
private R2 object key (server-side only)
```

The private object key and host staging path are never caller authority.

Canonical MCP ingress accepts the host-provided ChatGPT file parameter,
downloads it inside Bridge under a restricted HTTPS policy, verifies bounded
bytes, persists a stable source/object identity before the R2 write, and then
atomically finalizes a persistent READY asset. Interrupted internal writes remain
bounded WAITING records owned by scheduled cleanup. Low-level upload tickets
remain a compatible alternate ingress.

A Direct Run may bind owned READY input assets and declare bounded export slots.
Runner input download authorization is scoped to the authenticated host, current
RUNNING lease, lease owner, Run ID and that Run's declared asset membership; a
host credential by itself does not authorize arbitrary same-owner file reads.

Slot declarations contain only filename, MIME, maximum bytes and
required/optional state. At execution time the runner materializes a fresh
host-owned slot and may upload it only while the run lease remains current.
Export authorization binds:

```text
runner credential
∩ host
∩ live run
∩ lease owner
∩ declared export index
```

A terminal result may include READY export asset receipts. MCP mints a short-lived signed resource capability for each returned file. The capability is principal-bound and expires independently of the persistent object; binary payloads remain outside D1, stdout and ordinary structured JSON.

Persistent file objects may be rebound to later Direct Runs. Transient cleanup
must not delete persistent objects.

## 11. Publication receipt

A publish operation must bind:

- verified request ID;
- base SHA;
- candidate SHA;
- candidate tree SHA;
- changed-file digest;
- verification result digest;
- target branch;
- policy SHA.

Publication fails if the remote target head is no longer the verified base.

## 12. Versioning

`schemaVersion` changes only for incompatible protocol changes.

Compatible additions:

- optional result metadata;
- new error classes;
- new capability metadata ignored by old clients.

Incompatible changes require a new schema version and an explicit migration window. Bridge should prefer one current version rather than indefinite compatibility branches.
