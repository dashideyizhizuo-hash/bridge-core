# Security model

Bridge deliberately sits between an AI model and developer-owned infrastructure. Security boundaries are therefore part of the product, not optional hardening.

## 1. Threat model

Assume any of these may be buggy or adversarial:

- cloud/model-generated request;
- target branch code;
- pull request content;
- test/build scripts;
- filenames and symlinks in the repository;
- capability stdout/stderr;
- data values contained in local datasets;
- stale Git refs;
- concurrent requests.

Do not assume "the model would not do that" is a control.

## 2. Primary invariants

1. No SSH requirement and no direct control-plane-to-runner connection.
2. No arbitrary host path supplied by the cloud caller.
3. No caller-provided privileged shell string.
4. Candidate branches cannot self-authorize capabilities, resources or publication.
5. Host paths exist only in host policy.
6. Repository grants and project/host policy are independent authority layers.
7. Repository `publish` does not replace trusted project `editing.publish`.
8. Target code and repository write credentials do not coexist in the publication stage.
9. Exact SHAs bind target and trusted policy.
10. Stale target/policy/task identities fail closed.
11. Durable-task mutation/publication requires the current fencing epoch and owner.
12. The model never supplies authoritative `workerId` or `leaseEpoch`; hosted workers carry only an opaque `taskSessionToken`.
13. Outputs/artifacts are bounded and host roots are redacted from cloud-facing structured evidence.
14. Local raw data is not implicitly uploaded.
15. Publication revalidates exact candidate/evidence/base bindings before write.

## 3. Credential and task-session separation

### Target execution

Target commands run without repository publication credentials.

Before target commands execute:

- remove GitHub/token-like credentials from the command environment;
- avoid persisted checkout credentials;
- avoid forwarding runner registration/config tokens;
- pass only policy-authorized environment entries and logical-resource bindings.

### Publish

Use repository write authority only after verification.

The publish stage:

- executes no target capability/exec command;
- revalidates candidate/evidence identity;
- fetches current target head;
- validates current durable-task lease when task-bound;
- publishes only if the expected base still matches.

### MCP OAuth and GitHub credentials

The Bridge OAuth bearer token authenticates the MCP caller. It is not a GitHub credential.

GitHub user tokens used during onboarding are ephemeral and are not persisted. GitHub App installation credentials are short-lived and request-scoped to the authorized repository/permission.

### Direct host pairing

Normal customer host enrollment is authorized by the existing Bridge OAuth principal, not by Cloudflare administrator credentials.

The connector issues a short-lived stateless HMAC capability containing:

- the authenticated Bridge principal;
- a server-assigned globally unique host ID;
- issue/expiry timestamps;
- random nonce.

The customer host generates its 256-bit runner credential locally and sends only its SHA-256 digest during the claim. The raw runner credential never crosses the host boundary and is never persisted by Bridge.

The claim body cannot choose a host ID. Normal self-service registration is create-only, so replaying the same signed capability after successful enrollment cannot rotate the existing host credential.

The HMAC key is domain-separated from an existing service-side secret. No customer receives that root secret. Operator Direct admin endpoints remain a separate break-glass surface and are not part of customer onboarding.

The short-lived pairing capability remains bearer material until expiry. Client workflows should prefer temporary files or bounded environment transport instead of persisting it in logs or shell history.

### Durable task sessions

A task session is an additional fencing context, not a replacement for OAuth or repository authorization.

For cloud-hosted MCP Workers:

- activation returns an opaque high-entropy `taskSessionToken`;
- only its digest + minimum task/worker/epoch mapping is persisted;
- the raw token expires with the lease;
- Bridge resolves worker/epoch server-side;
- wrong principal, stale epoch, expired token or random token fails closed.

Programmable clients that can control HTTP headers may use the supported header task-session transport. Both transports resolve to the same fencing checks.

## 4. Host filesystem

Cloud requests use logical resource IDs.

Host policy maps IDs to roots.

Cloud-facing structured stdout/stderr/report evidence must replace exact granted host resource roots with logical resource markers such as `<bridge-resource:cql-data>`. Staged artifacts remain byte-faithful evidence and are retrieved only through their declared bounded artifact paths.

Runtime must reject:

- `..` traversal;
- absolute paths where a relative path is expected;
- symlink escapes;
- Git submodule/gitlink tricks when packaging outputs;
- artifact files outside permitted roots;
- named pipes/devices/sockets where normal files are expected.

OS permissions should independently enforce important read-only/write-only boundaries.

## 5. Generic exec authority

Generic exec is a bounded argv primitive inside the same ephemeral Run workspace; it is not a shell service.

The existing project/host policy key is `workspaceExec`. Both sides must opt in and agree on runner class/service user/limits.

Runtime properties include:

