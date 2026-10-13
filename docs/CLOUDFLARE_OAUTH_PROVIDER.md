# Cloudflare OAuth Provider deployment

This document defines the production Cloudflare path for Bridge.

The end-user experience is intentionally different from the one-time service-operator bootstrap.

## End-user experience

A Bridge user should only experience:

```text
ChatGPT / Codex
  -> Connect Bridge
  -> GitHub user authorization
  -> existing Bridge installation: verify and continue
  -> or install Bridge / choose repositories
  -> authorize
  -> return to ChatGPT / Codex
  -> Connected
```

The user does **not** create a GitHub App, copy a private key, paste a PAT, enter an installation ID, create D1/KV resources, or maintain repository-grant JSON.

GitHub's own installation UI remains the repository selector.

## Production topology

```text
ChatGPT / Codex
  -> OAuth 2.1 / PKCE
  -> Cloudflare OAuth Provider
  -> Bridge Worker
  -> official Bridge GitHub App
  -> GitHub installation + repository selection
  -> D1 identity / authorization mapping
  -> GitHub API / Actions
  -> self-hosted runner
```

Cloudflare's OAuth Provider owns MCP authorization-server protocol machinery:

- authorization-server metadata;
- Client ID Metadata Documents (CIMD);
- Dynamic Client Registration compatibility;
- PKCE validation;
- authorization codes;
- access / refresh tokens;
- bearer-token audience validation.

Bridge owns only application-specific authorization:

- authenticate the user through GitHub;
- verify the GitHub App installation;
- verify which repositories the authenticated GitHub user can access through that installation;
- persist the Bridge principal / installation / repository intersection;
- choose Bridge scopes and call `completeAuthorization(...)`.

GitHub user tokens are upstream credentials used only during onboarding. They are never used as MCP bearer tokens and are never persisted.

## Worker routes

The production Worker exposes:

```text
/mcp
/authorize
/oauth/token
/oauth/register
/auth/github/setup
/auth/github/callback
/task-runtime/activate
/task-runtime/control   # present only when operator control is configured
/healthz
/readyz
```

OAuth Provider also serves the relevant authorization-server / protected-resource metadata endpoints.

`/mcp` remains the canonical MCP resource.

## Repository authority

A successful MCP grant does not by itself authorize a repository.

A run still requires the full authority intersection:

```text
validated Bridge OAuth token
  ∩ Bridge principal
  ∩ GitHub App installation
  ∩ repository selected in GitHub
  ∩ Bridge read/run/publish grant
  ∩ .bridge/project.json
  ∩ host policy
```

Initial self-service repository grants are:

```json
{
  "read": true,
  "run": true,
  "publish": true
}
```

This enables the repository-level publish grant only. Publication still independently requires trusted project `editing.publish` authority, a VERIFIED candidate, current task fencing when applicable, and the existing stale-target/candidate-binding checks.

## Browser authorization state

The Worker stores a short-lived authorization transaction in D1 and also binds the browser to that transaction with a:

```text
__Host-bridge_oauth_state
```

cookie using:

- `HttpOnly`;
- `Secure`;
- `SameSite=Lax`;
- `Path=/`;
- bounded expiry.

Bridge begins with GitHub App user OAuth. After the callback it uses the ephemeral user token to call `GET /user/installations`.

If exactly one existing Bridge installation is accessible, Bridge verifies that installation and its repositories and completes the original MCP authorization without requiring the Setup URL.

If no installation exists, Bridge consumes the discovery transaction and creates a fresh opaque state + PKCE verifier before redirecting to the GitHub App installation URL. That install URL carries the fresh state.

The setup callback can recover that fresh state from the host-bound cookie if GitHub does not return the installation URL's state parameter. If both query state and cookie state exist, they must match.

GitHub's setup `installation_id` is always treated as attacker-controlled. Bridge verifies it with the authenticated GitHub user's installation-repository endpoint before persisting authority. If multiple existing installations are visible during reconnect, Bridge fails closed rather than silently choosing one and widening authority.

## Cloudflare resources

`wrangler.jsonc` declares:

