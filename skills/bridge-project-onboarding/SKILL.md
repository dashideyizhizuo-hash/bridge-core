---
name: bridge-project-onboarding
description: >
  Onboard a GitHub repository and self-hosted runner into Bridge so an Agent can
  discover, run, edit, verify, and publish code through Bridge's public MCP tools.
  Use this skill for new hosts, new repositories, runner changes, repository authorization,
  host/project policy configuration, workflow installation, acceptance testing, and common
  Bridge authorization failures.
---

# Bridge Project Onboarding

## Purpose

Use this Skill only when a GitHub repository must become a Bridge **engineering** target for source mutation, trusted verification and/or publication.

Do **not** invoke repository onboarding merely to run ordinary host commands, installed CLIs, browser automation, local SQLite/data inspection, media conversion or other non-Git operations. Those should use the host-first Direct Exec plane after one host-level enrollment:

```text
bridge.discover()
-> bridge.run(mode="direct", argv=[...])
-> bridge.get_run
-> bridge.get_result
```

Direct Exec intentionally requires no target repository, `.bridge/project.json`, repository grant, per-project runner class or GitHub gateway workflow.

Use the remainder of this Skill when the requested operation actually needs Git engineering semantics.

For a new repository, prefer the repository-owned bootstrap instead of manually
copying policy/workflow templates. Set `BRIDGE_RUNTIME_SHA`, `RUNNER_CLASS` and
`RUNNER_SERVICE_USER` from the verified runtime/host inventory before running:

```bash
node bin/bridge-runner.mjs bootstrap-project \
  --bridge-repository YOUR-OWNER/YOUR-RUNTIME \
  --bridge-sha "$BRIDGE_RUNTIME_SHA" \
  --repo /path/to/repository \
  --verify-argv '["<real>","<project>","<quality-gate>"]' \
  --runner-class "$RUNNER_CLASS" \
  --service-user "$RUNNER_SERVICE_USER"
```

Bootstrap generates the project policy and pinned gateway/publish workflows.
The actual default service user is `bridge-runner`, not the caller: pass the
GitHub Actions runner's actual OS account explicitly. Current templates select
`[self-hosted, linux, x64, <runner-class>]` and read `/etc/bridge/host.json`.
Optional `--host-policy` merges that local file but does not rewrite the workflow
path; stage/admin-review that change before replacing a protected active policy.
The merge writes a private file mode, so verify intended runner read access after
installation. The administrator-owned policy and parent directory must remain
unwritable by target code. Existing unrelated entries/resources must be preserved.

Host npm 0.4.2 does not include this bootstrap CLI. Obtain it from the public
`dashideyizhizuo-hash/bridge-core` source at an accepted exact SHA; no private
operated-service source is needed. The runtime repository and SHA must refer to
the same accessible source. Node.js 22+ suffices for the bootstrap path. Public
source availability does not authorize changing the runtime repository as an
acceptance target.

Bootstrap neither creates a real quality-gate script nor installs project
dependencies. Supply the actual trusted verifier argv; prepare a repository-owned
wrapper if a fresh workspace needs dependency installation/tests/builds. Review
and merge the three generated files into the default branch, then create an
approved existing remote `agent/**` or `codex/**` target before edit acceptance;
bootstrap's default edit branch patterns exclude `main`.

GitHub App installation, the service's repository grant/selection and runner
registration are separate external boundaries. A paired Direct Host is not a
GitHub Actions runner. Direct Host pause does not stop already dispatched Actions.
Bootstrap grants none of those external rights and changes no visibility,
licensing, account ownership or fee rules.

The intended GitHub-engineering end state is:

```text
ChatGPT / Agent
    ↓
Bridge MCP
    ↓
GitHub control plane
    ↓
GitHub Actions
    ↓
self-hosted runner
    ↓
one Run / one workspace
    ↓
exec + logical resources + edit + trusted verify
    ↓
VERIFIED candidate
    ↓
bridge.publish(runId)
    ↓
GitHub target branch
```

