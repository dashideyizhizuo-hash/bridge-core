-- Persistent Bridge file objects reuse the private Direct Asset R2 plane.
-- Existing ticket-created assets remain temporary by default.

ALTER TABLE direct_assets
  ADD COLUMN persistent INTEGER NOT NULL DEFAULT 0
  CHECK (persistent IN (0,1));

ALTER TABLE direct_assets
  ADD COLUMN source_kind TEXT;

ALTER TABLE direct_assets
  ADD COLUMN source_ref TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS direct_assets_source_unique
  ON direct_assets(bridge_user_id, source_kind, source_ref)
  WHERE source_kind IS NOT NULL AND source_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS direct_assets_by_user_persistent
  ON direct_assets(bridge_user_id, persistent, status, created_at);
