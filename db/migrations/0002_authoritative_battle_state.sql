-- Adds server-authoritative battle state to existing DEGEN databases.
-- Run once before deploying the Worker version that exposes /api/battle/action.

ALTER TABLE battle_permits ADD COLUMN player_hp INTEGER;
ALTER TABLE battle_permits ADD COLUMN enemy_hp INTEGER;
ALTER TABLE battle_permits ADD COLUMN battle_status TEXT NOT NULL DEFAULT 'active'
  CHECK (battle_status IN ('active', 'victory', 'defeat'));
ALTER TABLE battle_permits ADD COLUMN turn_count INTEGER NOT NULL DEFAULT 0;
