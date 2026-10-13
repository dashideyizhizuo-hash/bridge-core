-- Bind each durable task to the Bridge principal whose repository grant authorizes it.
-- This is a coordination authorization pointer, not engineering history.

ALTER TABLE agent_tasks ADD COLUMN bridge_user_id TEXT;

CREATE INDEX IF NOT EXISTS agent_tasks_bridge_user
  ON agent_tasks(bridge_user_id);
