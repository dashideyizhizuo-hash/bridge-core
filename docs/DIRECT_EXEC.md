# Direct Exec

Direct Exec is Bridge's host-first execution plane for ordinary operations that do not need Git engineering semantics.

The common case is intentionally small:

```text
enroll one host once
-> keep one outbound runner loop alive
-> bridge.run_host_command(hostId=<returned hostId>, argv=[...])
-> bridge.get_run / bridge.get_result
```

Choose an actual returned `hostId` explicitly, including when there is one Host.

No GitHub repository, `.bridge/project.json`, target workflow, target SHA, or repository grant is required for Direct Exec.

GitHub-backed execution remains the engineering plane for source edits, trusted verification, candidate evidence, publication and Durable Task Runtime checkpoints.

## Bounded result waiting

Direct commands default to a 20-second execution response window with
`bridge.run_host_command(hostId=<returned hostId>, argv=[...])`. The clock starts
when the Host successfully spawns the child process, not when the server accepts
or the Host claims its Run. A completed Run returns bounded result evidence in
the same response. Set `waitSeconds: 0` for an immediate asynchronous receipt,
or an integer from 1–20 for a shorter execution response window.

Queue pickup has a separate `queueWaitSeconds` budget (default 75, range 0–120).
Input preparation and output transfer each have a `transferWaitSeconds` budget
(default 60, range 0–120). Every response has an independent 120-second overall
ceiling, which takes precedence. These are Bridge response limits, not a
promised ChatGPT connection lifetime. They never change `timeoutSeconds`,
queue retention or Host execution limits. A client can disconnect earlier.

Host 0.5.1 reports authenticated `PREPARING`, `EXECUTING` and `RETURNING_RESULT`
progress. Older Hosts remain usable but cannot prove actual process start;
unknown start is bounded by the queue budget instead of being counted as
execution. Upgrade while preserving the Host ID, credential and local journal.

Host polling is unchanged: 15 seconds after activity, 30 after five idle
minutes, and 60 after ten idle minutes. Actual completed work resets activity;
viewing Hosts or reading task status does not. Pickup can therefore take nearly
one full idle interval plus network and preparation time.

Bridge first admits and binds one canonical Run, then reads its owner-scoped
state at most once per second, with a fixed maximum of 121 state reads. Waiting
adds server reads. When a wait ends, retain the same `runId` and latest status.
`waitStatus` distinguishes `timed_out`, `interrupted` and `unavailable`;
`waitPhase` distinguishes `queue`, `awaiting_start`, `input_transfer`,
`execution`, `output_transfer`, `result` and `total`. Neither a wait timeout nor
a disconnected response cancels, repeats or charges for a second execution.
Continue with `bridge.get_run` / `bridge.get_result`, without resubmitting the
command. Authorization, revocation, output limits and execution identity remain
in force. Export metadata may return inline; actual download links still require
an explicit `bridge.get_result` read. Refresh client tool discovery after schema
changes, and verify actual results rather than assuming a new field was sent.

## Minimal host policy

```json
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
```

`root` is optional. If omitted, Direct Exec is rooted at the configured service user's home directory. If configured, it is host-owned and absolute:

```json
{
  "directExec": {
    "enabled": true,
    "serviceUser": "bridge-runner",
    "root": "/srv",
    "maxSeconds": 900
  }
}
```

The cloud caller can request only a relative `cwd`. The service account and OS ACLs are the real filesystem/process boundary.

## Agent call

After `bridge.list_hosts`, call `bridge.run_host_command` with its returned Host:

```json
{
  "hostId": "<returned owned host ID>",
  "argv": ["ai-artist", "feedback-snapshot", "--hours", "48"]
}
```

Optional:

```json
{
  "hostId": "<returned owned host ID>",
  "argv": ["python", "script.py"],
  "cwd": "tools",
  "timeoutSeconds": 120
}
```

Direct commands use their dedicated tool and shared evidence getters:

```text
bridge.run_host_command
bridge.get_run
bridge.get_result
```

Direct runs are never accepted by `bridge.publish` and are intentionally outside GitHub Durable Task Runtime.

## Cloud topology

```text
ChatGPT / Agent
  -> Bridge OAuth MCP
  -> D1 Direct Run
  <- host runner outbound HTTPS claim
  -> bounded local argv execution
  -> HTTPS complete
  -> D1 result
  -> bridge.get_result
```

The host needs no public IP, inbound port, SSH server or per-repository GitHub Actions runner.

