-- Adds Degen-only Mana to authoritative in-progress battle state.
-- Monsters do not receive a Mana column or equivalent resource.

ALTER TABLE battle_permits ADD COLUMN player_mana INTEGER;
