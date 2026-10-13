# Bridge contributor rules

Bridge is security-sensitive developer infrastructure.

## Required invariants

- Do not add arbitrary privileged shell execution as a shortcut.
- Do not allow cloud requests or target repositories to supply host absolute paths.
- Do not let a candidate branch self-authorize a new capability/resource.
- Bind target and policy to exact SHAs.
- Keep target-code execution separate from repository publication credentials.
- Fail closed on stale identity, unknown policy or unknown resource.
- Bound logs and artifacts.
- Treat output as untrusted evidence.
- Keep GitHub as durable engineering truth for repository-backed work; keep Direct Run state in the bounded Cloudflare/D1 execution plane.
- Prefer the smallest protocol surface that serves the real crypto and micro-apps pilots.

## Core distribution boundary

Keep `main` independently deployable as the source-available core, including the local
Host and MCP/Cloudflare service. Commercial billing and payment integrations stay
private and must not enter core main. Audit private candidates separately. Before
any public release, read `docs/CORE_DISTRIBUTION.md`: the original private repositories' commercial branches/PR history must not be exposed by changing their visibility.
Check platform changes on Windows, Linux, and both macOS architectures in public hosted CI.
Hosted CI does not establish real desktop login/logout or reboot behavior.

## Development order

Before adding a feature:

1. state the authority it needs;
2. state the host/project trust boundary;
3. define failure behavior;
4. define exact identity/evidence;
5. add negative tests;
6. only then add convenience.

Do not expand the system based only on hypothetical multi-cloud or orchestration needs. The first proof is two materially different real repositories.

## Direct Exec default

For ordinary host commands, installed CLIs, local data inspection, browser automation and media/file tooling, prefer the host-first Direct Exec plane.

Do not require a target repository, `.bridge/project.json`, repository grant, project runner class or GitHub workflow merely to execute an ordinary command.

Direct Exec must remain:

- bound to a principal-owned logical host;
- authenticated by a host runner credential whose raw value is never stored in D1;
- executed under an intentionally low-privilege OS identity;
- argv-based, bounded and environment-sanitized;
- replay-safe through the local execution journal;
- cancellable through host disable/token rotation heartbeat failure;
- separate from `bridge.publish` and GitHub Durable Task Runtime.

Use repository onboarding only when the requested work actually needs Git engineering semantics such as source mutation, trusted verification, exact candidate identity or publication.

## Repository and host onboarding

For repository/host onboarding, self-hosted runner setup or changes, repository authorization, Bridge project/host policy configuration, workflow installation, or acceptance testing, read:

`skills/bridge-project-onboarding/SKILL.md`

Treat that Skill as the durable onboarding procedure. Keep the authority and security invariants in this file authoritative if guidance ever conflicts.

## Durable continuous development

For tasks enrolled in the Durable Agent Task Runtime, read:

`skills/continuous-github-development/SKILL.md`

A task-aware Worker must recover before mutation, respect the current stage lease/fencing epoch, keep one canonical product branch, checkpoint every bounded stage, and never bypass Bridge fencing with a direct canonical-branch code write.
