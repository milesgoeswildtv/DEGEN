import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

// Worker expiry timestamps are ISO strings with milliseconds. SQLite's
// datetime() and CURRENT_TIMESTAMP truncate them to whole seconds.
const worker = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8');
const precise = "julianday(expires_at) > julianday('now')";
const checks = worker.split(precise).length - 1;

test('all three permit-expiry guards preserve millisecond precision', () => {
  assert.equal(checks, 3, 'action lookup, action CAS, and new reward claim must agree');
  assert.doesNotMatch(worker, /datetime\(expires_at\)\s*>\s*CURRENT_TIMESTAMP/);
  assert.ok(worker.includes(`(${precise} OR reward_clear_number IS NOT NULL)`),
    'a previously reserved clear remains recoverable after expiry');
});

test('active permit is valid until the exact millisecond, then expires', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE permits (expires_at TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO permits (expires_at) VALUES (?)');
    const clear = db.prepare('DELETE FROM permits');
    const accepts = db.prepare(`SELECT COUNT(*) AS count FROM permits WHERE ${precise.replace("'now'", '?')}`);
    const origin = Date.parse('2026-10-11T12:00:00.000Z');
    const iso = (value: number) => new Date(value).toISOString();
    for (let nowMs = 0; nowMs <= 999; nowMs += 1) {
      const now = iso(origin + nowMs);
      for (const delta of [-1, 0, 1]) {
        clear.run();
        insert.run(iso(origin + nowMs + delta));
        assert.equal(accepts.get(now)?.count, delta > 0 ? 1 : 0,
          `now offset ${nowMs}ms, expiry delta ${delta}ms`);
      }
    }
  } finally {
    db.close();
  }
});

test('invalid and offset-normalized dates fail closed at expiry boundary', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE permits (expires_at TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO permits VALUES (?)');
    const clear = db.prepare('DELETE FROM permits');
    const accepts = db.prepare(`SELECT COUNT(*) AS count FROM permits WHERE ${precise.replace("'now'", '?')}`);
    for (const [expires, expected] of [
      ['2026-10-11T08:00:00.001-04:00', 1],
      ['2026-10-11T08:00:00.000-04:00', 0],
      ['2026-10-11T07:59:59.999-04:00', 0],
      ['not-a-date', 0],
    ] as const) {
      clear.run(); insert.run(expires);
      assert.equal(accepts.get('2026-10-11T12:00:00.000Z')?.count, expected, expires);
    }
  } finally {
    db.close();
  }
});
