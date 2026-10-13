# Deploy core with private operator configuration

An operator can build this public repository while keeping their account,
resource identifiers and operated domain in the deployment platform. This helper
deploys the core Worker using `BRIDGE_DEPLOY_CONFIG`, supplied as strict JSON in a
private build secret. The JSON must contain no runtime credentials. Existing
Worker secrets are managed separately; `keep_vars: true` is required.

Deployment authority comes from the operator-controlled build environment and
Cloudflare API credential. Target repositories, MCP clients and public pull
request jobs must not receive these build secrets. Configure automatic production
builds only for an accepted `main` revision. Validate the exact repository SHA,
deployed version and resources after a source migration.

The helper accepts one explicitly identified resource for each required binding:

- `DB`: named D1 database with UUID `database_id` and `migrations_dir: "migrations"`.
- `OAUTH_KV`: KV namespace with a 32-character hexadecimal `id`.
- `DIRECT_ASSETS`: named R2 bucket.

The configuration must specify `account_id`, Worker `name`,
`main: "src/cloudflare/worker-entry.mjs"`, `keep_vars: true`, a valid compatibility
date at least `2026-08-04`, and the `nodejs_compat` and
`global_fetch_strictly_public` flags. Optional supported fields are `$schema`,
`workers_dev`, plain string `vars`, custom-domain `routes`, `triggers.crons` and
`observability`. Other entry points, environments, build hooks, migration paths,
bindings and secret-looking variable names or known credential formats are
rejected. Operators still need to verify that the supplied resource identities
belong to the intended core service and that no secret is hidden under an
innocuous variable name.

Run after installing the repository's pinned dependencies:

```sh
node bin/deploy-configured-core.mjs --check
node bin/deploy-configured-core.mjs
```

`--check` parses and validates without writing a file, starting a process or
contacting Cloudflare. Normal deployment creates a unique temporary configuration
in the repository root, invokes the installed Wrangler through Node with explicit
argv and `--config`, and removes that owned file in `finally`, including command
failure. The helper does not print the JSON or propagate its build-secret variable
to Wrangler. Abrupt machine termination can leave a temporary file; never commit
`.bridge-core-deploy-*.json`.

The default command performs no database migration. For an explicitly reviewed
core migration, use:

```sh
node bin/deploy-configured-core.mjs --migrate
```

This applies the checked repository's `migrations` directory to the configured
`DB` with `--remote`, then deploys with the same configuration. A failed migration
stops deployment. If migration succeeds but deployment fails, the database changes
remain applied; this helper does not attempt database rollback. When relocating
an existing configuration from another folder,
use root-relative entry and migration paths. Keep database and runtime secrets
unchanged during a repository source cutover unless a separate migration is
authorized.
