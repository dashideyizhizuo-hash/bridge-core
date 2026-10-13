-- Direct Asset plane metadata. Binary payloads live in private R2.

CREATE TABLE IF NOT EXISTS direct_assets (
  asset_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL UNIQUE,
  bridge_user_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  upload_token_sha256 TEXT,
  status TEXT NOT NULL CHECK (status IN ('WAITING_UPLOAD','READY','EXPIRED')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  uploaded_at INTEGER,
  FOREIGN KEY (bridge_user_id) REFERENCES bridge_users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS direct_assets_by_user_status
  ON direct_assets(bridge_user_id, status, expires_at);

CREATE INDEX IF NOT EXISTS direct_assets_expiry
  ON direct_assets(status, expires_at);
