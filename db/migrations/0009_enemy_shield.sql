-- Persist temporary starting Shield for enemies in Worker-owned battle permits.
-- Existing encounters receive zero Shield; no monster Mana/equivalent resource is introduced.
ALTER TABLE battle_permits
  ADD COLUMN enemy_shield INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(enemy_shield) = 'integer' AND enemy_shield BETWEEN 0 AND 9007199254740991);
