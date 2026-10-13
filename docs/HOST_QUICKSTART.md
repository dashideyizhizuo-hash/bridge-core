# Bridge Host — cross-platform one-command preview

**The operator-scoped npm Host preview is public; this source export has not been remotely released.** The registry commands below install `@dashideyizhizuo/bridge-host@0.4.0-preview.1`. For self-deployment, explicitly select your own endpoint. A package built from this source export is a separate artifact and must not overwrite or republish that registry version. Node.js 22+ and npm remain prerequisites; Bridge does not install Node or require Wrangler or Cloudflare credentials on customer hosts.

```sh
npx @dashideyizhizuo/bridge-host@0.4.0-preview.1 --endpoint https://YOUR-BRIDGE-HOST/mcp
```

Replace YOUR-BRIDGE-HOST with your real self-hosted HTTPS domain. Source-built packages use a non-live placeholder default; existing Host identities retain their saved endpoint.

Confirm current-user command execution, authorize in the browser, then the CLI pairs the computer and selects a supported user-level runtime:

| Environment | Default behavior |
| --- | --- |
| Native Windows | Task Scheduler, current user's login/interactive session, LUA run level; no password, UAC request or LocalSystem service |
| macOS (preview) | User LaunchAgent in `~/Library/LaunchAgents`; no system daemon |
| Linux / WSL with an available systemd user manager | Existing systemd USER service adapter |
| No usable background manager | Clearly reported foreground fallback, not a fake installed/running service |

A missing supervisor is no longer an onboarding prerequisite. The foreground mode is deliberately first-class:

```sh
npx @dashideyizhizuo/bridge-host@0.4.0-preview.1 --endpoint https://YOUR-BRIDGE-HOST/mcp --foreground
```

It pairs on first use, starts the runner in that terminal, and keeps running. Keep the terminal open; Ctrl+C stops execution without deleting the Host ID or local credential. Run the same command to reconnect with the same identity. A closed terminal, logged-out user, stopped WSL distribution, sleeping or powered-off computer cannot execute new commands. Foreground operation is not reboot persistence.

`--background` requires a working native user supervisor and fails rather than silently falling back. `--no-service` preserves the old config-only behavior: pair but do not start. Modes are mutually exclusive. A conflicting/edited service, unsafe state, partial claim or failed service startup does **not** silently fall back. Repair or stop the installed service before choosing foreground. WSL never silently switches to a Windows service: that would change the OS execution identity and filesystem boundary.

## Identity, permissions and lifecycle

The current OS user's permissions are the execution boundary; this is not an OS sandbox. No root, sudo, service-account migration or credential rotation is silently introduced. Windows tasks explicitly use the current SID, `InteractiveToken` and least-privilege `LUA` rather than LocalSystem. The hidden task launcher waits for its Node child. It retries failed child exits with 5–30 second exponential backoff, resets after a stable minute, and honors a clean exit without restarting. Native CI showed Task Scheduler receiving exit code 1 without performing its configured retry, so child recovery does not rely on that setting. The launcher remains inside the owned task rather than detaching children; stopping the task must terminate the child as well. Native GUI/no-window behavior and login/reboot need real-user acceptance in addition to CI.

Windows Host state requires a normal local filesystem path (not a UNC share, device path or alternate stream). The CLI creates and verifies a current-user + SYSTEM ACL **before** writing credentials; chmod 0600 is not treated as Windows security. A new empty file receives its explicit owner/DACL before secret bytes are written; existing files are validated, not silently repaired or widened. POSIX configuration is private current-user-owned storage; symlinks/junctions and unsafe file permissions fail closed.

Defaults: Linux/macOS `~/.config/bridge`; Windows `%LOCALAPPDATA%/bridge`. `XDG_CONFIG_HOME` overrides are honored. The persistent identity is `host.json` + `direct-runner.env`. Account OAuth access tokens, PKCE verifiers and short pairing tokens are not saved as daemon credentials. Runner journals/assets use a private state directory.

Background adapters copy a content-addressed, dependency-free Node runtime outside the npx cache. Deleting the npx cache or checkout does not delete the installed daemon. The user's Node executable must remain installed. Repeated setup reuses the same identity and unchanged registration; it does not automatically upgrade an existing runtime or overwrite a foreign service.

```sh
npx @dashideyizhizuo/bridge-host@0.4.0-preview.1 status
npx @dashideyizhizuo/bridge-host@0.4.0-preview.1 stop
```

These commands concern the **managed background registration**, not arbitrary processes. Stop disables/stops it while retaining identity; foreground is stopped with Ctrl+C. launchd/systemd supervise their own user processes. The CLI does not start WSL from Windows boot, enable login lingering, guarantee operation after logout, or alter system power settings. A live Windows launcher may be backing off before a child restart; task-active is not proof of a successful Bridge connection.

## Automatic startup and current activity

After setting up a managed background Host on Windows or Linux:

