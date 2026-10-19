import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const manaBackfill = read('../db/migrations/0007_backfill_active_battle_mana.sql');

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec(read('../db/schema.sql'));
  db.exec(read('../db/migrations/0002_authoritative_battle_state.sql'));

  db.prepare('INSERT INTO players (id, display_name) VALUES (?, ?)').run('player', 'Player');
  // The cycle is closed, but a still-valid permit must remain usable across closure.
  db.prepare(`INSERT INTO world_event_cycles (id, event_key, opens_at, closes_at)
    VALUES ('closed-cycle', 'underpass', datetime('now', '-5 hours'), datetime('now', '-4 hours'))`).run();

  const future = new Date(Date.now() + 10 * 60_000).toISOString();
  const expired = new Date(Date.now() - 10 * 60_000).toISOString();
  const insert = db.prepare(`INSERT INTO battle_permits
    (id, player_id, event_key, cycle_id, encounter_key, expires_at, completed_at,
     player_hp, enemy_hp, battle_status, turn_count)
    VALUES (?, 'player', 'underpass', 'closed-cycle', 'tunnel-maw', ?, ?, ?, ?, ?, 0)`);

  insert.run('valid-active', future, null, 80, 20, 'active');
  insert.run('expired-active', expired, null, 80, 20, 'active');
  insert.run('malformed-expiry', 'not-a-date', null, 80, 20, 'active');
  insert.run('missing-player-hp', future, null, null, 20, 'active');
  insert.run('missing-enemy-hp', future, null, 80, null, 'active');
  insert.run('victory', future, null, 80, 0, 'victory');
  insert.run('defeat', future, null, 0, 20, 'defeat');
  insert.run('completed-active', future, '2026-10-01 00:00:00', 80, 20, 'active');
  insert.run('already-has-mana', future, null, 80, 20, 'active');

  // Reproduce the rollout window: valid HP/enemy state existed before player_mana.
  db.exec(read('../db/migrations/0003_degen_mana.sql'));
  db.prepare(`UPDATE battle_permits SET player_mana = 2 WHERE id = 'already-has-mana'`).run();
  db.exec(read('../db/migrations/0004_reward_receipt.sql'));
  db.exec(read('../db/migrations/0005_reward_claim_character_guard.sql'));
  db.exec(manaBackfill);
  return db;
}

function mana(db: DatabaseSync, id: string): number | null {
  const row = db.prepare('SELECT player_mana FROM battle_permits WHERE id = ?').get(id) as
    { player_mana: number | null } | undefined;
  assert.ok(row, `expected permit ${id}`);
  return row.player_mana;
}

test('Mana backfill repairs only eligible, unexpired active permits with complete live battle state', () => {
  const db = setup();
  try {
    assert.equal(mana(db, 'valid-active'), 12);
    assert.equal(mana(db, 'already-has-mana'), 2);
    for (const id of [
      'expired-active',
      'malformed-expiry',
      'missing-player-hp',
      'missing-enemy-hp',
      'victory',
      'defeat',
      'completed-active',
    ]) assert.equal(mana(db, id), null, `${id} must remain untouched`);
  } finally {
    db.close();
  }
});

test('Mana backfill preserves valid encounters after event closure and is safe to re-run', () => {
  const db = setup();
  try {
    db.exec(manaBackfill);
    assert.equal(mana(db, 'valid-active'), 12);
    assert.equal(mana(db, 'already-has-mana'), 2);
  } finally {
    db.close();
  }
});
