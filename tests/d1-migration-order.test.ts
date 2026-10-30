import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
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