A correctly onboarded repository should support the five-tool execution loop:

```text
bridge.discover
→ bridge.run
→ bridge.get_run
→ bridge.get_result
→ bridge.publish
```

Do not add repository-specific MCP tools unless the Bridge architecture itself changes. Named capabilities are presets over the common execution substrate.

---

# 1. Core authority model

Bridge authorization is intentionally layered.

Effective authority is the intersection of:

```text
Bridge principal repository grant
    ∩
trusted repository .bridge/project.json
    ∩
host-owned /etc/bridge/host.json
    ∩
GitHub App permissions
    ∩
runner class / service user
    ∩
OS filesystem and process permissions
```

A repository must not be able to grant itself host authority.

A target workflow must not modify `/etc/bridge/host.json`.

A project policy must not reveal physical host paths.

---

# 2. Default repository grant semantics

For an explicitly authorized full autonomous-development delivery flow, request
the following effective rights only when both the user's GitHub rights and App
installation profile permit them:

```text
can_read    = 1
can_run     = 1
can_publish = 1
```

Rationale:

```text
run
→ edit
→ verify
→ VERIFIED candidate
→ publish
```

is one complete development-delivery cycle.

`can_publish=1` does **not** bypass the rest of the Bridge safety model. Publication still requires:

- an existing repository grant;
- a VERIFIED candidate;
- project policy `editing.publish = true`;
- a target branch permitted by project policy;
- an exact bound base/target identity;
- stale-target / lease checks;
- GitHub write authority in the isolated publish workflow.

`can_publish=0` is not automatically deployment drift: a read-only user, restricted
App installation or intentionally limited grant must remain restricted. Diagnose
drift only against the independently verified intended effective authority. Use
the deployment's supported authorization flow; do not edit identity/grant records
to manufacture permission or change account ownership.

Do not globally remove repository authorization.

---

# 3. Repository onboarding inventory

Before changing anything, establish the durable state.

Record:

```text
Repository:
<owner/repo>

Default branch:
<main/master/etc>

Exact default HEAD:
<SHA>

Bridge main/runtime pin:
<SHA>

Self-hosted machine:
<hostname>

GitHub runner name:
<runner name>

Runner labels:
[self-hosted, OS, arch, project runner class]

Service user:
<OS user>

Host policy path:
/etc/bridge/host.json

Required logical resources:
<none or logical names>

Verification command:
<real project quality gate>

Allowed edit branches:
<patterns>

Allowed edit paths:
<patterns>
```

Also check:

- existing open PRs;
- existing Bridge branches;
- existing `.bridge/project.json`;
- existing `bridge-gateway.yml`;
- existing `bridge-publish.yml`;
- repository grant state;
- host policy repository entry.

Never overwrite parallel work without first reconciling it.

---

# 4. Connect a self-hosted machine to GitHub

## 4.1 Create a dedicated service user when practical

Prefer a dedicated non-root service account per trust domain.

Example:

```bash
sudo useradd --create-home --shell /bin/bash <runner-user>
```

Do not run the GitHub Actions runner as `root`.

Do not casually grant:

- passwordless sudo;
- unrestricted Docker socket;
- SSH private keys;
- unrelated host filesystems;
- persistent GitHub write tokens.

Give the runner only the OS permissions needed by its repositories and logical resources.

## 4.2 Register GitHub Actions runner

Use GitHub's repository or organization settings to generate a one-time self-hosted runner registration token.

Typical installation flow:

```bash
mkdir -p ~/actions-runner
cd ~/actions-runner

# Download the GitHub Actions runner version approved for this host.
# Verify GitHub's published checksum before extraction.

tar xzf actions-runner-<version>.tar.gz

./config.sh \
  --url https://github.com/<owner>/<repo-or-org> \
  --token <ONE_TIME_REGISTRATION_TOKEN> \
  --name <runner-name> \
  --labels <project-runner-class>
```

Never store the one-time registration token in the repository, workflow, Bridge policy, or logs.

Install the runner as a service using the platform-supported service mechanism.

