# Roadmap

This file tracks current product direction only. Historical implementation slices, acceptance evidence and completed milestone checkpoints belong in GitHub Issues.

Current architecture and security contracts are defined by:

- [README](../README.md)
- [Architecture](ARCHITECTURE.md)
- [Protocol](PROTOCOL.md)
- [Security](SECURITY.md)
- [Remote deployment](REMOTE_DEPLOYMENT.md)
- [Durable Task Runtime](DURABLE_TASK_RUNTIME.md)

## Current baseline

Bridge currently has:

- an explicit user-goal MCP surface with separately declared schemas, evidence retrieval and fenced task transition;
- Cloudflare OAuth + official GitHub App production composition;
- principal-scoped repository read/run/publish authority;
- one canonical GitHub-backed execution transport;
- one Run / one shared ephemeral workspace / ordered batch steps;
- generic bounded exec, trusted presets, editing and separate publication;
- exact target/policy/candidate/evidence binding;
- Durable Task Runtime fencing with opaque cloud task sessions;
- canonical gateway/publish workflow templates;
- intentional Node reference and private MCP compatibility adapters.

The architecture/code cleanup audit is tracked by Issue #65.

## Near-term work

### Production acceptance and operations

Keep the deployed control plane aligned with the repository contract:

- deploy accepted main revisions;
- apply new D1 migrations exactly once and never rewrite migration history;
- verify health/readiness and OAuth challenge behavior;
- keep Dashboard-managed non-secret vars safe across deploys;
- preserve secrets in Cloudflare secret storage;
- periodically exercise authenticated discover -> run -> get_result -> publish acceptance.

### Durable continuous development

Complete and maintain real task-runtime acceptance:

- deterministic recovery-before-mutate;
- crash/takeover proof;
- stale/zombie worker rejection;
- current-epoch publication fencing;
- bounded checkpointing and hard-stop behavior;
- explicit separation between D1 coordination and GitHub engineering truth.

### Consumer adoption

Keep Bridge generic while proving materially different consumers:

- crypto/CQL local-data research;
- micro-apps-infra verification/edit/publish;
- additional repositories only when they exercise reusable primitives rather than project-specific Bridge code.

### Packaging/distribution

Package Skills + MCP as one easy-to-connect product surface without creating a second authority model.

Distribution work may include:

- stable plugin/app metadata;
- user-facing onboarding;
- compatibility/version policy;
- account/repository lifecycle;
- operational diagnostics.

## Deferred until evidence demands them

Do not add by default:

- general remote shell or SSH;
- arbitrary host filesystem browser;
- host package-manager/sudo control;
- generalized secrets broker;
- Kubernetes/cross-cloud scheduler;
- persistent dirty workspaces across Runs;
- capability-specific MCP tool proliferation;
- a second durable execution/history database;
- automatic target-repository self-authorization;
- complex workflow/DAG language inside Bridge.

## Cleanup principle

When the same supported behavior can be expressed with fewer paths, prefer:

```text
delete
> consolidate
> reuse existing primitive
> small refactor
> new abstraction
```

Compatibility paths should remain only while a real consumer or documented support contract depends on them.
