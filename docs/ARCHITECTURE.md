# Bridge architecture

## 1. Purpose

Bridge lets cloud AI agents use configured developer-owned infrastructure without giving the model direct host administration authority.

Typical uses include ordinary commands, local/private data, browser-backed automation, self-hosted tools, media processing, repository engineering, and controlled code publication.

Bridge is not a public SSH login or a host filesystem browser.

## 2. Two execution planes

Bridge has two execution planes behind one MCP product surface.

~~~text
                       Bridge MCP
                           |
              +------------+------------+
              |                         |
         Direct Exec                GitHub Exec
      ordinary host work        engineering work
              |                         |
         D1 run queue              GitHub Actions
              |                         |
      outbound host runner       self-hosted runner
              |                         |
        bounded argv            edit / verify / publish
~~~

Direct Exec is for ordinary operations that do not need Git engineering identity.

Its authority is:

~~~text
authenticated Bridge principal
  intersect principal-owned host
  intersect authenticated runner token
  intersect host-owned directExec policy
  intersect configured low-privilege OS service user
  intersect runtime limits
~~~

It does not require a repository, project policy, GitHub workflow or repository grant.

GitHub Exec remains for source-control engineering guarantees. Its authority remains the intersection of authenticated principal, GitHub App installation, repository grant, trusted project policy, host policy, runtime safety rules and durable-task fencing when task-bound.

## 3. Product topology

The Cloudflare production composition is:

~~~text
ChatGPT / Codex
  -> MCP OAuth 2.1
  -> Cloudflare OAuth Provider
  -> Bridge MCP control plane
       |
       +-> Direct Run state in D1
       |     <- outbound HTTPS host runner
       |
       +-> official Bridge GitHub App
             -> GitHub API / Actions
             -> self-hosted runner
~~~

The host never needs an inbound public port.

GitHub remains durable engineering truth for repository-backed work. D1 stores current identity/authorization, Direct Run state and Durable Task Runtime coordination; it does not replace Git history.

## 4. Stable MCP surface

The public tools remain:

~~~text
bridge.discover
bridge.run
bridge.get_run
bridge.get_result
bridge.publish
bridge.task_transition
~~~

bridge.run selects the plane by mode.

A single-host Direct call can be as small as:

~~~json
{
  "mode": "direct",
  "argv": ["node", "--version"]
}
~~~

GitHub modes retain repository and target semantics.

bridge.get_run and bridge.get_result normalize both run types. bridge.publish accepts only VERIFIED GitHub engineering Runs. bridge.task_transition remains GitHub Durable Task Runtime coordination.

## 5. Direct Exec

### 5.1 Host enrollment

A Direct host is connected once to one authenticated Bridge principal.

Normal customer enrollment is self-service and does not expose Cloudflare or service-operator credentials:

~~~text
Bridge OAuth principal
  -> bridge.run(mode="connect")
  -> signed short-lived pairing capability
  -> customer host generates runner token locally
  -> pairing claim sends only runner-token SHA-256
  -> Bridge registers the server-reserved host ID to that principal
~~~

The pairing capability is stateless, HMAC-signed, principal-bound, host-bound and time-bounded. The service assigns a globally unique host ID before the claim so customer-selected machine names cannot collide across tenants.

The raw runner token never crosses the host boundary. D1 stores the logical host ID, owning Bridge principal, runner-token SHA-256 digest, enabled state and bounded liveness metadata.

Normal self-service pairing is create-only. Replaying a valid pairing after successful enrollment cannot rotate the existing runner credential. Operator Direct admin endpoints remain a separate break-glass surface.

When exactly one enabled Direct host belongs to a principal, callers may omit host. Multiple hosts require an explicit logical host ID.

### 5.2 Runner transport

The initial transport deliberately uses outbound HTTPS polling:

~~~text
host runner
  -> claim
  <- immutable request + lease
  -> bounded local execution
  -> complete
~~~

This is simpler operationally than requiring WebSockets or Durable Objects. Lower-latency transports may be added later without changing Direct Run semantics.

### 5.3 Host policy

The administrator-owned file remains /etc/bridge/host.json.

Minimal Direct authority:

~~~json
{
  "version": 1,
  "host": { "id": "wsl-main" },
  "repositories": {},
  "directExec": {
    "enabled": true,
    "serviceUser": "bridge-runner",
    "maxArgv": 64,
    "maxSeconds": 3600,
    "stdoutBytes": 1048576,
    "stderrBytes": 1048576
  }
}
~~~

The optional directExec.root is host-owned. The caller can request only a relative cwd beneath that root.

### 5.4 Execution authority

Direct Exec is intentionally broad at the command level under a deliberately low-privilege OS identity.

