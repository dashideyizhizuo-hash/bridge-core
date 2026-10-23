-- Authenticated Host progress; NULL means the Host has not reported a precise
-- process start. Claim/lease timing must never stand in for command execution.
ALTER TABLE direct_runs ADD COLUMN progress_phase TEXT
  CHECK (progress_phase IS NULL OR progress_phase IN ('PREPARING','EXECUTING','RETURNING_RESULT'));
ALTER TABLE direct_runs ADD COLUMN execution_elapsed_ms INTEGER
  CHECK (execution_elapsed_ms IS NULL OR (execution_elapsed_ms>=0 AND execution_elapsed_ms<=3700000));
ALTER TABLE direct_runs ADD COLUMN progress_reported_at INTEGER;
ALTER TABLE direct_runs ADD COLUMN phase_started_at INTEGER;
