---
name: continuous-github-development
description: Start, coordinate, recover, and continuously advance durable GitHub development when the user provides a repository plus a long-running development objective, using disposable Chat workers, one canonical branch, bounded stages, exact-SHA evidence, runtime ownership, and durable checkpoints.
---

# Continuous GitHub Development

Use this Skill for a long-running GitHub development task that must survive Worker/chat replacement.

## Authority order

Current user instruction -> repository-local AGENTS/governance -> durable task state -> this Skill -> default Agent habits.

## Fresh start

When a user names a GitHub repository and asks to start or continue a long-running development objective, enter this workflow without requiring them to describe Bridge mechanics:

1. Read repository `AGENTS.md`, delegated/long-running guidance, the plan entrypoint and directly relevant canonical architecture. Verify current `main`, open Issues, candidate canonical branches, PRs, CI and exact checkpoints before relying on prompt history.
2. Reuse the matching durable task and canonical branch when they exist; never create a duplicate Issue or replacement branch merely because the conversation is new.
3. For a genuinely new authorized objective, establish one primary GitHub Issue containing scope, non-goals, bounded stage chain, transition criteria, independent gates and hard stops; bind one canonical branch and exact starting SHA. Stop for a product/authority decision, not routine setup.
4. Confirm the connected server exposes the explicit repository configuration, command, verification/edit, evidence, publication and task-transition tools, and the repository is authorized. From an operator-capable Supervisor environment, enroll the task once when Runtime state does not already exist; ordinary Workers never self-enroll or bypass missing authority.
5. Start or recover the recurring Supervisor loop below. Completion means Runtime `inspect` identifies the durable task, branch and checkpoint, and either an existing valid Worker lease is healthy or exactly one Chat Worker has been launched through the current web path.

## Core rules

1. GitHub is durable engineering truth. Chat history is not project state.
2. One task has one canonical product branch unless a durable task-state migration explicitly changes it.
3. Recover before mutate. Resolve the latest checkpoint, canonical branch, exact HEAD, and checkpoint-to-HEAD work first.
4. If Durable Task Runtime is enabled, activate/claim the stage before task-bound mutation. For cloud MCP use only the opaque `taskSessionToken` returned by activation; never invent `workerId` or `leaseEpoch`.
5. One bounded stage at a time: one objective, coherent changes, focused verification, one durable checkpoint.
6. Bind claims and evidence to exact SHAs. Branch names are navigation.
7. Task code mutation/publication uses the governed Bridge path. Never bypass fencing with direct code writes.
8. A stale Worker stops. It must not write a checkpoint, publish, or create a replacement branch.
9. Checkpoint only while the current lease is still valid. If a Worker dies after publication but before checkpoint, the replacement Worker recovers checkpoint -> HEAD and reuses valid pushed work.
10. Persist the GitHub checkpoint or blocker before calling `bridge.task_transition` to release stage ownership in runtime coordination state.
11. In supervised mode, stop after the checkpoint.
12. In continuous mode, only continue after successfully claiming the already-authorized next stage with a new fencing epoch. If the Watchdog/another Worker wins the READY-state race, stop.
13. Do not reopen settled architecture without new durable evidence.
14. Hard-stop rather than improvise across authority, security, destructive migration, unexplained divergence, or unauthorized scope boundaries.

## Supervisor and disposable Chat workers

When a Supervisor manages ordinary ChatGPT chats, whether pre-created or provisioned on demand, the chats are disposable Worker carriers, not task identity or durable state.

- Keep one primary Chat carrier and sequential standby capacity. Put the authorized stage chain, transition criteria, review gates and hard stops in the primary GitHub Issue; activation sends pointers, not a copied plan. Workers persist progress and evidence in GitHub, claim already-authorized continuous stages themselves, and need not report conversationally to the Supervisor.
- The observation loop starts with Runtime `inspect`. A valid recovery lease without a Run is quiet. For a bound active Run, call `tick` before expiry when no more than eight minutes remain so Watchdog can renew both the lease and its still-live task session; always tick an expired lease even if `activeRunId` exists. `tick` verifies the bound Run, renews live work, reconciles terminal/missing work and creates any dispatch. Expand only pointed evidence for a gate, `BLOCKED`, `DONE` or identity/divergence anomaly.
- Chat is secondary transport evidence. Do not validate every send or routinely poll replies. At an expiry/delivery ambiguity, inspect the single target once through OpenCLI with a strict bound and output only status plus the latest Worker reply; never expose activation messages or `taskSessionToken` values.
- A merely stopped conversation can be reactivated after Watchdog dispatch. A Chat that durably reports missing Bridge tools is exhausted: after lease expiry, use a fresh carrier. Every new activation creates a new owner/epoch; late Workers are stale and must fail task-bound writes.
- Use standby carriers only for a durable takeover or declared independent review gate. A reviewer remains read-only without the exclusive mutation lease. At a review boundary, let the author release or expire before activating the reviewer; never overlap them.
- Ordinary Chat launch uses only repository-local `bridge-chat` over the existing browser session. Do not use Codex cross-thread messaging, invent another launcher, or put activation material in ordinary output.
- Begin bootstrap and activation prompts with: `Complete this task in the current ordinary Chat mode. Do not request or attempt a switch to Work or Codex mode.` Point the Worker to the GitHub copies of both Bridge Skills, the target Issue/governance entrypoints and the canonical checkpoint. Missing Chat-mode tools become a durable blocker, not permission to switch modes.
- Launch a fresh disposable carrier and deliver a dispatch through the single deep command `node bin/bridge-chat.mjs launch --task <task> --dispatch <dispatch> --prompt <recovery-pointers> --json`. It first asks the Chat to complete a harmless `bridge.get_repository_configuration` call for the target repository and waits for a nonce-bound response; missing, failed, or ambiguous readiness fails before activation. This is an availability screen, not authority evidence—Bridge fencing remains authoritative. Do not routinely reuse a carrier after its Worker turn ends.
- Wait for `bridge-chat launch` to reach a terminal process result. If the command runner yields a session ID, retain it and wait for completion. Runtime `RECOVERING` proves only that the dispatch was consumed; successful web delivery requires terminal `launched` for the expected conversation identity. If activation was consumed but delivery failed, wait for lease expiry; never reuse the dispatch or token. Keep `create`, `send`, and `activate` for bounded diagnostics and explicit continuation, not the normal Supervisor path.
- Before calling the loop operational, verify enrollment, canonical checkpoint, heartbeat launch route and secure web delivery. Single-writer safety also requires the canonical branch to have no unfenced direct-write path.

