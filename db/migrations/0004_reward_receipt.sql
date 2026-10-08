ALTER TABLE battle_permits ADD COLUMN reward_state TEXT NOT NULL DEFAULT 'pending' CHECK (reward_state IN ('pending', 'claiming', 'awarded'));
ALTER TABLE battle_permits ADD COLUMN reward_claim_token TEXT;
ALTER TABLE battle_permits ADD COLUMN reward_claimed_at TEXT;
ALTER TABLE battle_permits ADD COLUMN reward_clear_number INTEGER;
ALTER TABLE battle_permits ADD COLUMN reward_xp INTEGER;
ALTER TABLE battle_permits ADD COLUMN reward_currency INTEGER;
ALTER TABLE battle_permits ADD COLUMN reward_tier TEXT CHECK (reward_tier IN ('full', 'reduced'));
ALTER TABLE battle_permits ADD COLUMN reward_level INTEGER;
ALTER TABLE battle_permits ADD COLUMN reward_remaining_xp INTEGER;
