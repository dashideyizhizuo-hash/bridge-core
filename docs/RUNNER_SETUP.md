# Self-hosted runner setup standard

This document is the host-side contract for Bridge host execution.

Bridge has two host execution paths:

- **Direct Exec** — default for ordinary commands/local tools; one host-level runner, no repository onboarding.
- **GitHub Exec** — only for repository engineering that needs edit/verify/publish semantics.

## 1. Direct Exec baseline

Recommended:

- Linux x86_64 or WSL2 Linux environment;
- Node.js 22+;
- one dedicated low-privilege service account such as `bridge-runner`;
- outbound HTTPS to the Bridge Cloudflare endpoint;
- no inbound port, public IP or SSH requirement.

Minimal host policy:

```json
{
  "version": 1,
  "host": { "id": "wsl-main" },
  "repositories": {},
  "directExec": {
    "enabled": true,
    "serviceUser": "bridge-runner",
    "maxSeconds": 900,
    "resultBytes": 1048576
  }
}
```

Install `examples/bridge-direct-runner.service` and a 0600 environment file based on `examples/direct-runner.env.example`. The service should run continuously and is reusable by every local project that fits the same OS trust boundary.

Do not grant the Direct service identity sudo, Docker socket access, SSH private keys, deployment credentials or unrelated sensitive filesystem access merely for convenience.

## 2. GitHub engineering runner baseline

When repository edit/verify/publish is actually required, additionally use a GitHub Actions self-hosted runner with:

- Node.js 22+ available to the runner service account;
- dedicated non-root service account;
- outbound HTTPS to GitHub;
- no inbound SSH requirement for Bridge.

A runner class should represent a real privilege/substrate boundary. Examples:

```text
self-hosted, linux, x64, bridge
self-hosted, linux, x64, bridge, cql-research
self-hosted, linux, x64, bridge, docker
```

Do not put all privileges on one universal runner.

## 3. Service account

Recommended properties:

```text
user: bridge-runner (or project-specific runner account)
sudo: none
long-lived repository PAT: none
interactive login: optional/disabled
```

Important local resources should also be protected by OS ownership/ACLs. Bridge maps logical roots and validates configured subpaths; it is not a filesystem virtualization sandbox. OS permissions remain an independent enforcement layer.

For CQL the intended shape is:

```text
/data/cql/catalog   runner: read
/data/cql/raw       runner: read
/data/cql/results   runner: read/write
```

## 4. Repository host policy

Canonical path:

```text
/etc/bridge/host.json
```

Example:

```json
{
  "version": 1,
  "host": { "id": "research-01" },
  "repositories": {
    "example/crypto": {
      "runnerClasses": ["cql-research"],
      "resources": {
        "cql-data": {
          "root": "/data/cql",
          "read": ["catalog/**", "raw/**", "results/**"],
          "write": ["results/**"]
        }
      },
      "workspaceExec": { "enabled": true, "maxSeconds": 900 }
    }
  }
}
```

Real host paths appear only here. Target repositories and cloud requests use logical names such as `cql-data`.

## 5. Validate and doctor

From a Bridge checkout:

```bash
node bin/bridge-runner.mjs validate-host-policy \
  --host-policy /etc/bridge/host.json

node bin/bridge-runner.mjs doctor \
  --host-policy /etc/bridge/host.json \
  --repository example/crypto
```

`doctor` checks configured roots/subpaths, read/write access and symlink resolution. It does not mutate project data.

## 6. GitHub credentials

Runner registration is not repository write authority.

The canonical gateway job runs target code with read-only repository authority and `persist-credentials: false`. Bridge also strips GitHub/token-like environment variables before executing target commands.

Publication remains a separate hosted stage with narrow `contents: write` authority and no target-code execution. Do not put publication credentials on the self-hosted execution runner.

## 7. Target project workflows

Use the canonical templates:

- `examples/bridge-gateway.yml` for capability, edit and ordered batch execution;
- `examples/bridge-publish.yml` for separate verified publication.

The gateway materializes the exact target SHA once, binds the trusted control/policy identity, and fetches the exact policy commit shallowly only when it is not already present. Do not use full-history checkout merely to make the policy commit available.

Keep the target-repository copies pinned to an accepted Bridge runtime SHA. Do not use mutable `@main` references for the execution action.

## 8. Security checklist