The Supervisor establishes or approves the durable stage chain, then remains on the control plane: inspect compact state, activate or reactivate a Worker when the runtime says one is needed, and resolve hard stops or predeclared gates. It does not assign each stage conversationally, send routine continuation prompts, or inspect every intermediate result.

## Recovery loop

```text
activate / claim
-> read durable GitHub state
-> canonical branch + exact HEAD
-> compare checkpoint -> HEAD
-> inspect intervening commits/files
-> read repository governance
-> confirm one bounded stage
-> explicit repository command or edit-and-verify tool
-> focused evidence
-> publish if VERIFIED
-> revalidate current lease
-> durable GitHub checkpoint
-> bridge.task_transition / release runtime lease
-> supervised: stop
-> continuous: CAS-claim next authorized stage or stop
```

A recovery result showing valid linear work after the checkpoint is not permission to ignore it. Review and explicitly adopt it before mutation. Divergence or unexplained/unrelated work is a hard stop.

## Task-session transport

For cloud-hosted MCP workers:

- pass the activation-issued `taskSessionToken` to task-aware `bridge.get_repository_configuration`, `bridge.execute_repository_commands`, `bridge.verify_repository`, `bridge.edit_and_verify_repository`, `bridge.get_run`, `bridge.get_result`, `bridge.publish` and `bridge.task_transition`; successful task-bound operations slide the current lease and token expiry together without changing the fencing epoch. Use the fixed trusted `mcp.verification` recipe; caller-selected capability IDs, arbitrary parameters and mixed execution steps are not tool inputs. Poll long Runs and retrieve terminal evidence with the token rather than allowing it to expire between execution and checkpointing;
- record READY or DONE in the machine checkpoint payload so expiry reconciliation can recover a comment written just before an interrupted Issue-pointer update; legacy status-less comments remain recoverable by a replacement Worker but are not auto-adopted by the Watchdog;
- for BLOCKED, persist the blocker journal comment and its exact reason/comment pointer in managed Issue state before calling the transition tool;
- machine checkpoint/blocker comments must be written by the verified GitHub identity bound to the enrolled Bridge principal; another commenter's copied marker is not recoverable authority;
- mark the durable checkpoint continuation as `same-worker` only when the next stage is already authorized for the current Worker; use `handoff` for an independent reviewer/other Worker, and leave continuation null when there is no next stage;
- after persisting a checkpoint or blocker, call `bridge.task_transition` with READY, BLOCKED or DONE; READY `continue: true` is accepted only for an exact `same-worker` continuation;
- do not persist the raw token in GitHub Issues, source, checkpoints or ordinary logs;
- treat expired/stale/principal-mismatched token rejection as authoritative;
- do not manually supply task key, worker owner or fencing epoch as tool arguments.

Programmable clients that can inject MCP HTTP headers may use the supported three-header task-session transport. This is a transport compatibility path, not a different authority model.

OAuth principal/repository authorization and D1 fencing are still required in either transport.

## Hard stops

Stop mutation and persist a concise durable blocker when:

- canonical branch/HEAD cannot be reconciled;
- an active owner or newer fencing epoch exists;
- intervening work is unexplained or unrelated;
- governance/authority is unclear;
- security boundaries would need weakening;
- secrets, destructive migration, or new production authority is newly required;
- work crosses into an unauthorized independent Issue/stage;
- evidence is insufficient for the transition;
- a genuine product decision requires the human.

## Stage report

At a stage boundary report only durable facts:

```text
Canonical branch / exact HEAD
Completed stage
Evidence
Checkpoint comment / SHA
Changed facts
Remaining blocker or next stage
```

Do not copy recoverable repository history into narrative handoffs.
