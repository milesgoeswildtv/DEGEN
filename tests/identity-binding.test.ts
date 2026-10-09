import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

// This verifies the exact Worker SQL; platform credentials remain unauthenticated.
const worker = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8');
const binding = worker.match(/INSERT INTO platform_identities \(platform, platform_user_id, player_id, display_name\) VALUES \(\?, \?, \?, \?\)[\s\S]*?RETURNING player_id/)?.[0];
assert.ok(binding, 'Atomic identity ownership guard is required');

function withDatabase(run: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE platform_identities(platform TEXT NOT NULL, platform_user_id TEXT NOT NULL, player_id TEXT NOT NULL, display_name TEXT NOT NULL, PRIMARY KEY(platform, platform_user_id))');
  try { run(db); } finally { db.close(); }
}

test('an existing binding cannot be reassigned', () => withDatabase(db => {
  const stmt = db.prepare(binding!);
  assert.equal((stmt.get('discord', 'uid', 'owner', 'Owner') as { player_id: string }).player_id, 'owner');
  assert.equal(stmt.get('discord', 'uid', 'attacker', 'Impostor'), undefined);
  assert.deepEqual({ ...db.prepare('SELECT player_id, display_name FROM platform_identities').get() }, { player_id: 'owner', display_name: 'Owner' });
}));

test('same-player retries can refresh display names', () => withDatabase(db => {
  const stmt = db.prepare(binding!);
  stmt.get('telegram', 'uid', 'owner', 'Old');
  assert.equal((stmt.get('telegram', 'uid', 'owner', 'New') as { player_id: string }).player_id, 'owner');
  assert.equal(db.prepare('SELECT display_name FROM platform_identities').get()!.display_name, 'New');
}));

test('provider namespaces remain independent', () => withDatabase(db => {
  const stmt = db.prepare(binding!);
  stmt.get('discord', 'uid', 'one', 'Discord');
  stmt.get('telegram', 'uid', 'two', 'Telegram');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM platform_identities').get()!.count, 2);
}));