Verify in GitHub UI that the runner is:

```text
Online
Idle
```

and has the expected labels.

Example:

```text
self-hosted
linux
x64
cql-research
```

or:

```text
self-hosted
linux
x64
micro-apps-ci
```

## 4.3 Multiple repositories on one physical machine

One host can serve multiple repositories.

Do **not** infer that repositories should share authority.

Example:

```text
Physical host
├── Crypto
│   └── runnerClass = cql-research
└── Micro Apps
    └── runnerClass = micro-apps-ci
```

Prefer distinct runner registrations or at least distinct labels/service identities when repositories have materially different trust or resource requirements.

---

# 5. Configure the host policy

Canonical host policy is host-owned:

```text
/etc/bridge/host.json
```

Back it up before mutation.

Example:

```bash
sudo cp /etc/bridge/host.json \
  /etc/bridge/host.json.bak-$(date +%Y%m%d-%H%M%S)
```

Do not overwrite an existing backup.

## 5.1 Repository entry

Each repository gets a separate host entry.

Example:

```json
{
  "version": 1,
  "host": {
    "id": "my-runner-host"
  },
  "repositories": {
    "owner/repository": {
      "runnerClasses": [
        "project-runner"
      ],
      "resources": {},
      "workspaceExec": {
        "enabled": true,
        "runnerClass": "project-runner",
        "serviceUser": "project-runner-user",
        "maxArgv": 32,
        "maxSeconds": 3600,
        "stdoutBytes": 1048576,
        "stderrBytes": 1048576
      },
      "editing": {
        "enabled": true,
        "runnerClass": "project-runner",
        "serviceUser": "project-runner-user",
        "maxOperations": 16,
        "maxPatchBytes": 262144
      }
    }
  }
}
```

The host can set limits lower than project policy.

Do not use host policy to broaden project policy.

## 5.2 Logical resources

Projects request logical names, not host paths.

Example host mapping:

```json
{
  "resources": {
    "cql-data": {
      "root": "/data/cql",
      "read": [
        "catalog/**",
        "raw/**",
        "results/**"
      ],
      "write": []
    }
  }
}
```

Project code should only know:

```text
cql-data
```

not:

```text
/data/cql
```

Bridge evidence should redact physical roots.

Do not reuse another project's resource mapping merely because both projects use the same physical host.

## 5.3 Validate the host policy

Use the Bridge main/runtime intended for deployment.

Typical validation:

```bash
node bin/bridge-runner.mjs validate-host-policy \
  --host-policy /etc/bridge/host.json
```

Run Bridge doctor if available.

Verify:

```text
service user
runner class
logical resource root
read/write patterns
workspaceExec
editing
```

Stop if host validation fails.

---

# 6. Configure the GitHub repository

Every fully onboarded repository should contain:

```text
.bridge/project.json
.github/workflows/bridge-gateway.yml
.github/workflows/bridge-publish.yml
```

A repository missing `.bridge/project.json` is not a fully onboarded Bridge project.

---

# 7. Trusted project policy: .bridge/project.json

This file is repository-controlled and versioned in Git.

It declares what the project wants Bridge to do.

Example:

```json
{
  "version": 1,
  "project": {
    "repository": "owner/repository"
  },
  "runners": {
    "ci": {
      "class": "project-runner"
    }
  },
  "capabilities": {
    "verify": {
      "class": "verify",
      "runner": "ci",
      "command": {
        "argv": [
          "bash",
          "scripts/bridge_verify.sh"
        ]
      },
      "limits": {
        "timeoutSeconds": 1800,
        "stdoutBytes": 1048576,
        "stderrBytes": 1048576
      }
    }
  },
  "workspaceExec": {
    "enabled": true,
    "runner": "ci",
    "maxArgv": 32,
    "maxSeconds": 3600,
    "stdoutBytes": 1048576,
    "stderrBytes": 1048576,
    "resources": []
  },
  "editing": {
    "enabled": true,
    "runner": "ci",
    "allowedBranches": [
      "agent/**",
      "codex/**"
    ],
    "allowedPaths": [
      "src/**",
      "tests/**",
      "scripts/**",
      "README.md"
    ],
    "maxOperations": 16,
    "maxPatchBytes": 262144,
    "commitSubjectPattern": "^(feat|fix|test|docs|chore): .+",
    "publish": true
  }
}
```

