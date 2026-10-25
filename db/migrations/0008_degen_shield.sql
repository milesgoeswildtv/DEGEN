-- Persist temporary Degen-owned Shield and the last resolved Shield interaction
-- on authoritative battle permits. These are player-only audit fields; monsters
-- never receive a Shield/Mana resource namespace.
ALTER TABLE battle_permits ADD COLUMN player_shield INTEGER NOT NULL DEFAULT 0 CHECK (player_shield >= 0);
ALTER TABLE battle_permits ADD COLUMN last_shield_absorbed INTEGER NOT NULL DEFAULT 0 CHECK (last_shield_absorbed >= 0);
ALTER TABLE battle_permits ADD COLUMN last_retaliation_damage INTEGER NOT NULL DEFAULT 0 CHECK (last_retaliation_damage >= 0);
