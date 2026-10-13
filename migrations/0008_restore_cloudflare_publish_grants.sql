-- Restore repository publish grants that may have been downgraded by the
-- production Cloudflare OAuth reconnect path while preserving the existing
-- read -> run -> publish hierarchy.
--
-- Only already-authorized repositories with read+run enabled are promoted.

UPDATE repository_grants
SET can_publish = 1,
    updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
WHERE can_read = 1
  AND can_run = 1
  AND can_publish = 0;
