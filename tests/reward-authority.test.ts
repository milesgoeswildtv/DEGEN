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
  assert.deepEqual(Object.assign({}, row), { reward_state: 'pending', reward_clear_number: null });
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
    reward_state='pending' AND completed_at IS NULL AND datetime(expires_at)>CURRENT_TIMESTAMP
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
  assert.deepEqual(Object.assign({}, recovered), { reward_clear_number: 1 });

  db.exec(`UPDATE battle_permits SET reward_state='awarded', completed_at=CURRENT_TIMESTAMP,
    reward_xp=75, reward_currency=30, reward_tier='full' WHERE id='p'`);
  const retry = db.prepare(`UPDATE battle_permits SET reward_claim_token='retry'
    WHERE id='p' AND reward_state IN ('pending','claiming') RETURNING id`).get();
  assert.equal(retry, undefined);
});

test('action CAS rejects expired, stale, terminal, and wrong-player turns without mutation', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE battle_permits (
    id TEXT PRIMARY KEY, player_id TEXT NOT NULL, expires_at TEXT NOT NULL,
    completed_at TEXT, battle_status TEXT NOT NULL, turn_count INTEGER NOT NULL,
    player_hp INTEGER NOT NULL, player_mana INTEGER NOT NULL, enemy_hp INTEGER NOT NULL
  )`);
  const insert = db.prepare(`INSERT INTO battle_permits
    (id, player_id, expires_at, completed_at, battle_status, turn_count, player_hp, player_mana, enemy_hp)
    VALUES (?, 'player', ?, ?, ?, 0, 100, 5, 30)`);
  const future = new Date(Date.now() + 300000).toISOString();
  insert.run('active', future, null, 'active');
  insert.run('expired', new Date(Date.now() - 300000).toISOString(), null, 'active');
  insert.run('completed', future, '2026-10-01 00:00:00', 'active');
  insert.run('defeated', future, null, 'defeat');

  const action = db.prepare(`UPDATE battle_permits SET
    player_hp = ?, player_mana = ?, enemy_hp = ?, battle_status = ?, turn_count = turn_count + 1
    WHERE id = ? AND player_id = ? AND completed_at IS NULL AND battle_status = 'active'
      AND datetime(expires_at) > CURRENT_TIMESTAMP AND turn_count = ?
    RETURNING turn_count`);
  const state = db.prepare('SELECT player_hp, player_mana, enemy_hp, turn_count, battle_status FROM battle_permits WHERE id = ?');
  for (const id of ['expired', 'completed', 'defeated', 'missing']) {
    const before = state.get(id);
    assert.equal(action.get(90, 2, 20, 'active', id, 'player', 0), undefined);
    assert.deepEqual(state.get(id), before);
  }
  assert.equal(action.get(90, 2, 20, 'active', 'active', 'wrong-player', 0), undefined);
  assert.equal(action.get(90, 2, 20, 'active', 'active', 'player', 0)?.turn_count, 1);
  const afterFirst = state.get('active');
  assert.equal(action.get(80, 0, 10, 'active', 'active', 'player', 0), undefined);
  assert.deepEqual(state.get('active'), afterFirst);
  assert.equal(action.get(80, 0, 10, 'victory', 'active', 'player', 1)?.turn_count, 2);
  const victory = state.get('active');
  assert.equal(action.get(70, 0, 0, 'victory', 'active', 'player', 2), undefined);
  assert.deepEqual(state.get('active'), victory);
});