```sh
bridge-host autostart on
bridge-host autostart off
bridge-host autostart status
```

`on` enables automatic startup for the next user session; it does **not** start a
stopped Host now. `off` disables future automatic startup; a Host already running
continues until you stop it. Both commands change only an existing, verified,
current-user registration. They do not pair another Host or request elevation.
`status` and `autostart status` report `active` separately from `autostart.enabled`,
plus `autostart.scope` and `autostart.condition`. An unreadable setting is `null`,
not a guessed disabled state.

| Action | Running process | Automatic startup |
| --- | --- | --- |
| `autostart on` | Unchanged | Enabled |
| `autostart off` | Unchanged | Disabled |
| `stop` | Stopped | Disabled, preserving existing command behavior |
| `setup --background` | Started | Enabled |
| `start` / `--foreground` | Runs in this terminal | Does not change the setting |

Windows automatic startup means **after this user signs in**, not before login.
Linux needs its existing systemd user manager. WSL must already be running; Bridge
does not start the distribution from Windows boot or enable lingering. Sleeping or
powered-off computers cannot execute commands. macOS LaunchAgents also support independent autostart controls in the current user's graphical login session. A machine without that session must use foreground mode.

Upgrade and rollback retain running state and autostart independently. A stopped
Host stays stopped during upgrade. Historical rollback snapshots created before
this setting existed lack a separate autostart field: they retain the former
behavior, deriving autostart from their recorded running state. New snapshots
record both values explicitly.

中文：`autostart on` 只开启“以后自动启动”，不会立即运行；`autostart off`
只关闭“以后自动启动”，不会中断当前任务。要立即停止并关闭自动启动，使用
`stop`；要立即恢复后台运行，使用 `setup --background`。Windows 是当前用户
登录后自动启动，Linux 依赖用户服务管理器，WSL 需要先启动；不是未登录开机
常驻服务。`status` 分别显示当前运行状态和自动启动开关。

## Browser and headless operation

Normal setup reuses Bridge's existing OAuth authorization-code + PKCE S256 / MCP pairing flow. Windows uses the registered browser; macOS uses `open`; Linux/WSL uses available browser-opening tools. If opening fails, the CLI prints the same authorization URL. Open it on this computer: a remote computer cannot receive this loopback callback. `--no-browser` selects that manual-URL behavior.

The callback is loopback-only, one-use, deadline-bound and validates state, issuer, path, Host header, method and duplicate parameters. Login/claim HTTP is origin-pinned, redirect-rejecting, size-limited and time-bounded. No new auth server, OAuth scope, short-code database, Worker endpoint, or migration is added.

For a genuinely headless host, retain the explicit short-lived pairing-file path:

```sh
bridge-host connect --pairing-token-file /path/to/private-pairing-file
bridge-host doctor
bridge-host start
```

On Windows use native paths, for example `C:\Users\Alice\pairing.txt`. `connect` with an explicit token only pairs. Remove the temporary file after successful claim; never put tokens in history/logs. Custom deployments supply `--endpoint https://your-bridge.example/mcp`.

Commands are native argv, not implicitly expanded shell strings. On Windows an `.exe` can be invoked directly; shell built-ins and `.cmd` scripts require the caller to explicitly choose `cmd.exe` or PowerShell. Bridge does not silently turn all commands into shell strings. Timeout/cancellation kills the active Windows process subtree using a PID-scoped `taskkill /T`, and POSIX execution uses a process group. Deliberately detached processes are not a sandbox guarantee.

## Recovery and honest status

A failed service start preserves the paired identity. Retry the same setup after repair without another token. An ambiguous/lost claim retains `.pending-runner.env` and blocks automatic re-pairing until explicit reconciliation; never delete the only pending credential blindly. A forcibly interrupted setup leaves `.setup-lock/owner.json`; confirm the recorded process is gone before removing the stale setup lock only.

A registered Host, running local process, available network, and successful remote command are different states. Setup reports `remoteExecutionVerified: false`. Only a real connector command proves the production round trip; an active OS task does not. Native setup waits for private daemon readiness in addition to supervisor activity. `status` reports `runtime.localReady`, `runtime.connected`, and a bounded retry code. A successful queue poll confirms contact, not command execution. Dead processes, stale status and startup/import failures do not count as ready. Diagnostics contain no runner secret, argv/output or remote response text.

On Windows the immutable runtime defaults to `<config-dir>/runtimes`, and newly paired identities keep replay journals/assets under `<config-dir>/direct-exec`. Selecting a visible local configuration therefore selects its runtime and replay state together. Explicit `XDG_DATA_HOME` / `XDG_STATE_HOME` overrides remain supported. Some packaged environments expose profile files to their own children but not Task Scheduler. If the daemon cannot load there, choose a normal local directory with `--config-dir`; do not weaken ACLs or use an elevated service. Existing identities, journal roots and immutable registrations are not automatically moved or replaced. Successful lease heartbeats keep status current during long-running commands.

