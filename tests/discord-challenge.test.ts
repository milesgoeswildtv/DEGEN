import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { consumeDiscordChallenge, issueDiscordChallenge } from '../worker/auth/discordChallenge.ts';
import type { SessionDatabase } from '../worker/auth/sessionStore.ts';

const migration = readFileSync(new URL('../db/migrations/0007_player_sessions.sql', import.meta.url), 'utf8');
function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys=ON; CREATE TABLE players(id TEXT PRIMARY KEY); INSERT INTO players VALUES(\'player-a\');');
  raw.exec(migration);
  const db: SessionDatabase = {
    prepare(query: string) {
      const statement = raw.prepare(query);
      let values: unknown[] = [];
      return {
        bind(...next: unknown[]) { values = next; return this; },
        async first<T>() { return (statement.get(...values) as T | undefined) ?? null; },
        async run() { const result = statement.run(...values); return { meta: { changes: Number(result.changes) } }; },
      };
    },
  };
  return { raw, db };
}

test('Discord challenge stores only a hash and can be consumed once', async () => {
  const { raw, db } = setup();
  const challenge = await issueDiscordChallenge(db, 1000);
  assert.match(challenge.state, /^[A-Za-z0-9_-]{43}$/);
  const row = raw.prepare('SELECT nonce_hash, consumed_at_ms FROM auth_nonces').get() as {nonce_hash:string;consumed_at_ms:number|null};
  assert.equal(row.nonce_hash, createHash('sha256').update(challenge.state).digest('hex'));
  assert.notEqual(row.nonce_hash, challenge.state);
  assert.equal(row.consumed_at_ms, null);
  assert.equal(await consumeDiscordChallenge(db, challenge.state, 1001), true);
  assert.equal(await consumeDiscordChallenge(db, challenge.state, 1002), false);
  raw.close();
});

test('expired, malformed, and unknown Discord challenges reject', async () => {
  const { raw, db } = setup();
  const challenge = await issueDiscordChallenge(db, 2000);
  assert.equal(await consumeDiscordChallenge(db, challenge.state, challenge.expiresAtMs), false);
  assert.equal(await consumeDiscordChallenge(db, 'short', 2001), false);
  assert.equal(await consumeDiscordChallenge(db, 'B'.repeat(43), 2001), false);
  raw.close();
});
