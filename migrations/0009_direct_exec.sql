-- Host-first Direct Exec control-plane state.
-- GitHub remains the durable engineering truth for repository-backed runs.

CREATE TABLE IF NOT EXISTS direct_hosts (
  host_id TEXT PRIMARY KEY,
  bridge_user_id TEXT NOT NULL,
  runner_token_sha256 TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (bridge_user_id) REFERENCES bridge_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS direct_hosts_by_user
  ON direct_hosts(bridge_user_id, enabled, host_id);

CREATE TABLE IF NOT EXISTS direct_runs (
  request_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  bridge_user_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELED')),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  FOREIGN KEY (bridge_user_id) REFERENCES bridge_users(id) ON DELETE CASCADE,
  FOREIGN KEY (host_id) REFERENCES direct_hosts(host_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS direct_runs_by_host_status
  ON direct_runs(host_id, status, created_at);

CREATE INDEX IF NOT EXISTS direct_runs_by_user
  ON direct_runs(bridge_user_id, created_at);
