-- Durable Task Runtime worker-launch coordination.
-- One launch claim per current dispatch prevents duplicate launcher calls.

ALTER TABLE agent_tasks ADD COLUMN launch_id TEXT;
ALTER TABLE agent_tasks ADD COLUMN launch_started_at TEXT;
ALTER TABLE agent_tasks ADD COLUMN launcher_receipt_json TEXT;