The initial transport uses simple outbound HTTPS polling. WebSockets/Durable Objects are not required for correctness and can be added later only if latency justifies the operational cost.

## Self-service host connect

Cloudflare, D1, R2 and service administration credentials are Bridge operator internals. A customer host does not install Wrangler and does not receive `BRIDGE_DIRECT_ADMIN_TOKEN`, a PAT, an SSH key or a GitHub App secret.

The normal customer flow is:

```text
authenticated Bridge connector
  -> bridge.create_host_pairing()
  -> short-lived signed pairing capability

customer host
  -> bridge-host connect --endpoint <Bridge /mcp> --pairing-token <capability>
  -> generate runner token locally
  -> send only runner-token SHA-256
  -> receive server-assigned host identity
  -> write local 0600 host policy + runner environment

customer host
  -> bridge-host start
  -> outbound HTTPS claim / heartbeat / complete
```

The pairing capability is signed by the Bridge service, bound to the authenticated Bridge principal and a server-reserved globally unique host ID, and expires after a short bounded lifetime. It is stateless and introduces no pairing database or deployment migration.

The raw runner token is generated on the host and never leaves that host. D1 stores only its SHA-256 digest.

For script/agent use, prefer a temporary pairing-token file or the `BRIDGE_PAIRING_TOKEN` environment variable instead of placing the capability in a long-lived shell history:

```bash
bridge-host connect \
  --endpoint https://<bridge-host>/mcp \
  --pairing-token-file /run/user/$UID/bridge-pairing

bridge-host doctor
bridge-host start
```

A replayed pairing cannot rotate an existing host: normal self-service connect is create-only. Host enable/disable is performed by the authenticated owner through Bridge `mode="host"`; the operator-only Direct admin endpoints are break-glass/service operations, not customer onboarding.

When exactly one enabled Direct host belongs to a principal, callers may omit the host from subsequent Direct Runs.

## Local-only diagnostic

The same runtime can be tested without Cloudflare:

```bash
node bin/bridge-runner.mjs direct-exec \
  --request /path/to/request.json \
  --host-policy /etc/bridge/host.json \
  --output-dir /tmp/bridge-result
```

## Authority and limits

Direct Exec deliberately provides broad command-level utility under one intentionally low-privilege OS identity.

It preserves:

- argv arrays rather than a caller-provided shell field;
- exact host ownership and runner-token authentication;
- exact configured OS service user;
- sanitized environment;
- bounded argv/timeout/stdout/stderr;
- relative cwd contained under a host-owned root;
- no GitHub publication credential;
- principal-scoped Direct Run state;
- leased runner claims and stale-completion rejection.

The executed process also receives:

```text
BRIDGE_DIRECT_EXEC=1
BRIDGE_REQUEST_ID=<stable request id>
BRIDGE_HOST_ID=<host id>
```

Tools with non-idempotent side effects should use `BRIDGE_REQUEST_ID` as an idempotency key when practical.

The service user should not have sudo, Docker socket access, SSH private keys, deployment credentials or unrelated sensitive data unless that authority is explicitly intended.

## Text encoding / 中文输出

Command stdout and stderr are UTF-8 text. Bridge preserves Chinese, emoji and
multibyte characters across pipe chunks. A child emitting a legacy code page or
binary bytes fails with `OUTPUT_ENCODING_INVALID`; the invalid stream is omitted,
while valid output from the other stream and byte counts remain available. Bridge
does not guess encodings. Byte-limit failures retain only a valid UTF-8 prefix,
never a replacement character introduced by truncation. A failed execution may
already have performed side effects; fixing encoding does not authorize blindly
re-running non-idempotent work.

中文命令输出应由子程序明确使用 UTF-8。Windows 上可使用 Python 的
`python -X utf8 ...`；PowerShell 脚本可以显式设置
`[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)`，再运行需要输出
UTF-8 的命令。该设置不能保证每一个原生程序都会遵循：旧工具应使用其自己的
编码选项，或将原始字节写入声明式导出文件，在已知编码后显式转换。
不要把更改终端字体、自动猜 GBK，或无条件设置系统代码页当作通用修复。
二进制文件通过 Direct Assets 传递，不放入 stdout/stderr。

本次中文 Windows 实测中，普通 `whoami` 为 ASCII，`whoami /user`、`/groups`
和 `/all` 则输出本地代码页字节。对这些固定只读查询，显式 argv
`["cmd.exe","/d","/s","/c","chcp 65001 >nul & whoami /user"]` 可得到有效 UTF-8。
不要把这个例子的 shell 片段推广成自动拼接任意命令或不可信参数。

