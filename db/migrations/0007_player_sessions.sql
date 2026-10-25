-- Server-issued bearer sessions; only a SHA-256 digest is persisted.
CREATE TABLE IF NOT EXISTS player_sessions (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  player_id TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  revoked_at_ms INTEGER,
  CHECK (expires_at_ms > created_at_ms)
);
CREATE INDEX IF NOT EXISTS idx_player_sessions_player ON player_sessions(player_id, expires_at_ms);
