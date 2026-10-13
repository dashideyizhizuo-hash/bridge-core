-- Bridge remote identity / authorization store.
-- GitHub remains the execution/run-state source of truth.

CREATE TABLE IF NOT EXISTS bridge_users (
  id TEXT PRIMARY KEY,
  external_provider TEXT NOT NULL,
  external_subject TEXT NOT NULL,
  github_user_id TEXT,
  github_login TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(external_provider, external_subject)
);

CREATE TABLE IF NOT EXISTS github_installations (
  installation_id INTEGER PRIMARY KEY,
  account_login TEXT NOT NULL,
  account_id TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  suspended_at TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_installation_grants (
  bridge_user_id TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (bridge_user_id, installation_id),
  FOREIGN KEY (bridge_user_id) REFERENCES bridge_users(id) ON DELETE CASCADE,
  FOREIGN KEY (installation_id) REFERENCES github_installations(installation_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS repository_grants (
  bridge_user_id TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  repository_full_name TEXT NOT NULL,
  can_read INTEGER NOT NULL CHECK (can_read IN (0, 1)),
  can_run INTEGER NOT NULL CHECK (can_run IN (0, 1)),
  can_publish INTEGER NOT NULL CHECK (can_publish IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (bridge_user_id, installation_id, repository_full_name),
  FOREIGN KEY (bridge_user_id, installation_id)
    REFERENCES user_installation_grants(bridge_user_id, installation_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS repository_grants_by_user_repo
  ON repository_grants(bridge_user_id, repository_full_name);

CREATE TABLE IF NOT EXISTS github_onboarding_states (
  state TEXT PRIMARY KEY,
  bridge_user_id TEXT NOT NULL,
  principal_json TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  installation_id INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS github_onboarding_states_expiry
  ON github_onboarding_states(expires_at);
