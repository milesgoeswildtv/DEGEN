import assert from 'node:assert/strict';
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

test('Shield migration adds only the player-owned Shield column', () => {
  const addedColumns = [...shieldMigration.matchAll(/\bADD\s+COLUMN\s+([a-z_][a-z0-9_]*)/gi)]
    .map((match) => match[1]?.toLowerCase());
  assert.deepEqual(addedColumns, ['player_shield']);
  assert.equal((shieldMigration.match(/\bALTER\s+TABLE\b/gi) ?? []).length, 1);
  assert.doesNotMatch(shieldMigration, /CREATE\s+TABLE/i);
  assert.doesNotMatch(shieldMigration, /(?:enemy|monster)[_ ](?:mana|shield)/i);
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
