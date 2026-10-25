# GitHub Engineering Bootstrap

Ordinary host commands should use Direct Exec and require no repository onboarding.

Use GitHub engineering bootstrap only when an Agent needs repository source mutation, trusted verification and/or verified publication.

## Obtain the public CLI

The Host 0.5.1 archive does not include `bootstrap-project`; use the public core source
instead. Select an accepted immutable runtime SHA and a clean checkout of
`https://github.com/dashideyizhizuo-hash/bridge-core`. No private operated-service
source or published npm core package is required. Node.js 22+ is sufficient for
this bootstrap CLI; its imports use Node built-in modules.

When `.bridge/project.json` is absent from the trusted default-branch SHA, Bridge uses the same versioned default profile throughout discovery, execution, editing, verification and publication. It uses runner class `bridge`, bounded argv execution, and existing `agent/**` or `codex/**` edit branches. Default verification is `git diff --check`: report `patch-integrity` and `projectTestsRun=false`, never that project tests passed. An optional advanced policy file, when present, remains authoritative and must validate; invalid custom policy does not silently fall back. Workflows, runner availability, host policy and repository grants must still be checked independently before claiming execution is ready.

The runtime repository and SHA must identify the same accessible source. A SHA
from an unrelated/private checkout does not become a valid public action pin by
changing the repository name. Check the source and CI for a newly selected pin.

## Generate the repository files

From the selected Bridge checkout, set `BRIDGE_RUNTIME_SHA`, `RUNNER_CLASS` and
`RUNNER_SERVICE_USER` from the approved runtime/host inventory. Substitute the
actual target path (runner class `bridge` for the default profile):

~~~bash
node bin/bridge-runner.mjs bootstrap-project \
  --bridge-repository dashideyizhizuo-hash/bridge-core \
  --bridge-sha "$BRIDGE_RUNTIME_SHA" \
  --repo /path/to/target-repository \
  --runner-class "$RUNNER_CLASS" \
  --service-user "$RUNNER_SERVICE_USER"
~~~

Defaults:

- repository: derived from the target repository's GitHub origin;
- Bridge action pin: exact HEAD of the Bridge checkout running the command;
- runner class: bridge;
- service user: `bridge-runner`, regardless of the command caller; specify the actual GitHub Actions runner service user explicitly;
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
--verify-argv '["<real>","<quality-gate>"]'  # opts into advanced policy
~~~

## Generated repository files

Without `--verify-argv`, the command generates only:

~~~text
.github/workflows/bridge-gateway.yml
.github/workflows/bridge-publish.yml
~~~

Explicit `--verify-argv` additionally generates the optional `.bridge/project.json` and its fixed verification recipe. Review existing files; bootstrap does not silently replace advanced policy.

The gateway runner label is rewritten to the selected runner class. The shipped
template still requires `[self-hosted, linux, x64, <runner-class>]`, Bash and
`/etc/bridge/host.json`; general Windows/Linux Host support does not make this
engineering template Windows/ARM compatible.

Every example/bridge@... action reference is pinned to the exact selected Bridge SHA.

The trusted verify capability executes exactly the argv supplied through
`--verify-argv`; it is not interpreted as a shell string. `npm test` above is valid
only when it is the project's actual complete gate. If a fresh workspace needs
dependency setup/tests/builds, use a trusted repository-owned wrapper and supply
its exact argv. Bootstrap does not create that wrapper or install dependencies.

Review the generated paths, branches and limits before committing. The default
edit patterns permit `agent/**` and `codex/**`, not `main`. Create an approved
existing remote working branch before edit acceptance; target resolution requires
the ref to exist. Keep the trusted policy and workflow on the default branch and
bind verification/publication to the exact policy/base/candidate identities.

## Host policy merge

When --host-policy is provided, bootstrap merges only the target repository entry into the existing host policy.

The option does not rewrite the workflow's `/etc/bridge/host.json` input. Passing
an ordinary Direct Host's user configuration path does not make Actions use it.
The default generation command above leaves active host authority unchanged.
Stage/review any host-policy merge with the host administrator before installation.

The policy and its parent directory must remain administrator-controlled and
unwritable by target code while the actual runner account can read them. Atomic
bootstrap writes use a private file mode; when installing an administrator-owned
policy, explicitly preserve/restore its intended reader group/ACL. A successful
JSON validation is not proof of OS isolation. Do not give target code root/sudo,
an unrestricted Docker socket or long-lived publication credentials.

It preserves unrelated repositories, Direct Exec configuration and existing logical resources.

For a new repository it adds bounded:

- runner class;
- workspaceExec;
- editing authority.

If an existing repository entry already binds another runner class or service user for exec/edit, bootstrap fails with BOOTSTRAP_CONFLICT rather than widening/replacing authority silently.

Before the first host-policy mutation, it creates:

~~~text
<host-policy-path>.bridge-bootstrap.bak
~~~

if that backup does not already exist.

## Existing repository files

Bootstrap is idempotent when generated content already matches.

If one of the managed repository files exists with different content, bootstrap refuses to replace it by default.

Use --force only after reviewing the existing project policy/workflow differences. --force affects only the repository-managed files selected for this bootstrap invocation; it does not bypass host-policy conflict checks.

## What cannot be automated by a repository file

Bootstrap deliberately does not claim success for external authority it cannot create safely.

After generation, the returned next checklist still requires applicable external facts:

1. obtain permission for the specific target repository and review/commit the generated files to its trusted/default branch;
2. ensure the configured GitHub App installation includes the repository and the user has the required rights;
3. authorize/select the repository through the deployment's supported flow; read-only users or App installations must remain read-only;
4. ensure an independent GitHub Actions self-hosted runner is online under the actual approved account with the required Linux/x64/class labels;
5. validate the administrator-controlled host policy and resource isolation as that runner account;
6. check the target repository's Actions/allowed-action settings for the selected public runtime pin; public core does not need private cross-repository action access;
7. run `bridge.get_repository_configuration(repository)` and a separately authorized real acceptance flow: read-only execution, then VERIFIED edit and PUBLISHED receipt only when requested and permitted.

These are real authority boundaries, not boilerplate that should be hidden.

A paired Bridge Host is not a GitHub Actions runner. Its pause/autostart controls
do not stop separate Actions jobs; already dispatched work does not roll back on
grant revocation. Bootstrap changes no OAuth grant, account ownership, repository
visibility, license, fee rule or runner registration. Keep source preparation,
external authorization and actual execution acceptance distinct.

## Recommended product workflow

~~~text
ordinary command / local tool / file
    -> Direct Exec

repository source edit
    -> bootstrap-project once
    -> GitHub engineering plane
~~~

Do not onboard a repository merely because its CLI happens to live in that repository.
