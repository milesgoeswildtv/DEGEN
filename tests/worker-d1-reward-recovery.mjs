// Real local Worker + D1 fault injection for recoverable victory rewards.
// This harness never uses --remote and never touches production data.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const wrangler = resolve(root, 'node_modules/.bin/wrangler');
const scratch = mkdtempSync(join(tmpdir(), 'degen-reward-recovery-'));
const persist = join(scratch, 'state');
const origin = 'http://127.0.0.1:8795';
const env = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' };
let worker;
let logs = '';

function cli(args) {
  for (let attempt = 0; ; attempt += 1) {
    const result = spawnSync(wrangler, args, { cwd: root, env, encoding: 'utf8', timeout: 120_000 });
    if (!result.error && result.status === 0) return result.stdout;

    const details = `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`;
    const transientSqliteLock = /SQLITE_BUSY|database is locked|database is busy/i.test(details);
    if (!transientSqliteLock || attempt >= 7) {
      throw new Error(`wrangler ${args.join(' ')}: ${details}`);
    }

    // The Worker and a separate Wrangler D1 command share the same local SQLite
    // persistence. Retry only explicit busy/locked errors; real SQL or Worker
    // failures still fail the integration test immediately.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(100 * (2 ** attempt), 800));
  }
}
function sql(query) {
  const raw = cli(['d1', 'execute', 'DEGEN', '--local', `--persist-to=${persist}`, '--json', `--command=${query}`]);
  const parsed = JSON.parse(raw);
  const row = Array.isArray(parsed) ? parsed[0] : parsed;
  return row?.results ?? row?.result?.[0]?.results ?? [];
}
async function start() {
  logs = '';
  worker = spawn(wrangler, ['dev', '--local', `--persist-to=${persist}`, '--ip=127.0.0.1', '--port=8795'],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [worker.stdout, worker.stderr]) {
    stream.on('data', data => { logs = (logs + data.toString()).slice(-12_000); });
  }
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (worker.exitCode !== null) throw new Error('Worker exited: ' + logs);
    try {
      const response = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(600) });
      if (response.ok && (await response.json()).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error('Worker did not start: ' + logs);
}
async function stop() {
  if (!worker || worker.exitCode !== null) return;
  const child = worker;
  child.kill('SIGTERM');
  await Promise.race([new Promise(done => child.once('exit', done)), sleep(2_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
  worker = undefined;
}
async function complete(permitId = 'permit-recovery') {
  let response;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetch(origin + '/api/battle/complete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId: 'qa-player', permitId }),
        signal: AbortSignal.timeout(15_000),
      });
      break;
    } catch (error) {
      // A local Wrangler socket can close while the Worker remains healthy.
      // Completion is idempotent, so retry one transport failure only after
      // confirming the same local Worker is still serving health checks.
      if (attempt === 0 && worker?.exitCode === null) {
        await sleep(100);
        try {
          const health = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(2_000) });
          if (health.ok && (await health.json()).ok) continue;
        } catch {}
      }
      throw new Error(`POST /api/battle/complete failed for ${permitId}: ${error instanceof Error ? error.message : String(error)}\\nWorker exit code: ${worker?.exitCode ?? 'running'}\\nCaptured Worker logs:\\n${logs}`);
    }
  }
  if (!response) throw new Error(`POST /api/battle/complete produced no response for ${permitId}\\nCaptured Worker logs:\\n${logs}`);
  const raw = await response.text();
  let body;
  try { body = raw ? JSON.parse(raw) : undefined; } catch { body = { raw: raw.slice(0, 300) }; }
  return { status: response.status, body };
}
async function act(permitId, abilityId = 'slash', expectedTurnCount = 0) {
  const response = await fetch(origin + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: 'qa-player', permitId, abilityId, expectedTurnCount }),
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await response.text();
  let body;
  try { body = raw ? JSON.parse(raw) : undefined; } catch { body = { raw: raw.slice(0, 300) }; }
  return { status: response.status, body };
}
async function startBattle(requestId) {
  const response = await fetch(origin + '/api/battle/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'qa-player',
      eventKey: 'underpass',
      cycleId: 'qa-cycle',
      encounterKey: 'tunnel-maw',
      requestId,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await response.text();
  let body;
  try { body = raw ? JSON.parse(raw) : undefined; } catch { body = { raw: raw.slice(0, 300) }; }
  return { status: response.status, body };
}

try {
  cli(['d1', 'execute', 'DEGEN', '--local', `--persist-to=${persist}`, '--file=db/schema.sql']);
  cli(['d1', 'migrations', 'apply', 'DEGEN', '--local', `--persist-to=${persist}`]);
  const seed = join(scratch, 'seed.sql');
  writeFileSync(seed, `
    PRAGMA foreign_keys = ON;
    INSERT INTO players(id, display_name) VALUES
      ('qa-player', 'Reward Recovery QA'),
      ('qa-marker-owner', 'Conflicting History Marker Owner');
    INSERT INTO characters(player_id, level, xp, currency, degen_key)
      VALUES ('qa-player', 1, 0, 0, 'test-degen');
    INSERT INTO world_event_cycles(id, event_key, opens_at, closes_at)
      VALUES
        ('qa-cycle', 'underpass', datetime('now', '-1 hour'), datetime('now', '+1 hour')),
        ('qa-legacy-cycle', 'underpass', datetime('now', '-1 hour'), datetime('now', '+1 hour')),
        ('qa-reservation-cycle', 'underpass', datetime('now', '-1 hour'), datetime('now', '+1 hour')),
        ('qa-cleanup-cycle', 'underpass', datetime('now', '-1 hour'), datetime('now', '+1 hour')),
        ('qa-action-race-cycle', 'underpass', datetime('now', '-1 hour'), datetime('now', '+1 hour')),
        ('qa-poison-cycle', 'underpass', datetime('now', '-1 hour'), datetime('now', '+1 hour')),
        ('qa-malformed-cleanup-cycle', 'underpass', datetime('now', '-1 hour'), datetime('now', '+1 hour')),
        ('qa-completed-poison-cycle', 'underpass', datetime('now', '-1 hour'), datetime('now', '+1 hour')),
        ('qa-claim-race-cycle', 'underpass', datetime('now', '-1 hour'), datetime('now', '+1 hour'));
    INSERT INTO world_event_clears(player_id, event_key, cycle_id, full_reward_clears)
      VALUES
        ('qa-player', 'underpass', 'qa-legacy-cycle', 3),
        ('qa-player', 'underpass', 'qa-poison-cycle', 1),
        ('qa-player', 'underpass', 'qa-malformed-cleanup-cycle', 1),
        ('qa-player', 'underpass', 'qa-completed-poison-cycle', 1),
        ('qa-player', 'underpass', 'qa-claim-race-cycle', 0);
    INSERT INTO battle_permits(
      id, player_id, event_key, cycle_id, encounter_key, expires_at,
      player_hp, player_mana, enemy_hp, battle_status, turn_count,
      reward_state, reward_claim_token, reward_claimed_at
    ) VALUES
      (
        'permit-recovery', 'qa-player', 'underpass', 'qa-cycle', 'tunnel-maw',
        datetime('now', '+20 minutes'), 90, 0, 0, 'victory', 1, 'pending', NULL, NULL
      ),
      (
        'permit-legacy-recovery', 'qa-player', 'underpass', 'qa-legacy-cycle', 'tunnel-maw',
        datetime('now', '-20 minutes'), 70, NULL, 0, 'victory', 3, 'pending', NULL, NULL
      ),
      (
        'permit-live-claim', 'qa-player', 'underpass', 'qa-cycle', 'tunnel-maw',
        datetime('now', '+20 minutes'), 90, 0, 0, 'victory', 1,
        'claiming', 'live-claim-token', CURRENT_TIMESTAMP
      ),
      (
        'permit-stale-claim', 'qa-player', 'underpass', 'qa-cycle', 'tunnel-maw',
        datetime('now', '+20 minutes'), 90, 0, 0, 'victory', 1,
        'claiming', 'abandoned-claim-token', datetime('now', '-2 minutes')
      ),
      (
        'permit-stale-race', 'qa-player', 'underpass', 'qa-cycle', 'tunnel-maw',
        datetime('now', '-20 minutes'), 90, 0, 0, 'victory', 1,
        'claiming', 'abandoned-race-token', datetime('now', '-2 minutes')
      ),
      (
        'permit-fresh-race', 'qa-player', 'underpass', 'qa-cycle', 'tunnel-maw',
        datetime('now', '+20 minutes'), 90, 0, 0, 'victory', 1, 'pending', NULL, NULL
      ),
      (
        'permit-missing-claim-time', 'qa-player', 'underpass', 'qa-cycle', 'tunnel-maw',
        datetime('now', '+20 minutes'), 90, 0, 0, 'victory', 1,
        'claiming', 'missing-time-token', NULL
      ),
      (
        'permit-invalid-claim-time', 'qa-player', 'underpass', 'qa-cycle', 'tunnel-maw',
        datetime('now', '+20 minutes'), 90, 0, 0, 'victory', 1,
        'claiming', 'invalid-time-token', '0000-not-a-date'
      ),
      (
        'permit-nonnormalized-claim-time', 'qa-player', 'underpass', 'qa-cycle', 'tunnel-maw',
        datetime('now', '+20 minutes'), 90, 0, 0, 'victory', 1,
        'claiming', 'nonnormalized-time-token', strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-2 minutes')
      ),
      (
        'permit-completed-claim', 'qa-player', 'underpass', 'qa-cycle', 'tunnel-maw',
        datetime('now', '+20 minutes'), 90, 0, 0, 'victory', 1,
        'claiming', 'completed-claim-token', datetime('now', '-2 minutes')
      ),
      (
        'permit-completion-race', 'qa-player', 'underpass', 'qa-cycle', 'tunnel-maw',
        datetime('now', '+20 minutes'), 90, 0, 0, 'victory', 1, 'pending', NULL, NULL
      ),
      (
        'permit-completion-after-reservation', 'qa-player', 'underpass', 'qa-cycle', 'tunnel-maw',
        datetime('now', '+20 minutes'), 90, 0, 0, 'victory', 1, 'pending', NULL, NULL
      ),
      (
        'permit-reservation-recovery', 'qa-player', 'underpass', 'qa-reservation-cycle', 'tunnel-maw',
        datetime('now', '+20 minutes'), 90, 0, 0, 'victory', 1, 'pending', NULL, NULL
      ),
      (
        'permit-cleanup-failure', 'qa-player', 'underpass', 'qa-cleanup-cycle', 'tunnel-maw',
        datetime('now', '+20 minutes'), 90, 0, 0, 'victory', 1, 'pending', NULL, NULL
      ),
      (
        'permit-action-complete-race', 'qa-player', 'underpass', 'qa-action-race-cycle', 'tunnel-maw',
        datetime('now', '+20 minutes'), 90, 12, 1, 'active', 0, 'pending', NULL, NULL
      ),
      (
        'permit-poisoned-reservation', 'qa-player', 'underpass', 'qa-poison-cycle', 'tunnel-maw',
        datetime('now', '+20 minutes'), 90, 0, 0, 'victory', 1,
        'claiming', 'poisoned-reservation-token', datetime('now', '-2 minutes')
      ),
      (
        'permit-poison-recovery', 'qa-player', 'underpass', 'qa-poison-cycle', 'tunnel-maw',
        datetime('now', '+20 minutes'), 90, 0, 0, 'victory', 1, 'pending', NULL, NULL
      ),
      (
        'permit-malformed-reservation', 'qa-player', 'underpass', 'qa-malformed-cleanup-cycle', 'tunnel-maw',
        datetime('now', '+20 minutes'), 90, 0, 0, 'victory', 1,
        'claiming', 'malformed-reservation-token', strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-2 minutes')
      ),
      (
        'permit-malformed-reservation-recovery', 'qa-player', 'underpass', 'qa-malformed-cleanup-cycle', 'tunnel-maw',
        datetime('now', '+20 minutes'), 90, 0, 0, 'victory', 1, 'pending', NULL, NULL
      ),
      (
        'permit-completed-poisoned-reservation', 'qa-player', 'underpass', 'qa-completed-poison-cycle', 'tunnel-maw',
        datetime('now', '+20 minutes'), 90, 0, 0, 'victory', 1,
        'claiming', 'completed-poison-token', datetime('now', '-2 minutes')
      ),
      (
        'permit-completed-poison-recovery', 'qa-player', 'underpass', 'qa-completed-poison-cycle', 'tunnel-maw',
        datetime('now', '+20 minutes'), 90, 0, 0, 'victory', 1, 'pending', NULL, NULL
      ),
      (
        'permit-history-conflict', 'qa-player', 'underpass', 'qa-cycle', 'tunnel-maw',
        datetime('now', '+20 minutes'), 90, 0, 0, 'victory', 1, 'pending', NULL, NULL
      ),
      (
        'permit-defeat-history-conflict', 'qa-player', 'underpass', 'qa-cycle', 'tunnel-maw',
        datetime('now', '+20 minutes'), 90, 0, 0, 'victory', 1, 'pending', NULL, NULL
      ),
      (
        'permit-marker-race', 'qa-player', 'underpass', 'qa-claim-race-cycle', 'tunnel-maw',
        datetime('now', '+20 minutes'), 90, 0, 0, 'victory', 1, 'pending', NULL, NULL
      ),
      (
        'permit-counter-marker-race', 'qa-player', 'underpass', 'qa-claim-race-cycle', 'tunnel-maw',
        datetime('now', '+20 minutes'), 90, 0, 0, 'victory', 1, 'pending', NULL, NULL
      ),
      (
        'permit-settlement-marker-race', 'qa-player', 'underpass', 'qa-claim-race-cycle', 'tunnel-maw',
        datetime('now', '+20 minutes'), 90, 0, 0, 'victory', 1, 'pending', NULL, NULL
      );
    INSERT INTO battle_permits(
      id, player_id, event_key, cycle_id, encounter_key, expires_at,
      player_hp, player_mana, enemy_hp, battle_status, turn_count
    ) VALUES
      ('00000000-0000-4000-8000-000000000101', 'qa-player', 'underpass', 'qa-cycle', 'tunnel-maw',
        datetime('now', '+20 minutes'), 80, 12, 92, 'active', 0),
      ('00000000-0000-4000-8000-000000000102', 'qa-player', 'underpass', 'qa-cycle', 'tunnel-maw',
        datetime('now', '+20 minutes'), 80, 12, 92, 'active', 0);
    INSERT INTO battle_history(id, player_id, encounter_key, result, player_level, xp_awarded, currency_awarded)
      VALUES
        ('permit-history-conflict:victory', 'qa-marker-owner', 'tunnel-maw', 'defeat', 1, 0, 0),
        ('permit-defeat-history-conflict:defeat', 'qa-marker-owner', 'tunnel-maw', 'victory', 99, 999, 999),
        ('00000000-0000-4000-8000-000000000101:victory', 'qa-marker-owner', 'tunnel-maw', 'defeat', 1, 0, 0),
        ('00000000-0000-4000-8000-000000000102:defeat', 'qa-marker-owner', 'tunnel-maw', 'victory', 99, 999, 999),
        ('00000000-0000-4000-8000-000000000103:victory', 'qa-marker-owner', 'tunnel-maw', 'defeat', 1, 0, 0);
    UPDATE battle_permits SET completed_at = datetime('now', '-2 minutes')
      WHERE id = 'permit-completed-claim';
    UPDATE battle_permits SET reward_clear_number = 999999
      WHERE id = 'permit-poisoned-reservation';
    UPDATE battle_permits SET reward_clear_number = 999999
      WHERE id = 'permit-malformed-reservation';
    UPDATE battle_permits SET completed_at = datetime('now', '-2 minutes'), reward_clear_number = 999999
      WHERE id = 'permit-completed-poisoned-reservation';
  `);
  cli(['d1', 'execute', 'DEGEN', '--local', `--persist-to=${persist}`, `--file=${seed}`]);

  // Simulate a conflicting terminal marker appearing immediately after the claim
  // CAS, between the initial receipt read and clear-slot reservation. Reservation
  // and counter advancement must both fail closed and leave the slot untouched.
  sql(`CREATE TRIGGER qa_marker_during_claim AFTER UPDATE OF reward_state ON battle_permits
    WHEN NEW.id = 'permit-marker-race' AND NEW.reward_state = 'claiming' AND OLD.reward_state <> 'claiming'
    BEGIN
      INSERT INTO battle_history(id, player_id, encounter_key, result, player_level, xp_awarded, currency_awarded)
      VALUES ('permit-marker-race:defeat', 'qa-marker-owner', 'tunnel-maw', 'defeat', 1, 0, 0);
    END`);
  sql(`CREATE TRIGGER qa_marker_after_clear_assignment AFTER UPDATE OF reward_clear_number ON battle_permits
    WHEN NEW.id = 'permit-counter-marker-race' AND NEW.reward_clear_number IS NOT NULL AND OLD.reward_clear_number IS NULL
    BEGIN
      INSERT INTO battle_history(id, player_id, encounter_key, result, player_level, xp_awarded, currency_awarded)
      VALUES ('permit-counter-marker-race:defeat', 'qa-marker-owner', 'tunnel-maw', 'defeat', 1, 0, 0);
    END`);
  sql(`CREATE TRIGGER qa_marker_after_counter_advance AFTER UPDATE OF full_reward_clears ON world_event_clears
    WHEN NEW.player_id = 'qa-player' AND NEW.cycle_id = 'qa-claim-race-cycle'
      AND NEW.full_reward_clears > OLD.full_reward_clears
    BEGIN
      INSERT INTO battle_history(id, player_id, encounter_key, result, player_level, xp_awarded, currency_awarded)
      VALUES ('permit-settlement-marker-race:defeat', 'qa-marker-owner', 'tunnel-maw', 'defeat', 1, 0, 0);
    END`);

  // Force the atomic award batch to fail after the clear number has been
  // reserved. The lease must be released without rolling back or duplicating
  // that reservation, so the next request can retry immediately.
  sql(`CREATE TRIGGER qa_fail_victory_receipt BEFORE INSERT ON battle_history
    WHEN NEW.id = 'permit-recovery:victory'
    BEGIN SELECT RAISE(ABORT, 'QA_TRANSIENT_REWARD_FAILURE'); END`);
  await start();

  // Battle-start replay must not return a playable snapshot for an active permit
  // whose independent terminal history markers disagree with persisted state.
  for (const [permitId, markerKind] of [
    ['00000000-0000-4000-8000-000000000101', 'victory'],
    ['00000000-0000-4000-8000-000000000102', 'defeat'],
  ]) {
    const before = sql(`SELECT battle_status, player_hp, player_mana, enemy_hp, turn_count
      FROM battle_permits WHERE id = '${permitId}'`);
    const poisonedStart = await startBattle(permitId);
    assert.equal(poisonedStart.status, 409, JSON.stringify(poisonedStart.body));
    assert.equal('initialState' in (poisonedStart.body ?? {}), false,
      `start replay must not expose a snapshot with a conflicting ${markerKind} marker`);
    assert.deepEqual(sql(`SELECT battle_status, player_hp, player_mana, enemy_hp, turn_count
      FROM battle_permits WHERE id = '${permitId}'`), before,
      'rejecting a poisoned start replay must not mutate the persisted battle');
  }
  const orphanMarkerStart = await startBattle('00000000-0000-4000-8000-000000000103');
  assert.equal(orphanMarkerStart.status, 409, JSON.stringify(orphanMarkerStart.body));
  assert.equal('initialState' in (orphanMarkerStart.body ?? {}), false,
    'a request ID colliding with an orphan terminal marker must not issue a permit');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_permits
    WHERE id = '00000000-0000-4000-8000-000000000103'`)[0]?.n, 0,
    'a poisoned request ID must not create a new permit');

  // Server discovery is the recovery path when localStorage lost a permit ID.
  // Only valid, recoverable Worker-owned victories are returned; no reward data
  // is exposed, and active/live-claim/corrupt/awarded permits are not candidates.
  const pendingResponse = await fetch(origin + '/api/battle/pending-rewards?playerId=qa-player');
  const pendingBody = await pendingResponse.json();
  assert.equal(pendingResponse.status, 200, JSON.stringify(pendingBody));
  assert.deepEqual(Object.keys(pendingBody), ['permitIds']);
  assert.ok(Array.isArray(pendingBody.permitIds));
  const pendingPermitIds = new Set(pendingBody.permitIds);
  for (const permitId of ['permit-recovery', 'permit-legacy-recovery', 'permit-stale-claim', 'permit-stale-race']) {
    assert.ok(pendingPermitIds.has(permitId), `recoverable victory ${permitId} should be discoverable`);
  }
  for (const permitId of [
    'permit-live-claim', 'permit-missing-claim-time', 'permit-invalid-claim-time',
    'permit-nonnormalized-claim-time', 'permit-completed-claim', 'permit-action-complete-race',
    'permit-history-conflict', 'permit-defeat-history-conflict', 'permit-completed-poisoned-reservation',
  ]) {
    assert.equal(pendingPermitIds.has(permitId), false, `ineligible victory ${permitId} must not be discovered`);
  }

  // A terminal status with a conflicting history key is not a safe snapshot to
  // hand back to a stale tab. This pending victory already has a defeat marker.
  const poisonedPendingStateBefore = sql(`SELECT battle_status, player_hp, player_mana, enemy_hp, turn_count
    FROM battle_permits WHERE id = 'permit-defeat-history-conflict'`);
  const poisonedPendingAction = await act('permit-defeat-history-conflict', 'slash', 1);
  assert.equal(poisonedPendingAction.status, 409, JSON.stringify(poisonedPendingAction.body));
  assert.equal(poisonedPendingAction.body?.error, 'Battle state changed; authoritative snapshot unavailable.');
  assert.equal('battleState' in (poisonedPendingAction.body ?? {}), false,
    'a pending victory with a conflicting terminal marker must not be echoed');
  assert.deepEqual(sql(`SELECT battle_status, player_hp, player_mana, enemy_hp, turn_count
    FROM battle_permits WHERE id = 'permit-defeat-history-conflict'`), poisonedPendingStateBefore,
    'snapshot rejection must not mutate the persisted terminal state');

  // The claim itself can succeed before a conflicting terminal marker appears.
  // The reservation CAS must recheck both keys before consuming a clear slot.
  const markerRaceCharacterBefore = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  const markerRaceInventoryBefore = sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`);
  const markerRace = await complete('permit-marker-race');
  assert.equal(markerRace.status, 409, JSON.stringify(markerRace.body));
  assert.equal(markerRace.body?.error, 'Unable to assign authoritative reward clear.');
  assert.deepEqual(sql(`SELECT reward_state, reward_claim_token, reward_claimed_at, reward_clear_number, completed_at
    FROM battle_permits WHERE id = 'permit-marker-race'`), [{
    reward_state: 'pending', reward_claim_token: null, reward_claimed_at: null,
    reward_clear_number: null, completed_at: null,
  }], 'a poisoned claim must release its lease without reserving a clear number');
  assert.deepEqual(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-claim-race-cycle'`),
    [{ full_reward_clears: 0 }], 'a marker race must not advance the reward sequence');
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), markerRaceCharacterBefore);
  assert.deepEqual(sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`), markerRaceInventoryBefore);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history WHERE id = 'permit-marker-race:defeat'`)[0]?.n, 1,
    'the conflicting terminal marker remains intact for audit');
  const pendingAfterMarkerRace = await fetch(origin + '/api/battle/pending-rewards?playerId=qa-player');
  const pendingAfterMarkerBody = await pendingAfterMarkerRace.json();
  assert.equal(pendingAfterMarkerRace.status, 200, JSON.stringify(pendingAfterMarkerBody));
  assert.equal(new Set(pendingAfterMarkerBody.permitIds).has('permit-marker-race'), false,
    'server discovery must not requeue a victory with a conflicting terminal marker');
  // Inject a terminal marker after clear-number allocation but before the counter update.
  // The counter guard must prevent sequence advancement, and recovery must release
  // the invalid reservation rather than strand or consume the slot.
  const counterRaceCharacterBefore = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  const counterRaceInventoryBefore = sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`);
  const counterRace = await complete('permit-counter-marker-race');
  assert.equal(counterRace.status, 409, JSON.stringify(counterRace.body));
  assert.equal(counterRace.body?.error, 'Unable to assign authoritative reward clear.');
  assert.deepEqual(sql(`SELECT reward_state, reward_claim_token, reward_claimed_at, reward_clear_number, completed_at
    FROM battle_permits WHERE id = 'permit-counter-marker-race'`), [{
    reward_state: 'pending', reward_claim_token: null, reward_claimed_at: null,
    reward_clear_number: null, completed_at: null,
  }], 'a marker after allocation must release the claim and clear its unused reservation');
  assert.deepEqual(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-claim-race-cycle'`),
    [{ full_reward_clears: 0 }], 'a terminal marker arriving after allocation must not advance the counter');
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), counterRaceCharacterBefore);
  assert.deepEqual(sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`), counterRaceInventoryBefore);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history WHERE id = 'permit-counter-marker-race:defeat'`)[0]?.n, 1);
  const pendingAfterCounterRace = await fetch(origin + '/api/battle/pending-rewards?playerId=qa-player');
  const pendingAfterCounterBody = await pendingAfterCounterRace.json();
  assert.equal(pendingAfterCounterRace.status, 200, JSON.stringify(pendingAfterCounterBody));
  assert.equal(new Set(pendingAfterCounterBody.permitIds).has('permit-counter-marker-race'), false,
    'server discovery must exclude a victory poisoned after clear-number assignment');
  // A final marker can appear when the clear counter advances. The settlement
  // batch must not apply XP/currency/items or write a victory receipt in that case.
  // Keep the already-advanced slot reserved rather than decrementing a sequence
  // that another concurrent clear may already have observed.
  const settlementRaceCharacterBefore = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  const settlementRaceInventoryBefore = sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`);
  const settlementRace = await complete('permit-settlement-marker-race');
  assert.equal(settlementRace.status, 409, JSON.stringify(settlementRace.body));
  assert.equal(settlementRace.body?.error, 'Battle terminal history marker conflicts with reward settlement.');
  assert.deepEqual(sql(`SELECT reward_state, reward_claim_token, reward_claimed_at, reward_clear_number, completed_at
    FROM battle_permits WHERE id = 'permit-settlement-marker-race'`), [{
    reward_state: 'pending', reward_claim_token: null, reward_claimed_at: null,
    reward_clear_number: 1, completed_at: null,
  }], 'a poisoned post-counter victory must be unclaimed and remain auditable');
  assert.deepEqual(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-claim-race-cycle'`),
    [{ full_reward_clears: 1 }], 'do not renumber a clear slot after the counter has advanced');
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), settlementRaceCharacterBefore);
  assert.deepEqual(sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`), settlementRaceInventoryBefore);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history WHERE id = 'permit-settlement-marker-race:victory'`)[0]?.n, 0,
    'the invalid victory must not create its reward receipt');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history WHERE id = 'permit-settlement-marker-race:defeat'`)[0]?.n, 1);
  const pendingAfterSettlementRace = await fetch(origin + '/api/battle/pending-rewards?playerId=qa-player');
  const pendingAfterSettlementBody = await pendingAfterSettlementRace.json();
  assert.equal(pendingAfterSettlementRace.status, 200, JSON.stringify(pendingAfterSettlementBody));
  assert.equal(new Set(pendingAfterSettlementBody.permitIds).has('permit-settlement-marker-race'), false,
    'a terminally inconsistent receipt must not be rediscovered for reward settlement');
  sql('DROP TRIGGER qa_marker_during_claim');
  sql('DROP TRIGGER qa_marker_after_clear_assignment');
  sql('DROP TRIGGER qa_marker_after_counter_advance');

  // A pre-existing deterministic victory key is not a valid pending receipt.
  // Reject it before clear reservation or progression/inventory mutation.
  const conflictPermitBefore = sql(`SELECT reward_state, reward_claim_token, reward_claimed_at,
      reward_clear_number, reward_xp, reward_currency, reward_tier, reward_level,
      reward_remaining_xp, completed_at
    FROM battle_permits WHERE id = 'permit-history-conflict'`);
  const conflictHistoryBefore = sql(`SELECT id, player_id, encounter_key, result, player_level,
      xp_awarded, currency_awarded FROM battle_history
    WHERE id = 'permit-history-conflict:victory'`);
  const conflictCharacterBefore = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  const conflictInventoryBefore = sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`);
  const conflictClearsBefore = sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`);
  const historyConflict = await complete('permit-history-conflict');
  assert.equal(historyConflict.status, 409, JSON.stringify(historyConflict.body));
  assert.equal(historyConflict.body?.error, 'Battle victory history marker conflicts with pending reward.');
  assert.equal('reward' in (historyConflict.body ?? {}), false);
  assert.equal('player' in (historyConflict.body ?? {}), false);
  assert.deepEqual(sql(`SELECT reward_state, reward_claim_token, reward_claimed_at,
      reward_clear_number, reward_xp, reward_currency, reward_tier, reward_level,
      reward_remaining_xp, completed_at
    FROM battle_permits WHERE id = 'permit-history-conflict'`), conflictPermitBefore);
  assert.equal(conflictHistoryBefore[0]?.player_id, 'qa-marker-owner', 'regression must cover a key owned by another player');
  assert.deepEqual(sql(`SELECT id, player_id, encounter_key, result, player_level,
      xp_awarded, currency_awarded FROM battle_history
    WHERE id = 'permit-history-conflict:victory'`), conflictHistoryBefore);
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), conflictCharacterBefore);
  assert.deepEqual(sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`), conflictInventoryBefore);
  assert.deepEqual(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`), conflictClearsBefore);

  // A defeat marker is just as terminal as a victory marker. It must not allow
  // a corrupted victory permit to claim progression, inventory, or a clear slot.
  const defeatConflictPermitBefore = sql(`SELECT reward_state, reward_claim_token, reward_claimed_at,
      reward_clear_number, reward_xp, reward_currency, reward_tier, reward_level,
      reward_remaining_xp, completed_at
    FROM battle_permits WHERE id = 'permit-defeat-history-conflict'`);
  const defeatConflictHistoryBefore = sql(`SELECT id, player_id, encounter_key, result, player_level,
      xp_awarded, currency_awarded FROM battle_history
    WHERE id = 'permit-defeat-history-conflict:defeat'`);
  const historyDefeatConflict = await complete('permit-defeat-history-conflict');
  assert.equal(historyDefeatConflict.status, 409, JSON.stringify(historyDefeatConflict.body));
  assert.equal(historyDefeatConflict.body?.error, 'Battle defeat history marker conflicts with pending reward.');
  assert.equal('reward' in (historyDefeatConflict.body ?? {}), false);
  assert.equal('player' in (historyDefeatConflict.body ?? {}), false);
  assert.deepEqual(sql(`SELECT reward_state, reward_claim_token, reward_claimed_at,
      reward_clear_number, reward_xp, reward_currency, reward_tier, reward_level,
      reward_remaining_xp, completed_at
    FROM battle_permits WHERE id = 'permit-defeat-history-conflict'`), defeatConflictPermitBefore);
  assert.deepEqual(sql(`SELECT id, player_id, encounter_key, result, player_level,
      xp_awarded, currency_awarded FROM battle_history
    WHERE id = 'permit-defeat-history-conflict:defeat'`), defeatConflictHistoryBefore);
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), conflictCharacterBefore);
  assert.deepEqual(sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`), conflictInventoryBefore);
  assert.deepEqual(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`), conflictClearsBefore);

  const failed = await complete();
  assert.equal(failed.status, 500, 'injected reward transaction failure must be surfaced');
  await stop();

  assert.deepEqual(sql(`SELECT reward_state, reward_claim_token, reward_claimed_at,
      reward_clear_number, completed_at
    FROM battle_permits WHERE id = 'permit-recovery'`), [{
    reward_state: 'pending',
    reward_claim_token: null,
    reward_claimed_at: null,
    reward_clear_number: 1,
    completed_at: null,
  }], 'failed award should release only its own claim while retaining the reserved clear');
  assert.deepEqual(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`),
    [{ full_reward_clears: 1 }], 'retry must not consume a second reward slot');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history WHERE id = 'permit-recovery:victory'`)[0]?.n, 0);
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), [{
    level: 1, xp: 0, currency: 0, last_reward_claim_token: null,
  }], 'a failed D1 batch must not partially grant progression');

  // Simulate the permit expiring while the award service is recovering. Once
  // a clear number is reserved, the authoritative victory remains claimable.
  sql("UPDATE battle_permits SET expires_at = datetime('now', '-1 minute') WHERE id = 'permit-recovery'");
  assert.equal(sql("SELECT julianday(expires_at) < julianday('now') AS expired FROM battle_permits WHERE id = 'permit-recovery'")[0]?.expired, 1);
  sql('DROP TRIGGER qa_fail_victory_receipt');
  await start();
  const recovered = await complete();
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.ok(recovered.body?.reward, 'successful retry returns an authoritative reward receipt');
  const reward = recovered.body.reward;
  const characterAfterAward = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  const permitAfterAward = sql(`SELECT reward_state, reward_clear_number, reward_xp,
      reward_currency, reward_tier, completed_at
    FROM battle_permits WHERE id = 'permit-recovery'`);
  assert.equal(permitAfterAward[0]?.reward_state, 'awarded');
  assert.equal(permitAfterAward[0]?.reward_clear_number, 1);
  assert.equal(permitAfterAward[0]?.reward_xp, reward.xp);
  assert.equal(permitAfterAward[0]?.reward_currency, reward.currency);
  assert.ok(permitAfterAward[0]?.completed_at);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history WHERE id = 'permit-recovery:victory'`)[0]?.n, 1);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM defeated_bosses
    WHERE player_id = 'qa-player' AND boss_key = 'tunnel-maw'`)[0]?.n, 1);

  const duplicate = await complete();
  assert.equal(duplicate.status, 200, JSON.stringify(duplicate.body));
  assert.deepEqual(duplicate.body.reward, reward, 'duplicate completion returns the same stored receipt');
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), characterAfterAward,
    'duplicate completion must not change progression twice');
  assert.deepEqual(sql(`SELECT reward_state, reward_clear_number, reward_xp,
      reward_currency, reward_tier, completed_at
    FROM battle_permits WHERE id = 'permit-recovery'`), permitAfterAward);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history WHERE id = 'permit-recovery:victory'`)[0]?.n, 1);
  assert.equal(sql(`SELECT quantity FROM player_inventory
    WHERE player_id = 'qa-player' AND item_key = 'underpass-scrap' AND item_type = 'item'`)[0]?.quantity ?? 0,
    reward.items.includes('underpass-scrap') ? 1 : 0);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM player_inventory
    WHERE player_id = 'qa-player' AND item_key = 'tunnel-trophy' AND item_type = 'furniture'`)[0]?.n ?? 0,
    reward.furniture.includes('tunnel-trophy') ? 1 : 0);
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`)[0]?.full_reward_clears, 1);

  // A post-award conflicting defeat marker invalidates the independent audit
  // rather than allowing a corrupted terminal receipt to replay as trustworthy.
  sql(`INSERT INTO battle_history
    (id, player_id, encounter_key, result, player_level, xp_awarded, currency_awarded)
    VALUES ('permit-recovery:defeat', 'qa-marker-owner', 'tunnel-maw', 'victory', 99, 999, 999)`);
  const corruptedAwardReplay = await complete();
  assert.equal(corruptedAwardReplay.status, 409, JSON.stringify(corruptedAwardReplay.body));
  assert.equal(corruptedAwardReplay.body?.error, 'Battle reward receipt is invalid.');
  assert.equal('reward' in (corruptedAwardReplay.body ?? {}), false);
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), characterAfterAward,
    'a conflicting terminal marker must not alter already-awarded progression');
  assert.deepEqual(sql(`SELECT reward_state, reward_clear_number, reward_xp,
      reward_currency, reward_tier, completed_at
    FROM battle_permits WHERE id = 'permit-recovery'`), permitAfterAward,
    'a conflicting terminal marker must not rewrite the stored receipt');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history WHERE id = 'permit-recovery:victory'`)[0]?.n, 1);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history WHERE id = 'permit-recovery:defeat'`)[0]?.n, 1);
  const corruptedAwardAction = await act('permit-recovery', 'slash', 1);
  assert.equal(corruptedAwardAction.status, 409, JSON.stringify(corruptedAwardAction.body));
  assert.equal(corruptedAwardAction.body?.error, 'Battle permit is invalid, expired, or already completed.');
  assert.equal('battleState' in (corruptedAwardAction.body ?? {}), false,
    'a corrupted awarded receipt must not be replayed as a trustworthy victory snapshot');

  // A live claim lease must not be stolen by a concurrent completion attempt.
  const beforeLiveClaim = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  // Earlier fault-injection cases intentionally exercise several D1 transactions; refresh the
  // live lease immediately before asserting that a non-stale claim cannot be stolen.
  sql("UPDATE battle_permits SET reward_claimed_at = CURRENT_TIMESTAMP WHERE id = 'permit-live-claim'");
  const liveClaim = await complete('permit-live-claim');
  assert.equal(liveClaim.status, 409, JSON.stringify(liveClaim.body));
  assert.equal(liveClaim.body?.error, 'Battle reward is already being claimed, or the permit expired.');
  assert.equal('reward' in (liveClaim.body ?? {}), false);
  const livePermitState = sql(`SELECT reward_state, reward_claim_token, reward_claimed_at,
      reward_clear_number, completed_at
    FROM battle_permits WHERE id = 'permit-live-claim'`);
  assert.equal(livePermitState[0]?.reward_state, 'claiming');
  assert.equal(livePermitState[0]?.reward_claim_token, 'live-claim-token');
  assert.ok(livePermitState[0]?.reward_claimed_at, 'the live claim must retain its lease timestamp');
  assert.equal(livePermitState[0]?.reward_clear_number, null);
  assert.equal(livePermitState[0]?.completed_at, null);
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), beforeLiveClaim,
    'a live claim lease must not mutate progression');
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`)[0]?.full_reward_clears, 1);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history WHERE id = 'permit-live-claim:victory'`)[0]?.n, 0);

  // An inconsistent claim with completed_at already set is not a recoverable lease.
  // Completion timestamps are written atomically with reward_state='awarded'; accepting
  // this row would let a malformed receipt bypass the awarded-receipt audit and settle.
  const completedClaimPermitBefore = sql(`SELECT reward_state, reward_claim_token, reward_claimed_at,
      reward_clear_number, reward_xp, reward_currency, reward_tier, completed_at
    FROM battle_permits WHERE id = 'permit-completed-claim'`);
  const completedClaimCharacterBefore = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  const completedClaimInventoryBefore = sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`);
  const completedClaimClearsBefore = sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`);
  const completedClaimHistoryBefore = sql(`SELECT id, result, xp_awarded, currency_awarded FROM battle_history
    WHERE id = 'permit-completed-claim:victory'`);
  const inconsistentClaim = await complete('permit-completed-claim');
  assert.equal(inconsistentClaim.status, 409, JSON.stringify(inconsistentClaim.body));
  assert.equal(inconsistentClaim.body?.error, 'Battle reward is already being claimed, or the permit expired.');
  assert.equal('reward' in (inconsistentClaim.body ?? {}), false);
  assert.equal('player' in (inconsistentClaim.body ?? {}), false);
  assert.deepEqual(sql(`SELECT reward_state, reward_claim_token, reward_claimed_at,
      reward_clear_number, reward_xp, reward_currency, reward_tier, completed_at
    FROM battle_permits WHERE id = 'permit-completed-claim'`), completedClaimPermitBefore,
    'an inconsistent completed claim must not be reclaimed or rewritten');
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), completedClaimCharacterBefore,
    'an inconsistent completed claim must not award progression or currency');
  assert.deepEqual(sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`), completedClaimInventoryBefore,
    'an inconsistent completed claim must not award inventory');
  assert.deepEqual(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`), completedClaimClearsBefore,
    'an inconsistent completed claim must not reserve another clear');
  assert.deepEqual(sql(`SELECT id, result, xp_awarded, currency_awarded FROM battle_history
    WHERE id = 'permit-completed-claim:victory'`), completedClaimHistoryBefore,
    'an inconsistent completed claim must not create victory history');

  // Simulate a completion timestamp appearing after the claim UPDATE has passed its
  // initial NULL guard. The settlement and clear-allocation compare-and-swaps must
  // recheck that guard, and failed cleanup must not rewrite the inconsistent row.
  sql(`CREATE TRIGGER qa_complete_claim_after_acquire AFTER UPDATE OF reward_state ON battle_permits
    WHEN NEW.id = 'permit-completion-race' AND NEW.reward_state = 'claiming'
    BEGIN UPDATE battle_permits SET completed_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END`);
  const claimTimestampRaceCharacterBefore = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  const claimTimestampRaceInventoryBefore = sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`);
  const claimTimestampRaceClearsBefore = sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`);
  const claimTimestampRaceHistoryBefore = sql(`SELECT id, result, xp_awarded, currency_awarded FROM battle_history
    WHERE id = 'permit-completion-race:victory'`);
  const claimTimestampRace = await complete('permit-completion-race');
  assert.equal(claimTimestampRace.status, 409, JSON.stringify(claimTimestampRace.body));
  assert.equal('reward' in (claimTimestampRace.body ?? {}), false);
  assert.equal('player' in (claimTimestampRace.body ?? {}), false);
  const claimTimestampRacePermitAfter = sql(`SELECT reward_state, reward_claim_token, reward_claimed_at,
      reward_clear_number, reward_xp, reward_currency, reward_tier, completed_at
    FROM battle_permits WHERE id = 'permit-completion-race'`);
  assert.equal(claimTimestampRacePermitAfter[0]?.reward_state, 'claiming');
  assert.ok(claimTimestampRacePermitAfter[0]?.reward_claim_token);
  assert.ok(claimTimestampRacePermitAfter[0]?.reward_claimed_at);
  assert.equal(claimTimestampRacePermitAfter[0]?.reward_clear_number, null,
    'a completed claim must not reserve a clear number');
  assert.equal(claimTimestampRacePermitAfter[0]?.reward_xp, null);
  assert.equal(claimTimestampRacePermitAfter[0]?.reward_currency, null);
  assert.equal(claimTimestampRacePermitAfter[0]?.reward_tier, null);
  assert.ok(claimTimestampRacePermitAfter[0]?.completed_at,
    'the concurrent completion marker is retained for audit');
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), claimTimestampRaceCharacterBefore);
  assert.deepEqual(sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`), claimTimestampRaceInventoryBefore);
  assert.deepEqual(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`), claimTimestampRaceClearsBefore,
    'a completion timestamp race must not advance the clear counter');
  assert.deepEqual(sql(`SELECT id, result, xp_awarded, currency_awarded FROM battle_history
    WHERE id = 'permit-completion-race:victory'`), claimTimestampRaceHistoryBefore);
  sql('DROP TRIGGER qa_complete_claim_after_acquire');

  // Completion can also become inconsistent after the clear-number UPDATE fires.
  // The cycle counter must stay unchanged, and the unawarded reservation must be
  // cleared without touching progression, inventory, or victory history.
  sql(`CREATE TRIGGER qa_complete_after_clear_reservation AFTER UPDATE OF reward_clear_number ON battle_permits
    WHEN NEW.id = 'permit-completion-after-reservation' AND NEW.reward_clear_number IS NOT NULL
    BEGIN UPDATE battle_permits SET completed_at = CURRENT_TIMESTAMP WHERE id = NEW.id; END`);
  const postReservationCharacterBefore = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  const postReservationInventoryBefore = sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`);
  const postReservationClearsBefore = sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`);
  const postReservationHistoryBefore = sql(`SELECT id, result, xp_awarded, currency_awarded FROM battle_history
    WHERE id = 'permit-completion-after-reservation:victory'`);
  const postReservation = await complete('permit-completion-after-reservation');
  assert.equal(postReservation.status, 409, JSON.stringify(postReservation.body));
  assert.equal('reward' in (postReservation.body ?? {}), false);
  assert.equal('player' in (postReservation.body ?? {}), false);
  const postReservationPermitAfter = sql(`SELECT reward_state, reward_claim_token, reward_claimed_at,
      reward_clear_number, reward_xp, reward_currency, reward_tier, reward_level, reward_remaining_xp, completed_at
    FROM battle_permits WHERE id = 'permit-completion-after-reservation'`);
  assert.equal(postReservationPermitAfter[0]?.reward_state, 'claiming');
  assert.ok(postReservationPermitAfter[0]?.reward_claim_token);
  assert.ok(postReservationPermitAfter[0]?.reward_claimed_at);
  assert.equal(postReservationPermitAfter[0]?.reward_clear_number, null,
    'the inconsistent claim must not retain an unawarded clear reservation');
  assert.equal(postReservationPermitAfter[0]?.reward_xp, null);
  assert.equal(postReservationPermitAfter[0]?.reward_currency, null);
  assert.equal(postReservationPermitAfter[0]?.reward_tier, null);
  assert.equal(postReservationPermitAfter[0]?.reward_level, null);
  assert.equal(postReservationPermitAfter[0]?.reward_remaining_xp, null);
  assert.ok(postReservationPermitAfter[0]?.completed_at);
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), postReservationCharacterBefore);
  assert.deepEqual(sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`), postReservationInventoryBefore);
  assert.deepEqual(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`), postReservationClearsBefore,
    'a completion marker after reservation must not consume a cycle clear');
  assert.deepEqual(sql(`SELECT id, result, xp_awarded, currency_awarded FROM battle_history
    WHERE id = 'permit-completion-after-reservation:victory'`), postReservationHistoryBefore);
  sql('DROP TRIGGER qa_complete_after_clear_reservation');

  // A process that died while holding a claim must be recoverable after the 60-second lease.
  const staleClaim = await complete('permit-stale-claim');
  assert.equal(staleClaim.status, 200, JSON.stringify(staleClaim.body));
  assert.ok(staleClaim.body?.reward, 'stale claim recovery must return the authoritative receipt');
  const staleReward = staleClaim.body.reward;
  assert.equal(staleReward.tier, 'full', 'the second clear in this cycle remains full-tier');
  const stalePermitAfterAward = sql(`SELECT reward_state, reward_claim_token, reward_claimed_at,
      reward_clear_number, reward_xp, reward_currency, reward_tier, completed_at
    FROM battle_permits WHERE id = 'permit-stale-claim'`);
  assert.equal(stalePermitAfterAward[0]?.reward_state, 'awarded');
  assert.notEqual(stalePermitAfterAward[0]?.reward_claim_token, 'abandoned-claim-token',
    'recovery must replace the abandoned worker token');
  assert.ok(stalePermitAfterAward[0]?.reward_claimed_at);
  assert.equal(stalePermitAfterAward[0]?.reward_clear_number, 2);
  assert.equal(stalePermitAfterAward[0]?.reward_xp, staleReward.xp);
  assert.equal(stalePermitAfterAward[0]?.reward_currency, staleReward.currency);
  assert.equal(stalePermitAfterAward[0]?.reward_tier, staleReward.tier);
  assert.ok(stalePermitAfterAward[0]?.completed_at);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history WHERE id = 'permit-stale-claim:victory'`)[0]?.n, 1);
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`)[0]?.full_reward_clears, 2);
  const characterAfterStaleAward = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  const inventoryAfterStaleAward = sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`);

  // The abandoned worker's token-scoped cleanup is harmless after lease takeover.
  sql(`UPDATE battle_permits SET reward_state = 'pending', reward_claim_token = NULL, reward_claimed_at = NULL
    WHERE id = 'permit-stale-claim' AND player_id = 'qa-player'
      AND reward_state = 'claiming' AND reward_claim_token = 'abandoned-claim-token'`);
  assert.deepEqual(sql(`SELECT reward_state, reward_claim_token, reward_claimed_at,
      reward_clear_number, reward_xp, reward_currency, reward_tier, completed_at
    FROM battle_permits WHERE id = 'permit-stale-claim'`), stalePermitAfterAward,
    'an abandoned worker cannot release or reset the recovered/awarded claim');

  const staleDuplicate = await complete('permit-stale-claim');
  assert.equal(staleDuplicate.status, 200, JSON.stringify(staleDuplicate.body));
  assert.deepEqual(staleDuplicate.body.reward, staleReward);
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), characterAfterStaleAward,
    'duplicate completion after stale-lease recovery must not award progression twice');
  assert.deepEqual(sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`), inventoryAfterStaleAward);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history WHERE id = 'permit-stale-claim:victory'`)[0]?.n, 1);
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`)[0]?.full_reward_clears, 2);

  // Two callers racing to recover the same stale lease may settle once; a loser
  // can receive a conflict while the winner owns the fresh lease, then replay it.
  const beforeStaleRace = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  const inventoryBeforeStaleRace = sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`);
  assert.equal(sql(`SELECT julianday(expires_at) < julianday('now') AS expired
    FROM battle_permits WHERE id = 'permit-stale-race'`)[0]?.expired, 1,
    'the stale victory claim is already expired before recovery starts');
  const staleRaceResults = await Promise.all([
    complete('permit-stale-race'),
    complete('permit-stale-race'),
  ]);
  assert.ok(staleRaceResults.every(result => result.status === 200 || result.status === 409),
    JSON.stringify(staleRaceResults));
  assert.ok(staleRaceResults.some(result => result.status === 200),
    'at least one concurrent stale-lease claimant must settle or replay the receipt');
  for (const result of staleRaceResults.filter(result => result.status === 409)) {
    assert.equal(result.body?.error, 'Battle reward is already being claimed, or the permit expired.');
  }

  const staleRaceRetry = await complete('permit-stale-race');
  assert.equal(staleRaceRetry.status, 200, JSON.stringify(staleRaceRetry.body));
  assert.ok(staleRaceRetry.body?.reward);
  const staleRaceReward = staleRaceRetry.body.reward;
  assert.equal(staleRaceReward.tier, 'full', 'the third clear in this cycle remains full-tier');
  const staleRacePermit = sql(`SELECT reward_state, reward_claim_token, reward_clear_number,
      reward_xp, reward_currency, reward_tier, completed_at
    FROM battle_permits WHERE id = 'permit-stale-race'`);
  assert.equal(staleRacePermit[0]?.reward_state, 'awarded');
  assert.notEqual(staleRacePermit[0]?.reward_claim_token, 'abandoned-race-token');
  assert.equal(staleRacePermit[0]?.reward_clear_number, 3);
  assert.equal(staleRacePermit[0]?.reward_xp, staleRaceReward.xp);
  assert.equal(staleRacePermit[0]?.reward_currency, staleRaceReward.currency);
  assert.equal(staleRacePermit[0]?.reward_tier, staleRaceReward.tier);
  assert.ok(staleRacePermit[0]?.completed_at);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history WHERE id = 'permit-stale-race:victory'`)[0]?.n, 1);
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`)[0]?.full_reward_clears, 3);
  const characterAfterStaleRace = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  assert.equal(characterAfterStaleRace[0]?.currency,
    beforeStaleRace[0].currency + staleRaceReward.currency,
    'concurrent stale-lease recovery applies currency once');
  assert.equal(characterAfterStaleRace[0]?.last_reward_claim_token,
    staleRacePermit[0]?.reward_claim_token);
  const inventoryAfterStaleRace = sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`);
  const scrapBefore = inventoryBeforeStaleRace.find(row => row.item_key === 'underpass-scrap' && row.item_type === 'item')?.quantity ?? 0;
  const scrapAfter = inventoryAfterStaleRace.find(row => row.item_key === 'underpass-scrap' && row.item_type === 'item')?.quantity ?? 0;
  assert.equal(scrapAfter, scrapBefore + 1, 'concurrent stale-lease recovery adds one scrap');
  const staleRaceReplay = await complete('permit-stale-race');
  assert.equal(staleRaceReplay.status, 200, JSON.stringify(staleRaceReplay.body));
  assert.deepEqual(staleRaceReplay.body.reward, staleRaceReward);
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), characterAfterStaleRace);
  assert.deepEqual(sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`), inventoryAfterStaleRace);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history WHERE id = 'permit-stale-race:victory'`)[0]?.n, 1);
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`)[0]?.full_reward_clears, 3);

  // Race two completions against a fresh pending victory, not just a stale lease.
  // The first claimant may settle before the second reads, or the loser may see
  // the live lease; either way, one stored receipt and one reward application win.
  const beforeFreshRaceCharacter = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  const beforeFreshRaceInventory = sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`);
  const freshRaceResults = await Promise.all([
    complete('permit-fresh-race'),
    complete('permit-fresh-race'),
  ]);
  assert.ok(freshRaceResults.every(result => result.status === 200 || result.status === 409),
    JSON.stringify(freshRaceResults));
  for (const result of freshRaceResults.filter(result => result.status === 409)) {
    assert.equal(result.body?.error, 'Battle reward is already being claimed, or the permit expired.');
    assert.equal('reward' in (result.body ?? {}), false);
    assert.equal('player' in (result.body ?? {}), false);
  }
  const freshRaceSuccesses = freshRaceResults.filter(result => result.status === 200);
  for (const result of freshRaceSuccesses) assert.ok(result.body?.reward);
  if (freshRaceSuccesses.length === 2) {
    assert.deepEqual(freshRaceSuccesses[0].body.reward, freshRaceSuccesses[1].body.reward,
      'both successful concurrent responses must return the same stored receipt');
  }

  const freshRaceRetry = await complete('permit-fresh-race');
  assert.equal(freshRaceRetry.status, 200, JSON.stringify(freshRaceRetry.body));
  const freshRaceReward = freshRaceRetry.body.reward;
  assert.ok(freshRaceReward);
  const freshRacePermit = sql(`SELECT reward_state, reward_claim_token, reward_clear_number,
      reward_xp, reward_currency, reward_tier, reward_level, reward_remaining_xp, completed_at
    FROM battle_permits WHERE id = 'permit-fresh-race'`);
  assert.equal(freshRacePermit[0]?.reward_state, 'awarded');
  assert.notEqual(freshRacePermit[0]?.reward_claim_token, null);
  assert.equal(freshRacePermit[0]?.reward_clear_number, 4);
  assert.equal(freshRacePermit[0]?.reward_xp, freshRaceReward.xp);
  assert.equal(freshRacePermit[0]?.reward_currency, freshRaceReward.currency);
  assert.equal(freshRacePermit[0]?.reward_tier, freshRaceReward.tier);
  assert.equal(freshRacePermit[0]?.completed_at != null, true);

  const afterFreshRaceCharacter = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  assert.equal(afterFreshRaceCharacter[0]?.level, freshRacePermit[0]?.reward_level);
  assert.equal(afterFreshRaceCharacter[0]?.xp, freshRacePermit[0]?.reward_remaining_xp);
  assert.equal(afterFreshRaceCharacter[0]?.currency,
    beforeFreshRaceCharacter[0].currency + freshRaceReward.currency,
    'concurrent completion must apply currency exactly once');
  assert.equal(afterFreshRaceCharacter[0]?.last_reward_claim_token, freshRacePermit[0]?.reward_claim_token);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id = 'permit-fresh-race:victory'`)[0]?.n, 1);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM defeated_bosses
    WHERE player_id = 'qa-player' AND boss_key = 'tunnel-maw'`)[0]?.n, 1);
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`)[0]?.full_reward_clears, 4,
    'two concurrent requests must reserve only one clear number');
  const afterFreshRaceInventory = sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`);
  const scrapBeforeFreshRace = beforeFreshRaceInventory.find(row =>
    row.item_key === 'underpass-scrap' && row.item_type === 'item')?.quantity ?? 0;
  const scrapAfterFreshRace = afterFreshRaceInventory.find(row =>
    row.item_key === 'underpass-scrap' && row.item_type === 'item')?.quantity ?? 0;
  assert.equal(scrapAfterFreshRace, scrapBeforeFreshRace +
    (freshRaceReward.items.includes('underpass-scrap') ? 1 : 0),
    'concurrent completion must apply inventory once');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM player_inventory
    WHERE player_id = 'qa-player' AND item_key = 'tunnel-trophy' AND item_type = 'furniture'`)[0]?.n, 1);

  const freshRaceReplay = await complete('permit-fresh-race');
  assert.equal(freshRaceReplay.status, 200, JSON.stringify(freshRaceReplay.body));
  assert.deepEqual(freshRaceReplay.body.reward, freshRaceReward);
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), afterFreshRaceCharacter);
  assert.deepEqual(sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`), afterFreshRaceInventory);
  assert.deepEqual(sql(`SELECT reward_state, reward_claim_token, reward_clear_number,
      reward_xp, reward_currency, reward_tier, reward_level, reward_remaining_xp, completed_at
    FROM battle_permits WHERE id = 'permit-fresh-race'`), freshRacePermit);
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`)[0]?.full_reward_clears, 4);

  // A claiming receipt without a lease timestamp is malformed. Fail closed:
  // do not treat NULL as stale, steal the token, reserve a clear, or grant rewards.
  const beforeMissingLeaseTimeCharacter = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  const beforeMissingLeaseTimeInventory = sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`);
  const beforeMissingLeaseTimeClearCount = sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`)[0]?.full_reward_clears ?? 0;
  const missingLeaseTime = await complete('permit-missing-claim-time');
  assert.equal(missingLeaseTime.status, 409, JSON.stringify(missingLeaseTime.body));
  assert.equal(missingLeaseTime.body?.error, 'Battle reward is already being claimed, or the permit expired.');
  assert.equal('reward' in (missingLeaseTime.body ?? {}), false);
  assert.equal('player' in (missingLeaseTime.body ?? {}), false);
  assert.deepEqual(sql(`SELECT reward_state, reward_claim_token, reward_claimed_at,
      reward_clear_number, completed_at
    FROM battle_permits WHERE id = 'permit-missing-claim-time'`), [{
    reward_state: 'claiming',
    reward_claim_token: 'missing-time-token',
    reward_claimed_at: null,
    reward_clear_number: null,
    completed_at: null,
  }], 'NULL lease timestamps must not be interpreted as expired leases');
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), beforeMissingLeaseTimeCharacter);
  assert.deepEqual(sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`), beforeMissingLeaseTimeInventory,
    'malformed lease must not mutate inventory');
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`)[0]?.full_reward_clears ?? 0,
    beforeMissingLeaseTimeClearCount, 'malformed lease must not reserve a reward clear');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id = 'permit-missing-claim-time:victory'`)[0]?.n ?? 0, 0);

  // A non-NULL but malformed lease timestamp is not proof that a claim is
  // stale. In particular, lexical TEXT comparison would treat '0000-not-a-date'
  // as older than today's timestamp and could steal a live/unknown lease.
  const beforeInvalidLeaseTimeCharacter = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  const beforeInvalidLeaseTimeInventory = sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`);
  const beforeInvalidLeaseTimeClearCount = sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`)[0]?.full_reward_clears ?? 0;
  const invalidLeaseTime = await complete('permit-invalid-claim-time');
  assert.equal(invalidLeaseTime.status, 409, JSON.stringify(invalidLeaseTime.body));
  assert.equal(invalidLeaseTime.body?.error, 'Battle reward is already being claimed, or the permit expired.');
  assert.equal('reward' in (invalidLeaseTime.body ?? {}), false);
  assert.equal('player' in (invalidLeaseTime.body ?? {}), false);
  assert.deepEqual(sql(`SELECT reward_state, reward_claim_token, reward_claimed_at,
      reward_clear_number, completed_at
    FROM battle_permits WHERE id = 'permit-invalid-claim-time'`), [{
    reward_state: 'claiming',
    reward_claim_token: 'invalid-time-token',
    reward_claimed_at: '0000-not-a-date',
    reward_clear_number: null,
    completed_at: null,
  }], 'an invalid timestamp must not authorize stale-lease takeover or reserve a clear');
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), beforeInvalidLeaseTimeCharacter);
  assert.deepEqual(sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`), beforeInvalidLeaseTimeInventory);
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`)[0]?.full_reward_clears ?? 0,
    beforeInvalidLeaseTimeClearCount);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id = 'permit-invalid-claim-time:victory'`)[0]?.n ?? 0, 0);

  // An ISO-8601 timestamp can be parseable and older than the lease threshold
  // while still violating the canonical SQLite timestamp representation. Prove
  // the old age predicate alone would call it stale, then ensure the normalized
  // timestamp guard prevents lease theft and every reward-side mutation.
  const nonnormalizedLease = sql(`SELECT reward_claimed_at,
      julianday(reward_claimed_at) < julianday('now', '-60 seconds') AS appears_stale,
      strftime('%Y-%m-%d %H:%M:%S', reward_claimed_at) = reward_claimed_at AS is_normalized
    FROM battle_permits WHERE id = 'permit-nonnormalized-claim-time'`);
  assert.equal(nonnormalizedLease[0]?.appears_stale, 1,
    'the ISO timestamp must be old enough that age-only recovery would accept it');
  assert.equal(nonnormalizedLease[0]?.is_normalized, 0,
    'ISO timestamp representation must not pass the canonical SQLite format guard');
  const beforeNonnormalizedLeaseCharacter = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  const beforeNonnormalizedLeaseInventory = sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`);
  const beforeNonnormalizedLeaseClearCount = sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`)[0]?.full_reward_clears ?? 0;
  const nonnormalizedLeaseResponse = await complete('permit-nonnormalized-claim-time');
  assert.equal(nonnormalizedLeaseResponse.status, 409, JSON.stringify(nonnormalizedLeaseResponse.body));
  assert.equal('reward' in (nonnormalizedLeaseResponse.body ?? {}), false);
  assert.equal('player' in (nonnormalizedLeaseResponse.body ?? {}), false);
  assert.deepEqual(sql(`SELECT reward_state, reward_claim_token, reward_claimed_at,
      reward_clear_number, completed_at
    FROM battle_permits WHERE id = 'permit-nonnormalized-claim-time'`), [{
    reward_state: 'claiming',
    reward_claim_token: 'nonnormalized-time-token',
    reward_claimed_at: nonnormalizedLease[0].reward_claimed_at,
    reward_clear_number: null,
    completed_at: null,
  }], 'a parseable but noncanonical timestamp must not authorize stale-lease takeover');
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), beforeNonnormalizedLeaseCharacter);
  assert.deepEqual(sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`), beforeNonnormalizedLeaseInventory);
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`)[0]?.full_reward_clears ?? 0,
    beforeNonnormalizedLeaseClearCount);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id = 'permit-nonnormalized-claim-time:victory'`)[0]?.n ?? 0, 0);


  // A completed reservation is audit evidence, even if its clear number is inconsistent.
  // The recovery sweep must not erase it merely to unblock a different victory.
  const completedPoisonBefore = sql(`SELECT reward_state, reward_claim_token, reward_claimed_at,
      reward_clear_number, reward_xp, reward_currency, reward_tier, reward_level,
      reward_remaining_xp, completed_at
    FROM battle_permits WHERE id = 'permit-completed-poisoned-reservation'`);
  const completedPoisonCharacterBefore = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  const completedPoisonInventoryBefore = sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`);
  const completedPoisonClearBefore = sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-completed-poison-cycle'`);
  const completedPoisonHistoryBefore = sql(`SELECT id, result, xp_awarded, currency_awarded FROM battle_history
    WHERE id = 'permit-completed-poisoned-reservation:victory'`);
  const blockedByCompletedPoison = await complete('permit-completed-poison-recovery');
  assert.equal(blockedByCompletedPoison.status, 409, JSON.stringify(blockedByCompletedPoison.body));
  assert.equal('reward' in (blockedByCompletedPoison.body ?? {}), false);
  assert.equal('player' in (blockedByCompletedPoison.body ?? {}), false);
  assert.deepEqual(sql(`SELECT reward_state, reward_claim_token, reward_claimed_at,
      reward_clear_number, reward_xp, reward_currency, reward_tier, reward_level,
      reward_remaining_xp, completed_at
    FROM battle_permits WHERE id = 'permit-completed-poisoned-reservation'`), completedPoisonBefore,
    'cleanup must preserve a completed reservation even when its clear number is ahead of the counter');
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), completedPoisonCharacterBefore);
  assert.deepEqual(sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`), completedPoisonInventoryBefore);
  assert.deepEqual(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-completed-poison-cycle'`),
    completedPoisonClearBefore, 'the blocked recovery must not advance the clear counter');
  assert.deepEqual(sql(`SELECT id, result, xp_awarded, currency_awarded FROM battle_history
    WHERE id = 'permit-completed-poisoned-reservation:victory'`), completedPoisonHistoryBefore);
  assert.deepEqual(sql(`SELECT reward_state, reward_clear_number, completed_at FROM battle_permits
    WHERE id = 'permit-completed-poison-recovery'`), [{
      reward_state: 'pending', reward_clear_number: null, completed_at: null,
    }], 'the valid victory must remain retryable without claiming a false clear');

  // A reservation above the committed counter is invalid. If its first cleanup
  // fails transiently, the next valid victory must retry cleanup itself rather
  // than remain blocked until someone separately retries the poisoned permit.
  const poisonCharacterBefore = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  const poisonInventoryBefore = sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`);
  const poisonClearCountBefore = sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-poison-cycle'`)[0]?.full_reward_clears;
  assert.equal(poisonClearCountBefore, 1);
  sql(`CREATE TRIGGER qa_fail_poison_reservation_cleanup
    BEFORE UPDATE OF reward_clear_number ON battle_permits
    WHEN OLD.id = 'permit-poisoned-reservation' AND NEW.reward_clear_number IS NULL
    BEGIN SELECT RAISE(ABORT, 'QA_TRANSIENT_POISON_RESERVATION_CLEANUP_FAILURE'); END`);

  const poisonedReservation = await complete('permit-poisoned-reservation');
  assert.equal(poisonedReservation.status, 409, JSON.stringify(poisonedReservation.body));
  assert.equal('reward' in (poisonedReservation.body ?? {}), false);
  assert.equal('player' in (poisonedReservation.body ?? {}), false);
  const poisonedAfterFailedCleanup = sql(`SELECT reward_state, reward_claim_token, reward_claimed_at,
      reward_clear_number, reward_xp, reward_currency, reward_tier, reward_level,
      reward_remaining_xp, completed_at
    FROM battle_permits WHERE id = 'permit-poisoned-reservation'`)[0];
  assert.equal(poisonedAfterFailedCleanup.reward_state, 'claiming');
  assert.notEqual(poisonedAfterFailedCleanup.reward_claim_token, null);
  assert.equal(poisonedAfterFailedCleanup.reward_clear_number, 999999,
    'failed cleanup must not pretend the invalid reservation was released');
  assert.equal(poisonedAfterFailedCleanup.reward_xp, null);
  assert.equal(poisonedAfterFailedCleanup.reward_currency, null);
  assert.equal(poisonedAfterFailedCleanup.reward_tier, null);
  assert.equal(poisonedAfterFailedCleanup.completed_at, null);
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), poisonCharacterBefore);
  assert.deepEqual(sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`), poisonInventoryBefore);
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-poison-cycle'`)[0]?.full_reward_clears,
    poisonClearCountBefore, 'rejecting an invalid reservation must not advance the cycle counter');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id IN ('permit-poisoned-reservation:victory', 'permit-poison-recovery:victory')`)[0]?.n ?? 0, 0);

  // Simulate the first failed request's lease becoming stale. The valid permit
  // then tries to clean it but hits the same transient D1 failure.
  sql(`UPDATE battle_permits SET reward_claimed_at = datetime('now', '-2 minutes')
    WHERE id = 'permit-poisoned-reservation'`);
  const blockedPoisonRecovery = await complete('permit-poison-recovery');
  assert.equal(blockedPoisonRecovery.status, 500, JSON.stringify(blockedPoisonRecovery.body));
  assert.equal('reward' in (blockedPoisonRecovery.body ?? {}), false);
  assert.equal('player' in (blockedPoisonRecovery.body ?? {}), false);
  assert.deepEqual(sql(`SELECT reward_state, reward_claim_token, reward_claimed_at,
      reward_clear_number, reward_xp, reward_currency, reward_tier, reward_level,
      reward_remaining_xp, completed_at
    FROM battle_permits WHERE id = 'permit-poison-recovery'`), [{
    reward_state: 'pending',
    reward_claim_token: null,
    reward_claimed_at: null,
    reward_clear_number: null,
    reward_xp: null,
    reward_currency: null,
    reward_tier: null,
    reward_level: null,
    reward_remaining_xp: null,
    completed_at: null,
  }], 'failed cleanup must release only the current valid claim and reserve no clear');
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-poison-cycle'`)[0]?.full_reward_clears,
    poisonClearCountBefore);
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), poisonCharacterBefore);
  assert.deepEqual(sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`), poisonInventoryBefore);
  sql('DROP TRIGGER qa_fail_poison_reservation_cleanup');

  // Retrying the valid victory must clean the stale invalid reservation and
  // allocate the next real sequence slot in one D1 batch.
  const poisonRecovery = await complete('permit-poison-recovery');
  assert.equal(poisonRecovery.status, 200, JSON.stringify(poisonRecovery.body));
  assert.equal(poisonRecovery.body.reward.tier, 'full');
  assert.deepEqual(sql(`SELECT reward_state, reward_claim_token, reward_claimed_at,
      reward_clear_number, reward_xp, reward_currency, reward_tier, reward_level,
      reward_remaining_xp, completed_at
    FROM battle_permits WHERE id = 'permit-poisoned-reservation'`), [{
    reward_state: 'pending',
    reward_claim_token: null,
    reward_claimed_at: null,
    reward_clear_number: null,
    reward_xp: null,
    reward_currency: null,
    reward_tier: null,
    reward_level: null,
    reward_remaining_xp: null,
    completed_at: null,
  }], 'valid recovery must release the stale unauditable reservation before allocating');
  assert.deepEqual(sql(`SELECT reward_state, reward_clear_number, reward_xp, reward_currency,
      reward_tier, completed_at FROM battle_permits WHERE id = 'permit-poison-recovery'`), [{
    reward_state: 'awarded',
    reward_clear_number: 2,
    reward_xp: poisonRecovery.body.reward.xp,
    reward_currency: poisonRecovery.body.reward.currency,
    reward_tier: 'full',
    completed_at: sql(`SELECT completed_at FROM battle_permits WHERE id = 'permit-poison-recovery'`)[0]?.completed_at,
  }]);
  assert.ok(sql(`SELECT completed_at FROM battle_permits WHERE id = 'permit-poison-recovery'`)[0]?.completed_at);
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-poison-cycle'`)[0]?.full_reward_clears, 2);
  const poisonRecoveryCharacter = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  const poisonRecoveryInventory = sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`);
  const poisonRecoveryReplay = await complete('permit-poison-recovery');
  assert.equal(poisonRecoveryReplay.status, 200, JSON.stringify(poisonRecoveryReplay.body));
  assert.deepEqual(poisonRecoveryReplay.body.reward, poisonRecovery.body.reward);
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), poisonRecoveryCharacter,
    'retry after stale-reservation cleanup must not double-apply progression');
  assert.deepEqual(sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`), poisonRecoveryInventory,
    'retry after stale-reservation cleanup must not double-apply inventory');
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-poison-cycle'`)[0]?.full_reward_clears, 2);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id = 'permit-poison-recovery:victory'`)[0]?.n ?? 0, 1);

  // The original victory remains recoverable, but its invalid old sequence is
  // never reused. It receives the next audited slot only after the cleanup.
  const poisonedVictoryRecovery = await complete('permit-poisoned-reservation');
  assert.equal(poisonedVictoryRecovery.status, 200, JSON.stringify(poisonedVictoryRecovery.body));
  assert.equal(sql(`SELECT reward_clear_number FROM battle_permits
    WHERE id = 'permit-poisoned-reservation'`)[0]?.reward_clear_number, 3);
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-poison-cycle'`)[0]?.full_reward_clears, 3);
  const poisonedVictoryCharacter = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  const poisonedVictoryInventory = sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`);
  const poisonedVictoryReplay = await complete('permit-poisoned-reservation');
  assert.equal(poisonedVictoryReplay.status, 200, JSON.stringify(poisonedVictoryReplay.body));
  assert.deepEqual(poisonedVictoryReplay.body.reward, poisonedVictoryRecovery.body.reward);
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), poisonedVictoryCharacter);
  assert.deepEqual(sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`), poisonedVictoryInventory);
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-poison-cycle'`)[0]?.full_reward_clears, 3);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id IN ('permit-poisoned-reservation:victory', 'permit-poison-recovery:victory')`)[0]?.n, 2);

  // Failure while reserving a clear slot must roll back that reservation batch,
  // release only this claim, and allow a retry without losing the valid victory.
  const beforeReservationFailureCharacter = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  const beforeReservationFailureInventory = sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-reservation-cycle'`)[0]?.n ?? 0, 0);
  sql(`CREATE TRIGGER qa_fail_clear_reservation BEFORE INSERT ON world_event_clears
    WHEN NEW.player_id = 'qa-player' AND NEW.event_key = 'underpass'
      AND NEW.cycle_id = 'qa-reservation-cycle'
    BEGIN SELECT RAISE(ABORT, 'QA_TRANSIENT_CLEAR_RESERVATION_FAILURE'); END`);
  const reservationFailure = await complete('permit-reservation-recovery');
  assert.equal(reservationFailure.status, 500, JSON.stringify(reservationFailure.body));
  await stop();
  assert.deepEqual(sql(`SELECT reward_state, reward_claim_token, reward_claimed_at,
      reward_clear_number, completed_at
    FROM battle_permits WHERE id = 'permit-reservation-recovery'`), [{
    reward_state: 'pending',
    reward_claim_token: null,
    reward_claimed_at: null,
    reward_clear_number: null,
    completed_at: null,
  }], 'failed clear reservation must release the lease and retain no partial receipt');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-reservation-cycle'`)[0]?.n ?? 0, 0,
    'failed reservation batch must not leave a clear counter');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id = 'permit-reservation-recovery:victory'`)[0]?.n ?? 0, 0);
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), beforeReservationFailureCharacter);
  assert.deepEqual(sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`), beforeReservationFailureInventory);
  sql('DROP TRIGGER qa_fail_clear_reservation');
  await start();
  const reservationRecovered = await complete('permit-reservation-recovery');
  assert.equal(reservationRecovered.status, 200, JSON.stringify(reservationRecovered.body));
  const reservationReward = reservationRecovered.body.reward;
  assert.equal(reservationReward.tier, 'full');
  const reservationPermitAfter = sql(`SELECT reward_state, reward_clear_number,
      reward_xp, reward_currency, reward_tier, completed_at
    FROM battle_permits WHERE id = 'permit-reservation-recovery'`);
  assert.equal(reservationPermitAfter[0]?.reward_state, 'awarded');
  assert.equal(reservationPermitAfter[0]?.reward_clear_number, 1);
  assert.equal(reservationPermitAfter[0]?.reward_xp, reservationReward.xp);
  assert.equal(reservationPermitAfter[0]?.reward_currency, reservationReward.currency);
  assert.equal(reservationPermitAfter[0]?.reward_tier, 'full');
  assert.ok(reservationPermitAfter[0]?.completed_at);
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-reservation-cycle'`)[0]?.full_reward_clears, 1);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id = 'permit-reservation-recovery:victory'`)[0]?.n ?? 0, 1);
  const reservationCharacterAfter = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  assert.equal(reservationCharacterAfter[0]?.currency,
    beforeReservationFailureCharacter[0].currency + reservationReward.currency);
  const reservationInventoryAfter = sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`);
  const reservationReplay = await complete('permit-reservation-recovery');
  assert.equal(reservationReplay.status, 200, JSON.stringify(reservationReplay.body));
  assert.deepEqual(reservationReplay.body.reward, reservationReward);
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), reservationCharacterAfter,
    'retry after recovered clear reservation must not double-apply progression');
  assert.deepEqual(sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`), reservationInventoryAfter,
    'retry after recovered clear reservation must not double-apply inventory');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id = 'permit-reservation-recovery:victory'`)[0]?.n ?? 0, 1);
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-reservation-cycle'`)[0]?.full_reward_clears, 1);
  await stop();

  // If settlement fails and the token-scoped lease release also fails, the
  // valid victory must remain recoverable after the normal stale-lease threshold.
  const beforeCleanupFailureCharacter = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  const beforeCleanupFailureInventory = sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`);
  sql(`CREATE TRIGGER qa_fail_cleanup_award BEFORE INSERT ON battle_history
    WHEN NEW.id = 'permit-cleanup-failure:victory'
    BEGIN SELECT RAISE(ABORT, 'QA_TRANSIENT_CLEANUP_AWARD_FAILURE'); END`);
  sql(`CREATE TRIGGER qa_fail_cleanup_release BEFORE UPDATE ON battle_permits
    WHEN OLD.id = 'permit-cleanup-failure' AND OLD.reward_state = 'claiming'
      AND NEW.reward_state = 'pending'
    BEGIN SELECT RAISE(ABORT, 'QA_TRANSIENT_CLEANUP_RELEASE_FAILURE'); END`);
  await start();
  const cleanupFailure = await complete('permit-cleanup-failure');
  assert.equal(cleanupFailure.status, 500, JSON.stringify(cleanupFailure.body));
  await stop();

  const stuckClaim = sql(`SELECT reward_state, reward_claim_token, reward_claimed_at,
      reward_clear_number, completed_at
    FROM battle_permits WHERE id = 'permit-cleanup-failure'`);
  assert.equal(stuckClaim[0]?.reward_state, 'claiming');
  assert.ok(stuckClaim[0]?.reward_claim_token, 'failed cleanup must not pretend the lease was released');
  assert.ok(stuckClaim[0]?.reward_claimed_at);
  assert.equal(stuckClaim[0]?.reward_clear_number, 1,
    'the reserved clear number survives an ambiguous settlement failure');
  assert.equal(stuckClaim[0]?.completed_at, null);
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cleanup-cycle'`)[0]?.full_reward_clears, 1);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id = 'permit-cleanup-failure:victory'`)[0]?.n ?? 0, 0,
    'the failed atomic award must not leave a victory receipt');
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), beforeCleanupFailureCharacter,
    'failed settlement and failed cleanup must not partially award progression');
  assert.deepEqual(sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`), beforeCleanupFailureInventory,
    'failed settlement and failed cleanup must not partially award inventory');

  // Simulate the abandoned worker lease aging past 60 seconds, then retry.
  sql(`UPDATE battle_permits SET reward_claimed_at = datetime('now', '-2 minutes')
    WHERE id = 'permit-cleanup-failure' AND reward_state = 'claiming'`);
  sql('DROP TRIGGER qa_fail_cleanup_award');
  sql('DROP TRIGGER qa_fail_cleanup_release');
  await start();
  const cleanupRecovered = await complete('permit-cleanup-failure');
  assert.equal(cleanupRecovered.status, 200, JSON.stringify(cleanupRecovered.body));
  const cleanupReward = cleanupRecovered.body.reward;
  assert.equal(cleanupReward.tier, 'full');
  const cleanupPermitAfter = sql(`SELECT reward_state, reward_claim_token, reward_clear_number,
      reward_xp, reward_currency, reward_tier, reward_level, reward_remaining_xp, completed_at
    FROM battle_permits WHERE id = 'permit-cleanup-failure'`);
  assert.equal(cleanupPermitAfter[0]?.reward_state, 'awarded');
  assert.notEqual(cleanupPermitAfter[0]?.reward_claim_token, stuckClaim[0]?.reward_claim_token,
    'stale recovery must replace the token whose cleanup failed');
  assert.equal(cleanupPermitAfter[0]?.reward_clear_number, 1,
    'recovery must reuse the original clear number, not reserve another');
  assert.equal(cleanupPermitAfter[0]?.reward_xp, cleanupReward.xp);
  assert.equal(cleanupPermitAfter[0]?.reward_currency, cleanupReward.currency);
  assert.equal(cleanupPermitAfter[0]?.reward_tier, 'full');
  assert.ok(cleanupPermitAfter[0]?.completed_at);
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cleanup-cycle'`)[0]?.full_reward_clears, 1);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id = 'permit-cleanup-failure:victory'`)[0]?.n ?? 0, 1);
  const cleanupCharacterAfter = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  assert.equal(cleanupCharacterAfter[0]?.currency,
    beforeCleanupFailureCharacter[0].currency + cleanupReward.currency);
  assert.equal(cleanupCharacterAfter[0]?.last_reward_claim_token, cleanupPermitAfter[0]?.reward_claim_token);
  const cleanupInventoryAfter = sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`);
  const scrapBeforeCleanup = beforeCleanupFailureInventory.find(row =>
    row.item_key === 'underpass-scrap' && row.item_type === 'item')?.quantity ?? 0;
  const scrapAfterCleanup = cleanupInventoryAfter.find(row =>
    row.item_key === 'underpass-scrap' && row.item_type === 'item')?.quantity ?? 0;
  assert.equal(scrapAfterCleanup, scrapBeforeCleanup + 1,
    'recovery must apply the full-tier scrap reward exactly once');

  const cleanupReplay = await complete('permit-cleanup-failure');
  assert.equal(cleanupReplay.status, 200, JSON.stringify(cleanupReplay.body));
  assert.deepEqual(cleanupReplay.body.reward, cleanupReward);
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), cleanupCharacterAfter);
  assert.deepEqual(sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`), cleanupInventoryAfter);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id = 'permit-cleanup-failure:victory'`)[0]?.n ?? 0, 1);
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cleanup-cycle'`)[0]?.full_reward_clears, 1);
  await stop();

  // Repeat the transient-failure recovery against a valid pre-Mana victory.
  // Its persisted Mana must remain NULL, the already-expired permit must remain
  // reward-eligible, and its pre-existing clear counter makes this a reduced-tier
  // award. This combines legacy-state compatibility with the failure-retry path.
  sql(`CREATE TRIGGER qa_fail_legacy_victory_receipt BEFORE INSERT ON battle_history
    WHEN NEW.id = 'permit-legacy-recovery:victory'
    BEGIN SELECT RAISE(ABORT, 'QA_TRANSIENT_LEGACY_REWARD_FAILURE'); END`);
  await start();
  const legacyFailed = await complete('permit-legacy-recovery');
  assert.equal(legacyFailed.status, 500, 'legacy terminal reward failure must be surfaced');
  await stop();

  assert.deepEqual(sql(`SELECT player_mana, reward_state, reward_claim_token, reward_claimed_at,
      reward_clear_number, completed_at
    FROM battle_permits WHERE id = 'permit-legacy-recovery'`), [{
    player_mana: null,
    reward_state: 'pending',
    reward_claim_token: null,
    reward_claimed_at: null,
    reward_clear_number: 4,
    completed_at: null,
  }], 'failed legacy settlement must release its claim without inventing Mana or losing the reserved slot');
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-legacy-cycle'`)[0]?.full_reward_clears, 4);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id = 'permit-legacy-recovery:victory'`)[0]?.n, 0);
  const legacyCharacterBefore = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);

  sql('DROP TRIGGER qa_fail_legacy_victory_receipt');
  await start();
  const legacyRecovered = await complete('permit-legacy-recovery');
  assert.equal(legacyRecovered.status, 200, JSON.stringify(legacyRecovered.body));
  assert.equal(legacyRecovered.body?.reward?.tier, 'reduced');
  const legacyReward = legacyRecovered.body.reward;
  const legacyPermitAfterAward = sql(`SELECT player_mana, reward_state, reward_clear_number,
      reward_xp, reward_currency, reward_tier, completed_at
    FROM battle_permits WHERE id = 'permit-legacy-recovery'`);
  assert.equal(legacyPermitAfterAward[0]?.player_mana, null,
    'legacy recovery must not persist a fabricated Mana value');
  assert.equal(legacyPermitAfterAward[0]?.reward_state, 'awarded');
  assert.equal(legacyPermitAfterAward[0]?.reward_clear_number, 4);
  assert.equal(legacyPermitAfterAward[0]?.reward_xp, legacyReward.xp);
  assert.equal(legacyPermitAfterAward[0]?.reward_currency, legacyReward.currency);
  assert.equal(legacyPermitAfterAward[0]?.reward_tier, 'reduced');
  assert.ok(legacyPermitAfterAward[0]?.completed_at);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id = 'permit-legacy-recovery:victory'`)[0]?.n, 1);
  const legacyCharacterAfterAward = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  assert.notDeepEqual(legacyCharacterAfterAward, legacyCharacterBefore,
    'successful retry must grant the previously withheld reward');

  const legacyDuplicate = await complete('permit-legacy-recovery');
  assert.equal(legacyDuplicate.status, 200, JSON.stringify(legacyDuplicate.body));
  assert.deepEqual(legacyDuplicate.body.reward, legacyReward);
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), legacyCharacterAfterAward,
    'legacy duplicate completion must not grant progression twice');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id = 'permit-legacy-recovery:victory'`)[0]?.n, 1);
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-legacy-cycle'`)[0]?.full_reward_clears, 4);

  // Completion must never manufacture a victory from permit possession. First
  // prove an active encounter cannot reserve a clear or mutate progression.
  const beforeActionRaceCharacter = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  const beforeActionRaceInventory = sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`);
  const beforeActionRace = sql(`SELECT player_hp, player_mana, enemy_hp, battle_status, turn_count,
      reward_state, reward_clear_number FROM battle_permits WHERE id = 'permit-action-complete-race'`);
  assert.deepEqual(beforeActionRace, [{
    player_hp: 90, player_mana: 12, enemy_hp: 1, battle_status: 'active', turn_count: 0,
    reward_state: 'pending', reward_clear_number: null,
  }]);
  const prematureCompletion = await complete('permit-action-complete-race');
  assert.equal(prematureCompletion.status, 409);
  assert.equal('reward' in (prematureCompletion.body ?? {}), false);
  assert.deepEqual(sql(`SELECT player_hp, player_mana, enemy_hp, battle_status, turn_count,
      reward_state, reward_clear_number FROM battle_permits WHERE id = 'permit-action-complete-race'`), beforeActionRace);
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), beforeActionRaceCharacter);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id = 'permit-action-complete-race:victory'`)[0]?.n, 0);
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-action-race-cycle'`)[0]?.full_reward_clears ?? 0, 0);

  // Race the actual killing action against completion. Either completion sees
  // the still-active battle and conflicts, or it sees the committed victory and
  // settles it. In both cases, the retry must converge on exactly one receipt.
  const [actionRace, completionRace] = await Promise.all([
    act('permit-action-complete-race', 'slash', 0),
    complete('permit-action-complete-race'),
  ]);
  assert.equal(actionRace.status, 200, JSON.stringify(actionRace.body));
  assert.equal(actionRace.body?.status, 'victory');
  assert.equal(actionRace.body?.playerHp, 90, 'a killing blow does not trigger a monster retaliation');
  assert.equal(actionRace.body?.playerMana, 12, 'zero-cost Slash does not consume Mana');
  assert.equal(actionRace.body?.enemyHp, 0);
  assert.equal(actionRace.body?.turnCount, 1);
  assert.ok(completionRace.status === 200 || completionRace.status === 409,
    JSON.stringify(completionRace));
  if (completionRace.status === 200) assert.ok(completionRace.body?.reward);
  else assert.equal('reward' in (completionRace.body ?? {}), false);

  const actionRaceRetry = await complete('permit-action-complete-race');
  assert.equal(actionRaceRetry.status, 200, JSON.stringify(actionRaceRetry.body));
  const actionRaceReward = actionRaceRetry.body.reward;
  assert.ok(actionRaceReward);
  assert.equal(actionRaceReward.tier, 'full');
  const actionRacePermit = sql(`SELECT player_hp, player_mana, enemy_hp, battle_status, turn_count,
      reward_state, reward_clear_number, reward_xp, reward_currency, reward_tier, completed_at
    FROM battle_permits WHERE id = 'permit-action-complete-race'`);
  assert.deepEqual(actionRacePermit, [{
    player_hp: 90, player_mana: 12, enemy_hp: 0, battle_status: 'victory', turn_count: 1,
    reward_state: 'awarded', reward_clear_number: 1, reward_xp: actionRaceReward.xp,
    reward_currency: actionRaceReward.currency, reward_tier: 'full',
    completed_at: actionRacePermit[0]?.completed_at,
  }]);
  assert.ok(actionRacePermit[0]?.completed_at);
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-action-race-cycle'`)[0]?.full_reward_clears, 1);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id = 'permit-action-complete-race:victory'`)[0]?.n, 1);
  const afterActionRaceCharacter = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  assert.equal(afterActionRaceCharacter[0]?.currency,
    beforeActionRaceCharacter[0].currency + actionRaceReward.currency);
  const afterActionRaceInventory = sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`);
  const scrapBeforeActionRace = beforeActionRaceInventory.find(row => row.item_key === 'underpass-scrap' && row.item_type === 'item')?.quantity ?? 0;
  const scrapAfterActionRace = afterActionRaceInventory.find(row => row.item_key === 'underpass-scrap' && row.item_type === 'item')?.quantity ?? 0;
  assert.equal(scrapAfterActionRace, scrapBeforeActionRace + 1,
    'the action/completion race applies one scrap reward');
  assert.equal(afterActionRaceInventory.filter(row => row.item_key === 'tunnel-trophy' && row.item_type === 'furniture').length, 1,
    'the full-clear trophy remains unique');
  const replayAction = await act('permit-action-complete-race', 'slash', 0);
  assert.equal(replayAction.status, 409, 'a replayed action cannot apply damage or advance the terminal turn');
  assert.deepEqual(sql(`SELECT player_hp, player_mana, enemy_hp, battle_status, turn_count
    FROM battle_permits WHERE id = 'permit-action-complete-race'`), [{
    player_hp: 90, player_mana: 12, enemy_hp: 0, battle_status: 'victory', turn_count: 1,
  }]);
  const actionRaceReplay = await complete('permit-action-complete-race');
  assert.equal(actionRaceReplay.status, 200);
  assert.deepEqual(actionRaceReplay.body.reward, actionRaceReward);
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), afterActionRaceCharacter);
  assert.deepEqual(sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`), afterActionRaceInventory);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id = 'permit-action-complete-race:victory'`)[0]?.n, 1);
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-action-race-cycle'`)[0]?.full_reward_clears, 1);

  // The reservation cleanup sweep must not reclaim an ahead-of-counter slot
  // when its lease timestamp is malformed/noncanonical, even if it is parseable
  // and old enough by SQLite's age predicate.
  const malformedCleanupLease = sql(`SELECT reward_claimed_at,
      julianday(reward_claimed_at) < julianday('now', '-60 seconds') AS appears_stale,
      strftime('%Y-%m-%d %H:%M:%S', reward_claimed_at) = reward_claimed_at AS is_normalized
    FROM battle_permits WHERE id = 'permit-malformed-reservation'`)[0];
  assert.equal(malformedCleanupLease?.appears_stale, 1);
  assert.equal(malformedCleanupLease?.is_normalized, 0);
  const malformedCleanupCharacterBefore = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  const malformedCleanupInventoryBefore = sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`);
  const malformedCleanupCounterBefore = sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-malformed-cleanup-cycle'`)[0]?.full_reward_clears;
  const malformedCleanupBlocked = await complete('permit-malformed-reservation-recovery');
  assert.equal(malformedCleanupBlocked.status, 409, JSON.stringify(malformedCleanupBlocked.body));
  assert.equal('reward' in (malformedCleanupBlocked.body ?? {}), false);
  assert.equal('player' in (malformedCleanupBlocked.body ?? {}), false);
  assert.deepEqual(sql(`SELECT reward_state, reward_claim_token, reward_claimed_at, reward_clear_number,
      reward_xp, reward_currency, reward_tier, reward_level, reward_remaining_xp, completed_at
    FROM battle_permits WHERE id = 'permit-malformed-reservation'`), [{
    reward_state: 'claiming',
    reward_claim_token: 'malformed-reservation-token',
    reward_claimed_at: malformedCleanupLease.reward_claimed_at,
    reward_clear_number: 999999,
    reward_xp: null,
    reward_currency: null,
    reward_tier: null,
    reward_level: null,
    reward_remaining_xp: null,
    completed_at: null,
  }], 'malformed lease evidence must not be cleared by the recovery sweep');
  assert.deepEqual(sql(`SELECT reward_state, reward_claim_token, reward_claimed_at, reward_clear_number,
      reward_xp, reward_currency, reward_tier, reward_level, reward_remaining_xp, completed_at
    FROM battle_permits WHERE id = 'permit-malformed-reservation-recovery'`), [{
    reward_state: 'pending',
    reward_claim_token: null,
    reward_claimed_at: null,
    reward_clear_number: null,
    reward_xp: null,
    reward_currency: null,
    reward_tier: null,
    reward_level: null,
    reward_remaining_xp: null,
    completed_at: null,
  }], 'the valid claim must release its own lease without reserving an unsafe sequence');
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), malformedCleanupCharacterBefore);
  assert.deepEqual(sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`), malformedCleanupInventoryBefore);
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-malformed-cleanup-cycle'`)[0]?.full_reward_clears,
    malformedCleanupCounterBefore);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id IN ('permit-malformed-reservation:victory', 'permit-malformed-reservation-recovery:victory')`)[0]?.n ?? 0, 0);

  // Once an operator/data repair restores the canonical stale-lease timestamp,
  // the same valid victory can recover sequence 2 without duplicating rewards.
  sql(`UPDATE battle_permits SET reward_claimed_at = datetime('now', '-2 minutes')
    WHERE id = 'permit-malformed-reservation'`);
  const malformedCleanupRecovered = await complete('permit-malformed-reservation-recovery');
  assert.equal(malformedCleanupRecovered.status, 200, JSON.stringify(malformedCleanupRecovered.body));
  const malformedCleanupReward = malformedCleanupRecovered.body.reward;
  assert.equal(malformedCleanupReward.tier, 'full');
  const malformedCleanupCharacterAfter = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  const malformedCleanupInventoryAfter = sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`);
  assert.deepEqual(sql(`SELECT reward_state, reward_claim_token, reward_claimed_at, reward_clear_number,
      reward_xp, reward_currency, reward_tier, reward_level, reward_remaining_xp, completed_at
    FROM battle_permits WHERE id = 'permit-malformed-reservation'`), [{
    reward_state: 'pending',
    reward_claim_token: null,
    reward_claimed_at: null,
    reward_clear_number: null,
    reward_xp: null,
    reward_currency: null,
    reward_tier: null,
    reward_level: null,
    reward_remaining_xp: null,
    completed_at: null,
  }]);
  const malformedCleanupAwardedPermit = sql(`SELECT reward_state, reward_clear_number, reward_xp,
      reward_currency, reward_tier, reward_level, reward_remaining_xp, completed_at
    FROM battle_permits WHERE id = 'permit-malformed-reservation-recovery'`)[0];
  assert.equal(malformedCleanupAwardedPermit?.reward_state, 'awarded');
  assert.equal(malformedCleanupAwardedPermit?.reward_clear_number, 2);
  assert.equal(malformedCleanupAwardedPermit?.reward_xp, malformedCleanupReward.xp);
  assert.equal(malformedCleanupAwardedPermit?.reward_currency, malformedCleanupReward.currency);
  assert.equal(malformedCleanupAwardedPermit?.reward_tier, 'full');
  assert.equal(malformedCleanupAwardedPermit?.reward_level, malformedCleanupCharacterAfter[0]?.level);
  assert.equal(malformedCleanupAwardedPermit?.reward_remaining_xp, malformedCleanupCharacterAfter[0]?.xp);
  assert.ok(malformedCleanupAwardedPermit?.completed_at);
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-malformed-cleanup-cycle'`)[0]?.full_reward_clears, 2);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id IN ('permit-malformed-reservation:victory', 'permit-malformed-reservation-recovery:victory')`)[0]?.n ?? 0, 1);
  const malformedCleanupReplay = await complete('permit-malformed-reservation-recovery');
  assert.equal(malformedCleanupReplay.status, 200, JSON.stringify(malformedCleanupReplay.body));
  assert.deepEqual(malformedCleanupReplay.body.reward, malformedCleanupReward);
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), malformedCleanupCharacterAfter);
  assert.deepEqual(sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`), malformedCleanupInventoryAfter);
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-malformed-cleanup-cycle'`)[0]?.full_reward_clears, 2);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id IN ('permit-malformed-reservation:victory', 'permit-malformed-reservation-recovery:victory')`)[0]?.n ?? 0, 1);

  await stop();

  console.log('PASS local Worker/D1 reward recovery, conflicting victory history marker rejection, stale/fresh claim races, premature completion rejection, action/completion concurrency, terminal action replay rejection, and exactly-once rewards');
} finally {
  await stop();
  rmSync(scratch, { recursive: true, force: true });
}