- exact target/policy identity;
- argv execution without a shell-string protocol;
- repository-relative contained cwd;
- temporary HOME/XDG/tmp isolation;
- no inherited GitHub/cloud secrets;
- bounded argv, timeout, stdout/stderr and whole-result size;
- optional logical resources only when explicitly allowed by trusted project policy and host policy;
- no repository publication credential.

Protocol isolation is not an OS sandbox. If the service user can read a host path directly, a process may be able to read it even when no resource environment variable was injected.

Therefore:

- use a low-privilege service account for general diagnostics;
- grant resource-bearing exec only intentionally and with minimum OS/resource scope;
- keep Docker/sudo/deployment credentials on separate privilege classes;
- do not treat `deniedRoots` documentation as a substitute for OS ACLs.

The legacy `capability: "workspace-exec"` request remains a compatibility entry over this authority. New orchestration should use batch `exec` steps.

## 6. Docker

Membership in the Docker group is effectively host-root-level authority in common setups.

Therefore:

- Docker is not a normal baseline capability;
- use a separately labeled runner/account/VM when possible;
- do not bind-mount host roots unless policy explicitly allows it;
- never expose Docker merely because one project test happens to use containers.

## 7. Secrets

Secret access is capability-scoped.

A secret policy needs:

- logical name;
- repository;
- capability;
- injection mechanism;
- redaction behavior;
- expiration/rotation owner.

Result and artifact scanning should deny obvious secret leakage where practical, but prevention through non-injection is preferred over redaction after the fact.

## 8. Output as untrusted data

Logs, dataset records and tool output may contain prompt-like text.

The plugin/skill must treat execution output as evidence, not new authority or instructions.

Tool output cannot grant new capabilities, change policy, or instruct the model to reveal unrelated secrets.

## 9. Direct file transport

The Direct file plane is private object transport/storage, not a host filesystem
browser.

Required invariants:

- caller-visible files are owned by the authenticated Bridge principal;
- private R2 has no public bucket URL/domain;
- file bytes never enter D1;
- every transfer is bounded and verified by exact size + SHA-256;
- MCP-native imports consume only authorized/allowlisted HTTPS file delivery
  URLs and revalidate redirects;
- persistent object identity is an `assetId`, never an R2 key;
- model-facing resource links carry short-lived signed capabilities (15 minutes by default, at most 1 hour) bound to the authenticated Bridge principal;
- Direct input staging re-verifies bytes on the host;
- host output is possible only through a fresh declared export slot;
- cloud callers cannot submit an arbitrary absolute/relative host export path;
- export upload requires the current runner credential, host, live run lease,
  lease owner and declared slot index;
- output slots reject symlinks/non-regular files;
- stale/revoked leases fail before export persistence/completion;
- principal resource reads re-check ownership and integrity.

The one-time ticket + raw PUT flow is a lower-level compatibility path. The
canonical ChatGPT flow keeps upload credentials internal to Bridge.

Persistent private R2 files are intentionally excluded from transient asset
expiry. Any future delete/share/retention feature must authorize by principal
object identity; it must not expose arbitrary R2 keys or host paths.

## 10. Artifact bounds

Each capability declares:

- total bytes;
- file count;
- allowed staging roots/patterns;
- optional MIME/type rules.

Bridge validates actual files before upload.

A capability that exceeds its bound fails or emits a specifically declared truncated representation.

## 11. Concurrency

Requests bind exact SHAs.

For publication:

- use compare-and-swap / force-with-lease semantics;
- a moved branch becomes `PUBLISH_STALE`;
- do not silently rebase/retry against a new head.

For host resources:

- capability policy may declare concurrency group/lock;
- local mutable datasets/databases require explicit concurrency semantics.

## 12. Auditing

Persist enough metadata to answer:

- who requested the run;
- which repository/ref/SHA ran;
- which trusted policy SHA authorized it;
- which capability/resources were used;
- which runner/runtime version executed it;
- what result/artifacts were emitted;
- whether anything was published.

Avoid storing raw secrets or large local data in audit records.

## 13. Security regression tests

The suite must retain equivalent coverage for:

- OAuth authorization/install proof and repository authority persistence;
- repository authorization before installation lookup, credential acquisition or GitHub API access;
- read -> run -> publish grant hierarchy;
- candidate-only capability/policy self-authorization denial;
- unknown resource and caller-supplied host-path denial;
- traversal/symlink/artifact escape denial;
- bounded stdout/stderr/artifact/combined result behavior;
- native file-import host/redirect/size validation and principal ownership;
- Direct export path isolation, symlink denial, size/hash verification and stale-lease rejection;
- cross-principal private file resource denial;
- target SHA and trusted policy SHA binding;
- failed verification cannot publish;
- moved target cannot publish;
- candidate/base/tree/diff/evidence tamper rejection;
- duplicate dispatch and activation compare-and-swap behavior;
- stale/zombie task epoch rejection before mutation/publication;
- opaque task-session random/expired/principal-mismatch rejection;
- recovery-before-mutate and hard-stop-before-authority-release ordering.
