import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

// This deterministic preflight validates the exact SQL fixtures consumed by
// tests/worker-d1-concurrency.mjs against the tracked D1 schema/migrations.
// The HTTP harness itself must still run under isolated Wrangler/D1 in CI.
const source = readFileSync(new URL('./worker-d1-concurrency.mjs', import.meta.url), 'utf8');
const seed = source.match(/writeFileSync\(seed, `([\s\S]*?)`\);/)?.[1];
assert.ok(seed, 'Worker/D1 integration harness must contain its SQL seed');

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  const migrations = new URL('../db/migrations/', import.meta.url);
  for (const name of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(name, migrations), 'utf8'));
  }
  db.exec(seed);
  return db;
}

test('Worker/D1 integration seed respects all tracked migrations and foreign keys', () => {
  const db = database();
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM battle_permits').get()?.n, 19);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM world_event_cycles').get()?.n, 3);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
  } finally { db.close(); }
});

test('closed-cycle permit was legally entered before closure and remains unexpired', () => {
  const db = database();
  try {
    const row = db.prepare(`SELECT
      julianday(p.started_at) < julianday(c.closes_at) AS entered_before_close,
      julianday(c.opens_at) < julianday(p.started_at) AS entered_after_open,
      julianday(c.closes_at) < julianday('now') AS event_closed,
      julianday(p.expires_at) > julianday('now') AS permit_valid
      FROM battle_permits p JOIN world_event_cycles c ON c.id=p.cycle_id
      WHERE p.id='closed-cycle-valid'`).get();
    assert.deepEqual({ ...row }, {
      entered_before_close: 1, entered_after_open: 1, event_closed: 1, permit_valid: 1,
    });
  } finally { db.close(); }
});

test('integration fixtures distinguish authoritative victory, defeat and zero Mana', () => {
  const db = database();
  try {
    const victories = db.prepare(`SELECT COUNT(*) AS n FROM battle_permits
      WHERE id IN ('permit-a','permit-b','permit-c','permit-d') AND battle_status='victory'`).get();
    assert.equal(victories?.n, 4);
    const zero = db.prepare("SELECT player_mana, battle_status, turn_count FROM battle_permits WHERE id='zero-mana'").get();
    assert.deepEqual({ ...zero }, { player_mana: 0, battle_status: 'active', turn_count: 0 });
    const paid = db.prepare("SELECT player_mana, enemy_hp, battle_status FROM battle_permits WHERE id='paid-nonlethal'").get();
    assert.deepEqual({ ...paid }, { player_mana: 8, enemy_hp: 60, battle_status: 'active' });
  } finally { db.close(); }
});


test('HTTP action fixtures carry strict expected-turn preconditions for PR #9 integration', () => {
  assert.match(source, /async function action\(permitId, abilityId, playerId = 'integration-player', expectedTurnCount = 0\)/);
  assert.match(source, /JSON\.stringify\(\{ playerId, permitId, abilityId, expectedTurnCount \}\)/);
  assert.match(source, /action\('paid-nonlethal', 'crack', 'integration-player', 1\)/);
  assert.match(source, /action\('parallel-action', 'slash', 'integration-player', 1\)/);
});


test('expired server-recorded victory fixture remains distinct from an expired active permit', () => {
  const db = database();
  try {
    const victory = db.prepare(`SELECT p.battle_status, p.reward_state, p.reward_clear_number,
      julianday(p.started_at) < julianday(c.closes_at) AS entered_before_close,
      julianday(c.closes_at) < julianday('now') AS event_closed,
      julianday(p.expires_at) < julianday('now') AS permit_expired
      FROM battle_permits p JOIN world_event_cycles c ON c.id = p.cycle_id
      WHERE p.id = 'expired-victory'`).get();
    assert.deepEqual({ ...victory }, {
      battle_status: 'victory', reward_state: 'pending', reward_clear_number: null,
      entered_before_close: 1, event_closed: 1, permit_expired: 1,
    });
    const active = db.prepare(`SELECT battle_status, julianday(expires_at) < julianday('now') AS permit_expired
      FROM battle_permits WHERE id = 'expired'`).get();
    assert.deepEqual({ ...active }, { battle_status: 'active', permit_expired: 1 });
  } finally { db.close(); }
});


test('expired recovery fixtures use a dedicated player so rewards cannot contaminate baseline progression', () => {
  const db = database();
  try {
    const rows = db.prepare("SELECT id, player_id FROM battle_permits WHERE id IN ('expired', 'expired-victory') ORDER BY id").all();
    assert.deepEqual(rows.map(row => row.player_id), ['expired-player', 'expired-player']);
    assert.ok(source.includes("complete('expired', 'expired-player')"));
    assert.ok(source.includes("complete('expired-victory', 'expired-player')"));
    assert.equal(source.includes("complete('expired')"), false);
    assert.equal(source.includes("complete('expired-victory')"), false);
  } finally { db.close(); }
});
