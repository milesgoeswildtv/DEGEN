-- Rows written by pre-auth builds may contain caller-supplied provider IDs.
-- Preserve them for recovery, but never treat them as verified account ownership.
ALTER TABLE platform_identities ADD COLUMN verified_at TEXT;

-- Server-issued bearer sessions; only SHA-256 digests are persisted.
CREATE TABLE IF NOT EXISTS player_sessions (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER,
  CHECK (expires_at_ms > created_at_ms)
);
CREATE INDEX IF NOT EXISTS idx_player_sessions_player ON player_sessions(player_id, expires_at_ms);

-- One-use, short-lived state for Discord Embedded App OAuth code exchange.
CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce_hash TEXT PRIMARY KEY CHECK (length(nonce_hash) = 64),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER,
  CHECK (expires_at_ms > created_at_ms)
);
CREATE INDEX IF NOT EXISTS idx_auth_nonces_expiry ON auth_nonces(expires_at_ms, consumed_at_ms);