Adapt:

- runner class;
- allowed branches;
- allowed paths;
- verification command;
- resources;
- limits;

to the actual repository.

Do not copy Crypto-specific paths/resources into unrelated repositories.

---

# 8. Verification preset

Every autonomous coding repository should have at least one trusted `verify` capability.

It should execute the project's real quality gate.

Good examples:

```text
lint
typecheck
unit/integration tests
compile/build validation
config validation
offline safety checks
```

Prefer a repository-owned wrapper script when multiple commands are required.

Example:

```bash
#!/usr/bin/env bash
set -euo pipefail

npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

or:

```bash
#!/usr/bin/env bash
set -euo pipefail

export UV_OFFLINE=1
uv run --frozen ruff check src tests
uv run --frozen mypy
uv run --frozen pytest -q
uv run --frozen python -m compileall -q src tests
```

The verifier must not silently mutate publishable source content.

Bridge should compare actual publishable content/tree, not only a porcelain status string.

---

# 9. Gateway workflow

Install:

```text
.github/workflows/bridge-gateway.yml
```

Use the canonical Bridge example matching the currently deployed runtime.

Important invariants:

- one target checkout per Run;
- exact target SHA;
- shallow checkout where possible;
- exact trusted policy commit fetch;
- `persist-credentials: false`;
- self-hosted runner selected by the project runner class;
- Bridge runtime pinned to an exact trusted commit SHA;
- request materialized immutably;
- result/evidence uploaded even on failure.

Do not use `fetch-depth: 0` unless there is a demonstrated requirement.

Do not persist GitHub write credentials on the target-code runner.

---

# 10. Publish workflow

Install:

```text
.github/workflows/bridge-publish.yml
```

Publication is a separate authority path.

Preferred architecture:

```text
self-hosted target-code runner
    ↓
VERIFIED evidence/candidate
    ↓
hosted publish job
    ↓