## Reliability model

The long-lived host runner is expected to run under systemd using `examples/bridge-direct-runner.service`.

The runner uses:

- idle polling that backs off from 5 to 10 to 15 seconds by default;
- a short 90 second claim lease;
- a 20 second active-command heartbeat;
- exponential retry backoff for transient Cloudflare/network failures;
- immediate fatal stop for runner authentication/host-disable failures;
- a local 0700/0600 execution journal;
- bounded local journal retention.

Before executing a command, the runner writes a durable `STARTED` receipt. After execution, it fsyncs the bounded result locally before attempting the Cloudflare complete call.

Therefore:

- if complete succeeds, normal terminal state is durable in D1;
- if complete is temporarily lost, the next claim replays the saved result without re-running the command;
- if the host crashes after STARTED but before a local result is durable, automatic replay is refused with `DIRECT_EXEC_AMBIGUOUS_REPLAY`;
- if heartbeat authority is revoked, the runner aborts the full process group;
- if heartbeat connectivity is lost close to lease expiry, the runner aborts locally before a safe cloud reclaim could overlap it.

Consecutive empty claims increase the wait by the configured poll interval, up
to 15 seconds (an explicitly configured interval above 15 seconds stays at that
interval). Completing a Run triggers the next claim immediately and resets the
next idle wait to the base interval. Network-error backoff remains separate;
every claim still authenticates the runner, and active-command heartbeats stay
at 20 seconds. Cancellation interrupts an idle wait immediately. This is a
bounded polling optimization, not push delivery: a newly queued command can
wait up to the current idle interval plus request latency.

For a continuously idle host at defaults, steady-state claim requests fall from
approximately 720 to 240 per hour, a two-thirds reduction. Empty UPDATEs do not
imply rows were written; the estimate concerns requests and query invocations,
not measured D1 billed writes. `last_seen_at` retains its existing 60-second
write throttle. Cleanup migration `0022_direct_cleanup_indexes.sql` adds
indexes matching the bounded expiry/retirement scans; this avoids sorting and
scanning unrelated live records as retained history grows. Index maintenance
adds writes when indexed state/timestamps change. Query-plan tests establish
local SQLite access paths, not provider billing measurements.

Queue entries expire after 15 minutes by default so a command requested while a host is offline does not unexpectedly execute hours or days later.

D1 stores only bounded result JSON. Direct Exec defaults to a 1 MiB combined result budget and the server rejects results above 1.5 MB, staying below D1's 2 MB row ceiling. Large binary outputs belong in the Direct Asset plane rather than D1.

## Operator controls

Re-registering an existing host rotates its 256-bit runner token. The old token becomes invalid immediately and any in-flight old-token run is canceled.

The operator kill switch is:

```text
POST /direct/admin/set-host-enabled
```

with the service-level Direct admin bearer token and:

```json
{
  "bridgeUserId": "<owner>",
  "hostId": "wsl-main",
  "enabled": false
}
```

Disabling a host cancels queued/running Direct Run state. The active runner observes the revocation on heartbeat and terminates its local process group.

`bridge.list_hosts()` without a repository returns Direct host status including `enabled` and `lastSeenAt`, plus `defaultHost` when exactly one enabled host exists.

## Delivery semantics

The runner uses a lease that covers the configured maximum command duration plus a safety margin. A stale runner cannot complete after another runner reclaims the job.

Like most remote job systems, a host/process crash at the exact boundary between an external side effect and durable completion can still cause replay after lease expiry. Side-effecting tools should therefore implement request-id idempotency. This is especially important for operations such as publishing a social post.

## Why this is not the GitHub path

Use Direct Exec for:

- installed CLIs;
- local SQLite/data inspection;
- OpenCLI/browser operations;
- conversion and media tools;
- diagnostics;
- ordinary scripts and tests.

Use GitHub-backed Bridge execution when the task needs:

- source mutation;
- exact commit identity;
- trusted verification;
- VERIFIED candidate evidence;
- `bridge.publish`;
- durable engineering checkpoints.

## Files and assets

Bounded cloud-to-host binary handoff is implemented through the private Direct Asset plane. The cloud creates a one-time upload ticket, bytes are stored in private R2, and the runner privately downloads and verifies size + SHA-256 before substituting an exact `{asset:N}` argv element.

See [Direct Assets](DIRECT_ASSETS.md).