## Acceptance scope and remaining checks

Public CI runs the repository suite and package round trips on Windows, Linux, Apple Silicon macOS and Intel macOS with Node 22/24. Its macOS jobs also run an isolated, synthetic launchd heartbeat and independent autostart lifecycle; check the exact commit results, not historical green runs. Native acceptance scripts exercise real ACLs, child processes and cancellation, packed npx foreground execution through an isolated TLS fixture, identity reuse, and user-supervisor lifecycle. `node bin/test-host-maintenance-native.mjs` additionally checks real non-elevated Windows upgrade, failure rollback and uninstall against a unique temporary task, without production credentials. Run it only on native Windows and preserve its cleanup result. The TLS key under `test/fixtures/host-tls` is a PUBLIC test fixture, never a production secret or part of the distributed package.

Mock/provider integration, native CI tasks and test-server round trips do not prove human production consent or reboot behavior. The npm preview is publicly available, but fresh-user browser consent, standard-user desktop visibility and logout/reboot/WSL boot still need their own acceptance evidence. Runtime changes do not silently replace an existing installation.

### Platform references

- Microsoft: Security Contexts for Tasks — https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks
- Microsoft: Principal.LogonType — https://learn.microsoft.com/en-us/windows/win32/taskschd/principal-logontype
- Apple: Creating Launch Daemons and Agents — https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html

## Explicit local maintenance (preview)

Default setup still refuses to replace another runtime. Maintenance is a separate,
explicit local action using the installed package version you intend to run:

```sh
bridge-host upgrade --yes
bridge-host rollback --yes
bridge-host uninstall --yes
```

`upgrade` stages this package's immutable runtime, validates the owned registration,
retains a private snapshot, stops the previous registration and installs the
new runtime while preserving its prior running and autostart states. A previously
running Host is restarted and must report daemon readiness; a stopped Host is not
executed during upgrade. If installation fails, it attempts to
restore the previous registration. `rollback` restores the single previous snapshot,
including its prior stopped/running state. `uninstall` removes only the owned
background registration; identity, credentials, journals, immutable runtimes and a
rollback snapshot remain on disk. It does not revoke the cloud Host or erase files.
Use the same `--config-dir` as setup. These commands require explicit `--yes` and do
not obtain elevated privileges. An edited or foreign registration is never removed.

A killed maintenance process or failed automatic restoration retains
`maintenance-pending.json` and blocks further maintenance. Retain this snapshot,
the original files and `.setup-lock`; an operator must reconcile the actual OS
registration before removing a stale lock/transaction. Do not delete credentials
to fix an interrupted upgrade. Linux daemon identity is decoded from the receipt-verified service definition.
A live foreground or mismatched runtime blocks maintenance. After stopping the
supervisor, a still-live recorded daemon PID blocks registration removal; this
check does not claim that stub tests prove real OS process-tree termination.

These maintenance paths have isolated registration and failure-injection tests,
plus real non-elevated Windows Task Scheduler and existing WSL systemd USER
acceptance using synthetic daemons. Those checks cover upgrade, failed-start
recovery, rollback, uninstall and independent autostart/activity preservation,
including owned-fixture cleanup. Fresh-user consent, real login/logout/reboot and
WSL boot remain unverified. Hosted macOS checks do not substitute for those desktop acceptance steps. Availability of
the published npm preview does not establish those platform results or publication of this source export.

## 中文快速使用

运营方的 `@dashideyizhizuo/bridge-host@0.4.0-preview.1` 已公开发布到 npm；这份源码导出候选尚未远程发行。自部署必须指定自己的服务地址。从这份源码自行打包得到的是另一个制品，不得覆盖或重新发布上述 npm 版本。
安装前准备 Node.js 22 或更高版本以及 npm。首次运行 `bridge-host --endpoint https://你的实际域名/mcp`，确认允许
以当前系统用户执行命令，然后在浏览器授权。不要用管理员或 root 身份安装。

- 默认优先使用当前用户的后台服务；无法使用后台服务时会明确进入前台模式。
- `bridge-host --foreground`：保持终端打开；Ctrl+C 停止，不删除配对身份。
- `bridge-host status` / `bridge-host autostart status`：分别查看当前运行、自动启动开关及连接状态。
- `bridge-host autostart on`：开启以后自动启动；当前已停止的 Host 不会立即启动。
- `bridge-host autostart off`：关闭以后自动启动；当前运行的 Host 不会被停止。
- `bridge-host stop`：立即停止后台运行并关闭自动启动，保留身份；`setup --background` 重新开启并启动。
- 显式升级、回退、卸载使用上面的维护命令；卸载不删除身份、凭据或执行记录。
- 电脑休眠、关机、退出当前用户或停止 WSL 后，不保证能执行远程命令。

CLI 当前仍使用英文提示和固定错误代码；文件名及命令内容的中文传输与界面
翻译是两个不同问题。遇到错误请保留错误代码，不要分享任何令牌或私钥。
