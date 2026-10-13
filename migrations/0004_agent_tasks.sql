-- Durable Agent Task Runtime coordination state.
-- GitHub remains the durable engineering journal; this table stores only current coordination truth.

CREATE TABLE IF NOT EXISTS agent_tasks (
  task_key TEXT PRIMARY KEY,
  repository TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  canonical_branch TEXT NOT NULL,

  mode TEXT NOT NULL CHECK (mode IN ('supervised', 'continuous')),
  status TEXT NOT NULL CHECK (
    status IN ('READY', 'DISPATCHING', 'RECOVERING', 'RUNNING', 'ORPHANED', 'BLOCKED', 'DONE')
  ),

  dispatch_id TEXT,
  dispatch_expires_at TEXT,

  lease_owner TEXT,
  lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_expires_at TEXT,

  active_run_id TEXT,

  checkpoint_sha TEXT,
  state_comment_id INTEGER,

  last_transition_reason TEXT,
  updated_at TEXT NOT NULL,

  UNIQUE(repository, issue_number)
);

CREATE INDEX IF NOT EXISTS agent_tasks_status
  ON agent_tasks(status);

CREATE INDEX IF NOT EXISTS agent_tasks_dispatch_expiry
  ON agent_tasks(dispatch_expires_at);

CREATE INDEX IF NOT EXISTS agent_tasks_lease_expiry
  ON agent_tasks(lease_expires_at);
