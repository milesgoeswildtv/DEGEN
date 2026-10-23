import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

// This verifies the exact Worker SQL; platform credentials remain unauthenticated.
const worker = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8');
const bindingTemplate = worker.match(/INSERT INTO platform_identities[\s\S]*?RETURNING player_id/)?.[0];
assert.ok(bindingTemplate, 'Atomic identity ownership guard is required');
const binding = bindingTemplate!.replaceAll('${guard}', 'NOT EXISTS (SELECT 1 FROM platform_identities WHERE platform = ? AND platform_user_id = ? AND player_id <> ?)');

function withDatabase(run: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE platform_identities(platform TEXT NOT NULL, platform_user_id TEXT NOT NULL, player_id TEXT NOT NULL, display_name TEXT NOT NULL, PRIMARY KEY(platform, platform_user_id))');
  try { run(db); } finally { db.close(); }
}

function bindIdentity(db: DatabaseSync, platform: string, platformUserId: string, playerId: string, displayName: string) {
  return db.prepare(binding).get(platform, platformUserId, playerId, displayName, platform, platformUserId, playerId);
}

test('an existing binding cannot be reassigned', () => withDatabase(db => {
  const bind = (platform: string, userId: string, playerId: string, name: string) => bindIdentity(db, platform, userId, playerId, name);
  assert.equal((bind('discord', 'uid', 'owner', 'Owner') as { player_id: string }).player_id, 'owner');
  assert.equal(bind('discord', 'uid', 'attacker', 'Impostor'), undefined);
  assert.deepEqual({ ...db.prepare('SELECT player_id, display_name FROM platform_identities').get() }, { player_id: 'owner', display_name: 'Owner' });
}));

test('same-player retries can refresh display names', () => withDatabase(db => {
  const bind = (platform: string, userId: string, playerId: string, name: string) => bindIdentity(db, platform, userId, playerId, name);
  bind('telegram', 'uid', 'owner', 'Old');
  assert.equal((bind('telegram', 'uid', 'owner', 'New') as { player_id: string }).player_id, 'owner');
  assert.equal(db.prepare('SELECT display_name FROM platform_identities').get()!.display_name, 'New');
}));

test('provider namespaces remain independent', () => withDatabase(db => {
  const bind = (platform: string, userId: string, playerId: string, name: string) => bindIdentity(db, platform, userId, playerId, name);
  bind('discord', 'uid', 'one', 'Discord');
  bind('telegram', 'uid', 'two', 'Telegram');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM platform_identities').get()!.count, 2);
}));
