import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const migrationDirectory = new URL('../db/migrations/', import.meta.url);
const migrationVersion = (filename: string): string => {
  const match = /^(\d{4})_[a-z0-9][a-z0-9_-]*\.sql$/i.exec(filename);
  assert.ok(match, `invalid tracked D1 migration filename: ${filename}`);
  return match[1]!;
};

const assertUniqueMigrationVersions = (filenames: readonly string[]): void => {
  const byVersion = new Map<string, string>();
  for (const filename of filenames) {
    const version = migrationVersion(filename);
    const previous = byVersion.get(version);
    assert.equal(
      previous,
      undefined,
      `D1 migration version ${version} is duplicated by ${previous} and ${filename}`,
    );
    byVersion.set(version, filename);
  }
};

test('tracked D1 migrations have valid filenames and unique numeric versions', () => {
  const filenames = readdirSync(migrationDirectory).filter((name) => name.endsWith('.sql'));
  assert.ok(filenames.length > 0, 'expected tracked D1 migrations');
  assertUniqueMigrationVersions(filenames);
});

test('duplicate D1 migration numbers are rejected before deployment', () => {
  assert.throws(
    () => assertUniqueMigrationVersions([
      '0007_player_inventory_quantity_guards.sql',
      '0007_player_sessions.sql',
    ]),
    /D1 migration version 0007 is duplicated/,
  );
});

test('Worker deployment checks migration versions before any remote D1 or Worker write', () => {
  const workflow = readFileSync(new URL('../.github/workflows/deploy-worker.yml', import.meta.url), 'utf8');
  const migrationCheck = workflow.indexOf('npm run check:migrations');
  const schemaApply = workflow.indexOf('npm run db:apply');
  const migrationApply = workflow.indexOf('npm run db:migrate');
  const workerDeploy = workflow.indexOf('npm run deploy:worker');

  assert.ok(migrationCheck >= 0, 'expected the deployment workflow to run the migration guard');
  assert.ok(schemaApply >= 0, 'expected the deployment workflow to apply the D1 schema');
  assert.ok(migrationApply >= 0, 'expected the deployment workflow to apply tracked D1 migrations');
  assert.ok(workerDeploy >= 0, 'expected the deployment workflow to deploy the Worker');
  assert.ok(migrationCheck < schemaApply, 'migration guard must run before remote schema operations');
  assert.ok(schemaApply < migrationApply, 'D1 schema must be applied before tracked migrations');
  assert.ok(migrationApply < workerDeploy, 'tracked migrations must finish before Worker deployment');
});
