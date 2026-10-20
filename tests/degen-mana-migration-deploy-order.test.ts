import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');
const manaMigration = read('../db/migrations/0003_degen_mana.sql');
const manaBackfill = read('../db/migrations/0007_backfill_active_battle_mana.sql');
const deployWorkflow = read('../.github/workflows/deploy-worker.yml');
const wranglerConfig = read('../wrangler.toml');
const packageJson = JSON.parse(read('../package.json')) as { scripts: Record<string, string> };

test('Degen Mana migration adds only the player-owned Mana column', () => {
  const addedColumns = [...manaMigration.matchAll(/\bADD\s+COLUMN\s+([a-z_][a-z0-9_]*)/gi)]
    .map((match) => match[1]?.toLowerCase());

  assert.deepEqual(addedColumns, ['player_mana']);
  assert.equal((manaMigration.match(/\bALTER\s+TABLE\b/gi) ?? []).length, 1);
  assert.doesNotMatch(manaMigration, /CREATE\s+TABLE/i);
});

test('active-permit backfill is scoped to valid live Degen encounters and expiry-safe', () => {
  assert.match(manaBackfill, /SET\s+player_mana\s*=\s*12/i);
  assert.match(manaBackfill, /event_key\s*=\s*'underpass'/i);
  assert.match(manaBackfill, /encounter_key\s*=\s*'tunnel-maw'/i);
  assert.match(manaBackfill, /player_mana\s+IS\s+NULL/i);
  assert.match(manaBackfill, /player_hp\s+IS\s+NOT\s+NULL\s+AND\s+player_hp\s*>\s*0/i);
  assert.match(manaBackfill, /enemy_hp\s+IS\s+NOT\s+NULL\s+AND\s+enemy_hp\s*>\s*0/i);
  assert.match(manaBackfill, /battle_status\s*=\s*'active'/i);
  assert.match(manaBackfill, /completed_at\s+IS\s+NULL/i);
  assert.match(manaBackfill, /julianday\(expires_at\)\s*>\s*julianday\('now'\)/i);
  assert.doesNotMatch(manaBackfill, /\b(?:enemy|monster)_mana\b/i);
});

test('Worker deployment applies the configured D1 schema and migrations before Worker code', () => {
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
