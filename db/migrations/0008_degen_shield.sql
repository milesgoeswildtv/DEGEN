-- Persist temporary Degen-owned Shield on authoritative battle permits.
-- Existing encounters receive zero Shield and retain HP, Mana, enemy, and turn state.
ALTER TABLE battle_permits
  ADD COLUMN player_shield INTEGER NOT NULL DEFAULT 0 CHECK (player_shield >= 0);
