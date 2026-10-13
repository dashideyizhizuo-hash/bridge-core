-- Direct Exec reliability and operator controls.
-- Add queue expiry, cancel reason, and low-frequency host heartbeat metadata.

ALTER TABLE direct_hosts ADD COLUMN last_seen_at INTEGER;

ALTER TABLE direct_runs ADD COLUMN expires_at INTEGER;
ALTER TABLE direct_runs ADD COLUMN cancel_reason TEXT;

CREATE INDEX IF NOT EXISTS direct_runs_claimable_v2
  ON direct_runs(host_id, status, expires_at, created_at);
