# Project integration standard

Ordinary host operations should use Direct Exec and do not require repository integration.

When Git engineering semantics are required, the preferred onboarding path is the bootstrap command:

```bash
node bin/bridge-runner.mjs bootstrap-project \
  --bridge-repository YOUR-OWNER/YOUR-RUNTIME \
  --repo /path/to/repository \
  --verify-argv '["npm","test"]' \
  --host-policy /etc/bridge/host.json
```

See [GitHub Engineering Bootstrap](GITHUB_BOOTSTRAP.md).

A repository integrates with the GitHub engineering plane by committing one trusted project policy and thin GitHub Actions entrypoints.

## 1. Canonical policy

Path:

```text
.bridge/project.json
```

Bridge uses JSON deliberately as the canonical policy format so the runner core does not depend on a YAML parser.

A request executes target code at `target.sha`, but Bridge loads `.bridge/project.json` from the separately bound trusted `policy.sha`. Therefore a candidate cannot grant itself a new capability by modifying its own policy file.

## 2. Minimal policy

```json
{
  "version": 1,
  "project": { "repository": "owner/repo" },
  "runners": {
    "default": { "class": "bridge" }
  },
  "capabilities": {
    "unit-test": {
      "class": "verify",
      "runner": "default",
      "command": { "argv": ["python", "-m", "pytest", "-q"] },
      "limits": {
        "timeoutSeconds": 900,
        "stdoutBytes": 524288,
        "stderrBytes": 524288
      }
    }
  }
}
```

## 3. Capability fields

Bridge supports named `observe` and `verify` capabilities. In the canonical batch model these are trusted `preset` steps over the generic execution substrate.

Each capability may declare:

- `class`;
- `runner` (logical project runner -> host runner class);
- `command.argv`;
- typed `parameters`;
- logical `resources` and env names;
- output report/artifact paths;
- timeout/output limits.

Commands are argv arrays, not shell strings.

## 4. Typed parameters

Supported parameter types:

- `string` with length/pattern bounds;
- `integer` with min/max bounds;
- `boolean`.

Example:

```json
{
  "dataset_id": {
    "type": "string",
    "minLength": 1,
    "maxLength": 128,
    "pattern": "^[A-Za-z0-9._:-]+$"
  },
  "sample_levels": {
    "type": "integer",
    "minimum": 1,
    "maximum": 50,
    "default": 10
  }
}
```

Parameter interpolation stays inside one argv element:

```json
["uv", "run", "cql", "dataset-inspect", "--dataset-id", "{params.dataset_id}"]
```

Unknown parameters are denied. Parameter values are never re-parsed as shell syntax.

## 5. Logical resources

Project policy:

```json
{
  "resources": [
    { "name": "cql-data", "env": "CQL_DATA_DIR" }
  ]
}
```

Host policy separately maps `cql-data` to `/data/cql`.

The project never supplies the host path.

## 6. CQL example

See `examples/crypto.project.json`.

It declares `dataset-status` and `dataset-inspect` against runner class `cql-research`, requests logical resource `cql-data`, bounds output, and allows only typed dataset parameters.

## 7. Evidence outputs

A capability can declare a small structured report:

```json
{ "report": "bridge-output/cloud-report.json" }
```

or JSON stdout:

```json
{ "structuredStdout": "json" }
```

and bounded artifacts:

```json
{ "artifacts": ["bridge-output/**"] }
```

Bridge validates paths, rejects symlink escapes, enforces byte limits and stages only declared outputs.

Observe/verify executions must leave the repository unchanged except for those exact declared output paths.

## 8. Generic exec

Generic exec is project + host opt-in. The existing policy key remains `workspaceExec` for compatibility, but new agent orchestration should use batch `exec` steps.

Project policy binds a logical runner, limits and optionally logical resources:

```json
{
  "runners": {
    "research": { "class": "cql-research" }
  },
  "workspaceExec": {
    "enabled": true,
    "runner": "research",
    "resources": [
      { "name": "cql-data", "env": "CQL_DATA_DIR" }
    ],
    "maxArgv": 32,
    "maxSeconds": 900,
    "stdoutBytes": 524288,
    "stderrBytes": 262144
  }
}
```

The host independently opts in and binds the real service identity:

```json
{
  "runnerClasses": ["cql-research"],
  "resources": {
    "cql-data": {
      "root": "/data/cql",
      "read": ["catalog/**", "raw/**", "results/**"],
      "write": []
    }
  },
  "workspaceExec": {
    "enabled": true,
    "runnerClass": "cql-research",
    "serviceUser": "cql-runner",
    "maxArgv": 32,
    "maxSeconds": 900
  }
}
```

A canonical batch step is:

```json
{
  "id": "focused-tests",
  "type": "exec",
  "argv": ["python", "-m", "pytest", "-q", "tests/test_x.py"],
  "cwd": ".",
  "resources": []
}
```

Rules:

- argv array only; never caller-provided shell text;
- exact target SHA and separately trusted policy SHA;
- one ephemeral shared workspace per Run;
- repository-relative contained cwd;
- isolated temporary HOME/XDG/tmp;
- no inherited Bridge/GitHub/cloud secrets;
- logical resources only when allowed by both project and host policy;
- bounded argv count/bytes, timeout and output;
- no publication credential in target execution.

Environment isolation is not a filesystem sandbox. The real OS privileges of the configured service user remain authoritative. For general diagnostics, prefer a low-privilege runner. Resource-bearing generic exec should be enabled only when the project/host policy and OS ACLs intentionally grant that access.

The legacy `capability: "workspace-exec"` request form remains supported as a compatibility entry over the same authority.

## 9. Request placement

The initial GitHub transport stores immutable request JSON inside the checked-out repository, e.g.:

```text
.bridge/requests/<request-id>.json
```

Bridge refuses a request file that resolves outside the target checkout or through a symlink.

## 10. Policy changes

A candidate that adds a new capability cannot use it during the same untrusted candidate run.

Sequence:

1. review/accept policy change;
2. policy reaches trusted ref (normally `main`);
3. new request binds the new `policy.sha`;
4. capability becomes executable only if host policy independently grants its runner/resources.

## 11. Project onboarding checklist

- `.bridge/project.json` is committed;
- repository identity matches;
- every capability has a valid runner/class;
- commands are argv, not shell strings;
- parameters are typed/bounded;
- project policy contains no absolute host paths;
- required logical resources are configured on intended hosts;
- timeout/output limits are bounded;
- target workflow uses read-only GitHub permission for observe/verify;
- one positive and at least one denied execution are recorded.
