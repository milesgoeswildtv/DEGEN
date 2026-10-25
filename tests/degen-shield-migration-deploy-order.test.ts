import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const shieldMigration = read('../db/migrations/0008_degen_shield.sql');
const deployWorkflow = read('../.github/workflows/deploy-worker.yml');
const wranglerConfig = read('../wrangler.toml');
const packageJson = JSON.parse(read('../package.json')) as { scripts: Record<string, string> };
const domainTypes = read('../src/domain/types.ts');

test('D1 migration sequence is unique and Shield follows the merged Mana backfill', () => {
  const migrationNames = readdirSync(new URL('../db/migrations/', import.meta.url))
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/i.test(name))
    .sort();
  const manaIndex = migrationNames.indexOf('0006_backfill_active_battle_mana.sql');
  const sessionIndex = migrationNames.indexOf('0007_player_sessions.sql');
  const shieldIndex = migrationNames.indexOf('0008_degen_shield.sql');
  assert.ok(manaIndex >= 0, 'the merged Mana backfill must remain tracked');
  assert.ok(shieldIndex > manaIndex, 'Shield must follow the Mana backfill');
  if (sessionIndex >= 0) assert.ok(shieldIndex > sessionIndex, 'Shield must follow player sessions when the auth migration is integrated');
  const prefixes = migrationNames.map((name) => name.match(/^(\d+)_/)?.[1]);
  assert.equal(new Set(prefixes).size, prefixes.length, 'migration sequence numbers must be unique');
});

test('Shield migration adds only player-owned Shield and last-action audit columns', () => {
  const addedColumns = [...shieldMigration.matchAll(/\bADD\s+COLUMN\s+([a-z_][a-z0-9_]*)/gi)]
    .map((match) => match[1]?.toLowerCase());
  assert.deepEqual(addedColumns, ['player_shield', 'last_shield_absorbed', 'last_retaliation_damage']);
  assert.match(shieldMigration, /ADD COLUMN player_shield INTEGER NOT NULL DEFAULT 0/i,
    'legacy permits must receive zero Shield when the column is introduced');
  assert.equal((shieldMigration.match(/\bALTER\s+TABLE\b/gi) ?? []).length, 3);
  assert.doesNotMatch(shieldMigration, /CREATE\s+TABLE/i);
  assert.doesNotMatch(shieldMigration, /(?:enemy|monster)[_ ](?:mana|shield)/i);
});


test('Shield migration preserves legacy active permits with zero Shield', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE battle_permits (
        id TEXT PRIMARY KEY,
        battle_status TEXT NOT NULL,
        player_hp INTEGER,
        player_mana INTEGER,
        enemy_hp INTEGER,
        turn_count INTEGER NOT NULL
      );
      INSERT INTO battle_permits(id,battle_status,player_hp,player_mana,enemy_hp,turn_count)
        VALUES('active-legacy','active',80,4,92,2),
              ('victory-legacy','victory',80,0,0,3);
    `);
    db.exec(shieldMigration);

    const shields = db.prepare('SELECT id, player_shield, last_shield_absorbed, last_retaliation_damage FROM battle_permits ORDER BY id').all();
    assert.deepEqual(shields.map((row) => ({ ...row })), [
      { id: 'active-legacy', player_shield: 0, last_shield_absorbed: 0, last_retaliation_damage: 0 },
      { id: 'victory-legacy', player_shield: 0, last_shield_absorbed: 0, last_retaliation_damage: 0 },
    ]);
    const active = db.prepare(`SELECT battle_status, player_hp, player_mana, enemy_hp, turn_count
      FROM battle_permits WHERE id = 'active-legacy'`).get();
    assert.deepEqual({ ...active }, {
      battle_status: 'active', player_hp: 80, player_mana: 4, enemy_hp: 92, turn_count: 2,
    }, 'adding Shield must not invalidate or reset an already-issued encounter');
  } finally {
    db.close();
  }
});

test('Worker deployment applies schema and migrations before Worker code', () => {
  const schemaStep = deployWorkflow.indexOf('run: npm run db:apply');
  const migrationStep = deployWorkflow.indexOf('run: npm run db:migrate');
  const workerDeployStep = deployWorkflow.indexOf('run: npm run deploy:worker');
  assert.ok(schemaStep >= 0, 'deployment must apply the base D1 schema');
  assert.ok(migrationStep > schemaStep, 'tracked migrations must run after the base schema');
  assert.ok(workerDeployStep > migrationStep, 'Worker code must deploy after D1 migrations');
  assert.match(wranglerConfig, /binding\s*=\s*"DB"/);
  assert.match(wranglerConfig, /database_name\s*=\s*"DEGEN"/);
  assert.match(wranglerConfig, /migrations_dir\s*=\s*"db\/migrations"/);
  assert.match(packageJson.scripts['db:migrate'], /wrangler d1 migrations apply DEGEN/);
});

test('EnemyDefinition does not gain a Mana or Shield resource namespace', () => {
  const start = domainTypes.indexOf('export interface EnemyDefinition');
  const end = domainTypes.indexOf('export interface LocationDefinition', start);
  assert.ok(start >= 0 && end > start, 'EnemyDefinition type must remain explicit');
  assert.doesNotMatch(domainTypes.slice(start, end), /\b(?:mana|maxMana|currentMana|energy|stamina|shield|currentShield)\s*:/i);
});

test('Worker deployment refuses Shield migration before player-session migration', () => {
  const guardStart = deployWorkflow.indexOf('      - name: Verify migration release order');
  const schemaStart = deployWorkflow.indexOf('      - name: Apply D1 schema');
  const nextStep = deployWorkflow.indexOf('\n      - name:', guardStart + 1);
  assert.ok(guardStart >= 0 && guardStart < schemaStart,
    'the release guard must run before any remote D1 schema or migration operation');
  const guard = deployWorkflow.slice(guardStart, nextStep === -1 ? undefined : nextStep);
  assert.match(guard, /0008_degen_shield\.sql/);
  assert.match(guard, /0007_player_sessions\.sql/);
  assert.match(guard, /Refusing Worker deployment/);
  assert.match(guard, /exit 1/);
});
