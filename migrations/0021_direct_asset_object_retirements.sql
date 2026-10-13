-- Main file-plane hardening only. Billing migrations 0013-0020 are separate.
-- The trigger records replaced keys in the same transaction as generation CAS.
CREATE TABLE IF NOT EXISTS direct_asset_object_retirements (
  object_key TEXT PRIMARY KEY,
  retired_at INTEGER NOT NULL,
  retirement_token TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS direct_asset_retire_object_generation
AFTER UPDATE OF object_key ON direct_assets
WHEN OLD.object_key <> NEW.object_key
BEGIN
  INSERT INTO direct_asset_object_retirements(object_key,retired_at,retirement_token)
  VALUES(OLD.object_key,CAST(strftime('%s','now') AS INTEGER)*1000,lower(hex(randomblob(16))))
  ON CONFLICT(object_key) DO UPDATE SET retired_at=excluded.retired_at,
    retirement_token=excluded.retirement_token;
END;
