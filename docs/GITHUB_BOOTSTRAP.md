# GitHub Engineering Bootstrap

Ordinary host commands should use Direct Exec and require no repository onboarding.

Use GitHub engineering bootstrap only when an Agent needs repository source mutation, trusted verification and/or verified publication.

## One command

From a Bridge checkout:

~~~bash
node bin/bridge-runner.mjs bootstrap-project \
  --bridge-repository YOUR-OWNER/YOUR-RUNTIME \
  --repo /path/to/target-repository \
  --verify-argv '["npm","test"]' \
  --host-policy /etc/bridge/host.json
~~~

Defaults:

- repository: derived from the target repository's GitHub origin;
- Bridge action pin: exact HEAD of the Bridge checkout running the command;
- runner class: bridge;
- service user: current OS user;
- edit branches: agent/** and codex/**;
- edit paths: **;
- publication: enabled, but still subject to repository grant, trusted policy, VERIFIED evidence and stale-target checks.

Optional overrides:

~~~text
--repository owner/repo
--runner-class NAME
--service-user USER
--bridge-sha <40-hex|current>
--force
~~~

## Generated repository files

The command generates:

~~~text
.bridge/project.json
.github/workflows/bridge-gateway.yml
.github/workflows/bridge-publish.yml
~~~

The gateway runner label is rewritten to the selected runner class.

Every example/bridge@... action reference is pinned to the exact selected Bridge SHA.

The trusted verify capability executes exactly the argv supplied through --verify-argv; it is not interpreted as a shell string.

## Host policy merge

When --host-policy is provided, bootstrap merges only the target repository entry into the existing host policy.

It preserves unrelated repositories, Direct Exec configuration and existing logical resources.

For a new repository it adds bounded:

- runner class;
- workspaceExec;
- editing authority.

If an existing repository entry already binds another runner class or service user for exec/edit, bootstrap fails with BOOTSTRAP_CONFLICT rather than widening/replacing authority silently.

Before the first host-policy mutation, it creates:

~~~text
/etc/bridge/host.json.bridge-bootstrap.bak
~~~

if that backup does not already exist.

## Existing repository files

Bootstrap is idempotent when generated content already matches.

If one of the managed repository files exists with different content, bootstrap refuses to replace it by default.

Use --force only after reviewing the existing project policy/workflow differences. --force affects the three repository-managed files; it does not bypass host-policy conflict checks.

## What cannot be automated by a repository file

Bootstrap deliberately does not claim success for external authority it cannot create safely.

After generation, the returned next checklist still requires applicable external facts:

1. commit generated repository files to the trusted/default branch;
2. ensure the official Bridge GitHub App installation includes the repository;
3. ensure Bridge's principal repository grant allows read/run/publish;
4. ensure a self-hosted GitHub runner with the declared class is online;
5. verify private cross-repository action access while Bridge itself remains private;
6. run bridge.discover(repository) and an actual acceptance flow.

These are real authority boundaries, not boilerplate that should be hidden.

## Recommended product workflow

~~~text
ordinary command / local tool / file
    -> Direct Exec

repository source edit
    -> bootstrap-project once
    -> GitHub engineering plane
~~~

Do not onboard a repository merely because its CLI happens to live in that repository.
