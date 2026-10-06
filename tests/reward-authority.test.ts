import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const migration = readFileSync(new URL('../db/migrations/0004_reward_receipt.sql', import.meta.url), 'utf8');

const makeDb = () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE battle_permits (
    id TEXT PRIMARY KEY, player_id TEXT NOT NULL, event_key TEXT NOT NULL,
    cycle_id TEXT NOT NULL, encounter_key TEXT NOT NULL, expires_at TEXT NOT NULL,
    completed_at TEXT, battle_status TEXT NOT NULL DEFAULT 'active'
  );`);
  db.exec(migration);
  return db;
};

test('reward receipt migration defaults existing permits to pending', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE battle_permits (
    id TEXT PRIMARY KEY, player_id TEXT NOT NULL, event_key TEXT NOT NULL,
    cycle_id TEXT NOT NULL, encounter_key TEXT NOT NULL, expires_at TEXT NOT NULL,
    completed_at TEXT, battle_status TEXT NOT NULL DEFAULT 'active'
  ); INSERT INTO battle_permits VALUES
    ('p', 'player', 'underpass', 'cycle', 'tunnel-maw', datetime('now', '+5 minutes'), NULL, 'victory');`);
  db.exec(migration);
  const row = db.prepare("SELECT reward_state, reward_clear_number FROM battle_permits WHERE id = 'p'").get();
  assert.deepEqual(row, { reward_state: 'pending', reward_clear_number: null });
});

test('claim predicate rejects expired and non-victory permits and locks duplicate live claims', () => {
  const db = makeDb();
  const insert = db.prepare(`INSERT INTO battle_permits
    (id, player_id, event_key, cycle_id, encounter_key, expires_at, battle_status)
    VALUES (?, 'player', 'underpass', 'cycle', 'tunnel-maw', ?, ?)`);
  insert.run('valid', new Date(Date.now() + 300000).toISOString(), 'victory');
  insert.run('expired', new Date(Date.now() - 300000).toISOString(), 'victory');
  insert.run('defeat', new Date(Date.now() + 300000).toISOString(), 'defeat');

  const claim = db.prepare(`UPDATE battle_permits SET reward_state='claiming',
    reward_claim_token=?, reward_claimed_at=CURRENT_TIMESTAMP
    WHERE id=? AND player_id='player' AND battle_status='victory' AND
    reward_state='pending' AND completed_at IS NULL AND expires_at>CURRENT_TIMESTAMP
    RETURNING id`);
  assert.ok(claim.get('a', 'valid'));
  assert.equal(claim.get('b', 'valid'), undefined);
  assert.equal(claim.get('c', 'expired'), undefined);
  assert.equal(claim.get('d', 'defeat'), undefined);
});

test('stale claim recovery preserves assigned clear number and awarded receipts are terminal', () => {
  const db = makeDb();
  db.prepare(`INSERT INTO battle_permits
    (id, player_id, event_key, cycle_id, encounter_key, expires_at, battle_status,
     reward_state, reward_claim_token, reward_claimed_at, reward_clear_number)
    VALUES ('p', 'player', 'underpass', 'cycle', 'tunnel-maw', datetime('now', '+5 minutes'),
      'victory', 'claiming', 'old', datetime('now', '-61 seconds'), 1)`).run();

  const recovered = db.prepare(`UPDATE battle_permits SET reward_claim_token='new',
    reward_claimed_at=CURRENT_TIMESTAMP WHERE id='p' AND reward_state='claiming'
    AND reward_claimed_at < datetime('now', '-60 seconds') RETURNING reward_clear_number`).get();
  assert.deepEqual(recovered, { reward_clear_number: 1 });

  db.exec(`UPDATE battle_permits SET reward_state='awarded', completed_at=CURRENT_TIMESTAMP,
    reward_xp=75, reward_currency=30, reward_tier='full' WHERE id='p'`);
  const retry = db.prepare(`UPDATE battle_permits SET reward_claim_token='retry'
    WHERE id='p' AND reward_state IN ('pending','claiming') RETURNING id`).get();
  assert.equal(retry, undefined);
});
