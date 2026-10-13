import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const worker = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8');
const guard = "julianday(expires_at) > julianday('now')";

test('all three Worker action guards use millisecond precision without gating earned reward recovery', () => {
  assert.equal(worker.split(guard).length - 1, 3,
    'initial action lookup, CAS and stale-state re-read must share the same expiry rule');
  assert.doesNotMatch(worker, /datetime\(expires_at\)\s*>\s*CURRENT_TIMESTAMP/);
  assert.match(worker, /reward_state = 'pending' AND completed_at IS NULL\)/,
    'server-resolved earned victories remain recoverable after permit expiry');
});

test('SQLite expiry guard accepts a permit until its exact millisecond and rejects it at expiry', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE permits (expires_at TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO permits VALUES (?)');
    const clear = db.prepare('DELETE FROM permits');
    const accepts = db.prepare("SELECT COUNT(*) AS n FROM permits WHERE julianday(expires_at) > julianday(?)");
    const start = Date.parse('2026-10-11T12:00:00.000Z');
    for (let ms = 0; ms < 1000; ms += 1) {
      const now = new Date(start + ms).toISOString();
      for (const delta of [-1, 0, 1]) {
        clear.run(); insert.run(new Date(start + ms + delta).toISOString());
        assert.equal(accepts.get(now)?.n, delta > 0 ? 1 : 0,
          `now ${ms}ms, expiry delta ${delta}ms`);
      }
    }
  } finally { db.close(); }
});

test('offset timestamps normalize and malformed timestamps fail closed', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE permits (expires_at TEXT NOT NULL)');
    const accepts = db.prepare("SELECT COUNT(*) AS n FROM permits WHERE julianday(expires_at) > julianday(?)");
    const insert = db.prepare('INSERT INTO permits VALUES (?)');
    for (const [expires, valid] of [
      ['2026-10-11T08:00:00.001-04:00', 1],
      ['2026-10-11T08:00:00.000-04:00', 0],
      ['2026-10-11T07:59:59.999-04:00', 0],
      ['invalid-date', 0],
    ] as const) {
      db.exec('DELETE FROM permits'); insert.run(expires);
      assert.equal(accepts.get('2026-10-11T12:00:00.000Z')?.n, valid, expires);
    }
  } finally { db.close(); }
});
