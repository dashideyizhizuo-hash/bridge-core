-- Pending MCP authorization requests before a GitHub identity / Bridge principal exists.
-- OAuth grants/tokens remain in the Cloudflare OAuth Provider OAUTH_KV namespace.

CREATE TABLE IF NOT EXISTS mcp_authorization_states (
  state TEXT PRIMARY KEY,
  oauth_request_json TEXT NOT NULL,
  client_name TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  installation_id INTEGER,
  consented INTEGER NOT NULL DEFAULT 0 CHECK (consented IN (0, 1)),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS mcp_authorization_states_expiry
  ON mcp_authorization_states(expires_at);
