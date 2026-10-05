-- Adds a recoverable reward-claim lease and durable reward receipt to battle permits.
-- A stale claim may be retried after the Worker lease expires; awarded claims replay their receipt.

ALTER TABLE battle_permits ADD COLUMN reward_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (reward_status IN ('pending', 'claiming', 'awarded'));
ALTER TABLE battle_permits ADD COLUMN reward_claim_token TEXT;
ALTER TABLE battle_permits ADD COLUMN reward_claimed_at TEXT;
ALTER TABLE battle_permits ADD COLUMN reward_xp INTEGER;
ALTER TABLE battle_permits ADD COLUMN reward_currency INTEGER;
ALTER TABLE battle_permits ADD COLUMN reward_tier TEXT
  CHECK (reward_tier IS NULL OR reward_tier IN ('full', 'reduced'));