```text
OAUTH_KV
DB
```

without account-specific IDs.

Current Wrangler automatic provisioning can create KV and D1 resources during deployment.

D1 stores identity/authorization/transient onboarding state plus the bounded Durable Task Runtime coordination/session records. GitHub remains the durable engineering/execution evidence truth.

## One-time operator bootstrap

The Bridge service operator must perform these actions once.

### 1. Deploy the Worker

The repository contains:

```text
wrangler.jsonc
src/cloudflare/worker-entry.mjs
```

Run:

```bash
npm install
npm run cloudflare:deploy
npm run cloudflare:migrate
```

Or use Cloudflare Workers Git integration and configure the equivalent deploy/migration commands.

The first deploy can auto-provision `OAUTH_KV` and `DB`.

### 2. Choose the canonical HTTPS endpoint

Use either the Worker `workers.dev` URL for initial acceptance or a custom domain.

The canonical MCP resource must be:

```text
https://<bridge-host>/mcp
```

Configure:

```text
BRIDGE_PUBLIC_URL=https://<bridge-host>/mcp
```

### 3. Register the official Bridge GitHub App

This happens once for the Bridge service, not once per user.

Configure the GitHub App with the permissions required by the proven GitHub transport:

```text
Actions   read + write
Contents  read + write
Issues    read
Metadata  read
```

Adding `Issues: read` to an existing GitHub App requires the installation owner to approve the updated permission before durable task transition/reconciliation can read managed Issue state. Until approval, those paths fail closed.

Disable webhooks unless a later Bridge feature explicitly requires them.

For a multi-user Bridge service, allow the App to be installed by the accounts that will use Bridge.

Configure:

```text
Setup URL:
https://<bridge-host>/auth/github/setup

Callback URL:
https://<bridge-host>/auth/github/callback
```

The setup URL is deliberate. Bridge does not trust its `installation_id`; it subsequently proves the installation through GitHub user authorization.

### 4. Configure non-secret Worker values

```text
BRIDGE_GITHUB_APP_ISSUER=<GitHub App client ID or app ID>
BRIDGE_GITHUB_APP_CLIENT_ID=<GitHub App client ID>
BRIDGE_GITHUB_APP_SLUG=<GitHub App slug>
BRIDGE_PUBLIC_URL=https://<bridge-host>/mcp
```

### 5. Configure Worker secrets

Store these only as Cloudflare secrets:

```text
BRIDGE_GITHUB_APP_PRIVATE_KEY
BRIDGE_GITHUB_APP_CLIENT_SECRET
BRIDGE_TASK_RUNTIME_ADMIN_TOKEN

# Optional only when automatic Worker launching is enabled:
BRIDGE_TASK_LAUNCHER_TOKEN
```

Never place them in:

- repository files;
- Wrangler vars;
- GitHub Issues;
- PR descriptions;
- logs;
- ChatGPT conversations.

## Client compatibility

The provider is configured for:

- OAuth 2.1 authorization code flow;
- PKCE;
- MCP resource indicators;
- CIMD as the preferred current MCP client-registration path;
- RFC 7591 DCR as compatibility fallback.

This allows clients such as ChatGPT/Codex to discover the Bridge authorization server from the protected `/mcp` resource rather than requiring users to configure OAuth endpoints manually.

## Acceptance contract

Production acceptance must prove:

```text
MCP authorize
  -> GitHub user OAuth
  -> existing-install discovery
  -> existing install: installation/repository proof
     OR no install: fresh state + install -> setup -> GitHub user OAuth
  -> D1 authority commit
  -> Cloudflare completeAuthorization
  -> MCP token props
  -> tools/list == exactly six tools
```

Negative acceptance must also prove:

- anonymous/invalid OAuth cannot invoke Bridge tools;
- setup `installation_id` alone cannot create authority;
- suspended/inaccessible installations fail closed;
- multiple ambiguous installations fail closed instead of widening authority;
- reconnect cannot downgrade repository publish grants;
- GitHub user/App credentials are absent from persisted OAuth state and cloud-facing results;
- task-session capabilities cannot replace OAuth or repository authority.
