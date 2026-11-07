-- Persist temporary starting Shield for enemies in Worker-owned battle permits.
-- Existing encounters receive zero Shield; no monster Mana/equivalent resource is introduced.
ALTER TABLE battle_permits
  ADD COLUMN enemy_shield INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(enemy_shield) = 'integer' AND enemy_shield BETWEEN 0 AND 9007199254740991);


-- Preserve the last accepted enemy Shield absorption for stale-turn and terminal recovery snapshots.
ALTER TABLE battle_permits
  ADD COLUMN last_enemy_shield_absorbed INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(last_enemy_shield_absorbed) = 'integer' AND last_enemy_shield_absorbed BETWEEN 0 AND 9007199254740991);
