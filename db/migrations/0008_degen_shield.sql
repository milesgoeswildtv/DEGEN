-- Persist temporary Degen-owned Shield and the last resolved Shield interaction.
-- Existing permits receive zero Shield but NULL audit deltas, marking pre-Shield history.
-- New permits initialize both audit deltas to zero; every accepted action stores its result.
-- D1 must preserve exact JavaScript safe-integer values used by authoritative combat state.
ALTER TABLE battle_permits
  ADD COLUMN player_shield INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(player_shield) = 'integer' AND player_shield BETWEEN 0 AND 9007199254740991);
ALTER TABLE battle_permits
  ADD COLUMN last_shield_absorbed INTEGER
    CHECK (last_shield_absorbed IS NULL OR (typeof(last_shield_absorbed) = 'integer' AND last_shield_absorbed BETWEEN 0 AND 9007199254740991));
ALTER TABLE battle_permits
  ADD COLUMN last_retaliation_damage INTEGER
    CHECK (last_retaliation_damage IS NULL OR (typeof(last_retaliation_damage) = 'integer' AND last_retaliation_damage BETWEEN 0 AND 9007199254740991));
