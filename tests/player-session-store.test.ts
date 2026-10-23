import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  DEFAULT_PLAYER_SESSION_TTL_MS,
  issuePlayerSession,
  resolvePlayerSession,
  revokePlayerSession,
  type SessionDatabase,
} from '../worker/auth/sessionStore.ts';

const migration = readFileSync(
  new URL('../db/migrations/0007_player_sessions.sql', import.meta.url),
  'utf8',
);

function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE players (id TEXT PRIMARY KEY);
    INSERT INTO players (id) VALUES ('player-a'), ('player-b');
  `);
  raw.exec(migration);

  const db: SessionDatabase = {
    prepare(query: string) {
      const statement = raw.prepare(query);
      let values: unknown[] = [];
      return {
        bind(...next: unknown[]) {
          values = next;
          return this;
        },
        async first<T>() {
          return (statement.get(...values) as T | undefined) ?? null;
        },
        async run() {
          const result = statement.run(...values);
          return { meta: { changes: Number(result.changes) } };
        },
      };
    },
  };

  return { raw, db };
}

test('issued session returns a one-time opaque token and stores only its SHA-256 digest', async () => {
  const { raw, db } = setup();
  const session = await issuePlayerSession(db, 'player-a', 1_000);

  assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(session.playerId, 'player-a');
  assert.equal(session.expiresAtMs, 1_000 + DEFAULT_PLAYER_SESSION_TTL_MS);

  const stored = raw.prepare(
    'SELECT token_hash, player_id, created_at_ms, expires_at_ms, revoked_at_ms FROM player_sessions',
  ).get() as {
    token_hash: string; player_id: string; created_at_ms: number;
    expires_at_ms: number; revoked_at_ms: number | null;
  };
  assert.equal(stored.token_hash, createHash('sha256').update(session.token).digest('hex'));
  assert.notEqual(stored.token_hash, session.token);
  assert.equal(stored.player_id, 'player-a');
  assert.equal(stored.created_at_ms, 1_000);
  assert.equal(stored.expires_at_ms, session.expiresAtMs);
  assert.equal(stored.revoked_at_ms, null);
  assert.deepEqual(await resolvePlayerSession(db, session.token, 1_001), {
    playerId: 'player-a',
    expiresAtMs: session.expiresAtMs,
  });
});

test('session expiry is strict at the boundary and invalid clocks fail closed', async () => {
  const { db } = setup();
  const session = await issuePlayerSession(db, 'player-a', 2_000, 60_000);

  assert.equal((await resolvePlayerSession(db, session.token, session.expiresAtMs - 1))?.playerId, 'player-a');
  assert.equal(await resolvePlayerSession(db, session.token, session.expiresAtMs), null);
  assert.equal(await resolvePlayerSession(db, session.token, -1), null);
  assert.equal(await resolvePlayerSession(db, session.token, Number.MAX_SAFE_INTEGER + 1), null);
});

test('malformed bearer tokens are rejected before session lookup', async () => {
  const { db } = setup();
  const session = await issuePlayerSession(db, 'player-a', 3_000);

  for (const token of [undefined, null, '', 'short', session.token + '=', '!'.repeat(43)]) {
    assert.equal(await resolvePlayerSession(db, token, 3_001), null);
    assert.equal(await revokePlayerSession(db, token, 3_001), false);
  }
});

test('revocation is idempotent and cannot revoke a different player session', async () => {
  const { db } = setup();
  const first = await issuePlayerSession(db, 'player-a', 4_000);
  const second = await issuePlayerSession(db, 'player-b', 4_000);

  assert.equal(await revokePlayerSession(db, first.token, 5_000), true);
  assert.equal(await resolvePlayerSession(db, first.token, 5_000), null);
  assert.equal(await revokePlayerSession(db, first.token, 5_001), false);
  assert.deepEqual(await resolvePlayerSession(db, second.token, 5_001), {
    playerId: 'player-b',
    expiresAtMs: second.expiresAtMs,
  });
});

test('session issuance rejects invalid player identifiers and unsafe TTLs', async () => {
  const { db } = setup();

  await assert.rejects(issuePlayerSession(db, '', 1_000), /player ID is required/);
  await assert.rejects(issuePlayerSession(db, 'x'.repeat(129), 1_000), /player ID is required/);
  await assert.rejects(issuePlayerSession(db, 'player-a', -1), /creation time/);
  await assert.rejects(issuePlayerSession(db, 'player-a', 1_000, 59_999), /between one minute and 24 hours/);
  await assert.rejects(issuePlayerSession(db, 'player-a', 1_000, 86_400_001), /between one minute and 24 hours/);
});

test('session issuance cannot create a session for a nonexistent player', async () => {
  const { db } = setup();
  await assert.rejects(issuePlayerSession(db, 'missing-player', 1_000), /FOREIGN KEY constraint failed/);
});
