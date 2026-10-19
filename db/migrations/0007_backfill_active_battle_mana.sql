-- Backfill Degen-only Mana for eligible in-flight permits created after authoritative HP
-- state shipped but before player_mana was added. Existing encounters remain valid
-- across Underpass cycle closure; only permit expiry/terminal/incomplete state excludes.
-- TEST_DEGEN.maxMana is currently 12. This is migration scaffolding, not final balance canon.
UPDATE battle_permits
SET player_mana = 12
WHERE player_mana IS NULL
  AND player_hp IS NOT NULL AND player_hp > 0
  AND enemy_hp IS NOT NULL AND enemy_hp > 0
  AND battle_status = 'active'
  AND completed_at IS NULL
  AND julianday(expires_at) > julianday('now');
