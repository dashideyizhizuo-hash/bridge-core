CREATE TABLE agent_task_sessions (
  token_hash TEXT PRIMARY KEY,
  task_key TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_key) REFERENCES agent_tasks(task_key) ON DELETE CASCADE
);

CREATE INDEX idx_agent_task_sessions_task_epoch
  ON agent_task_sessions(task_key, lease_epoch);
