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

test('Shield migration follows the current tracked inventory guard with unique versions', () => {
  const names = readdirSync(new URL('../db/migrations/', import.meta.url))
    .filter((name) => name.endsWith('.sql') && name.slice(0, 4).split('').every((char) => char >= '0' && char <= '9')).sort();
  const inventoryIndex = names.indexOf('0007_player_inventory_quantity_guards.sql');
  const shieldIndex = names.indexOf('0008_degen_shield.sql');
  assert.ok(inventoryIndex >= 0, 'current main migration 0007 must remain tracked');
  assert.ok(shieldIndex > inventoryIndex, 'Shield must follow the current main migration chain');
  const versions = names.map((name) => name.slice(0, 4));
  assert.equal(new Set(versions).size, versions.length, 'migration versions must be unique');
});

test('Shield migration defaults existing permits to zero without resetting battle state', () => {
  assert.ok(shieldMigration.includes('ADD COLUMN player_shield INTEGER NOT NULL DEFAULT 0 CHECK (player_shield >= 0);'));
  assert.ok(shieldMigration.includes('ADD COLUMN last_shield_absorbed INTEGER CHECK (last_shield_absorbed >= 0);'));
  assert.ok(shieldMigration.includes('ADD COLUMN last_retaliation_damage INTEGER CHECK (last_retaliation_damage >= 0);'));
  assert.equal(shieldMigration.split('ALTER TABLE').length - 1, 3);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE battle_permits (
        id TEXT PRIMARY KEY, battle_status TEXT NOT NULL, player_hp INTEGER, player_mana INTEGER,
        enemy_hp INTEGER, turn_count INTEGER NOT NULL
      );
      INSERT INTO battle_permits VALUES('legacy-active','active',80,4,92,2);
    `);
    db.exec(shieldMigration);
    const migrated = db.prepare('SELECT player_shield,last_shield_absorbed,last_retaliation_damage,player_hp,player_mana,enemy_hp,turn_count FROM battle_permits WHERE id = ?').get('legacy-active') as Record<string, number | null>;
    assert.equal(migrated.player_shield, 0);
    assert.equal(migrated.last_shield_absorbed, null);
    assert.equal(migrated.last_retaliation_damage, null);
    assert.equal(migrated.player_hp, 80);
    assert.equal(migrated.player_mana, 4);
    assert.equal(migrated.enemy_hp, 92);
    assert.equal(migrated.turn_count, 2);
  } finally { db.close(); }
});

test('Worker deployment applies tracked migrations before deploying Worker code', () => {
  const schema = deployWorkflow.indexOf('run: npm run db:apply');
  const migrations = deployWorkflow.indexOf('run: npm run db:migrate');
  const worker = deployWorkflow.indexOf('run: npm run deploy:worker');
  assert.ok(schema >= 0 && migrations > schema && worker > migrations);
  assert.ok(wranglerConfig.includes('binding = "DB"'));
  assert.ok(wranglerConfig.includes('database_name = "DEGEN"'));
  assert.ok(wranglerConfig.includes('migrations_dir = "db/migrations"'));
  assert.ok(packageJson.scripts['db:migrate'].includes('wrangler d1 migrations apply DEGEN'));
});

test('Worker deployment watches every shared source module imported by the Worker', () => {
  for (const sourcePath of [
    'src/data/combatPrototype.ts',
    'src/domain/types.ts',
    'src/game/combat/rules.ts',
    'src/game/progression.ts',
  ]) {
    assert.ok(
      deployWorkflow.includes(`      - '${sourcePath}'`),
      `Worker deployment must run when ${sourcePath} changes`,
    );
  }
});

test('EnemyDefinition remains free of Mana-equivalent resources', () => {
  const enemyDefinition = domainTypes.match(/export interface EnemyDefinition \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(enemyDefinition, 'EnemyDefinition interface must remain present');
  assert.equal(/mana|maxMana|currentMana|energy|stamina|focus/i.test(enemyDefinition), false);
  assert.match(domainTypes, /type _EnemyDefinitionHasNoUniversalActionResource/,
    'the recursive compile-time monster resource guard must remain active');
});
