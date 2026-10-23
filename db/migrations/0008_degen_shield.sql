-- Persist temporary Degen-owned Shield on authoritative battle permits.
-- Shield is player-only; no monster resource fields are introduced.
ALTER TABLE battle_permits ADD COLUMN player_shield INTEGER NOT NULL DEFAULT 0 CHECK (player_shield >= 0);