It preserves:

- argv arrays rather than a caller-defined shell field;
- exact host ownership;
- runner-token authentication;
- exact configured service user;
- sanitized process environment;
- bounded argv, timeout, stdout and stderr;
- relative cwd containment;
- no GitHub publication credential;
- principal-scoped Direct Run state;
- leased claims and stale-completion rejection.

OS ownership and ACLs are the hard filesystem/process authority boundary. Protocol policy is not a substitute for OS isolation.

The child receives BRIDGE_REQUEST_ID and BRIDGE_HOST_ID so side-effecting tools can implement idempotency.

## 6. GitHub engineering plane

A target repository may store .bridge/project.json, but target code does not authorize itself. Bridge binds targetSha as workspace code identity and policySha as accepted execution authority.

The trusted project policy declares project identity, logical runners, named capabilities, repository generic exec authority, logical resource requirements, editing paths and limits, and publication opt-in.

The host policy independently declares repository runner, service-user and resource authority.

The canonical workflows remain examples/bridge-gateway.yml and examples/bridge-publish.yml.

## 7. GitHub Run model

One repository-backed bridge.run batch represents:

~~~text
resolve exact target + trusted policy
  -> one ephemeral workspace
  -> ordered bounded steps
       - exec
       - preset
       - edit
  -> trusted verification when edited
  -> one structured result
  -> optional separate publish
~~~

Exec runs bounded argv in the shared workspace. Preset executes a trusted named observe/verify capability. Edit mutates under trusted branch/path/operation limits. An edited batch must finish with trusted verification before emitting a VERIFIED candidate.

After the first failed, denied, stale or canceled step, later steps are skipped.

## 8. Candidate and publication lifecycle

Repository edits retain the isolated publication chain:

~~~text
Run workspace
  -> edit
  -> trusted verification
  -> exact candidate + evidence
  -> VERIFIED

bridge.publish(runId)
  -> separate publication authority
  -> revalidate base/policy/candidate/evidence
  -> verify current task lease when task-bound
  -> fail if target moved
  -> publish
~~~

Direct Runs never enter this lifecycle.

## 9. Durable Task Runtime

Long-running engineering work adds coordination to the GitHub engineering plane:

~~~text
GitHub = durable engineering truth
D1 = current coordination truth
Worker = disposable
Watchdog = deterministic
lease_epoch = fencing token
~~~

A stale Worker cannot publish task-bound work after a newer epoch takes over.

Cloud-hosted MCP Workers use opaque short-lived task-session capabilities. Direct Exec is intentionally not attached to these GitHub engineering task leases.

## 10. Run identity and evidence

Direct Run identity includes the run/request ID, owning principal, logical host, request digest, execution status and timing, and bounded stdout/stderr.

GitHub Run identity additionally includes repository, exact target and policy identity, runner class, ordered steps, candidate/base/tree/diff identity for edits, verification evidence and task fencing identity as applicable.

A ref name alone is never sufficient engineering evidence identity.

## 11. Isolation and privilege

Baseline Direct runner requirements:

- dedicated low-privilege service identity;
- no sudo;
- no Docker socket unless explicitly intended;
- no SSH private keys or unrelated deployment credentials;
- OS ACLs for private resources;
- bounded output and time;
- no inbound network listener required.

Generic command execution necessarily matches the real OS privileges of its service user. If that account can read or mutate something, a sufficiently general executable under the account may be able to do so.

Repository execution additionally isolates GitHub publication credentials from target-code execution.

## 12. Delivery semantics

Direct Run claim leases cover the configured command timeout plus a safety margin. A stale runner cannot complete after lease takeover.

A crash at the exact boundary between an external side effect and durable completion can still permit replay after lease expiry. Side-effecting tools should use BRIDGE_REQUEST_ID as an idempotency key where practical.

GitHub edit/publication semantics retain exact-SHA stale-target and fencing checks.

## 13. Compatibility/reference layers

Legacy capability/edit requests, repository workspace-exec compatibility, the Node reference remote adapter, and the private loopback MCP harness remain supported. They are compatibility/reference layers, not alternative authority models.

## 14. Why not raw SSH?

For humans, SSH remains appropriate administration infrastructure.

For cloud Agents, Bridge aims for SSH-like convenience without making a long-lived login shell the product authority boundary:

~~~text
Direct Exec:
principal + host ownership + runner credential
+ low-privilege service user
+ bounded execution + structured run state

Git engineering:
repository/policy/SHA/fencing layers
+ isolated verification and publication
~~~

The goal is not to prevent a deliberately general low-privilege service account from running useful interpreters. The goal is to keep host enrollment, identity, limits, run state and engineering publication authority explicit and auditable.
