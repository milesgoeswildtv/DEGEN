import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

// Verify the exact Worker identity SQL; route-level verified proof is covered by Worker/D1 integration.
const worker = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8');
const bindingTemplate = worker.match(/INSERT INTO platform_identities[\s\S]*?RETURNING player_id/)?.[0];
assert.ok(bindingTemplate, 'Atomic identity ownership guard is required');
const binding = bindingTemplate!.replaceAll('${guard}', 'NOT EXISTS (SELECT 1 FROM platform_identities WHERE platform = ? AND platform_user_id = ? AND player_id <> ?)');

function withDatabase(run: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE platform_identities(platform TEXT NOT NULL, platform_user_id TEXT NOT NULL, player_id TEXT NOT NULL, display_name TEXT NOT NULL, verified_at TEXT, PRIMARY KEY(platform, platform_user_id))');
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


test('identity upserts never promote an unverified legacy mapping', () => withDatabase(db => {
  db.prepare(`INSERT INTO platform_identities
    (platform, platform_user_id, player_id, display_name, verified_at)
    VALUES (?, ?, ?, ?, NULL)`).run('telegram', 'legacy-id', 'owner', 'Legacy Owner');
  const result = bindIdentity(db, 'telegram', 'legacy-id', 'owner', 'Claimed Name') as { player_id: string } | undefined;
  assert.equal(result?.player_id, 'owner');
  const row = db.prepare('SELECT player_id, display_name, verified_at FROM platform_identities').get() as {
    player_id: string; display_name: string; verified_at: string | null;
  };
  assert.equal(row.player_id, 'owner');
  assert.equal(row.display_name, 'Claimed Name');
  assert.equal(row.verified_at, null, 'an old caller-supplied binding must remain unverified');
}));

test('session migration preserves legacy identity rows as unverified', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE players (id TEXT PRIMARY KEY);
    INSERT INTO players VALUES ('legacy-owner');
    CREATE TABLE platform_identities (
      platform TEXT NOT NULL, platform_user_id TEXT NOT NULL, player_id TEXT NOT NULL,
      display_name TEXT NOT NULL, linked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (platform, platform_user_id),
      FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
    );
    INSERT INTO platform_identities(platform, platform_user_id, player_id, display_name)
      VALUES ('telegram', 'legacy-id', 'legacy-owner', 'Legacy Owner');
  `);
  const migration = readFileSync(new URL('../db/migrations/0007_player_sessions.sql', import.meta.url), 'utf8');
  db.exec(migration);
  const row = db.prepare('SELECT player_id, verified_at FROM platform_identities WHERE platform_user_id = ?')
    .get('legacy-id') as { player_id: string; verified_at: string | null };
  assert.equal(row.player_id, 'legacy-owner');
  assert.equal(row.verified_at, null, 'migration preserves but quarantines the old binding');
  db.close();
});
