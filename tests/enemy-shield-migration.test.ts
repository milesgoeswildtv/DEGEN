import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(new URL('../db/migrations/0009_enemy_shield.sql', import.meta.url), 'utf8');

test('enemy Shield migration defaults existing permits to zero without changing combat state', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE battle_permits (
        id TEXT PRIMARY KEY,
        player_hp INTEGER,
        player_mana INTEGER,
        player_shield INTEGER,
        enemy_hp INTEGER,
        battle_status TEXT,
        turn_count INTEGER
      );
      INSERT INTO battle_permits VALUES ('legacy', 73, 4, 2, 41, 'active', 3);
    `);
    db.exec(migration);
    const row = db.prepare('SELECT player_hp,player_mana,player_shield,enemy_hp,enemy_shield,last_enemy_shield_absorbed,battle_status,turn_count FROM battle_permits WHERE id=?').get('legacy') as Record<string, unknown>;
    assert.deepEqual({ ...row }, {
      player_hp: 73, player_mana: 4, player_shield: 2, enemy_hp: 41,
      enemy_shield: 0, last_enemy_shield_absorbed: 0, battle_status: 'active', turn_count: 3,
    });
    for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => db.prepare('UPDATE battle_permits SET enemy_shield=? WHERE id=?').run(invalid, 'legacy'),
        /CHECK constraint failed/,
      );
    }
    for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => db.prepare('UPDATE battle_permits SET last_enemy_shield_absorbed=? WHERE id=?').run(invalid, 'legacy'),
        /CHECK constraint failed/,
      );
    }
    db.prepare('UPDATE battle_permits SET enemy_shield=? WHERE id=?').run(Number.MAX_SAFE_INTEGER, 'legacy');
    db.prepare('UPDATE battle_permits SET last_enemy_shield_absorbed=? WHERE id=?').run(Number.MAX_SAFE_INTEGER, 'legacy');
    const accepted = db.prepare('SELECT enemy_shield,last_enemy_shield_absorbed FROM battle_permits WHERE id=?').get('legacy') as { enemy_shield: number; last_enemy_shield_absorbed: number };
    assert.equal(accepted.enemy_shield, Number.MAX_SAFE_INTEGER);
    assert.equal(accepted.last_enemy_shield_absorbed, Number.MAX_SAFE_INTEGER);
  } finally {
    db.close();
  }
});

test('enemy Shield migration is tracked after Degen Shield and before Worker deployment', () => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy-worker.yml', import.meta.url), 'utf8');
  const wrangler = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  assert.match(wrangler, /migrations_dir\s*=\s*"db\/migrations"/);
  assert.match(workflow, /npm run db:migrate[\s\S]*npm run deploy:worker/);
});
