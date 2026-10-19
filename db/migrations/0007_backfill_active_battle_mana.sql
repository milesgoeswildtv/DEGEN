-- Backfill only the legacy Underpass/Tunnel Maw permits that could exist before player_mana.
-- A closed Underpass cycle does not invalidate an already-issued, unexpired encounter.
-- TEST_DEGEN.maxMana is currently 12. This is migration scaffolding, not final balance canon.
UPDATE battle_permits
SET player_mana = 12
WHERE event_key = 'underpass'
  AND encounter_key = 'tunnel-maw'
  AND player_mana IS NULL
  AND player_hp IS NOT NULL AND player_hp > 0
  AND enemy_hp IS NOT NULL AND enemy_hp > 0
  AND battle_status = 'active'
  AND completed_at IS NULL
  AND julianday(expires_at) > julianday('now');
