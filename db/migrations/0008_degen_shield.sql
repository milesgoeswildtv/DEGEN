-- Persist temporary Degen-owned Shield and the last resolved Shield interaction.
-- Existing permits receive zero Shield but NULL audit deltas, marking pre-Shield history.
-- New permits initialize both audit deltas to zero; every accepted action stores its result.
ALTER TABLE battle_permits
  ADD COLUMN player_shield INTEGER NOT NULL DEFAULT 0 CHECK (player_shield >= 0);
ALTER TABLE battle_permits
  ADD COLUMN last_shield_absorbed INTEGER CHECK (last_shield_absorbed >= 0);
ALTER TABLE battle_permits
  ADD COLUMN last_retaliation_damage INTEGER CHECK (last_retaliation_damage >= 0);
