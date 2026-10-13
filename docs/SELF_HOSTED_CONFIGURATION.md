# Configure your own Bridge deployment

This source-available core runs without the commercial account console, billing or payment services. It does not grant access to an operator's private Cloudflare account, GitHub App, hosted Bridge account or connected ChatGPT App.

## Cloud service and Host

Follow CLOUDFLARE_OAUTH_PROVIDER.md and REMOTE_DEPLOYMENT.md with your own Cloudflare account, D1/KV/R2 resource IDs, GitHub App credentials and HTTPS domain. The checked-in wrangler file declares binding names only; no production account/resource IDs or secret values are included. Keep credentials in Worker Secrets or local ignored files.

Pass your real HTTPS MCP endpoint explicitly when installing a Host:

```sh
bridge-host --endpoint https://YOUR-BRIDGE-HOST/mcp
```

All `example` repositories, `example.invalid` domains, zero action SHAs and sample local resource paths in this export are placeholders. They are not live services or grants. Replace them with resources you own; do not reuse our private service credentials.

For the operator-only durable task CLI, set `BRIDGE_TASK_ORIGIN` to your own HTTPS origin when initializing and running the CLI. Its private config `baseUrl` must match that exact origin; redirects and cross-origin token delivery remain forbidden. The default `https://bridge.example.invalid` intentionally identifies no live deployment.

## GitHub engineering workflows

Direct Host commands and files do not require this plane. For repository engineering, first place this reviewed runtime in a GitHub repository accessible to the target repositories. Then use the real runtime repository name and an exact commit that exists in that repository:

```sh
bridge-runner bootstrap-project --repo /path/to/target --verify-argv '["npm","test"]' --bridge-repository YOUR-OWNER/YOUR-RUNTIME --bridge-sha YOUR-40-HEX-COMMIT
```

The bootstrap refuses a missing or placeholder runtime repository. It generates pinned action references from this explicit operator choice. Copying templates without replacing `example/bridge@000...` is not a runnable workflow. A new clean-history repository does not contain old private repository commit IDs. Ordinary GitHub repository grants, runner isolation and exact-policy/target SHA checks still apply.

## Optional connected plugin

The shipped `.app.json` has no private App binding and the marketplace has no fabricated public repository URL. Create your own connected App for your deployed MCP endpoint. Supply its real ID through `BRIDGE_APP_ID` when running `npm run plugin:package`. The packager refuses to produce an apparently connected package without a binding. Publish a marketplace URL only after your chosen repository actually exists and its release is reviewed.

## CI and platform acceptance

The public-source CI uses disposable GitHub-hosted Ubuntu machines and does not request this operator's private self-hosted runners. Dependency checks, core tests, package installation and foreground TLS execution remain enabled. A public workflow definition has not been run until a destination repository is created. Native user-service lifecycle/reboot acceptance must be run separately using the existing isolated acceptance tooling on each supported OS; do not treat the removed private-runner CI assumptions as public platform proof.

## License

The project uses the unmodified Elastic License 2.0 in LICENSE. This is source-available, not OSI open source. Customer/internal business use is not generally prohibited; hosting or managing substantial Bridge functionality for third parties is restricted by the license. The exact license text governs, without an additional blanket commercial-use prohibition. Third-party dependencies retain their own notices and terms.
