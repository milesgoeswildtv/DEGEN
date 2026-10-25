import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const worker = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8');
const preciseExpiryGuard = "julianday(expires_at) > julianday('now')";

test('Worker action expiry guards preserve millisecond precision while terminal victory settlement survives expiry', () => {
  assert.equal(
    worker.split(preciseExpiryGuard).length - 1,
    2,
    'active action lookup and action compare-and-swap must use exact expiry precision',
  );
  assert.doesNotMatch(worker, /datetime\(expires_at\)\s*>\s*CURRENT_TIMESTAMP/);

  const supportedReceiptGuard = worker.indexOf(
    "if (receipt.event_key !== 'underpass' || receipt.cycle_event_key !== 'underpass'\n    || receipt.encounter_key !== TUNNEL_MAW.id)",
  );
  const awardedReceiptReplay = worker.indexOf("if (receipt.reward_state === 'awarded')");
  assert.ok(
    supportedReceiptGuard >= 0 && supportedReceiptGuard < awardedReceiptReplay,
    'unsupported event/cycle/encounter receipts must fail closed before even an awarded receipt can replay',
  );

  const claimStart = worker.indexOf('const claim = await env.DB.prepare');
  const claimEnd = worker.indexOf('RETURNING cycle_id, encounter_key, reward_clear_number', claimStart);
  assert.ok(claimStart >= 0 && claimEnd > claimStart, 'the authoritative reward claim statement must exist');
  const claim = worker.slice(claimStart, claimEnd);
  assert.match(
    claim,
    /WHERE id = \? AND player_id = \? AND event_key = 'underpass'\s+AND encounter_key = \?\s+AND EXISTS \(SELECT 1 FROM world_event_cycles\s+WHERE id = battle_permits\.cycle_id AND event_key = 'underpass'\)\s+AND battle_status = 'victory'/,
    'the claim lease must be scoped to the supported event, encounter, and matching cycle',
  );
  assert.match(
    claim,
    /reward_state = 'pending' AND completed_at IS NULL/,
    'a valid server-resolved victory remains eligible for first settlement after expiry',
  );
  assert.doesNotMatch(
    claim,
    /expires_at/,
    'permit expiry blocks new actions; the already-persisted victory state gates late settlement',
  );
});

test('awarded receipt audit rejects duplicate clear sequence numbers', () => {
  const receiptStart = worker.indexOf('const receipt = await env.DB.prepare');
  const receiptEnd = worker.indexOf(
    "WHERE permit.id = ? AND permit.player_id = ? AND permit.battle_status = 'victory'",
    receiptStart,
  );
  assert.ok(receiptStart >= 0 && receiptEnd > receiptStart, 'the authoritative receipt query must exist');
  const receiptQuery = worker.slice(receiptStart, receiptEnd);
  assert.match(
    receiptQuery,
    /SELECT COUNT\(\*\) FROM battle_permits AS other[\s\S]*other\.player_id = permit\.player_id[\s\S]*other\.event_key = permit\.event_key[\s\S]*other\.cycle_id = permit\.cycle_id[\s\S]*other\.reward_clear_number = permit\.reward_clear_number[\s\S]*AS duplicate_clear_count/,
    'receipt validation must count any other permit claiming the same per-cycle sequence number',
  );
  assert.ok(receiptQuery.includes("other.event_key = 'underpass'"),
    'unsupported event receipts must not poison a valid receipt audit');
  assert.ok(receiptQuery.includes("other.encounter_key = '${TUNNEL_MAW.id}'"),
    'unsupported encounter receipts must not poison a valid receipt audit');
  assert.ok(receiptQuery.includes("other_cycle.event_key = 'underpass'"),
    'a permit attached to an unsupported event cycle must not poison a valid receipt audit');

  const auditStart = worker.indexOf('const isValidAwardedReceipt');
  const auditEnd = worker.indexOf('const canonicalReward =', auditStart);
  assert.ok(auditStart >= 0 && auditEnd > auditStart, 'awarded receipt audit must exist');
  assert.match(
    worker.slice(auditStart, auditEnd),
    /isSafeIntegerBetween\(row\.duplicate_clear_count, 0, 0\)/,
    'any duplicate clear-number claim must fail closed before reward replay',
  );
});

test('permit validity is strict at every millisecond expiry boundary', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE permits (expires_at TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO permits (expires_at) VALUES (?)');
    const clear = db.prepare('DELETE FROM permits');
    const accepts = db.prepare(`SELECT COUNT(*) AS count FROM permits WHERE ${preciseExpiryGuard.replace("'now'", '?')}`);
    const origin = Date.parse('2026-10-21T12:00:00.000Z');
    const iso = (value: number) => new Date(value).toISOString();

    for (let nowMs = 0; nowMs <= 999; nowMs += 1) {
      const now = iso(origin + nowMs);
      for (const delta of [-1, 0, 1]) {
        clear.run();
        insert.run(iso(origin + nowMs + delta));
        assert.equal(
          accepts.get(now)?.count,
          delta > 0 ? 1 : 0,
          `now offset ${nowMs}ms, expiry delta ${delta}ms`,
        );
      }
    }
  } finally {
    db.close();
  }
});

test('invalid and offset-normalized expiries fail closed at the exact boundary', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE permits (expires_at TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO permits (expires_at) VALUES (?)');
    const clear = db.prepare('DELETE FROM permits');
    const accepts = db.prepare(`SELECT COUNT(*) AS count FROM permits WHERE ${preciseExpiryGuard.replace("'now'", '?')}`);
    for (const [expires, expected] of [
      ['2026-10-11T08:00:00.001-04:00', 1],
      ['2026-10-11T08:00:00.000-04:00', 0],
      ['2026-10-11T07:59:59.999-04:00', 0],
      ['not-a-date', 0],
    ] as const) {
      clear.run();
      insert.run(expires);
      assert.equal(accepts.get('2026-10-11T12:00:00.000Z')?.count, expected, expires);
    }
  } finally {
    db.close();
  }
});