GitHub contents write
```

Required invariants:

- only publish VERIFIED candidate;
- bind exact request/base/policy/candidate/tree/diff identities;
- exact base checkout;
- stale-target / force-with-lease behavior;
- target branch cannot be redirected by the caller;
- publish workflow gets write authority, target-code runner does not;
- upload a bounded publication receipt.

---

# 11. Repository principal grant

Bridge's identity store associates a principal/installation/repository with:

```text
can_read
can_run
can_publish
```

For an authorized full delivery flow whose user/App/project/host layers allow it,
the desired effective state is:

```text
1 / 1 / 1
```

This grant is separate from:

```text
project policy
host policy
GitHub App installation
```

All layers must agree.

Do not treat GitHub App `contents:write` as equivalent to Bridge `can_publish`.
Read/run/publish also require the corresponding maintained App permission profile
and the user's current repository rights; repository selection cannot elevate them.

Do not remove repository authorization checks.

---

# 12. GitHub App / repository installation

Confirm the Bridge GitHub App installation covers the target repository.

Check:

- installation is active;
- repository is included if installation uses selected repositories;
- required Actions permissions exist;
- required Code/Contents permissions exist;
- control-plane read/run operations work;
- publish workflow has the intended write authority.

If the app is installed for all repositories, Bridge's own repository grant remains the principal-level authorization boundary.

---

# 13. Connect ChatGPT / MCP

After deployment, ChatGPT should expose exactly these six public tools:

```text
bridge.discover
bridge.run
bridge.get_run
bridge.get_result
bridge.publish
bridge.task_transition
```

If batch runtime works through GitHub workflows but `bridge.run(mode=batch)` fails at the public MCP layer, inspect request-scoped transport delegation before touching the runtime.

Do not add another public tool for a repository-specific operation. `bridge.task_transition` is reserved for the common Durable Task Runtime and grants no repository-specific execution authority.

---

# 14. First acceptance: discover

Call:

```text
bridge.discover(repository)
```

Confirm:

```text
repository
trusted policy SHA
named capabilities
generic exec enabled
logical resource names
editing enabled
editing.publish = true
runner classes
```

Host filesystem paths must not appear.

A 404 for `.bridge/project.json` means repository onboarding is incomplete.

---

# 15. Read-only batch acceptance

Before edit/publish, run a small batch:

```text
1. generic exec
2. named observe preset
3. generic exec using a logical resource
4. trusted verify
```

Require:

```text
status = SUCCEEDED
workspace.materializations = 1
workspace.shared = true
```

Confirm resource roots are redacted.

Common failures:

```text
HOST_RESOURCE_DENIED
```

Usually means host policy did not opt into generic exec or the requested resource.

---

# 16. Full edit acceptance

Run one bounded batch:

```text
1. optional bootstrap
2. exec: inspect status
3. optional observe preset
4. optional generic resource exec
5. one benign edit
6. trusted verify tail
```

The final result must be:

```text
VERIFIED
```

not merely:

```text
SUCCEEDED
```

Record:

```text
runId
requestId
targetRef
baseSha
policySha
candidateSha
treeSha
diffSha256
changedFiles
verificationResultSha256
workspace.materializations
workspace.shared
runner class
host ID
```

---

# 17. Publish acceptance

Only after:

```text
get_result.status = VERIFIED
```

call:

```text
bridge.publish(runId)
```

Do not pass an alternate:

```text
candidate
branch
repository
target
```

Publication must derive all authority and identity from durable Run state.

Require:

```text
PUBLISHED
```

Then independently read GitHub and verify:

```text
remote branch HEAD == candidate SHA
```

and, if needed:

```text
candidate parent == Run base SHA
```

A successful workflow by itself is not sufficient evidence.

---

# 18. Durable development workflow for Agents

Before every substantial Bridge task:

1. Read the repository's `AGENTS.md` or equivalent.
2. Read the relevant durable GitHub Issue/checkpoint.
3. Read exact current `main`.
4. Search for parallel branches/PRs.
5. Confirm canonical working branch and exact HEAD.
6. Reconcile other Agents' work before mutation.
7. Keep changes inside the current bounded stage.
8. Run the project's real CI/acceptance.
9. Merge only after acceptance is green.
10. Write a durable checkpoint with exact identities.

If this repository is enrolled in Durable Task Runtime, also verify the task-session transport used by the intended Agent:
- cloud-hosted MCP Worker: activation returns an opaque `taskSessionToken`, and task-aware `bridge.run` / `bridge.publish` / `bridge.task_transition` accept it;
- programmable MCP client: the three task-session headers may be used;
- in both cases, OAuth/repository authorization and current D1 fencing remain mandatory;
- the model must not supply authoritative `workerId` / `leaseEpoch` itself.

Never reconstruct project state from memory when GitHub durable state is available.

---

# 19. Adding a second repository to the same host

Do not redeploy Bridge.

Repeat repository onboarding.

For repository B:

```text
1. Decide its runner class/service user.
2. Add a separate host.json repository entry.
3. Add only its logical resources.
4. Add .bridge/project.json.
5. Add gateway workflow.
6. Add publish workflow.
7. Ensure repository grant = read/run/publish.
8. Run discover.
9. Run read-only batch acceptance.
10. Run edit → verify → publish acceptance.
```

Repository B must not automatically inherit repository A's:

```text
resources
allowed paths
allowed branches
service user
runner class
OS data access
```

---

# 20. Example: Crypto vs Micro Apps

A single machine may contain:

```text
Crypto
  repository = owner/crypto
  runnerClass = cql-research
  logical resource = cql-data

Micro Apps
  repository = owner/micro-apps-infra
  runnerClass = micro-apps-ci
  logical resources = project-specific only
