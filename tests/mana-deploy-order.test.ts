import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8');

test('Worker deployment applies the tracked D1 schema and migrations before Worker code', () => {
  const workflow = read('../.github/workflows/deploy-worker.yml');
  const packageJson = JSON.parse(read('../package.json')) as { scripts?: Record<string, string> };
  const wrangler = read('../wrangler.toml');
  const manaBackfill = read('../db/migrations/0007_backfill_active_battle_mana.sql');

  const step = (name: string): string => {
    const start = workflow.indexOf(`      - name: ${name}`);
    assert.notEqual(start, -1, `missing deployment step: ${name}`);
    const next = workflow.indexOf('\n      - name:', start + 1);
    return workflow.slice(start, next === -1 ? undefined : next);
  };

  const schemaStep = step('Apply D1 schema');
  const migrationsStep = step('Apply D1 migrations');
  const deployStep = step('Deploy Worker');

  assert.match(schemaStep, /run: npm run db:apply/);
  assert.match(migrationsStep, /run: npm run db:migrate/);
  assert.match(deployStep, /run: npm run deploy:worker/);
  assert.ok(
    workflow.indexOf('      - name: Apply D1 schema')
      < workflow.indexOf('      - name: Apply D1 migrations')
      && workflow.indexOf('      - name: Apply D1 migrations')
      < workflow.indexOf('      - name: Deploy Worker'),
    'schema and tracked migrations must run before Worker deployment',
  );

  assert.equal(packageJson.scripts?.['db:migrate'], 'wrangler d1 migrations apply DEGEN --remote');
  assert.match(wrangler, /migrations_dir = "db\/migrations"/);
  assert.match(manaBackfill, /UPDATE battle_permits[\s\S]*SET player_mana = 12/);
});
