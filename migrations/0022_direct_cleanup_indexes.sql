-- Index bounded maintenance scans without changing lease or retention policy.
CREATE INDEX IF NOT EXISTS direct_runs_terminal_gc
  ON direct_runs(completed_at)
  WHERE status IN ('SUCCEEDED','FAILED','CANCELED');
CREATE INDEX IF NOT EXISTS direct_runs_queued_gc
  ON direct_runs(expires_at)
  WHERE status='QUEUED';
CREATE INDEX IF NOT EXISTS direct_runs_running_gc
  ON direct_runs(lease_expires_at)
  WHERE status='RUNNING';
CREATE INDEX IF NOT EXISTS direct_asset_retirements_gc
  ON direct_asset_object_retirements(retired_at,object_key);