Before calling a host ready:

- runner has intended labels;
- service account has no sudo;
- Node.js 22+ is available;
- `/etc/bridge/host.json` validates;
- `doctor` passes intended resource paths;
- source datasets are OS read-only where intended;
- results paths alone are writable where intended;
- no long-lived repository PAT is required;
- a positive read-only capability succeeds;
- unknown resource/path requests fail closed.

## 9. Private Bridge repository note

While `example/bridge` is private, target repositories must be allowed to use its private action or must check out a pinned Bridge release/runtime through an explicitly authorized mechanism. A future public/stable release removes this onboarding friction.


## 10. Private Bridge action access

When the Bridge repository is private and a different private repository calls:

```yaml
uses: OWNER/bridge@<pinned-sha>
```

GitHub requires the Bridge repository to explicitly allow cross-repository Actions access.

For a user-owned private Bridge repository:

1. Open the **Bridge repository** on GitHub.
2. Go to **Settings -> Actions -> General**.
3. At the bottom, under **Access**, choose **Accessible from repositories owned by '<USER>' user**.
4. Save.

This does **not** place a permanent Bridge PAT on the self-hosted runner. GitHub supplies the runner a scoped read token for downloading the private action; GitHub documents that this token expires automatically.

Equivalent REST administration endpoint:

```text
PUT /repos/{owner}/{repo}/actions/permissions/access
{"access_level":"user"}
```

This endpoint requires repository Administration write permission. Bridge tooling should diagnose the common failure:

```text
Unable to resolve action OWNER/bridge, repository not found
```

as **private action access not granted** before suggesting changes to the runner or project capability.

If Bridge is later made public, this same-owner private sharing switch is no longer needed for private caller repositories, subject to the caller repository's normal Actions allow-list policy.

## 11. First project E2E checklist

Before calling a project integrated, verify in this order:

1. target repository hosted CI is green;
2. Bridge project policy is accepted on the trusted policy ref;
3. Bridge control workflow itself is on the trusted/default branch;
4. private Bridge action access is granted when Bridge is private;
5. self-hosted runner is online with the exact declared class label;
6. host-local policy exists (default `/etc/bridge/host.json`);
7. `bridge-runner doctor` passes for the target repository;
8. a read-only capability executes through Bridge;
9. a real privileged/local-resource capability executes through Bridge;
10. bounded result/artifact is retrievable by the cloud caller.

A direct project workflow that can access local data is useful product evidence, but it is not Bridge transport evidence.


## 12. Repository generic-exec isolation

Do not run broad generic exec diagnostics under the same OS identity that owns privileged datasets, Docker sockets, deployment credentials or other host resources unless that access is explicitly intended by both project/host policy.

Preferred low-privilege diagnostic topology:

```text
cql-research runner
  user: cql-runner
  can read: /data/cql
  purpose: named CQL capabilities only

bridge-sandbox runner
  user: bridge-sandbox
  cannot read: /data/cql
  no sudo
  no Docker group
  no SSH keys / Git credentials
  purpose: generic exec diagnostics
```

Both runners may live on the same Linux machine if filesystem permissions provide the boundary, but they must be separately registered/services and run under distinct OS accounts.

The existing host-policy key `workspaceExec` binds generic exec to both a runner class and expected service user. Runtime verifies the current service user before executing.

Example:

```json
{
  "workspaceExec": {
    "enabled": true,
    "runnerClass": "bridge-sandbox",
    "serviceUser": "bridge-sandbox",
    "maxArgv": 32,
    "maxSeconds": 900,
    "deniedRoots": ["/data/cql"]
  }
}
```

`deniedRoots` documents roots that onboarding/doctor should prove inaccessible to the sandbox account. It is not a substitute for OS ACLs.

For Linux, a practical administrator setup is:

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin bridge-sandbox
# Register a second GitHub self-hosted runner service as bridge-sandbox.
# Give it labels such as: self-hosted,linux,x64,bridge-sandbox.
# Do not add it to sudo/docker groups and do not grant it ACLs for /data/cql.
```

The exact GitHub runner registration token is obtained through the normal GitHub repository/organization UI and should not be committed to source control.

Before enabling generic exec for a low-privilege diagnostic runner, verify from that account that intended denied roots are actually unreadable. Resource-bearing exec should be enabled only when such access is intentional.