```

Do not give Micro Apps `cql-data` simply because it uses the same physical host.

If `bridge.discover(micro-apps-infra)` returns missing `.bridge/project.json`, repository onboarding is not complete even if D1 `can_publish=1`.

---

# 21. Common failure matrix

## `GITHUB_API_ERROR` / `.bridge/project.json` 404

Meaning:

Repository has not completed project-side Bridge onboarding.

Fix:

Add/merge trusted `.bridge/project.json` on the default branch.

---

## `HOST_RESOURCE_DENIED: exec is not enabled by host policy`

Meaning:

Project asked for generic exec, host did not grant it.

Fix:

Enable repository-scoped `workspaceExec` in host policy.

Do not loosen global host policy.

---

## `EDIT_DENIED: editing is not enabled by host policy`

Meaning:

Project asked for editing, host did not grant it.

Fix:

Enable repository-scoped `editing` in host policy.

---

## `REPOSITORY_DENIED: publish access denied`

Check separately:

```text
GitHub App installation/permissions
repository grant can_publish
project policy editing.publish
```

Do not assume they are the same layer.

For a full-delivery onboarding expected to allow publication, verify rather than
assume:

```text
effective can_publish = 1 only if user, App and Bridge grant all allow it
```

---

## `GATEWAY_CONFIG_INVALID: transport does not support batch requests`

Meaning:

Public/request-scoped transport did not delegate batch submission even though the underlying GitHub transport does.

Fix the connection/delegation layer.

Do not redesign batch runtime.

---

## stale target during publish

Meaning:

Target branch no longer equals the Run's exact base.

Correct behavior:

Fail closed.

Do not force-publish over concurrent work.

Run/reconcile again from the new target state.

---

# 22. Security invariants

Never:

- allow project workflows to edit `/etc/bridge/host.json`;
- expose physical resource roots through public MCP discovery;
- give target-code runner persistent GitHub write credentials;
- disable stale-target checks;
- remove repository authorization;
- let caller redirect a VERIFIED candidate to another repository/branch;
- publish a non-VERIFIED Run;
- silently reuse another project's host resource grant;
- store one-time runner registration tokens in Git;
- run the runner as root without a documented exceptional reason;
- infer completion from CI green alone when exact Git identities are required.

---

# 23. Completion checklist

A new repository is fully onboarded only when all are true:

```text
[ ] GitHub self-hosted runner online
[ ] runner class correct
[ ] service user correct
[ ] host policy repository entry exists
[ ] host policy validates
[ ] required logical resources healthy
[ ] .bridge/project.json merged on default branch
[ ] trusted verify preset exists
[ ] gateway workflow installed
[ ] publish workflow installed
[ ] repository grant read=1
[ ] repository grant run=1
[ ] repository grant publish=1
[ ] bridge.discover PASS
[ ] read-only batch PASS
[ ] one workspace proven
[ ] resource redaction proven
[ ] edit PASS
[ ] verify PASS
[ ] result VERIFIED
[ ] bridge.publish(runId) PUBLISHED
[ ] remote branch HEAD independently equals candidate SHA
[ ] durable GitHub checkpoint written
[ ] task-aware repository: `bridge.task_transition` releases the current lease after the checkpoint
```

Only then call the repository a fully operational Bridge development target.

---

# 24. Agent handoff report

When onboarding completes, report:

```text
Repository:
<owner/repo>

Bridge runtime:
<SHA>

Default policy:
<SHA>

Runner:
<name>

Runner class:
<class>

Service user:
<user>

Host policy validation:
PASS/FAIL

Logical resources:
<names>

Repository grant:
read/run/publish

discover:
PASS/FAIL

read-only batch:
PASS/FAIL

edit batch:
VERIFIED/FAIL

runId:
<id>

base:
<SHA>

candidate:
<SHA>

publish:
PUBLISHED/FAIL

remote HEAD:
<SHA>

remote HEAD == candidate:
yes/no

Remaining blocker:
none/<exact blocker>
```

Keep facts, assumptions, and unverified claims separate.
