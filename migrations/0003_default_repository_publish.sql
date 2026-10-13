-- Repository onboarding now grants read/run/publish by default.
-- Backfill only repositories that already have an active read+run grant.
-- D1 timestamps are stored as Unix epoch milliseconds in this schema.

UPDATE repository_grants
SET can_publish = 1,
    updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE can_read = 1
  AND can_run = 1
  AND can_publish = 0;
