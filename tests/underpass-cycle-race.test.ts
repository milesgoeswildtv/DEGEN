import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

// Exercise the actual SQL embedded in the Worker; avoid a duplicated test-only predicate.
const source = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8');
const insertSql = source.match(/INSERT INTO world_event_cycles \(id, event_key, opens_at, closes_at\)\n    SELECT[\s\S]*?RETURNING id, event_key, opens_at, closes_at/)?.[0];
const latestSql = source.match(/SELECT id, event_key, opens_at, closes_at FROM world_event_cycles\n    WHERE event_key = 'underpass' AND julianday\(closes_at\) > julianday\(\?\)[\s\S]*?LIMIT 1/)?.[0];
assert.ok(insertSql, 'Worker must reserve a cycle with an atomic conditional INSERT');
assert.ok(latestSql, 'Worker must reuse the concurrently reserved cycle');

const iso = (time: number) => new Date(time).toISOString();
function withDb(fn: (a: DatabaseSync, b: DatabaseSync) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'degen-cycle-'));
  const file = join(dir, 'cycles.sqlite');
  const a = new DatabaseSync(file);
  const b = new DatabaseSync(file);
  a.exec('CREATE TABLE world_event_cycles (id TEXT PRIMARY KEY, event_key TEXT NOT NULL, opens_at TEXT NOT NULL, closes_at TEXT NOT NULL)');
  try { fn(a, b); } finally { a.close(); b.close(); rmSync(dir, { recursive: true, force: true }); }
}
function reserve(db: DatabaseSync, id: string, now: number, opens: number, closes: number) {
  const inserted = db.prepare(insertSql!).get(id, iso(opens), iso(closes), iso(now));
  return inserted ?? db.prepare(latestSql!).get(iso(now));
}

test('two requests observing no cycle converge on one persisted cycle', () => withDb((a, b) => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  assert.equal(a.prepare(latestSql!).get(iso(now)), undefined);
  assert.equal(b.prepare(latestSql!).get(iso(now)), undefined);
  const first = reserve(a, 'first', now, now + 7200000, now + 10800000);
  const second = reserve(b, 'second', now, now + 14400000, now + 18000000);
  assert.equal((first as { id: string }).id, 'first');
  assert.equal((second as { id: string }).id, 'first');
  assert.equal(a.prepare('SELECT COUNT(*) AS count FROM world_event_cycles').get()!.count, 1);
}));

test('expired cycles remain durable and rollover creates exactly one successor', () => withDb((a, b) => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  assert.equal((reserve(a, 'old', now, now + 1000, now + 2000) as { id: string }).id, 'old');
  assert.equal((reserve(b, 'new', now + 3000, now + 4000, now + 5000) as { id: string }).id, 'new');
  assert.equal((reserve(a, 'duplicate', now + 3500, now + 6000, now + 7000) as { id: string }).id, 'new');
  assert.equal(a.prepare('SELECT COUNT(*) AS count FROM world_event_cycles').get()!.count, 2);
}));

test('expiry uses precise fractional seconds, not truncated datetime', () => withDb((a, b) => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  reserve(a, 'old', now, now + 100, now + 500);
  assert.equal((reserve(b, 'same', now + 499, now + 1000, now + 2000) as { id: string }).id, 'old');
  assert.equal((reserve(b, 'next', now + 501, now + 1500, now + 2500) as { id: string }).id, 'next');
}));

test('other event types do not block Underpass cycles', () => withDb((a, b) => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  a.prepare("INSERT INTO world_event_cycles VALUES ('other', 'another-event', ?, ?)").run(iso(now + 1000), iso(now + 5000));
  assert.equal((reserve(b, 'underpass', now, now + 1000, now + 5000) as { id: string }).id, 'underpass');
}));
