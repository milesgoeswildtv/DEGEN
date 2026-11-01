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
  assert.ok(
    claim.includes("WHERE id = battle_permits.cycle_id AND event_key = 'underpass'")
      && claim.includes("julianday(opens_at) <= julianday(battle_permits.started_at)")
      && claim.includes("julianday(battle_permits.started_at) < julianday(closes_at)")
      && claim.includes("AND battle_status = 'victory'"),
    'the claim lease must be scoped to the supported event, encounter, and permit start window',
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
  const receiptStart = worker.indexOf('const loadReceipt = async () => env.DB.prepare');
  const receiptEnd = worker.indexOf(
    "WHERE permit.id = ? AND permit.player_id = ?`)",
    receiptStart,
  );
  assert.ok(receiptStart >= 0 && receiptEnd > receiptStart, 'the authoritative receipt query must exist');
  const receiptQuery = worker.slice(receiptStart, receiptEnd);
  assert.doesNotMatch(receiptQuery, /WHERE permit\.id = \? AND permit\.player_id = \? AND permit\.battle_status = 'victory'/,
    'the owner-scoped receipt lookup must not discard an already-awarded receipt when combat status is later corrupt');
  const unawardedVictoryGuard = worker.indexOf("if (receipt.battle_status !== 'victory')", receiptEnd);
  const awardedReplayGuard = worker.indexOf("if (receipt.reward_state === 'awarded')", receiptEnd);
  assert.ok(awardedReplayGuard > receiptEnd && unawardedVictoryGuard > awardedReplayGuard,
    'unawarded permits must still require a server-resolved victory after the audited awarded-replay path');
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

test('newly settled rewards and idempotent replays share the full persisted receipt audit', () => {
  const loaderStart = worker.indexOf('const loadReceipt = async () => env.DB.prepare');
  const initialRead = worker.indexOf('const receipt = await loadReceipt();', loaderStart);
  const replayStart = worker.indexOf("if (receipt.reward_state === 'awarded')", initialRead);
  const settlementRead = worker.indexOf('const settledReceipt = await loadReceipt();', replayStart);
  assert.ok(loaderStart >= 0 && initialRead > loaderStart && replayStart > initialRead,
    'completion must load one complete owner-scoped receipt before deciding whether to claim or replay');
  assert.ok(settlementRead > replayStart,
    'successful settlement must re-read the complete persisted receipt before returning reward data');

  const replayBlock = worker.slice(replayStart, worker.indexOf('const token =', replayStart));
  assert.match(replayBlock,
    /if \(!isValidAwardedReceipt\(receipt\)\)[\s\S]*return fail\(request, env, 'Battle reward receipt is invalid\.', 409\)[\s\S]*return respond\(receipt\)/,
    'the replay path must validate reward, clear-counter, uniqueness, claim, and history audit first');

  const settlementBlock = worker.slice(
    settlementRead,
    worker.indexOf("if (settledReceipt?.reward_state !== 'claiming'", settlementRead),
  );
  assert.match(settlementBlock,
    /if \(settledReceipt\?\.reward_state === 'awarded'\)[\s\S]*if \(!isValidAwardedReceipt\(settledReceipt\)\)[\s\S]*return fail\(request, env, 'Battle reward receipt is invalid\.', 409\)[\s\S]*return respond\(settledReceipt\)/,
    'the first settlement response must apply the same full persisted receipt audit before returning rewards');
  const claimStart = worker.indexOf('const claim = await env.DB.prepare', replayStart);
  const claimRaceStart = worker.indexOf('if (!claim) {', claimStart);
  const claimRaceEnd = worker.indexOf('if (claim.reward_clear_number === null)', claimRaceStart);
  assert.ok(claimStart > replayStart && claimRaceStart > claimStart && claimRaceEnd > claimRaceStart,
    'a lost claim CAS must re-read the persisted receipt before deciding whether to retry');
  const claimRaceBlock = worker.slice(claimRaceStart, claimRaceEnd);
  assert.match(claimRaceBlock,
    /const current = await loadReceipt\(\)[\s\S]*if \(current\?\.reward_state === 'awarded'\)[\s\S]*isValidAwardedReceipt\(current\)[\s\S]*return respond\(current\)/,
    'a concurrently settled receipt must pass the same full audit before the losing request returns it');
  assert.equal((worker.match(/return respond\(/g) ?? []).length, 3,
    'the replay, claim-race recovery, and settlement response paths all return only audited receipts');
});

test('new clear allocation fails closed when the persisted counter trails a reserved sequence', () => {
  const assignmentStart = worker.indexOf('UPDATE battle_permits SET reward_clear_number = (');
  const assignmentEnd = worker.indexOf('UPDATE world_event_clears SET full_reward_clears =', assignmentStart);
  assert.ok(assignmentStart >= 0 && assignmentEnd > assignmentStart,
    'the permit clear-number reservation and cycle-counter update must exist');
  const assignment = worker.slice(assignmentStart, assignmentEnd);
  assert.match(assignment,
    /full_reward_clears[\s\S]*>= COALESCE\([\s\S]*SELECT MAX\(other\.reward_clear_number\)[\s\S]*other\.reward_clear_number IS NOT NULL[\s\S]*other_cycle\.event_key = 'underpass'/,
    'a new sequence number must not be allocated while the cycle counter trails any existing supported receipt');

  assert.ok(assignment.includes("typeof((SELECT full_reward_clears FROM world_event_clears"),
    'sequence allocation must reject non-integer D1 counters before writing');
  assert.ok(assignment.includes('BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER - 1}'),
    'sequence allocation must stop before adding one would exceed the JavaScript safe-integer range');

  const ownedStart = worker.indexOf('const owned = await env.DB.prepare');
  const ownedEnd = worker.indexOf('const reward = underpassRewardForClear', ownedStart);
  const owned = worker.slice(ownedStart, ownedEnd);
  assert.match(owned, /cycle_clear_count/);
  assert.match(owned, /duplicate_clear_count/);
  assert.match(owned, /isSafeIntegerBetween\(owned\.cycle_clear_count, owned\.reward_clear_number, Number\.MAX_SAFE_INTEGER\)/);
  assert.match(owned, /isSafeIntegerBetween\(owned\.duplicate_clear_count, 0, 0\)/,
    'both newly assigned and previously reserved sequence numbers must be audited before progression writes');
});

test('completion timestamps are rechecked during reward clear reservation and failed-claim cleanup', () => {
  const releaseStart = worker.indexOf('const releaseClaim = async');
  const releaseEnd = worker.indexOf('};', releaseStart);
  assert.ok(releaseStart >= 0 && releaseEnd > releaseStart, 'token-scoped claim cleanup must exist');
  assert.match(
    worker.slice(releaseStart, releaseEnd),
    /reward_state = 'claiming' AND reward_claim_token = \?[\s\S]*AND completed_at IS NULL/,
    'cleanup must not rewrite a claim whose completion marker appeared after acquisition',
  );

  const allocationStart = worker.indexOf('UPDATE battle_permits SET reward_clear_number = (');
  const allocationEnd = worker.indexOf('UPDATE world_event_clears SET full_reward_clears =', allocationStart);
  assert.ok(allocationStart >= 0 && allocationEnd > allocationStart, 'clear allocation must exist');
  assert.match(
    worker.slice(allocationStart, allocationEnd),
    /reward_claim_token = \? AND reward_clear_number IS NULL AND completed_at IS NULL/,
    'a completion marker appearing after claim acquisition must block clear reservation',
  );

  const reservationBatch = worker.slice(
    allocationStart,
    worker.indexOf('const owned = await env.DB.prepare', allocationStart),
  );
  const counterStart = reservationBatch.indexOf('UPDATE world_event_clears SET full_reward_clears =');
  assert.ok(counterStart >= 0, 'the cycle clear counter update must exist in the reservation batch');
  assert.match(
    reservationBatch.slice(counterStart),
    /reward_state = 'claiming' AND reward_claim_token = \? AND completed_at IS NULL/,
    'the cycle counter may advance only while the same incomplete claim still owns the reservation',
  );
  assert.match(
    reservationBatch,
    /UPDATE battle_permits SET reward_clear_number = NULL[\s\S]*completed_at IS NOT NULL[\s\S]*reward_tier IS NULL/,
    'a completion marker appearing after assignment must release the unawarded clear number',
  );

  const ownsStart = worker.indexOf('const owns =');
  const ownsEnd = worker.indexOf(';', ownsStart);
  assert.ok(ownsStart >= 0 && ownsEnd > ownsStart, 'settlement ownership guard must exist');
  assert.match(
    worker.slice(ownsStart, ownsEnd),
    /reward_state = 'claiming' AND reward_claim_token = \? AND completed_at IS NULL/,
    'settlement must recheck the same completion marker before any reward write',
  );
});

test('an invalid pre-reserved clear number is released so it cannot block later valid claims', () => {
  const ownedStart = worker.indexOf('const owned = await env.DB.prepare');
  const rewardStart = worker.indexOf('const reward = underpassRewardForClear', ownedStart);
  assert.ok(ownedStart >= 0 && rewardStart > ownedStart, 'the audited reservation check must exist');
  const auditFailure = worker.slice(ownedStart, rewardStart);
  assert.match(auditFailure, /if \(!owned\?\.reward_clear_number[\s\S]*await releaseClaim\(typeof owned\?\.reward_clear_number === 'number'\)/,
    'any numeric reservation that fails its authoritative audit must be cleared while releasing the unawarded claim');
  assert.doesNotMatch(auditFailure, /hadReservedClearNumber/,
    'whether the reservation pre-existed the current attempt must not preserve an unauditable sequence number');
});

test('a valid claim repairs stale unawarded reservations above the committed clear counter before allocation', () => {
  const batchStart = worker.indexOf('if (claim.reward_clear_number === null) {');
  const batchEnd = worker.indexOf('const owned = await env.DB.prepare', batchStart);
  assert.ok(batchStart >= 0 && batchEnd > batchStart, 'clear reservation must use an ordered D1 batch');
  const batch = worker.slice(batchStart, batchEnd);
  const cleanupStart = batch.indexOf("UPDATE battle_permits SET reward_state = 'pending'");
  const allocationStart = batch.indexOf('UPDATE battle_permits SET reward_clear_number = (');
  assert.ok(cleanupStart >= 0 && allocationStart > cleanupStart,
    'stale invalid reservations must be cleaned before a new sequence is allocated');
  const cleanup = batch.slice(cleanupStart, allocationStart);
  assert.match(cleanup, /reward_clear_number > \(SELECT full_reward_clears FROM world_event_clears/,
    'cleanup is limited to reservations above the committed cycle counter');
  assert.match(cleanup, /typeof\(\(SELECT full_reward_clears FROM world_event_clears[\s\S]*\) = 'integer'/,
    'corrupt counters must fail closed without triggering reservation cleanup');
  assert.ok(cleanup.includes("BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER}"),
    'counter cleanup must preserve the same safe-integer bounds as sequence allocation');
  assert.match(cleanup, /battle_status = 'victory'[\s\S]*NOT EXISTS \(SELECT 1 FROM battle_history/,
    'only unresolved victory permits with no victory history can be reset');
  assert.match(cleanup, /NOT EXISTS \(SELECT 1 FROM characters[\s\S]*last_reward_claim_token = battle_permits\.reward_claim_token/,
    'a reservation tied to an already-applied progression token must not be cleared');
  assert.match(cleanup, /reward_xp IS NULL AND reward_currency IS NULL[\s\S]*reward_tier IS NULL AND reward_level IS NULL AND reward_remaining_xp IS NULL/,
    'cleanup must not erase any reservation with a partial or completed reward receipt');
  assert.match(cleanup, /reward_state = 'pending' OR \(reward_state = 'claiming'[\s\S]*strftime\('%Y-%m-%d %H:%M:%S', reward_claimed_at\) = reward_claimed_at[\s\S]*julianday\(reward_claimed_at\) < julianday\('now', '-60 seconds'\)/,
    'only pending reservations or normalized stale leases may be reset');
  assert.match(cleanup, /id <> \?/,
    'the current claim must not invalidate its own reservation');
  assert.ok(cleanup.includes(".bind(input.playerId, claim.cycle_id, TUNNEL_MAW.id, input.permitId)"),
    'cleanup statement bindings must exactly match its four scoped placeholders');
});
