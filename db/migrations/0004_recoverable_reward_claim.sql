-- Track recoverable, auditable server reward delivery for resolved victories.
ALTER TABLE battle_permits ADD COLUMN reward_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE battle_permits ADD COLUMN reward_claim_token TEXT;
ALTER TABLE battle_permits ADD COLUMN reward_claimed_at TEXT;
ALTER TABLE battle_permits ADD COLUMN reward_tier TEXT;
ALTER TABLE battle_permits ADD COLUMN reward_xp INTEGER;
ALTER TABLE battle_permits ADD COLUMN reward_currency INTEGER;
ALTER TABLE battle_permits ADD COLUMN reward_level INTEGER;
ALTER TABLE battle_permits ADD COLUMN reward_player_xp INTEGER;
