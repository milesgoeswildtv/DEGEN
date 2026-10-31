// Isolated local Worker/D1 integration test; never connects to production.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const wrangler = resolve(root, 'node_modules/.bin/wrangler');
const scratch = mkdtempSync(join(tmpdir(), 'degen-worker-d1-'));
const persist = join(scratch, 'state');
const base = 'http://127.0.0.1:8789';
const env = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' };
let server;
let logs = '';
function cli(args) {
  const r = spawnSync(wrangler, args, { cwd: root, env, encoding: 'utf8', timeout: 120000 });
  if (r.error || r.status !== 0) throw new Error(`wrangler ${args.join(' ')}: ${r.error ?? ''} ${r.stdout} ${r.stderr}`);
}
async function complete(permitId, playerId = 'integration-player', extraFields = {}) {
  let r;
  try {
    r = await fetch(base + '/api/battle/complete', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...extraFields, playerId, permitId }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(`Battle completion request ${permitId} failed or timed out: ${String(error)}`);
  }
  assert.equal(r.headers.get('cache-control'), 'no-store',
    '/api/battle/complete success and error responses must not be cached');
  return { status: r.status, data: await r.json() };
}
async function eventuallyComplete(id, extraFields = {}, playerId = 'integration-player') {
  for (let n = 0; n < 10; n++) {
    const r = await complete(id, playerId, extraFields);
    if (r.status === 200) return r.data;
    if (r.status !== 409 && r.status !== 500) throw new Error(id + ': ' + JSON.stringify(r));
    await sleep(100 + 50 * n);
  }
  throw new Error('Reward retry exhausted for ' + id);
}
const queryBusyRetryDelaysMs = [50, 100, 200, 400, 800];
const queryBusyWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

function queryRows(query) {
  const statement = query.trim();
  // This helper retries only read-only assertions. Reject DML and multiple
  // statements before Wrangler runs so an ambiguous result can never replay a write.
  assert.match(statement, /^SELECT\b/i, 'queryRows only accepts read-only SELECT statements');
  assert.doesNotMatch(statement.replace(/;\s*$/, ''), /;/,
    'queryRows only accepts one SELECT statement');
  let r;
  for (let attempt = 0; attempt <= queryBusyRetryDelaysMs.length; attempt += 1) {
    r = spawnSync(wrangler, ['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist,
      '--command=' + query, '--json'], { cwd: root, env, encoding: 'utf8', timeout: 120000 });
    if (r.status === 0) break;

    const details = [r.stderr, r.stdout, r.error?.message].filter(Boolean).join('\n');
    const transientSqliteLock = /SQLITE_BUSY|database is locked/i.test(details);
    if (!transientSqliteLock || attempt === queryBusyRetryDelaysMs.length) {
      assert.equal(r.status, 0, 'local D1 query failed: ' + details);
    }

    // A completed Worker request can briefly leave the local SQLite file busy
    // while workerd releases its connection. Retry read-only assertions only;
    // never replay a D1 mutation after an ambiguous result.
    Atomics.wait(queryBusyWaitBuffer, 0, 0, queryBusyRetryDelaysMs[attempt]);
  }

  const result = JSON.parse(r.stdout);
  return Array.isArray(result) ? (result[0]?.results ?? []) : (result.results ?? []);
}
assert.throws(
  () => queryRows("UPDATE battle_permits SET player_hp = 1 WHERE id = 'must-not-run'"),
  /queryRows only accepts read-only SELECT statements/,
);
assert.throws(
  () => queryRows("SELECT 1; DELETE FROM battle_permits"),
  /queryRows only accepts one SELECT statement/,
);
function countRows(query) {
  return queryRows(query)[0]?.n;
}
function expectInventoryGuardFailure(query) {
  const r = spawnSync(wrangler, ['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist,
    '--command=' + query, '--json'], { cwd: root, env, encoding: 'utf8', timeout: 120000 });
  assert.notEqual(r.status, 0, 'inventory quantity guard must reject: ' + query);
  assert.match(`${r.stdout}\n${r.stderr}`, /player_inventory\.quantity must be a positive safe integer/i);
}
function assertPersistedPermitState(permitId, state) {
  const query = `SELECT COUNT(*) AS n FROM battle_permits WHERE id = '${permitId}'
    AND completed_at IS NULL AND battle_status = '${state.status}'
    AND player_hp = ${state.playerHp} AND player_mana = ${state.playerMana}
    AND enemy_hp = ${state.enemyHp} AND turn_count = ${state.turnCount}`;
  assert.equal(countRows(query), 1, `persisted Worker state must match the authoritative snapshot for ${permitId}`);
}

async function assertInvalidActionState(permitId, state) {
  const response = await fetch(base + '/api/battle/action', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: 'integration-player', permitId, abilityId: 'slash', expectedTurnCount: 0 }),
  });
  const data = await response.json();
  assert.equal(response.status, 409, `${permitId} must fail closed`);
  assert.equal(data.error, 'Battle state is invalid.');
  assert.equal('battleState' in data, false, 'invalid persisted state must not be echoed as authoritative');
  assertPersistedPermitState(permitId, state);
}

async function assertUnsupportedActionPermit(permitId, state) {
  const response = await fetch(base + '/api/battle/action', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: 'integration-player', permitId, abilityId: 'slash', expectedTurnCount: 0 }),
  });
  const data = await response.json();
  assert.equal(response.status, 409, `${permitId} must reject an unsupported event or cycle`);
  assert.equal(data.error, 'Unsupported battle permit.');
  assert.equal('battleState' in data, false, 'unsupported permits must not expose a combat snapshot');
  assertPersistedPermitState(permitId, state);
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id IN ('${permitId}:victory', '${permitId}:defeat')`), 0,
    'an unsupported permit must not record combat history');
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits WHERE id = '${permitId}'
    AND reward_state = 'pending' AND reward_clear_number IS NULL AND completed_at IS NULL`), 1,
    'an unsupported permit must not reserve or claim a reward');
}
try {
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist, '--file=db/schema.sql']);
  cli(['d1', 'migrations', 'apply', 'DEGEN', '--local', '--persist-to=' + persist]);
  const seed = join(scratch, 'seed.sql');
  writeFileSync(seed, `
    INSERT INTO players(id,display_name) VALUES
      ('integration-player','Integration'),
      ('start-race-player','Concurrent Start QA'),
      ('start-distinct-key-player','Concurrent Distinct-Key Start QA'),
      ('start-collision-a','Start ID Collision A'),
      ('start-collision-b','Start ID Collision B'),
      ('start-replay-player','Start Replay After Closure QA'),
      ('restart-after-victory-player','Restart After Victory QA'),
      ('event-closure-player','Event Closure QA'),
      ('closure-active-player','Closure Active QA'),
      ('expired-after-cycle-player','Expired After Cycle QA'),
      ('closed-cycle-entry-player','Closed Cycle Entry QA'),
      ('out-of-cycle-award-player','Out-of-cycle award QA'),
      ('malformed-start-player','Malformed Start QA'),
      ('malformed-expiry-player','Malformed Expiry QA'),
      ('malformed-cycle-player','Malformed Cycle QA'),
      ('open-boundary-player','Open Boundary QA'),
      ('future-start-player','Future Start QA'),
      ('future-terminal-player','Future Terminal Recovery QA'),
      ('xp-boundary-player','XP Boundary'),
      ('invalid-progression-player','Invalid Progression'),
      ('post-award-overflow-player','Post-award Overflow'),
      ('currency-overflow-player','Currency Overflow'),
      ('inventory-cap-player','Inventory Cap'),
      ('inventory-atomic-player','Inventory Atomicity'),
      ('inventory-race-player','Inventory Race'),
      ('inventory-oversized-player','Oversized Inventory'),
      ('paid-killing-race-player','Paid Mana Race QA');
    INSERT INTO characters(player_id,level,xp,currency,degen_key)
      VALUES
        ('integration-player',1,0,0,'test-degen'),
        ('start-race-player',1,0,0,'test-degen'),
        ('start-distinct-key-player',1,0,0,'test-degen'),
        ('start-collision-a',1,0,0,'test-degen'),
        ('start-collision-b',1,0,0,'test-degen'),
        ('start-replay-player',1,0,0,'test-degen'),
        ('restart-after-victory-player',1,0,0,'test-degen'),
        ('event-closure-player',1,0,0,'test-degen'),
        ('closure-active-player',1,0,0,'test-degen'),
        ('expired-after-cycle-player',1,0,0,'test-degen'),
        ('closed-cycle-entry-player',1,0,0,'test-degen'),
        ('out-of-cycle-award-player',1,0,0,'test-degen'),
        ('malformed-start-player',1,0,0,'test-degen'),
        ('malformed-expiry-player',1,0,0,'test-degen'),
        ('malformed-cycle-player',1,0,0,'test-degen'),
        ('open-boundary-player',1,0,0,'test-degen'),
        ('future-start-player',1,0,0,'test-degen'),
        ('future-terminal-player',1,0,0,'test-degen'),
        ('xp-boundary-player',2,174,30,'test-degen'),
        ('invalid-progression-player',120095990063214,0,0,'test-degen'),
        ('post-award-overflow-player',120095990063212,9007199254740924,0,'test-degen'),
        ('currency-overflow-player',2,0,9007199254740971,'test-degen'),
        ('inventory-cap-player',1,0,0,'test-degen'),
        ('inventory-atomic-player',1,0,0,'test-degen'),
        ('inventory-race-player',1,0,0,'test-degen'),
        ('inventory-oversized-player',1,0,0,'test-degen'),
        ('paid-killing-race-player',1,0,0,'test-degen');
    INSERT INTO player_inventory(id,player_id,item_key,item_type,quantity)
      VALUES
        ('inventory-cap-player:item:underpass-scrap','inventory-cap-player','underpass-scrap','item',10000),
        ('inventory-atomic-player:item:underpass-scrap','inventory-atomic-player','underpass-scrap','item',1),
        ('inventory-race-player:item:underpass-scrap','inventory-race-player','underpass-scrap','item',9999),
        ('inventory-oversized-player:item:bulk','inventory-oversized-player','bulk','item',10001);
    INSERT INTO world_event_cycles(id,event_key,opens_at,closes_at)
      VALUES
        ('integration-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+90 minutes')),
        ('paid-killing-race-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+90 minutes')),
        ('closed-after-entry-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+90 minutes')),
        ('start-before-open-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+90 minutes')),
        ('start-at-open-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+90 minutes')),
        ('future-start-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+90 minutes')),
        ('start-after-close-cycle','underpass',datetime('now','-20 minutes'),datetime('now','-10 minutes')),
        ('malformed-start-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+90 minutes')),
        ('malformed-open-cycle','underpass','not-a-timestamp',datetime('now','+90 minutes')),
        ('malformed-close-cycle','underpass',datetime('now','-10 minutes'),'not-a-timestamp'),
        ('unsupported-cycle','unapproved-event',datetime('now','-10 minutes'),datetime('now','+90 minutes')),
        ('unsupported-event-cycle','unapproved-event',datetime('now','-10 minutes'),datetime('now','+90 minutes')),
        ('uncounted-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+90 minutes')),
        ('duplicate-receipt-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+90 minutes')),
        ('counter-lag-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+90 minutes')),
        ('counter-boundary-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+90 minutes')),
        ('counter-fractional-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+90 minutes')),
        ('counter-negative-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+90 minutes')),
        ('legacy-terminal-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+90 minutes')),
        ('invalid-xp-residual-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+90 minutes')),
        ('xp-residual-boundary-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+90 minutes')),
        ('negative-xp-residual-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+90 minutes')),
        ('fractional-xp-residual-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+90 minutes')),
        ('unsafe-xp-threshold-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+90 minutes')),
        ('invalid-progression-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+90 minutes')),
        ('post-award-overflow-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+90 minutes')),
        ('currency-overflow-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+90 minutes'));
    INSERT INTO battle_permits(id,player_id,event_key,cycle_id,encounter_key,expires_at,
      battle_status,player_hp,player_mana,enemy_hp,turn_count)
    VALUES
      ('permit-a','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-restart-after-victory','restart-after-victory-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-b','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-c','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-d','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-unsupported-encounter','integration-player','underpass','integration-cycle','unapproved-monster',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-unsupported-event','integration-player','unapproved-event','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-cycle-mismatch','integration-player','underpass','unsupported-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-active-unsupported-event','integration-player','unapproved-event','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,12,92,0),
      ('permit-active-cycle-mismatch','integration-player','underpass','unsupported-event-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,12,92,0),
      ('permit-start-before-open','integration-player','underpass','start-before-open-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,12,92,0),
      ('permit-start-after-close','integration-player','underpass','start-after-close-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-malformed-open-cycle','malformed-cycle-player','underpass','malformed-open-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,12,92,0),
      ('permit-malformed-close-cycle','malformed-cycle-player','underpass','malformed-close-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,12,92,0),
      ('permit-corrupt-awarded-reward','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-awarded-without-history','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-awarded-clear-ahead','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-awarded-no-counter','integration-player','underpass','uncounted-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-awarded-invalid-xp-residual','integration-player','underpass','invalid-xp-residual-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-awarded-xp-residual-boundary','xp-boundary-player','underpass','xp-residual-boundary-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-awarded-negative-xp-residual','integration-player','underpass','negative-xp-residual-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-awarded-fractional-xp-residual','integration-player','underpass','fractional-xp-residual-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-awarded-unsafe-xp-threshold','integration-player','underpass','unsafe-xp-threshold-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-invalid-progression','invalid-progression-player','underpass','invalid-progression-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-post-award-overflow','post-award-overflow-player','underpass','post-award-overflow-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-currency-overflow','currency-overflow-player','underpass','currency-overflow-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-awarded-duplicate-clear','integration-player','underpass','duplicate-receipt-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-awarded-duplicate-peer','integration-player','underpass','duplicate-receipt-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-mana-zero','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,0,50,0),
      ('permit-survives-event-closure','event-closure-player','underpass','closed-after-entry-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,0,1,0),
      ('permit-insufficient-mana','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,0,92,0),
      ('permit-invalid-mana','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,13,92,0),
      ('permit-missing-mana-active','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,NULL,92,0),
      ('permit-invalid-negative-mana','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,-1,92,0),
      ('permit-invalid-fractional-mana','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,1.5,92,0),
      ('permit-invalid-fractional-player-hp','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80.5,12,92,0),
      ('permit-invalid-fractional-enemy-hp','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,12,92.5,0),
      ('permit-invalid-fractional-turn','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,12,92,0.5),
      ('permit-invalid-victory-mana','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,13,0,3),
      ('permit-invalid-victory-fractional-mana','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,1.5,0,3),
      ('permit-invalid-victory-fractional-player-hp','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70.5,0,0,3),
      ('permit-invalid-victory-fractional-enemy-hp','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0.5,3),
      ('permit-invalid-victory-fractional-turn','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3.5),
      ('permit-invalid-player-hp','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',121,12,92,0),
      ('permit-invalid-enemy-hp','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,12,93,0),
      ('permit-invalid-negative-turn','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,12,92,-1),
      ('permit-invalid-active-terminal','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',0,12,92,0),
      ('permit-invalid-turn-overflow','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,12,92,9007199254740991),
      ('permit-turn-boundary-active','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,12,92,9007199254740990),
      ('permit-turn-boundary-victory','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,4,20,9007199254740990),
      ('permit-invalid-victory-enemy','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,1,1),
      ('permit-invalid-victory-turn','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,0),
      ('permit-invalid-defeat-player','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'defeat',1,0,92,1),
      ('permit-killing-blow','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,4,30,0),
      ('permit-defeat','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',10,0,92,0),
      ('permit-turn-race','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,0,92,0),
      ('permit-paid-turn-race','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,4,92,0),
      ('permit-paid-killing-race','paid-killing-race-player','underpass','paid-killing-race-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,4,20,0),
      ('permit-e','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,12,1,0),
      ('expired','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','-20 minutes'),'active',80,12,92,0),
      ('expired-active','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','-20 minutes'),'active',80,12,92,0),
      ('permit-expired-victory','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,0,1,0),
      ('permit-expired-defeat','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',10,0,92,0),
      ('permit-counter-lag-peer','integration-player','underpass','counter-lag-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-counter-lag-pending','integration-player','underpass','counter-lag-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-counter-last-safe','integration-player','underpass','counter-boundary-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-counter-overflow','integration-player','underpass','counter-boundary-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-counter-fractional','integration-player','underpass','counter-fractional-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-counter-negative','integration-player','underpass','counter-negative-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      -- A pre-Mana terminal victory may legitimately retain NULL player_mana.
      ('permit-legacy-terminal-victory','integration-player','underpass','legacy-terminal-cycle','tunnel-maw',datetime('now','-20 minutes'),'victory',70,NULL,0,3),
      -- Legacy terminal defeat is recoverable for display, never reward-eligible.
      ('permit-legacy-terminal-defeat','integration-player','underpass','legacy-terminal-cycle','tunnel-maw',datetime('now','-20 minutes'),'defeat',0,NULL,40,3),
      -- NULL Mana is not permission to accept an internally inconsistent legacy victory.
      ('permit-legacy-malformed-victory','integration-player','underpass','legacy-terminal-cycle','tunnel-maw',datetime('now','-20 minutes'),'victory',70,NULL,40,3),
      ('permit-inventory-cap','inventory-cap-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-inventory-atomic','inventory-atomic-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-inventory-race-a','inventory-race-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-inventory-race-b','inventory-race-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3);
    INSERT INTO battle_permits(id,player_id,event_key,cycle_id,encounter_key,started_at,expires_at,
      battle_status,player_hp,player_mana,enemy_hp,turn_count)
      VALUES ('permit-malformed-start','malformed-start-player','underpass','malformed-start-cycle',
        'tunnel-maw','not-a-timestamp',datetime('now','+20 minutes'),'active',80,12,92,0);
    INSERT INTO battle_permits(id,player_id,event_key,cycle_id,encounter_key,started_at,expires_at,
      battle_status,player_hp,player_mana,enemy_hp,turn_count)
      VALUES ('permit-malformed-expiry','malformed-expiry-player','underpass','integration-cycle',
        'tunnel-maw',datetime('now','-10 minutes'),'not-a-timestamp','active',80,12,92,0);
    INSERT INTO battle_permits(id,player_id,event_key,cycle_id,encounter_key,started_at,expires_at,
      battle_status,player_hp,player_mana,enemy_hp,turn_count)
      VALUES ('permit-future-start','future-start-player','underpass','future-start-cycle',
        'tunnel-maw',datetime('now','+15 minutes'),datetime('now','+30 minutes'),'active',80,12,92,0);
    INSERT INTO battle_permits(id,player_id,event_key,cycle_id,encounter_key,started_at,expires_at,
      battle_status,player_hp,player_mana,enemy_hp,turn_count)
      VALUES ('permit-future-start-terminal','future-terminal-player','underpass','future-start-cycle',
        'tunnel-maw',datetime('now','+15 minutes'),datetime('now','+30 minutes'),'victory',80,12,0,1);
    INSERT INTO battle_permits(id,player_id,event_key,cycle_id,encounter_key,started_at,expires_at,
      battle_status,player_hp,player_mana,enemy_hp,turn_count)
      SELECT 'permit-start-at-close','integration-player','underpass','start-after-close-cycle',
        'tunnel-maw',closes_at,datetime('now','+20 minutes'),'active',80,12,92,0
      FROM world_event_cycles WHERE id='start-after-close-cycle';
    INSERT INTO battle_permits(id,player_id,event_key,cycle_id,encounter_key,started_at,expires_at,
      battle_status,player_hp,player_mana,enemy_hp,turn_count)
      SELECT 'permit-start-at-open','open-boundary-player','underpass','start-at-open-cycle',
        'tunnel-maw',opens_at,datetime('now','+20 minutes'),'active',80,12,92,0
      FROM world_event_cycles WHERE id='start-at-open-cycle';
    -- A structurally valid, fully audited award must still be rejected if its
    -- permit start timestamp falls outside the referenced cycle window.
    INSERT INTO battle_permits(
      id,player_id,event_key,cycle_id,encounter_key,started_at,expires_at,
      battle_status,player_hp,player_mana,enemy_hp,turn_count,reward_state,
      reward_clear_number,reward_xp,reward_currency,reward_tier,reward_level,
      reward_remaining_xp,reward_claim_token,reward_claimed_at,completed_at
    ) VALUES (
      'permit-awarded-start-after-close','out-of-cycle-award-player','underpass','start-after-close-cycle','tunnel-maw',
      datetime('now','-5 minutes'),datetime('now','+20 minutes'),
      'victory',70,0,0,3,'awarded',1,75,30,'full',2,50,
      'out-of-cycle-award-token',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
    );
    INSERT INTO battle_history
      (id,player_id,encounter_key,result,player_level,xp_awarded,currency_awarded)
      VALUES ('permit-awarded-start-after-close:victory','out-of-cycle-award-player',
        'tunnel-maw','victory',2,75,30);
    -- Model the permit as issued two minutes before the cycle closes.
    UPDATE battle_permits SET started_at=datetime('now','-2 minutes'),
      expires_at=datetime('now','+18 minutes')
      WHERE id='permit-survives-event-closure';
    INSERT INTO world_event_clears(player_id,event_key,cycle_id,full_reward_clears)
      VALUES
        ('integration-player','underpass','counter-lag-cycle',0),
        ('integration-player','underpass','counter-boundary-cycle',9007199254740990),
        ('integration-player','underpass','counter-fractional-cycle',1.5),
        ('integration-player','underpass','counter-negative-cycle',-1),
        ('integration-player','underpass','legacy-terminal-cycle',0),
        ('out-of-cycle-award-player','underpass','start-after-close-cycle',1);
    UPDATE battle_permits SET reward_state='awarded', reward_clear_number=1,
      reward_xp=75, reward_currency=30, reward_tier='full', reward_level=2,
      reward_remaining_xp=50, reward_claim_token='counter-lag-peer-token',
      reward_claimed_at=CURRENT_TIMESTAMP, completed_at=CURRENT_TIMESTAMP
      WHERE id='permit-counter-lag-peer';
    INSERT INTO battle_history
      (id,player_id,encounter_key,result,player_level,xp_awarded,currency_awarded)
      VALUES('permit-counter-lag-peer:victory','integration-player','tunnel-maw','victory',2,75,30);
  `);
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist, '--file=' + seed]);
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist,
    "--command=UPDATE battle_permits SET started_at = CASE id " +
      "WHEN 'permit-start-before-open' THEN datetime('now','-20 minutes') " +
      "WHEN 'permit-start-after-close' THEN datetime('now','-5 minutes') END " +
      "WHERE id IN ('permit-start-before-open','permit-start-after-close')"]);
  // Close the cycle after that persisted entry time, before starting the Worker.
  // Opening a second Wrangler D1 CLI against the same persisted SQLite store while
  // Miniflare is serving requests can drop the Worker socket.
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist,
    "--command=UPDATE world_event_cycles SET closes_at=datetime('now','-1 minute') WHERE id='closed-after-entry-cycle'"]);
  assert.equal(countRows("SELECT COUNT(*) AS n FROM world_event_cycles WHERE id='closed-after-entry-cycle' AND julianday(closes_at) < julianday('now')"), 1,
    'the Underpass cycle must be closed before the action is submitted');
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits AS permit
    JOIN world_event_cycles AS cycle ON cycle.id = permit.cycle_id
    WHERE permit.id='permit-survives-event-closure'
      AND julianday(cycle.opens_at) <= julianday(permit.started_at)
      AND julianday(permit.started_at) < julianday(cycle.closes_at)
      AND julianday(cycle.closes_at) < julianday('now')
      AND julianday(permit.expires_at) > julianday('now')`), 1,
    'the permit must be issued while the cycle is open and remain unexpired after closure');
  const invalidStartCharacterBefore = queryRows("SELECT level, xp, currency, last_reward_claim_token FROM characters WHERE player_id='integration-player'");
  const invalidStartInventoryBefore = queryRows("SELECT item_key, item_type, quantity FROM player_inventory WHERE player_id='integration-player' ORDER BY item_type, item_key");
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits AS permit JOIN world_event_cycles AS cycle ON cycle.id=permit.cycle_id
    WHERE permit.id='permit-start-at-close' AND julianday(permit.started_at)=julianday(cycle.closes_at)`), 1,
    'the boundary fixture must start exactly at the cycle close instant');
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits AS permit JOIN world_event_cycles AS cycle ON cycle.id=permit.cycle_id
    WHERE permit.id='permit-start-at-open' AND julianday(permit.started_at)=julianday(cycle.opens_at)
      AND julianday(cycle.opens_at) <= julianday(permit.started_at)
      AND julianday(permit.started_at) < julianday(cycle.closes_at)`), 1,
    'the lower cycle boundary is inclusive and the permit must start exactly at opens_at');
  const openBoundaryCharacterBefore = queryRows("SELECT level, xp, currency, last_reward_claim_token FROM characters WHERE player_id='open-boundary-player'");
  const openBoundaryInventoryBefore = queryRows("SELECT item_key, item_type, quantity FROM player_inventory WHERE player_id='open-boundary-player' ORDER BY item_type, item_key");
  const openBoundaryClearsBefore = queryRows("SELECT cycle_id, full_reward_clears FROM world_event_clears WHERE player_id='open-boundary-player' ORDER BY cycle_id");
  const openBoundaryHistoryBefore = countRows("SELECT COUNT(*) AS n FROM battle_history WHERE player_id='open-boundary-player'");
  const invalidStartPermitsBefore = queryRows("SELECT id, started_at, battle_status, player_hp, player_mana, enemy_hp, turn_count, reward_state, reward_clear_number, reward_claim_token, reward_claimed_at, completed_at FROM battle_permits WHERE id IN ('permit-start-before-open','permit-start-after-close','permit-start-at-close') ORDER BY id");
  const malformedStartPermitBefore = queryRows("SELECT id, started_at, battle_status, player_hp, player_mana, enemy_hp, turn_count, reward_state, reward_clear_number, reward_claim_token, reward_claimed_at, completed_at FROM battle_permits WHERE id='permit-malformed-start'");
  const malformedStartCharacterBefore = queryRows("SELECT level, xp, currency, last_reward_claim_token FROM characters WHERE player_id='malformed-start-player'");
  const malformedStartInventoryBefore = queryRows("SELECT item_key, item_type, quantity FROM player_inventory WHERE player_id='malformed-start-player' ORDER BY item_type, item_key");
  const malformedStartClearsBefore = queryRows("SELECT cycle_id, full_reward_clears FROM world_event_clears WHERE player_id='malformed-start-player' AND cycle_id='malformed-start-cycle'");
  const malformedStartHistoryBefore = countRows("SELECT COUNT(*) AS n FROM battle_history WHERE player_id='malformed-start-player'");
  const futureStartPermitBefore = queryRows("SELECT id, started_at, expires_at, battle_status, player_hp, player_mana, enemy_hp, turn_count, reward_state, reward_clear_number, reward_claim_token, reward_claimed_at, completed_at FROM battle_permits WHERE id='permit-future-start'");
  const futureStartCharacterBefore = queryRows("SELECT level, xp, currency, last_reward_claim_token FROM characters WHERE player_id='future-start-player'");
  const futureStartInventoryBefore = queryRows("SELECT item_key, item_type, quantity FROM player_inventory WHERE player_id='future-start-player' ORDER BY item_type, item_key");
  const futureStartClearsBefore = queryRows("SELECT cycle_id, full_reward_clears FROM world_event_clears WHERE player_id='future-start-player'");
  const futureStartHistoryBefore = countRows("SELECT COUNT(*) AS n FROM battle_history WHERE player_id='future-start-player'");
  const futureTerminalPermitBefore = queryRows("SELECT id, started_at, expires_at, battle_status, player_hp, player_mana, enemy_hp, turn_count, reward_state, reward_clear_number, reward_claim_token, reward_claimed_at, completed_at FROM battle_permits WHERE id='permit-future-start-terminal'");
  const futureTerminalCharacterBefore = queryRows("SELECT level, xp, currency, last_reward_claim_token FROM characters WHERE player_id='future-terminal-player'");
  const futureTerminalInventoryBefore = queryRows("SELECT item_key, item_type, quantity FROM player_inventory WHERE player_id='future-terminal-player' ORDER BY item_type, item_key");
  const futureTerminalClearsBefore = queryRows("SELECT cycle_id, full_reward_clears FROM world_event_clears WHERE player_id='future-terminal-player'");
  const futureTerminalHistoryBefore = countRows("SELECT COUNT(*) AS n FROM battle_history WHERE player_id='future-terminal-player'");
  const invalidStartClearsBefore = queryRows("SELECT cycle_id, full_reward_clears FROM world_event_clears WHERE player_id='integration-player' AND cycle_id IN ('start-before-open-cycle','start-after-close-cycle') ORDER BY cycle_id");
  assert.equal(countRows("SELECT COUNT(*) AS n FROM world_event_cycles WHERE id='malformed-open-cycle' AND opens_at='not-a-timestamp' AND julianday(opens_at) IS NULL"), 1,
    'malformed cycle-open fixture must remain unparsable in SQLite');
  assert.equal(countRows("SELECT COUNT(*) AS n FROM world_event_cycles WHERE id='malformed-close-cycle' AND closes_at='not-a-timestamp' AND julianday(closes_at) IS NULL"), 1,
    'malformed cycle-close fixture must remain unparsable in SQLite');
  const malformedCyclePermitsBefore = queryRows("SELECT id, started_at, battle_status, player_hp, player_mana, enemy_hp, turn_count, reward_state, reward_clear_number, reward_claim_token, reward_claimed_at, completed_at FROM battle_permits WHERE id IN ('permit-malformed-open-cycle','permit-malformed-close-cycle') ORDER BY id");
  const malformedCycleClearsBefore = queryRows("SELECT cycle_id, full_reward_clears FROM world_event_clears WHERE player_id='malformed-cycle-player' AND cycle_id IN ('malformed-open-cycle','malformed-close-cycle') ORDER BY cycle_id");
  const malformedCycleHistoryBefore = countRows("SELECT COUNT(*) AS n FROM battle_history WHERE player_id='malformed-cycle-player' AND id IN ('permit-malformed-open-cycle:victory','permit-malformed-open-cycle:defeat','permit-malformed-close-cycle:victory','permit-malformed-close-cycle:defeat')");
  const malformedCycleCharacterBefore = queryRows("SELECT level, xp, currency, last_reward_claim_token FROM characters WHERE player_id='malformed-cycle-player'");
  const malformedCycleInventoryBefore = queryRows("SELECT item_key, item_type, quantity FROM player_inventory WHERE player_id='malformed-cycle-player' ORDER BY item_type, item_key");
  // Capture the isolated invalid awarded receipt before the Worker starts; later
  // D1 CLI reads while Miniflare is serving requests can drop its HTTP socket.
  const invalidStartAwardedPermitBefore = queryRows(`SELECT started_at, battle_status, player_hp, player_mana,
    enemy_hp, turn_count, reward_state, reward_clear_number, reward_xp, reward_currency, reward_tier,
    reward_level, reward_remaining_xp, reward_claim_token, reward_claimed_at, completed_at
    FROM battle_permits WHERE id='permit-awarded-start-after-close'`);
  const invalidStartAwardedCharacterBefore = queryRows("SELECT level, xp, currency, last_reward_claim_token FROM characters WHERE player_id='out-of-cycle-award-player'");
  const invalidStartAwardedInventoryBefore = queryRows("SELECT item_key, item_type, quantity FROM player_inventory WHERE player_id='out-of-cycle-award-player' ORDER BY item_type, item_key");
  const invalidStartAwardedClearsBefore = queryRows("SELECT cycle_id, full_reward_clears FROM world_event_clears WHERE player_id='out-of-cycle-award-player' AND cycle_id='start-after-close-cycle'");
  const invalidStartAwardedHistoryBefore = queryRows("SELECT id, player_id, encounter_key, result, player_level, xp_awarded, currency_awarded FROM battle_history WHERE id='permit-awarded-start-after-close:victory'");
  const malformedExpiryPermitBefore = queryRows("SELECT started_at, expires_at, battle_status, player_hp, player_mana, enemy_hp, turn_count, reward_state, reward_clear_number, reward_claim_token, reward_claimed_at, completed_at FROM battle_permits WHERE id='permit-malformed-expiry'");
  const malformedExpiryCharacterBefore = queryRows("SELECT level, xp, currency, last_reward_claim_token FROM characters WHERE player_id='malformed-expiry-player'");
  const malformedExpiryInventoryBefore = queryRows("SELECT item_key, item_type, quantity FROM player_inventory WHERE player_id='malformed-expiry-player' ORDER BY item_type, item_key");
  const malformedExpiryClearsBefore = queryRows("SELECT cycle_id, full_reward_clears FROM world_event_clears WHERE player_id='malformed-expiry-player' ORDER BY cycle_id");
  const malformedExpiryHistoryBefore = queryRows("SELECT id, player_id, encounter_key, result, player_level, xp_awarded, currency_awarded FROM battle_history WHERE player_id='malformed-expiry-player' ORDER BY id");
  server = spawn(wrangler, ['dev', '--local', '--persist-to=' + persist, '--ip=127.0.0.1', '--port=8789'], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [server.stdout, server.stderr]) {
    stream.on('data', data => { logs = (logs + data.toString()).slice(-10000); });
  }
  let ready = false;
  for (let n = 0; n < 80; n++) {
    if (server.exitCode !== null) throw new Error('Worker exited: ' + logs);
    try {
      const r = await fetch(base + '/api/health', { signal: AbortSignal.timeout(600) });
      if (r.ok && (await r.json()).ok) { ready = true; break; }
    } catch { /* startup */ }
    await sleep(250);
  }
  assert.ok(ready, 'Worker did not start: ' + logs);

  // Invalid start times must not authorize actions or rewards. Keep these requests
  // adjacent to Worker startup so local D1 probes cannot disrupt HTTP.
  const beforeOpenActionResponse = await fetch(base + '/api/battle/action', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: 'integration-player', permitId: 'permit-start-before-open', abilityId: 'slash', expectedTurnCount: 0 }),
    signal: AbortSignal.timeout(30_000),
  });
  const beforeOpenAction = await beforeOpenActionResponse.json();
  assert.equal(beforeOpenActionResponse.status, 409, JSON.stringify(beforeOpenAction));
  assert.equal(beforeOpenAction.error, 'Battle permit is invalid, expired, or already completed.');
  assert.equal('battleState' in beforeOpenAction, false);

  const afterCloseCompletion = await complete('permit-start-after-close');
  assert.equal(afterCloseCompletion.status, 409, JSON.stringify(afterCloseCompletion.data));
  assert.equal(afterCloseCompletion.data.error, 'Battle permit was not issued during its event cycle.');
  assert.equal('reward' in afterCloseCompletion.data, false);
  assert.equal('player' in afterCloseCompletion.data, false);

  // SQLite's date parser returns NULL for a malformed permit timestamp. Neither
  // the action snapshot path nor completion/reward settlement may treat that NULL
  // comparison as permission to act or replay a reward.
  const malformedStartActionResponse = await fetch(base + '/api/battle/action', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: 'malformed-start-player', permitId: 'permit-malformed-start', abilityId: 'slash', expectedTurnCount: 0 }),
    signal: AbortSignal.timeout(30_000),
  });
  const malformedStartAction = await malformedStartActionResponse.json();
  assert.equal(malformedStartActionResponse.status, 409, JSON.stringify(malformedStartAction));
  assert.equal(malformedStartAction.error, 'Battle permit is invalid, expired, or already completed.');
  assert.equal('battleState' in malformedStartAction, false);
  const malformedStartCompletion = await complete('permit-malformed-start', 'malformed-start-player', {
    victory: true, xp: 999999, currency: 999999, items: ['forged-item'],
  });
  assert.equal(malformedStartCompletion.status, 409, JSON.stringify(malformedStartCompletion.data));
  assert.equal(malformedStartCompletion.data.error, 'Battle permit was not issued during its event cycle.');
  assert.equal('reward' in malformedStartCompletion.data, false);
  assert.equal('player' in malformedStartCompletion.data, false);

  // A timestamp can be inside a cycle's interval but still lie in the future.
  // Such a permit was not yet issued and must not authorize actions or rewards.
  const futureStartActionResponse = await fetch(base + '/api/battle/action', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: 'future-start-player', permitId: 'permit-future-start', abilityId: 'slash', expectedTurnCount: 0 }),
    signal: AbortSignal.timeout(30_000),
  });
  const futureStartAction = await futureStartActionResponse.json();
  assert.equal(futureStartActionResponse.status, 409, JSON.stringify(futureStartAction));
  assert.equal(futureStartAction.error, 'Battle permit is invalid, expired, or already completed.');
  assert.equal('battleState' in futureStartAction, false);
  const futureStartCompletion = await complete('permit-future-start', 'future-start-player', {
    victory: true, playerHp: 0, playerMana: 999, enemyHp: 0, turnCount: 999,
    xp: 999999, currency: 999999, items: ['forged-item'],
  });
  assert.equal(futureStartCompletion.status, 409, JSON.stringify(futureStartCompletion.data));
  assert.equal(futureStartCompletion.data.error, 'Battle permit was not issued during its event cycle.');
  assert.equal('reward' in futureStartCompletion.data, false);
  assert.equal('player' in futureStartCompletion.data, false);

  // Terminal recovery must apply the same D1-clock chronology guard. Without it,
  // a future-dated victory with no completion receipt could leak a trusted snapshot
  // back to the client even though the same permit cannot authorize a fresh action.
  const futureTerminalActionResponse = await fetch(base + '/api/battle/action', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: 'future-terminal-player', permitId: 'permit-future-start-terminal', abilityId: 'slash', expectedTurnCount: 1 }),
    signal: AbortSignal.timeout(30_000),
  });
  const futureTerminalAction = await futureTerminalActionResponse.json();
  assert.equal(futureTerminalActionResponse.status, 409, JSON.stringify(futureTerminalAction));
  assert.equal('battleState' in futureTerminalAction, false);
  assert.equal('reward' in futureTerminalAction, false);
  assert.equal('player' in futureTerminalAction, false);

  // A valid in-cycle start does not rescue a permit with an unparsable expiry.
  // New actions must fail closed, and client-supplied victory/reward fields must
  // not turn that invalid permit into a settlement path.
  const malformedExpiryActionResponse = await fetch(base + '/api/battle/action', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: 'malformed-expiry-player', permitId: 'permit-malformed-expiry', abilityId: 'slash', expectedTurnCount: 0 }),
    signal: AbortSignal.timeout(30_000),
  });
  const malformedExpiryAction = await malformedExpiryActionResponse.json();
  assert.equal(malformedExpiryActionResponse.status, 409, JSON.stringify(malformedExpiryAction));
  assert.equal(malformedExpiryAction.error, 'Battle permit is invalid, expired, or already completed.');
  assert.equal('battleState' in malformedExpiryAction, false);
  const malformedExpiryCompletion = await complete('permit-malformed-expiry', 'malformed-expiry-player', {
    victory: true, playerHp: 0, playerMana: 999, enemyHp: 0, turnCount: 999,
    xp: 999999, currency: 999999, items: ['forged-item'],
  });
  assert.equal(malformedExpiryCompletion.status, 409, JSON.stringify(malformedExpiryCompletion.data));
  assert.equal(malformedExpiryCompletion.data.error, 'Battle is not an authoritative victory.');
  assert.equal('reward' in malformedExpiryCompletion.data, false);
  assert.equal('player' in malformedExpiryCompletion.data, false);

  const exactCloseActionResponse = await fetch(base + '/api/battle/action', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: 'integration-player', permitId: 'permit-start-at-close', abilityId: 'slash', expectedTurnCount: 0 }),
    signal: AbortSignal.timeout(30_000),
  });
  const exactCloseAction = await exactCloseActionResponse.json();
  assert.equal(exactCloseActionResponse.status, 409, JSON.stringify(exactCloseAction));
  assert.equal(exactCloseAction.error, 'Battle permit is invalid, expired, or already completed.');
  assert.equal('battleState' in exactCloseAction, false,
    'the cycle open interval is half-open: entry exactly at closes_at is invalid');
  const exactCloseCompletion = await complete('permit-start-at-close', 'integration-player', {
    victory: true, xp: 999999, currency: 999999, items: ['forged-item'],
  });
  assert.equal(exactCloseCompletion.status, 409, JSON.stringify(exactCloseCompletion.data));
  assert.equal(exactCloseCompletion.data.error, 'Battle permit was not issued during its event cycle.');
  assert.equal('reward' in exactCloseCompletion.data, false);
  assert.equal('player' in exactCloseCompletion.data, false);

  // The lower boundary is inclusive: a permit whose persisted start equals
  // opens_at is valid, unlike the exact-closes_at permit above.
  const exactOpenActionResponse = await fetch(base + '/api/battle/action', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: 'open-boundary-player', permitId: 'permit-start-at-open', abilityId: 'slash', expectedTurnCount: 0 }),
    signal: AbortSignal.timeout(30_000),
  });
  const exactOpenAction = await exactOpenActionResponse.json();
  assert.equal(exactOpenActionResponse.status, 200, JSON.stringify(exactOpenAction));
  assert.equal(exactOpenAction.status, 'active');
  assert.equal(exactOpenAction.turnCount, 1);
  assert.equal(exactOpenAction.playerMana, 12, 'zero-cost Slash must not change Mana');
  assert.ok(exactOpenAction.playerHp > 0 && exactOpenAction.playerHp < 80,
    'the accepted action must apply the normal monster retaliation');
  assert.ok(exactOpenAction.enemyHp > 0 && exactOpenAction.enemyHp < 92,
    'the accepted action must apply player damage without ending the encounter');
  const exactOpenCompletion = await complete('permit-start-at-open', 'open-boundary-player', {
    victory: true, xp: 999999, currency: 999999, items: ['forged-item'],
  });
  assert.equal(exactOpenCompletion.status, 409, JSON.stringify(exactOpenCompletion.data));
  assert.equal('reward' in exactOpenCompletion.data, false,
    'a valid lower-bound permit still cannot claim rewards before a Worker-resolved victory');
  assert.equal('player' in exactOpenCompletion.data, false);

  // Malformed cycle bounds are also invalid authority data. SQLite comparisons with
  // an unparsable opens_at/closes_at produce NULL, which must fail closed for both
  // the action snapshot path and reward completion.
  for (const permitId of ['permit-malformed-open-cycle', 'permit-malformed-close-cycle']) {
    const malformedCycleActionResponse = await fetch(base + '/api/battle/action', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: 'malformed-cycle-player', permitId, abilityId: 'slash', expectedTurnCount: 0 }),
      signal: AbortSignal.timeout(30_000),
    });
    const malformedCycleAction = await malformedCycleActionResponse.json();
    assert.equal(malformedCycleActionResponse.status, 409, JSON.stringify(malformedCycleAction));
    assert.equal(malformedCycleAction.error, 'Battle permit is invalid, expired, or already completed.');
    assert.equal('battleState' in malformedCycleAction, false);

    const malformedCycleCompletion = await complete(permitId, 'malformed-cycle-player', {
      victory: true, xp: 999999, currency: 999999, items: ['forged-item'],
    });
    assert.equal(malformedCycleCompletion.status, 409, JSON.stringify(malformedCycleCompletion.data));
    assert.equal(malformedCycleCompletion.data.error, 'Battle permit was not issued during its event cycle.');
    assert.equal('reward' in malformedCycleCompletion.data, false);
    assert.equal('player' in malformedCycleCompletion.data, false);
  }

  // A legitimately issued permit remains valid after the cycle closes. Closure is
  // not permit expiry: the Worker must resolve the entered fight and settle its victory.
  const closureActionResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'event-closure-player',
      permitId: 'permit-survives-event-closure',
      abilityId: 'slash',
      expectedTurnCount: 0,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const closureAction = await closureActionResponse.json();
  assert.equal(closureActionResponse.status, 200, JSON.stringify(closureAction));
  assert.equal(closureAction.status, 'victory');
  assert.equal(closureAction.playerHp, 80);
  assert.equal(closureAction.playerMana, 0);
  assert.equal(closureAction.enemyHp, 0);
  assert.equal(closureAction.turnCount, 1);
  const closureRewardResponse = await complete('permit-survives-event-closure', 'event-closure-player');
  assert.equal(closureRewardResponse.status, 200, JSON.stringify(closureRewardResponse.data));
  assert.equal(closureRewardResponse.data.reward.tier, 'full');
  const closureReplay = await complete('permit-survives-event-closure', 'event-closure-player');
  assert.equal(closureReplay.status, 200);
  assert.deepEqual(closureReplay.data.reward, closureRewardResponse.data.reward);

  // Keep this additional HTTP request adjacent to the closure action/completion/replay
  // sequence. The receipt is otherwise fully audited, but its start is after cycle close.
  const invalidStartAwardedReplay = await complete('permit-awarded-start-after-close', 'out-of-cycle-award-player', {
    victory: true, xp: 999999, currency: 999999, items: ['forged-item'],
  });
  assert.equal(invalidStartAwardedReplay.status, 409, JSON.stringify(invalidStartAwardedReplay.data));
  assert.equal(invalidStartAwardedReplay.data.error, 'Battle permit was not issued during its event cycle.');
  assert.equal('reward' in invalidStartAwardedReplay.data, false);
  assert.equal('player' in invalidStartAwardedReplay.data, false);

  // Assert the committed terminal state only after both HTTP requests so a local
  // D1 CLI read cannot interfere with the action→completion→replay sequence.
  assert.deepEqual(queryRows("SELECT battle_status, player_hp, player_mana, enemy_hp, turn_count, reward_state, reward_clear_number, reward_tier FROM battle_permits WHERE id='permit-survives-event-closure'"), [{
    battle_status: 'victory', player_hp: 80, player_mana: 0, enemy_hp: 0, turn_count: 1,
    reward_state: 'awarded', reward_clear_number: 1, reward_tier: 'full',
  }], 'the post-closure victory and its reward receipt must persist authoritatively');
  assert.deepEqual(queryRows("SELECT full_reward_clears FROM world_event_clears WHERE player_id='event-closure-player' AND event_key='underpass' AND cycle_id='closed-after-entry-cycle'"), [{ full_reward_clears: 1 }]);
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_history WHERE id='permit-survives-event-closure:victory' AND player_id='event-closure-player'"), 1);
  assert.deepEqual(queryRows("SELECT level, xp, currency FROM characters WHERE player_id='event-closure-player'"), [{
    level: closureRewardResponse.data.player.level,
    xp: closureRewardResponse.data.player.xp,
    currency: closureRewardResponse.data.player.currency,
  }], 'replaying a post-closure receipt must not duplicate progression');

  assert.deepEqual(queryRows("SELECT id, started_at, battle_status, player_hp, player_mana, enemy_hp, turn_count, reward_state, reward_clear_number, reward_claim_token, reward_claimed_at, completed_at FROM battle_permits WHERE id IN ('permit-start-before-open','permit-start-after-close','permit-start-at-close') ORDER BY id"), invalidStartPermitsBefore,
    'invalid permit start timestamps must not be normalized or settled');
  assert.deepEqual(queryRows("SELECT level, xp, currency, last_reward_claim_token FROM characters WHERE player_id='integration-player'"), invalidStartCharacterBefore);
  assert.deepEqual(queryRows("SELECT item_key, item_type, quantity FROM player_inventory WHERE player_id='integration-player' ORDER BY item_type, item_key"), invalidStartInventoryBefore);
  assert.deepEqual(queryRows("SELECT cycle_id, full_reward_clears FROM world_event_clears WHERE player_id='integration-player' AND cycle_id IN ('start-before-open-cycle','start-after-close-cycle') ORDER BY cycle_id"), invalidStartClearsBefore);
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_history WHERE id IN ('permit-start-before-open:victory','permit-start-before-open:defeat','permit-start-after-close:victory','permit-start-after-close:defeat','permit-start-at-close:victory','permit-start-at-close:defeat')"), 0);
  // The isolated out-of-cycle awarded receipt must remain unchanged:
  // no progression, inventory, clear counter, or history mutation is allowed.
  // A valid action without the turn precondition is rejected before any combat mutation.
  const missingTurnPreconditionResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: 'integration-player', permitId: 'permit-mana-zero', abilityId: 'slash' }),
  });
  const missingTurnPrecondition = await missingTurnPreconditionResponse.json();
  assert.equal(missingTurnPreconditionResponse.status, 400);
  assert.equal(missingTurnPreconditionResponse.headers.get('cache-control'), 'no-store');
  assert.equal(missingTurnPrecondition.error,
    'expectedTurnCount is required and must be a non-negative safe integer.');
  assertPersistedPermitState('permit-mana-zero', {
    status: 'active', playerHp: 80, playerMana: 0, enemyHp: 50, turnCount: 0,
  });

  // Client claims cannot turn an active permit into a victory or grant a reward.
  const forgedActiveCompletion = await complete('permit-mana-zero', 'integration-player', {
    victory: true,
    status: 'victory',
    playerHp: 0,
    playerMana: 999,
    enemyHp: 0,
    turnCount: 999,
    xp: 999999,
    currency: 999999,
    items: ['admin-item'],
    reward: { xp: 999999, currency: 999999, items: ['admin-item'], tier: 'full' },
  });
  assert.equal(forgedActiveCompletion.status, 409,
    'client-supplied victory and reward fields must not complete an active permit');
  assert.equal(forgedActiveCompletion.data.error, 'Battle is not an authoritative victory.');
  assertPersistedPermitState('permit-mana-zero', {
    status: 'active', playerHp: 80, playerMana: 0, enemyHp: 50, turnCount: 0,
  });
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_history WHERE id IN ('permit-mana-zero:victory','permit-mana-zero:defeat')"), 0,
    'forged completion must not write victory or defeat history');
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_permits WHERE id='permit-mana-zero' AND reward_state='pending' AND reward_clear_number IS NULL AND completed_at IS NULL"), 1,
    'forged completion must not reserve or claim rewards');

  for (const [permitId, state] of [
    ['permit-unsupported-event', { status: 'victory', playerHp: 70, playerMana: 0, enemyHp: 0, turnCount: 3 }],
    ['permit-cycle-mismatch', { status: 'victory', playerHp: 70, playerMana: 0, enemyHp: 0, turnCount: 3 }],
  ]) {
    await assertUnsupportedActionPermit(permitId, state);
  }

  // Victory state is not enough by itself: the permit, its referenced cycle,
  // and the encounter must all match the Worker-supported Underpass slice.
  for (const permitId of ['permit-unsupported-encounter', 'permit-unsupported-event', 'permit-cycle-mismatch']) {
    const unsupported = await complete(permitId, 'integration-player', {
      victory: true, xp: 999999, currency: 999999, items: ['forged-item'],
    });
    assert.equal(unsupported.status, 409, JSON.stringify(unsupported.data));
    assert.equal(unsupported.data.error, 'Unsupported battle permit.');
    assertPersistedPermitState(permitId, {
      status: 'victory', playerHp: 70, playerMana: 0, enemyHp: 0, turnCount: 3,
    });
    assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits WHERE id='${permitId}'
      AND reward_state='pending' AND reward_clear_number IS NULL AND completed_at IS NULL`), 1,
      'unsupported victory must remain unclaimed and reserve no clear');
    assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_history WHERE id='${permitId}:victory'`), 0,
      'unsupported victory must not create a reward receipt');
  }
  // Even a pre-existing awarded receipt must not replay through an unsupported event/cycle/encounter.
  // This models a stale/corrupt receipt row and proves the guard runs before the idempotent replay path.
  for (const permitId of ['permit-unsupported-encounter', 'permit-unsupported-event', 'permit-cycle-mismatch']) {
    const clearNumber = permitId === 'permit-unsupported-encounter' ? 1
      : permitId === 'permit-unsupported-event' ? 2 : 3;
    cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist,
      "--command=UPDATE battle_permits SET reward_state='awarded', reward_clear_number=" + clearNumber + ", reward_xp=25, reward_currency=10, reward_tier='full', completed_at=CURRENT_TIMESTAMP, reward_claim_token=NULL, reward_claimed_at=NULL WHERE id='" + permitId + "'"]);
    const replay = await complete(permitId, 'integration-player', {
      victory: true, xp: 999999, currency: 999999, items: ['forged-item'],
    });
    assert.equal(replay.status, 409, JSON.stringify(replay.data));
    assert.equal(replay.data.error, 'Unsupported battle permit.');
    assert.equal('reward' in replay.data, false, 'unsupported awarded receipts must not replay reward payloads');
    assert.equal('player' in replay.data, false, 'unsupported awarded receipts must not replay progression snapshots');
    assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits WHERE id='${permitId}'
      AND reward_state='awarded' AND reward_clear_number=${clearNumber} AND reward_xp=25 AND reward_currency=10
      AND reward_tier='full' AND completed_at IS NOT NULL AND reward_claim_token IS NULL AND reward_claimed_at IS NULL`), 1,
      'rejected replay must preserve the existing receipt without acquiring or rewriting a claim');
    assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_history WHERE id='${permitId}:victory'`), 0,
      'unsupported awarded receipt must not create a second history receipt');
  }
  assert.equal(countRows("SELECT COUNT(*) AS n FROM characters WHERE player_id='integration-player' AND level=1 AND xp=0 AND currency=0 AND last_reward_claim_token IS NULL"), 1,
    'unsupported encounter/event claims must not mutate progression');

  const invalidManaResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'integration-player',
      permitId: 'permit-invalid-mana',
      abilityId: 'slash',
      expectedTurnCount: 0,
    }),
  });
  const invalidMana = await invalidManaResponse.json();
  assert.equal(invalidManaResponse.status, 409, 'persisted Mana above the Degen maximum must fail closed');
  assert.equal(invalidMana.error, 'Battle state is invalid.');
  assert.equal('battleState' in invalidMana, false, 'invalid persisted state must not be echoed as authoritative');
  assertPersistedPermitState('permit-invalid-mana', {
    status: 'active', playerHp: 80, playerMana: 13, enemyHp: 92, turnCount: 0,
  });

  // NULL Mana remains invalid for every active permit; only terminal legacy outcomes can use the display fallback.
  const missingActiveManaResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'integration-player',
      permitId: 'permit-missing-mana-active',
      abilityId: 'slash',
      expectedTurnCount: 0,
    }),
  });
  const missingActiveMana = await missingActiveManaResponse.json();
  assert.equal(missingActiveManaResponse.status, 409);
  assert.equal(missingActiveMana.error, 'Battle state is unavailable.');
  assert.equal('battleState' in missingActiveMana, false);
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits
    WHERE id='permit-missing-mana-active' AND player_mana IS NULL
      AND battle_status='active' AND player_hp=80 AND enemy_hp=92 AND turn_count=0`), 1,
    'active permits must never use the terminal-only Mana fallback');

  // A valid zero-Mana permit must reject a paid move without applying any part of the turn.
  const insufficientManaResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'integration-player',
      permitId: 'permit-insufficient-mana',
      abilityId: 'crack',
      expectedTurnCount: 0,
    }),
  });
  const insufficientMana = await insufficientManaResponse.json();
  assert.equal(insufficientManaResponse.status, 409);
  assert.equal(insufficientMana.error, 'Not enough Mana for that ability.');
  assert.deepEqual(insufficientMana.battleState, {
    permitId: 'permit-insufficient-mana',
    status: 'active',
    playerHp: 80,
    playerMana: 0,
    enemyHp: 92,
    turnCount: 0,
  }, 'rejection must return the unchanged server-authoritative snapshot');
  assertPersistedPermitState('permit-insufficient-mana', {
    status: 'active', playerHp: 80, playerMana: 0, enemyHp: 92, turnCount: 0,
  });
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_history WHERE id IN ('permit-insufficient-mana:victory','permit-insufficient-mana:defeat')"), 0,
    'an unaffordable action must not write terminal battle history');
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_permits WHERE id='permit-insufficient-mana' AND reward_state='pending' AND reward_clear_number IS NULL AND completed_at IS NULL"), 1,
    'an unaffordable action must not reserve or claim rewards');

  // The same permit remains playable at zero Mana with a zero-cost bespoke ability.
  const zeroManaActionResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'integration-player',
      permitId: 'permit-insufficient-mana',
      abilityId: 'slash',
      expectedTurnCount: 0,
    }),
  });
  const zeroManaAction = await zeroManaActionResponse.json();
  assert.equal(zeroManaActionResponse.status, 200, JSON.stringify(zeroManaAction));
  assert.equal(zeroManaAction.status, 'active');
  assert.equal(zeroManaAction.playerHp, 70);
  assert.equal(zeroManaAction.playerMana, 0, 'a zero-cost action at zero Mana must spend exactly zero');
  assert.equal(zeroManaAction.enemyHp, 63);
  assert.equal(zeroManaAction.turnCount, 1);
  assertPersistedPermitState('permit-insufficient-mana', {
    status: 'active', playerHp: 70, playerMana: 0, enemyHp: 63, turnCount: 1,
  });

  // Replaying the accepted action with its original turn must not apply damage twice.
  const duplicateActionResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'integration-player',
      permitId: 'permit-insufficient-mana',
      abilityId: 'slash',
      expectedTurnCount: 0,
    }),
  });
  const duplicateAction = await duplicateActionResponse.json();
  assert.equal(duplicateActionResponse.status, 409);
  assert.equal(duplicateActionResponse.headers.get('cache-control'), 'no-store');
  assert.equal(duplicateAction.error, 'Stale battle turn.');
  assert.deepEqual(duplicateAction.battleState, {
    permitId: 'permit-insufficient-mana', status: 'active',
    playerHp: 70, playerMana: 0, enemyHp: 63, turnCount: 1,
  });
  assertPersistedPermitState('permit-insufficient-mana', {
    status: 'active', playerHp: 70, playerMana: 0, enemyHp: 63, turnCount: 1,
  });

  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_history WHERE id IN ('permit-insufficient-mana:victory','permit-insufficient-mana:defeat')"), 0,
    'a non-terminal zero-cost action must not create battle history');
  await assertInvalidActionState('permit-invalid-negative-mana', { status: 'active', playerHp: 80, playerMana: -1, enemyHp: 92, turnCount: 0 });
  await assertInvalidActionState('permit-invalid-fractional-mana', { status: 'active', playerHp: 80, playerMana: 1.5, enemyHp: 92, turnCount: 0 });
  await assertInvalidActionState('permit-invalid-fractional-player-hp', { status: 'active', playerHp: 80.5, playerMana: 12, enemyHp: 92, turnCount: 0 });
  await assertInvalidActionState('permit-invalid-fractional-enemy-hp', { status: 'active', playerHp: 80, playerMana: 12, enemyHp: 92.5, turnCount: 0 });
  await assertInvalidActionState('permit-invalid-fractional-turn', { status: 'active', playerHp: 80, playerMana: 12, enemyHp: 92, turnCount: 0.5 });

  await assertInvalidActionState('permit-invalid-player-hp', { status: 'active', playerHp: 121, playerMana: 12, enemyHp: 92, turnCount: 0 });
  await assertInvalidActionState('permit-invalid-enemy-hp', { status: 'active', playerHp: 80, playerMana: 12, enemyHp: 93, turnCount: 0 });
  await assertInvalidActionState('permit-invalid-negative-turn', { status: 'active', playerHp: 80, playerMana: 12, enemyHp: 92, turnCount: -1 });
  await assertInvalidActionState('permit-invalid-active-terminal', { status: 'active', playerHp: 0, playerMana: 12, enemyHp: 92, turnCount: 0 });
  await assertInvalidActionState('permit-invalid-turn-overflow', { status: 'active', playerHp: 80, playerMana: 12, enemyHp: 92, turnCount: 9007199254740991 });

  const activeBoundaryResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'integration-player',
      permitId: 'permit-turn-boundary-active',
      abilityId: 'slash',
      expectedTurnCount: 9007199254740990,
    }),
  });
  const activeBoundary = await activeBoundaryResponse.json();
  assert.equal(activeBoundaryResponse.status, 409,
    'a non-terminal action must not persist an active state at Number.MAX_SAFE_INTEGER');
  assert.equal(activeBoundary.error, 'Battle turn limit reached.');
  assert.equal('battleState' in activeBoundary, false);
  assertPersistedPermitState('permit-turn-boundary-active', {
    status: 'active', playerHp: 80, playerMana: 12, enemyHp: 92, turnCount: 9007199254740990,
  });

  const victoryBoundaryResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'integration-player',
      permitId: 'permit-turn-boundary-victory',
      abilityId: 'crack',
      expectedTurnCount: 9007199254740990,
    }),
  });
  const victoryBoundary = await victoryBoundaryResponse.json();
  assert.equal(victoryBoundaryResponse.status, 200, JSON.stringify(victoryBoundary));
  assert.equal(victoryBoundary.status, 'victory',
    'a terminal victory may resolve on the final safe turn');
  assert.equal(victoryBoundary.playerMana, 0);
  assert.equal(victoryBoundary.enemyHp, 0);
  assert.equal(victoryBoundary.turnCount, 9007199254740991);
  assertPersistedPermitState('permit-turn-boundary-victory', {
    status: 'victory', playerHp: 80, playerMana: 0, enemyHp: 0, turnCount: 9007199254740991,
  });

  const invalidVictory = await complete('permit-invalid-victory-mana');
  assert.equal(invalidVictory.status, 409, 'a victory with out-of-range persisted Mana must not award rewards');
  assert.equal(invalidVictory.data.error, 'Battle state is invalid.');
  assertPersistedPermitState('permit-invalid-victory-mana', {
    status: 'victory', playerHp: 70, playerMana: 13, enemyHp: 0, turnCount: 3,
  });
  for (const [permitId, state] of [
    ['permit-invalid-victory-enemy', { status: 'victory', playerHp: 70, playerMana: 0, enemyHp: 1, turnCount: 1 }],
    ['permit-invalid-victory-turn', { status: 'victory', playerHp: 70, playerMana: 0, enemyHp: 0, turnCount: 0 }],
    ['permit-invalid-victory-fractional-mana', { status: 'victory', playerHp: 70, playerMana: 1.5, enemyHp: 0, turnCount: 3 }],
    ['permit-invalid-victory-fractional-player-hp', { status: 'victory', playerHp: 70.5, playerMana: 0, enemyHp: 0, turnCount: 3 }],
    ['permit-invalid-victory-fractional-enemy-hp', { status: 'victory', playerHp: 70, playerMana: 0, enemyHp: 0.5, turnCount: 3 }],
    ['permit-invalid-victory-fractional-turn', { status: 'victory', playerHp: 70, playerMana: 0, enemyHp: 0, turnCount: 3.5 }],
  ]) {
    const invalid = await complete(permitId);
    assert.equal(invalid.status, 409, `${permitId} must not award an inconsistent victory`);
    assert.equal(invalid.data.error, 'Battle state is invalid.');
    assertPersistedPermitState(permitId, state);
    assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits WHERE id = '${permitId}'
      AND reward_state = 'pending' AND reward_clear_number IS NULL AND completed_at IS NULL`), 1,
      `${permitId} must retain its untouched pending claim`);
  }
  await assertInvalidActionState('permit-invalid-defeat-player', { status: 'defeat', playerHp: 1, playerMana: 0, enemyHp: 92, turnCount: 1 });
  await assertUnsupportedActionPermit('permit-active-unsupported-event', {
    status: 'active', playerHp: 80, playerMana: 12, enemyHp: 92, turnCount: 0,
  });
  await assertUnsupportedActionPermit('permit-active-cycle-mismatch', {
    status: 'active', playerHp: 80, playerMana: 12, enemyHp: 92, turnCount: 0,
  });
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM characters
    WHERE player_id = 'integration-player' AND xp = 0 AND currency = 0`), 1,
    'invalid victories must not grant XP or currency');

  const expiredActionResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'integration-player',
      permitId: 'expired-active',
      abilityId: 'slash',
      expectedTurnCount: 0,
    }),
  });
  const expiredAction = await expiredActionResponse.json();
  assert.equal(expiredActionResponse.status, 409, 'an expired active permit must not accept another turn');
  assert.match(expiredAction.error, /invalid, expired, or already completed/i);
  assertPersistedPermitState('expired-active', {
    status: 'active', playerHp: 80, playerMana: 12, enemyHp: 92, turnCount: 0,
  });

  const wrongOwnerActionResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'someone-else',
      permitId: 'permit-mana-zero',
      abilityId: 'slash',
      expectedTurnCount: 0,
    }),
  });
  const wrongOwnerAction = await wrongOwnerActionResponse.json();
  assert.equal(wrongOwnerActionResponse.status, 409, 'a permit cannot be used by a different player ID');
  assert.match(wrongOwnerAction.error, /invalid, expired, or already completed/i);
  assertPersistedPermitState('permit-mana-zero', {
    status: 'active', playerHp: 80, playerMana: 0, enemyHp: 50, turnCount: 0,
  });

  const terminalActionResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'integration-player',
      permitId: 'permit-a',
      abilityId: 'slash',
      expectedTurnCount: 3,
    }),
  });
  const terminalAction = await terminalActionResponse.json();
  assert.equal(terminalActionResponse.status, 409, 'a server-resolved victory must not accept another turn');
  assert.equal(terminalAction.battleState.status, 'victory');
  assertPersistedPermitState('permit-a', {
    status: 'victory', playerHp: 70, playerMana: 0, enemyHp: 0, turnCount: 3,
  });

  // This player has one terminal victory and no unrelated active/corrupt fixture permits.
  // Other integration-player rows intentionally include active/corrupt permits, which
  // correctly block a new start under the single-active-per-player invariant.
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_permits WHERE player_id='restart-after-victory-player' AND battle_status='active' AND completed_at IS NULL AND julianday(expires_at) > julianday('now')"), 0);
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_permits WHERE id='permit-restart-after-victory' AND player_id='restart-after-victory-player' AND battle_status='victory' AND completed_at IS NULL"), 1, 'the restart fixture must contain a server-resolved terminal victory');
  const startResponse = await fetch(base + '/api/battle/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'restart-after-victory-player',
      eventKey: 'underpass',
      cycleId: 'integration-cycle',
      encounterKey: 'tunnel-maw',
      // A forged start snapshot must be ignored; the Worker owns every combat field.
      playerHp: 1,
      playerMana: 0,
      enemyHp: 1,
      turnCount: 999,
      status: 'victory',
    }),
  });
  const started = await startResponse.json();
  assert.equal(startResponse.status, 200, JSON.stringify(started));
  assert.equal(startResponse.headers.get('cache-control'), 'no-store',
    'server-issued battle permit snapshots must not be cached');
  assert.equal(started.initialState.permitId, started.permitId);
  assert.equal(started.initialState.status, 'active');
  assert.ok(Number.isSafeInteger(started.initialState.playerHp) && started.initialState.playerHp > 1,
    'forged playerHp=1 must not initialize the server-owned encounter');
  assert.ok(Number.isSafeInteger(started.initialState.playerMana) && started.initialState.playerMana > 0,
    'forged playerMana=0 must not initialize the server-owned encounter');
  assert.ok(Number.isSafeInteger(started.initialState.enemyHp) && started.initialState.enemyHp > 1,
    'forged enemyHp=1 must not initialize the server-owned encounter');
  assert.equal(started.initialState.turnCount, 0, 'forged turnCount=999 must be ignored');
  assert.equal(started.initialState.status, 'active', 'forged victory status must be ignored');
  const issuedTimes = queryRows(`SELECT started_at, expires_at FROM battle_permits WHERE id='${started.permitId}'`);
  assert.equal(issuedTimes.length, 1);
  assert.equal(started.expiresAt, issuedTimes[0].expires_at,
    'the returned expiry must be the same D1-authoritative timestamp that was persisted');
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits
    WHERE id='${started.permitId}'
      AND julianday(started_at) <= julianday('now')
      AND julianday(expires_at) > julianday('now')
      AND ABS((julianday(expires_at) - julianday(started_at)) * 1440 - 20) < 0.001`), 1,
    'D1 must issue a non-future start and an expiry exactly 20 minutes after that start');
  assertPersistedPermitState(started.permitId, started.initialState);

  // Concurrent duplicate start attempts with the same idempotency key must converge
  // on one D1 permit. This exercises the actual SQLite uniqueness/ON CONFLICT path,
  // not only the Worker-handler fake used by the deterministic unit tests.
  const concurrentStartRequestId = '00000000-0000-4000-8000-000000000083';
  const concurrentStartBody = JSON.stringify({
    playerId: 'start-race-player',
    eventKey: 'underpass',
    cycleId: 'integration-cycle',
    encounterKey: 'tunnel-maw',
    requestId: concurrentStartRequestId,
  });
  const concurrentStartResponses = await Promise.all([1, 2].map(() => fetch(base + '/api/battle/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: concurrentStartBody,
    signal: AbortSignal.timeout(30_000),
  })));
  const concurrentStarts = await Promise.all(concurrentStartResponses.map(async response => ({
    status: response.status,
    data: await response.json(),
  })));
  for (const result of concurrentStarts) {
    assert.equal(result.status, 200, 'same-key concurrent start must return the existing valid permit: ' + JSON.stringify(result.data));
    assert.equal(result.data.permitId, concurrentStartRequestId);
    assert.equal(result.data.initialState.permitId, concurrentStartRequestId);
    assert.equal(result.data.initialState.status, 'active');
    assert.equal(result.data.initialState.turnCount, 0);
  }
  assert.deepEqual(concurrentStarts[0].data, concurrentStarts[1].data,
    'both concurrent callers must receive the same authoritative permit snapshot and expiry');
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits
    WHERE id='${concurrentStartRequestId}' AND player_id='start-race-player'
      AND event_key='underpass' AND cycle_id='integration-cycle'
      AND encounter_key='tunnel-maw' AND completed_at IS NULL`), 1,
    'concurrent retries must persist exactly one owner-scoped active permit');
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits WHERE player_id='start-race-player'`), 1,
    'the same start key must not create a second permit for the player');
  assertPersistedPermitState(concurrentStartRequestId, concurrentStarts[0].data.initialState);

  // Distinct request IDs from the same player must not create simultaneous
  // encounters. A losing key is rejected without exposing the active permit.
  const distinctStartRequestIds = [
    '00000000-0000-4000-8000-000000000086',
    '00000000-0000-4000-8000-000000000087',
  ];
  const distinctStartResponses = await Promise.all(distinctStartRequestIds.map(requestId => fetch(base + '/api/battle/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'start-distinct-key-player',
      eventKey: 'underpass',
      cycleId: 'integration-cycle',
      encounterKey: 'tunnel-maw',
      requestId,
    }),
    signal: AbortSignal.timeout(30_000),
  })));
  const distinctStartResults = await Promise.all(distinctStartResponses.map(async response => ({
    status: response.status,
    data: await response.json(),
  })));
  assert.equal(distinctStartResults.filter(result => result.status === 200).length, 1,
    'different keys racing for one player must issue exactly one permit');
  assert.equal(distinctStartResults.filter(result => result.status === 409).length, 1,
    'the losing distinct-key request must be rejected');
  const distinctAcceptedIndex = distinctStartResults.findIndex(result => result.status === 200);
  const distinctAccepted = distinctStartResults[distinctAcceptedIndex];
  const distinctRejected = distinctStartResults[1 - distinctAcceptedIndex];
  const distinctAcceptedId = distinctStartRequestIds[distinctAcceptedIndex];
  assert.equal(distinctAccepted.data.permitId, distinctAcceptedId);
  assert.equal(distinctAccepted.data.initialState.permitId, distinctAcceptedId);
  assert.deepEqual(distinctRejected.data, { error: 'The Underpass is sealed.' },
    'the losing request must not receive the active permit ID or combat snapshot');
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_permits WHERE player_id='start-distinct-key-player'"), 1,
    'different idempotency keys must persist only one permit for the player');
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_permits WHERE player_id='start-distinct-key-player' AND completed_at IS NULL AND julianday(expires_at) > julianday('now')"), 1,
    'only one unexpired unresolved permit may exist for the player');
  assertPersistedPermitState(distinctAcceptedId, distinctAccepted.data.initialState);

  // A later distinct key is rejected until the current encounter is settled or expires.
  const thirdDistinctResponse = await fetch(base + '/api/battle/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'start-distinct-key-player',
      eventKey: 'underpass',
      cycleId: 'integration-cycle',
      encounterKey: 'tunnel-maw',
      requestId: '00000000-0000-4000-8000-000000000088',
    }),
  });
  assert.equal(thirdDistinctResponse.status, 409);
  assert.deepEqual(await thirdDistinctResponse.json(), { error: 'The Underpass is sealed.' });
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_permits WHERE player_id='start-distinct-key-player'"), 1,
    'a sequential distinct-key request must not create a second unresolved permit');

  // A terminal defeat is resolved combat, not an active encounter or reward claim.
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist,
    "--command=UPDATE battle_permits SET battle_status='defeat' WHERE id='" + distinctAcceptedId + "'"]);
  const afterDefeatRequestId = '00000000-0000-4000-8000-000000000089';
  const afterDefeatResponse = await fetch(base + '/api/battle/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'start-distinct-key-player',
      eventKey: 'underpass',
      cycleId: 'integration-cycle',
      encounterKey: 'tunnel-maw',
      requestId: afterDefeatRequestId,
    }),
  });
  const afterDefeat = await afterDefeatResponse.json();
  assert.equal(afterDefeatResponse.status, 200, JSON.stringify(afterDefeat));
  assert.equal(afterDefeat.permitId, afterDefeatRequestId);
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_permits WHERE player_id='start-distinct-key-player'"), 2,
    'a resolved defeat must allow a new encounter without granting a reward for the defeat');
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_permits WHERE player_id='start-distinct-key-player' AND completed_at IS NULL AND battle_status IN ('active','victory') AND julianday(expires_at) > julianday('now')"), 1,
    'only the new active encounter remains unresolved for start-guard purposes');

  // A shared idempotency key must never let a concurrent caller recover another player's permit.
  const collisionRequestId = '00000000-0000-4000-8000-000000000085';
  const collisionPlayers = ['start-collision-a', 'start-collision-b'];
  const collisionResponses = await Promise.all(collisionPlayers.map(playerId => fetch(base + '/api/battle/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId,
      eventKey: 'underpass',
      cycleId: 'integration-cycle',
      encounterKey: 'tunnel-maw',
      requestId: collisionRequestId,
    }),
    signal: AbortSignal.timeout(30_000),
  })));
  const collisionResults = await Promise.all(collisionResponses.map(async response => ({
    status: response.status,
    data: await response.json(),
  })));
  assert.equal(collisionResults.filter(result => result.status === 200).length, 1,
    'exactly one owner may win a concurrent start-key collision');
  assert.equal(collisionResults.filter(result => result.status === 409).length, 1,
    'the other owner must be rejected rather than replaying the winner permit');
  const acceptedIndex = collisionResults.findIndex(result => result.status === 200);
  const acceptedCollision = collisionResults[acceptedIndex];
  const rejectedCollision = collisionResults[1 - acceptedIndex];
  assert.equal(acceptedCollision.data.permitId, collisionRequestId);
  assert.equal(acceptedCollision.data.initialState.permitId, collisionRequestId);
  assert.deepEqual(rejectedCollision.data, { error: 'Battle start request is already used or invalid.' },
    'the losing owner must not receive the other player\'s combat snapshot or permit details');
  const collisionRows = queryRows(`SELECT player_id, event_key, cycle_id, encounter_key, completed_at,
      battle_status, player_hp, player_mana, enemy_hp, turn_count
    FROM battle_permits WHERE id='${collisionRequestId}'`);
  assert.equal(collisionRows.length, 1, 'the collided idempotency key must persist one permit only');
  assert.equal(collisionRows[0].player_id, collisionPlayers[acceptedIndex],
    'the persisted permit owner must match the only request that received success');
  assert.equal(collisionRows[0].event_key, 'underpass');
  assert.equal(collisionRows[0].cycle_id, 'integration-cycle');
  assert.equal(collisionRows[0].encounter_key, 'tunnel-maw');
  assert.equal(collisionRows[0].completed_at, null);
  assert.equal(collisionRows[0].battle_status, 'active');
  assert.equal(collisionRows[0].turn_count, 0);
  assertPersistedPermitState(collisionRequestId, acceptedCollision.data.initialState);


  // A lost start response may be retried after the valid permit has already
  // advanced and the event cycle has closed. Replay the D1-owned snapshot rather
  // than resetting HP/Mana/turn count or requiring the event to remain open.
  const startReplayRequestId = '00000000-0000-4000-8000-000000000084';
  const startReplaySeed = join(scratch, 'start-replay-cycle.sql');
  writeFileSync(startReplaySeed, `
    INSERT INTO world_event_cycles(id,event_key,opens_at,closes_at)
      VALUES('start-replay-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+3 hours'));
  `);
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist, '--file=' + startReplaySeed]);
  const startReplayBody = JSON.stringify({
    playerId: 'start-replay-player',
    eventKey: 'underpass',
    cycleId: 'start-replay-cycle',
    encounterKey: 'tunnel-maw',
    requestId: startReplayRequestId,
  });
  const startReplayResponse = await fetch(base + '/api/battle/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: startReplayBody,
  });
  const startReplay = await startReplayResponse.json();
  assert.equal(startReplayResponse.status, 200, JSON.stringify(startReplay));
  const progressedStartReplayResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'start-replay-player',
      permitId: startReplayRequestId,
      abilityId: 'crack',
      expectedTurnCount: 0,
    }),
  });
  const progressedStartReplay = await progressedStartReplayResponse.json();
  assert.equal(progressedStartReplayResponse.status, 200, JSON.stringify(progressedStartReplay));
  assert.deepEqual({
    status: progressedStartReplay.status,
    playerHp: progressedStartReplay.playerHp,
    playerMana: progressedStartReplay.playerMana,
    enemyHp: progressedStartReplay.enemyHp,
    turnCount: progressedStartReplay.turnCount,
  }, { status: 'active', playerHp: 110, playerMana: 8, enemyHp: 57, turnCount: 1 });
  assertPersistedPermitState(startReplayRequestId, progressedStartReplay);
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist,
    "--command=UPDATE battle_permits SET started_at=datetime('now','-2 minutes'), expires_at=datetime('now','+18 minutes') WHERE id='" + startReplayRequestId + "'"]);
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist,
    "--command=UPDATE world_event_cycles SET closes_at=datetime('now','-1 minute') WHERE id='start-replay-cycle'"]);
  const recoveredStartReplayResponse = await fetch(base + '/api/battle/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: startReplayBody,
  });
  const recoveredStartReplay = await recoveredStartReplayResponse.json();
  assert.equal(recoveredStartReplayResponse.status, 200, JSON.stringify(recoveredStartReplay));
  assert.equal(recoveredStartReplay.permitId, startReplayRequestId);
  assert.equal(recoveredStartReplay.expiresAt,
    queryRows("SELECT expires_at FROM battle_permits WHERE id='" + startReplayRequestId + "'")[0]?.expires_at);
  assert.deepEqual(recoveredStartReplay.initialState, progressedStartReplay,
    'a closed-cycle start retry must return the persisted progressed snapshot, not reinitialize combat');
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_permits WHERE id='" + startReplayRequestId + "' AND player_id='start-replay-player'"), 1,
    'start recovery after closure must not issue a second permit');
  assertPersistedPermitState(startReplayRequestId, recoveredStartReplay.initialState);

  const firstActionResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'restart-after-victory-player',
      permitId: started.permitId,
      abilityId: 'crack',
      expectedTurnCount: started.initialState.turnCount,
      // Client-supplied battle state is untrusted and must not affect the turn.
      playerHp: 1,
      playerMana: 0,
      enemyHp: 1,
      turnCount: 999,
    }),
  });
  const firstAction = await firstActionResponse.json();
  assert.equal(firstActionResponse.status, 200, JSON.stringify(firstAction));
  assert.equal(firstActionResponse.headers.get('cache-control'), 'no-store',
    'authoritative battle action snapshots must not be cached');
  assert.equal(firstAction.permitId, started.permitId);
  assert.equal(firstAction.playerMana, started.initialState.playerMana - 4);
  assert.equal(firstAction.playerHp, started.initialState.playerHp - 10);
  assert.equal(firstAction.enemyHp, started.initialState.enemyHp - 35);
  assert.equal(firstAction.turnCount, started.initialState.turnCount + 1);
  assert.equal(firstAction.status, 'active');
  assertPersistedPermitState(started.permitId, firstAction);

  const staleReplayResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'restart-after-victory-player',
      permitId: started.permitId,
      abilityId: 'crack',
      expectedTurnCount: started.initialState.turnCount,
    }),
  });
  const staleReplay = await staleReplayResponse.json();
  assert.equal(staleReplayResponse.status, 409, 'replaying the observed turn must not apply a second action');
  assert.equal(staleReplayResponse.headers.get('cache-control'), 'no-store',
    'authoritative conflict snapshots must not be cached');
  assert.deepEqual(staleReplay.battleState, {
    permitId: started.permitId,
    status: firstAction.status,
    playerHp: firstAction.playerHp,
    playerMana: firstAction.playerMana,
    enemyHp: firstAction.enemyHp,
    turnCount: firstAction.turnCount,
  });
  assertPersistedPermitState(started.permitId, firstAction);

  const freeActionResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'restart-after-victory-player',
      permitId: started.permitId,
      abilityId: 'slash',
      expectedTurnCount: firstAction.turnCount,
    }),
  });
  const freeAction = await freeActionResponse.json();
  assert.equal(freeActionResponse.status, 200, JSON.stringify(freeAction));
  assert.equal(freeAction.playerMana, firstAction.playerMana);
  assert.equal(freeAction.turnCount, firstAction.turnCount + 1);

  const unaffordableResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'integration-player',
      permitId: 'permit-mana-zero',
      abilityId: 'crack',
      expectedTurnCount: 0,
      // Forged client Mana cannot make an unaffordable server action valid.
      playerMana: 999,
      playerHp: 999,
      enemyHp: 1,
      turnCount: 0,
    }),
  });
  const unaffordable = await unaffordableResponse.json();
  assert.equal(unaffordableResponse.status, 409, 'an unaffordable ability must reject');
  assert.equal(unaffordableResponse.headers.get('cache-control'), 'no-store',
    'unaffordable-action state and error responses must not be cached');
  assert.deepEqual(unaffordable.battleState, {
    permitId: 'permit-mana-zero', status: 'active', playerHp: 80, playerMana: 0,
    enemyHp: 50, turnCount: 0,
  });
  assertPersistedPermitState('permit-mana-zero', unaffordable.battleState);

  const freeAtZeroResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'integration-player',
      permitId: 'permit-mana-zero',
      abilityId: 'slash',
      expectedTurnCount: 0,
    }),
  });
  const freeAtZero = await freeAtZeroResponse.json();
  assert.equal(freeAtZeroResponse.status, 200, JSON.stringify(freeAtZero));
  assert.equal(freeAtZeroResponse.headers.get('cache-control'), 'no-store',
    'zero-Mana action results must not be cached');
  assert.equal(freeAtZero.playerMana, 0);
  assert.equal(freeAtZero.turnCount, 1, 'rejected paid action must not advance the turn');
  assert.equal(freeAtZero.playerHp, 70, 'only the accepted free action may apply retaliation');
  assert.equal(freeAtZero.enemyHp, 21, 'only the accepted free action may damage the enemy');
  assertPersistedPermitState('permit-mana-zero', freeAtZero);

  const killingBlowResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'integration-player',
      permitId: 'permit-killing-blow',
      abilityId: 'crack',
      expectedTurnCount: 0,
    }),
  });
  const killingBlow = await killingBlowResponse.json();
  assert.equal(killingBlowResponse.status, 200, JSON.stringify(killingBlow));
  assert.equal(killingBlow.status, 'victory');
  assert.equal(killingBlow.playerHp, 80, 'a killing blow must not trigger enemy retaliation');
  assert.equal(killingBlow.playerMana, 0, 'the killing blow must deduct its Mana cost exactly once');
  assert.equal(killingBlow.enemyHp, 0);
  assert.equal(killingBlow.turnCount, 1);
  assertPersistedPermitState('permit-killing-blow', killingBlow);

  const defeatResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'integration-player',
      permitId: 'permit-defeat',
      abilityId: 'slash',
      expectedTurnCount: 0,
    }),
  });
  const defeat = await defeatResponse.json();
  assert.equal(defeatResponse.status, 200, JSON.stringify(defeat));
  assert.equal(defeat.status, 'defeat');
  assert.equal(defeat.playerHp, 0);
  assert.equal(defeat.playerMana, 0, 'zero-cost action at zero Mana remains usable on defeat');
  assert.equal(defeat.enemyHp, 63);
  assert.equal(defeat.turnCount, 1);
  assertPersistedPermitState('permit-defeat', defeat);

  const malformedTurnResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'integration-player', permitId: 'permit-turn-race',
      abilityId: 'slash', expectedTurnCount: -1,
    }),
  });
  assert.equal(malformedTurnResponse.status, 400, 'invalid expected-turn preconditions must reject');

  const raceRequest = () => fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'integration-player', permitId: 'permit-turn-race',
      abilityId: 'slash', expectedTurnCount: 0,
    }),
  });
  const raceResponses = await Promise.all([raceRequest(), raceRequest()]);
  const raceResults = await Promise.all(raceResponses.map(async response => ({
    status: response.status, data: await response.json(),
  })));
  assert.equal(raceResults.filter(result => result.status === 200).length, 1,
    'exactly one action for the same observed turn may commit');
  assert.equal(raceResults.filter(result => result.status === 409).length, 1,
    'the losing same-turn action must receive a conflict');
  const acceptedRace = raceResults.find(result => result.status === 200).data;
  const rejectedRace = raceResults.find(result => result.status === 409).data;
  assert.equal(acceptedRace.turnCount, 1);
  assert.equal(rejectedRace.battleState.turnCount, 1);
  assert.equal(rejectedRace.battleState.playerHp, acceptedRace.playerHp);
  assert.equal(rejectedRace.battleState.playerMana, acceptedRace.playerMana);
  assert.equal(rejectedRace.battleState.enemyHp, acceptedRace.enemyHp);
  assertPersistedPermitState('permit-turn-race', acceptedRace);

  // A same-turn race with a paid bespoke ability must spend Mana and apply
  // damage/retaliation once, not once per concurrent request.
  const paidRaceRequest = () => fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'integration-player', permitId: 'permit-paid-turn-race',
      abilityId: 'crack', expectedTurnCount: 0,
    }),
  });
  const paidRaceResponses = await Promise.all([paidRaceRequest(), paidRaceRequest()]);
  const paidRaceResults = await Promise.all(paidRaceResponses.map(async response => ({
    status: response.status, data: await response.json(),
  })));
  assert.equal(paidRaceResults.filter(result => result.status === 200).length, 1,
    'exactly one paid action for the same observed turn may commit');
  assert.equal(paidRaceResults.filter(result => result.status === 409).length, 1,
    'the losing paid action must receive a conflict');
  const acceptedPaidRace = paidRaceResults.find(result => result.status === 200).data;
  const rejectedPaidRace = paidRaceResults.find(result => result.status === 409).data;
  assert.equal(acceptedPaidRace.turnCount, 1);
  assert.equal(acceptedPaidRace.playerMana, 0,
    'the accepted paid action deducts its four Mana exactly once');
  assert.equal(acceptedPaidRace.playerHp, 70,
    'only one accepted action may trigger retaliation');
  assert.equal(acceptedPaidRace.enemyHp, 57,
    'only one accepted action may damage the enemy');
  assert.equal(rejectedPaidRace.battleState.turnCount, 1);
  assert.equal(rejectedPaidRace.battleState.playerMana, 0);
  assert.equal(rejectedPaidRace.battleState.playerHp, acceptedPaidRace.playerHp);
  assert.equal(rejectedPaidRace.battleState.enemyHp, acceptedPaidRace.enemyHp);
  assertPersistedPermitState('permit-paid-turn-race', acceptedPaidRace);


  assert.equal((await complete('expired')).status, 409);
  const wrongOwnerCompletion = await complete('permit-a', 'wrong-player', {
    victory: true,
    status: 'victory',
    playerHp: 0,
    playerMana: 999,
    enemyHp: 0,
    turnCount: 999,
    xp: 999999,
    currency: 999999,
    items: ['admin-item'],
    reward: { xp: 999999, currency: 999999, items: ['admin-item'], tier: 'full' },
  });
  assert.equal(wrongOwnerCompletion.status, 409);
  assert.equal(wrongOwnerCompletion.data.error, 'Battle is not an authoritative victory.');
  assert.equal('reward' in wrongOwnerCompletion.data, false,
    'a wrong owner must not receive another player\'s reward receipt');
  assert.equal('player' in wrongOwnerCompletion.data, false,
    'a wrong owner must not receive another player\'s progression snapshot');
  assertPersistedPermitState('permit-a', {
    status: 'victory', playerHp: 70, playerMana: 0, enemyHp: 0, turnCount: 3,
  });
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_permits WHERE id='permit-a' AND reward_state='pending' AND reward_clear_number IS NULL AND completed_at IS NULL"), 1,
    'wrong-owner completion must not claim or reserve the valid permit');
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_history WHERE id='permit-a:victory'"), 0,
    'wrong-owner completion must not write victory history');
  assert.equal(countRows("SELECT COUNT(*) AS n FROM characters WHERE player_id='integration-player' AND level=1 AND xp=0 AND currency=0 AND last_reward_claim_token IS NULL"), 1,
    'wrong-owner completion must not mutate the real owner\'s progression');
  assert.equal(countRows("SELECT COUNT(*) AS n FROM world_event_clears WHERE player_id='integration-player' AND event_key='underpass' AND cycle_id='integration-cycle'"), 0,
    'wrong-owner completion must not reserve a reward sequence');
  const forgedVictoryRewardPayload = {
    victory: false,
    status: 'defeat',
    playerHp: 1,
    playerMana: 999,
    enemyHp: 1,
    turnCount: 999,
    xp: 999999,
    currency: 999999,
    items: ['admin-item'],
    reward: { xp: 999999, currency: 999999, items: ['admin-item'], tier: 'reduced' },
  };
  const [a, b] = await Promise.all([
    eventuallyComplete('permit-a', forgedVictoryRewardPayload),
    eventuallyComplete('permit-b'),
  ]);
  assert.deepEqual({
    xp: a.reward.xp,
    currency: a.reward.currency,
    tier: a.reward.tier,
    items: a.reward.items,
    furniture: a.reward.furniture,
  }, {
    xp: 75,
    currency: 30,
    tier: 'full',
    items: ['underpass-scrap'],
    furniture: ['tunnel-trophy'],
  }, 'the Worker must return the persisted canonical reward, ignoring client reward fields');
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_permits WHERE id='permit-a' AND reward_xp=75 AND reward_currency=30 AND reward_tier='full'"), 1,
    'client reward fields must not alter the stored reward receipt');
  assert.equal(b.reward.xp, 75);
  const concurrentClearSequence = queryRows(`SELECT reward_clear_number
    FROM battle_permits
    WHERE id IN ('permit-a', 'permit-b')
    ORDER BY reward_clear_number`);
  assert.deepEqual(concurrentClearSequence, [
    { reward_clear_number: 1 },
    { reward_clear_number: 2 },
  ], 'simultaneous completions for separate permits must reserve distinct clear slots');

  // A second tab can retry an action after another tab has already settled the
  // victory receipt. The Worker should return the persisted terminal snapshot so
  // the client can re-enter the existing idempotent completion recovery path.
  const completedActionResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'integration-player', permitId: 'permit-b',
      abilityId: 'slash', expectedTurnCount: 3,
    }),
  });
  assert.equal(completedActionResponse.status, 409);
  assert.equal(completedActionResponse.headers.get('cache-control'), 'no-store');
  const completedAction = await completedActionResponse.json();
  assert.equal(completedAction.error, 'Battle permit is already completed.');
  assert.deepEqual(completedAction.battleState, {
    permitId: 'permit-b', status: 'victory', playerHp: 70,
    playerMana: 0, enemyHp: 0, turnCount: 3,
  });
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_permits WHERE id='permit-b' AND completed_at IS NOT NULL AND reward_state='awarded' AND battle_status='victory' AND turn_count=3"), 1,
    'retrying an action after settlement must not change the completed permit or receipt');
  // Once awarded, the persisted receipt remains replayable even if the combat snapshot is later corrupt.
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist,
    "--command=UPDATE battle_permits SET player_mana = 13 WHERE id = 'permit-a'"]);
  const replayResponse = await complete('permit-a', 'integration-player', {
    victory: false,
    status: 'defeat',
    playerHp: 1,
    playerMana: 999,
    enemyHp: 1,
    turnCount: 999,
    xp: 0,
    currency: 0,
    items: [],
    reward: { xp: 0, currency: 0, items: [], tier: 'reduced' },
  });
  assert.equal(replayResponse.status, 200,
    'an already-awarded receipt must remain idempotent despite later invalid state and hostile client reward fields');
  const replay = replayResponse.data;
  assert.deepEqual(replay.reward, a.reward,
    'an idempotent replay must return the original canonical receipt, not caller-supplied reward values');
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_history WHERE id = 'permit-a:victory'"), 1,
    'replaying an awarded receipt must not create a second victory history row');
  assert.equal(replay.player.level, 2);
  assert.equal(replay.player.xp, 50);
  assert.equal(replay.player.currency, 60);
  assert.equal(replay.worldEvent.fullRewardClears, 2);
  assert.equal(replay.player.inventory.filter(x => x === 'underpass-scrap').length, 2);

  // An awarded receipt can still recover the original result if even the persisted
  // terminal status is later corrupted; the audited receipt must not award twice.
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist,
    "--command=UPDATE battle_permits SET battle_status = 'active' WHERE id = 'permit-a'"]);
  const corruptedTerminalReplay = await complete('permit-a', 'integration-player', {
    status: 'victory', playerMana: 999, xp: 999999, currency: 999999,
    items: ['admin-item'], reward: { xp: 999999, currency: 999999, items: ['admin-item'], tier: 'full' },
  });
  assert.equal(corruptedTerminalReplay.status, 200,
    'a valid, already-awarded receipt must recover despite a later corrupted battle_status');
  assert.deepEqual(corruptedTerminalReplay.data.reward, a.reward,
    'terminal snapshot corruption must not replace the audited canonical reward');
  assert.equal(corruptedTerminalReplay.data.player.level, 2);
  assert.equal(corruptedTerminalReplay.data.player.xp, 50);
  assert.equal(corruptedTerminalReplay.data.player.currency, 60);
  assert.equal(corruptedTerminalReplay.data.player.inventory.filter(x => x === 'underpass-scrap').length, 2);
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_history WHERE id = 'permit-a:victory'"), 1,
    'recovery after terminal-status corruption must not duplicate battle history');
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_permits WHERE id='permit-a' AND battle_status='active' AND reward_state='awarded' AND completed_at IS NOT NULL"), 1,
    'replay must recover the audited receipt without rewriting the corrupted combat snapshot');
  assert.equal((await eventuallyComplete('permit-c')).reward.tier, 'full');
  assert.equal((await eventuallyComplete('permit-d')).reward.tier, 'reduced');
  const final = await eventuallyComplete('permit-d');
  assert.equal(final.player.level, 2);
  assert.equal(final.player.xp, 135);
  assert.equal(final.player.currency, 93);
  assert.equal(final.worldEvent.fullRewardClears, 4);
  assert.equal(final.player.inventory.filter(x => x === 'underpass-scrap').length, 3);
  assert.equal((await complete('expired')).status, 409);

  // Race a killing action against completion: only a Worker-resolved victory may award.
  const [raceActionResponse, earlyCompletion] = await Promise.all([
    fetch(base + '/api/battle/action', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId: 'integration-player', permitId: 'permit-e',
        abilityId: 'slash', expectedTurnCount: 0,
      }),
    }),
    complete('permit-e'),
  ]);
  const raceAction = await raceActionResponse.json();
  assert.equal(raceActionResponse.status, 200, JSON.stringify(raceAction));
  assert.equal(raceAction.status, 'victory');
  assert.equal(raceAction.enemyHp, 0);
  assert.equal(raceAction.turnCount, 1);
  assert.ok([200, 409].includes(earlyCompletion.status),
    'completion may observe either active state (409) or the committed server victory (200)');

  // Two simultaneous completion attempts must converge on the same persisted receipt.
  const [completionA, completionB] = await Promise.all([
    eventuallyComplete('permit-e'),
    eventuallyComplete('permit-e'),
  ]);
  assert.equal(completionA.reward.tier, 'reduced', 'fifth clear should use the existing reduced tier');
  assert.equal(completionB.reward.tier, completionA.reward.tier);
  assert.equal(completionB.reward.xp, completionA.reward.xp);
  assert.equal(completionB.reward.currency, completionA.reward.currency);
  assert.equal(completionA.player.currency, final.player.currency + completionA.reward.currency,
    'concurrent completion must apply currency exactly once');
  assert.equal(completionB.player.currency, completionA.player.currency);
  assert.equal(completionA.player.inventory.filter(x => x === 'underpass-scrap').length, 3,
    'reduced duplicate completion must not add another scrap');
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_history WHERE id = 'permit-e:victory'"), 1,
    'one victory receipt/history row must exist for the permit');
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_permits WHERE id = 'permit-e' AND reward_state = 'awarded' AND battle_status = 'victory' AND enemy_hp = 0 AND turn_count = 1"), 1,
    'the completed permit must retain one authoritative terminal state');

  // Repeat the action/completion race with a paid killing blow that consumes the
  // Degen's final Mana. The receipt race must not charge the ability twice or
  // let completion observe a client-authored outcome.
  const paidRaceCurrencyBefore = queryRows("SELECT currency FROM characters WHERE player_id='paid-killing-race-player'")[0]?.currency;
  assert.equal(paidRaceCurrencyBefore, 0, 'the isolated race fixture starts with no currency');
  const [paidRaceActionResponse, paidRaceEarlyCompletion] = await Promise.all([
    fetch(base + '/api/battle/action', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId: 'paid-killing-race-player', permitId: 'permit-paid-killing-race',
        abilityId: 'crack', expectedTurnCount: 0,
      }),
    }),
    complete('permit-paid-killing-race', 'paid-killing-race-player'),
  ]);
  const paidRaceAction = await paidRaceActionResponse.json();
  assert.equal(paidRaceActionResponse.status, 200, JSON.stringify(paidRaceAction));
  assert.equal(paidRaceAction.status, 'victory');
  assert.equal(paidRaceAction.playerHp, 80, 'a killing blow must not receive retaliation');
  assert.equal(paidRaceAction.playerMana, 0, 'the paid killing blow must spend the final Mana');
  assert.equal(paidRaceAction.enemyHp, 0);
  assert.equal(paidRaceAction.turnCount, 1);
  assert.ok([200, 409].includes(paidRaceEarlyCompletion.status),
    'completion may see the active permit or the committed Worker victory');
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_permits WHERE id='permit-paid-killing-race' AND battle_status='victory' AND player_hp=80 AND player_mana=0 AND enemy_hp=0 AND turn_count=1"), 1,
    'the authoritative paid killing-blow state must be persisted exactly once');

  const [paidCompletionA, paidCompletionB] = await Promise.all([
    eventuallyComplete('permit-paid-killing-race', {}, 'paid-killing-race-player'),
    eventuallyComplete('permit-paid-killing-race', {}, 'paid-killing-race-player'),
  ]);
  assert.equal(paidCompletionA.reward.tier, 'full');
  assert.deepEqual(paidCompletionB.reward, paidCompletionA.reward,
    'concurrent retries must return the same stored paid-killing-blow receipt');
  assert.equal(paidCompletionA.player.currency, paidRaceCurrencyBefore + paidCompletionA.reward.currency,
    'the paid killing-blow reward must apply currency exactly once');
  assert.equal(paidCompletionB.player.currency, paidCompletionA.player.currency);
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_history WHERE id='permit-paid-killing-race:victory'"), 1,
    'one victory history row must exist for the paid killing-blow permit');
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_permits WHERE id='permit-paid-killing-race' AND reward_state='awarded' AND battle_status='victory' AND player_hp=80 AND player_mana=0 AND enemy_hp=0 AND turn_count=1"), 1,
    'the final paid Mana state and awarded receipt must agree');

  // A permit already issued while the Underpass is open remains legal until its own expiry.
  // Closing the world-event cycle must not interrupt an encounter or move its reward to a new cycle.
  const closureSeed = join(scratch, 'closure-cycle.sql');
  writeFileSync(closureSeed, `
    INSERT INTO world_event_cycles(id,event_key,opens_at,closes_at)
      VALUES('closure-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+4 hours'));
  `);
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist, '--file=' + closureSeed]);

  const closureStartResponse = await fetch(base + '/api/battle/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'closure-active-player',
      eventKey: 'underpass',
      cycleId: 'closure-cycle',
      encounterKey: 'tunnel-maw',
    }),
  });
  const closureStart = await closureStartResponse.json();
  assert.equal(closureStartResponse.status, 200, JSON.stringify(closureStart));
  assert.equal(closureStart.initialState.status, 'active');
  assert.equal(closureStart.initialState.turnCount, 0);

  // Each player may have only one unresolved active permit, so use a separate
  // player for the expiry half of this event-closure scenario.
  const expiredClosureStartResponse = await fetch(base + '/api/battle/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'expired-after-cycle-player',
      eventKey: 'underpass',
      cycleId: 'closure-cycle',
      encounterKey: 'tunnel-maw',
    }),
  });
  const expiredClosureStart = await expiredClosureStartResponse.json();
  assert.equal(expiredClosureStartResponse.status, 200, JSON.stringify(expiredClosureStart));

  // Preserve the entry-before-close chronology for both issued permits. The
  // simulated close is moved into the past for a deterministic test, so backdate
  // their persisted start times first; neither permit should be retroactively invalidated.
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist,
    "--command=UPDATE battle_permits SET started_at = datetime('now','-2 minutes') WHERE id IN ('" + closureStart.permitId + "','" + expiredClosureStart.permitId + "')"]);
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist,
    "--command=UPDATE world_event_cycles SET closes_at = datetime('now','-1 minute') WHERE id = 'closure-cycle'"]);

  const closedCycleStartResponse = await fetch(base + '/api/battle/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'closed-cycle-entry-player',
      eventKey: 'underpass',
      cycleId: 'closure-cycle',
      encounterKey: 'tunnel-maw',
    }),
  });
  assert.equal(closedCycleStartResponse.status, 409,
    'a closed cycle cannot issue a new permit even while an earlier permit remains valid');
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_permits WHERE cycle_id = 'closure-cycle'"), 2,
    'failed entry after closure must not create another permit');

  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist,
    `--command=UPDATE battle_permits SET expires_at = datetime('now','-1 minute') WHERE id = '${expiredClosureStart.permitId}'`]);

  const expiredAfterClosureResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'expired-after-cycle-player',
      permitId: expiredClosureStart.permitId,
      abilityId: 'slash',
      expectedTurnCount: 0,
    }),
  });
  const expiredAfterClosure = await expiredAfterClosureResponse.json();
  assert.equal(expiredAfterClosureResponse.status, 409, 'cycle closure does not extend a permit past its own expiry');
  assert.match(expiredAfterClosure.error, /invalid, expired, or already completed/i);
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits WHERE id = '${expiredClosureStart.permitId}'
    AND player_id = 'expired-after-cycle-player'
    AND battle_status = 'active' AND turn_count = 0
    AND player_hp = ${expiredClosureStart.initialState.playerHp}
    AND player_mana = ${expiredClosureStart.initialState.playerMana}
    AND enemy_hp = ${expiredClosureStart.initialState.enemyHp}`), 1,
    'an expired permit must remain unchanged even when its event cycle is closed');

  let closureResult = closureStart.initialState;
  for (let expectedTurnCount = 0; expectedTurnCount < 3; expectedTurnCount += 1) {
    const response = await fetch(base + '/api/battle/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId: 'closure-active-player',
        permitId: closureStart.permitId,
        abilityId: 'crack',
        expectedTurnCount,
      }),
    });
    const action = await response.json();
    assert.equal(response.status, 200, JSON.stringify(action));
    assert.equal(action.turnCount, expectedTurnCount + 1);
    assert.equal(action.status, expectedTurnCount === 2 ? 'victory' : 'active');
    closureResult = action;
  }
  assert.equal(closureResult.playerMana, 0);
  assert.equal(closureResult.enemyHp, 0);
  assert.equal(closureResult.playerHp, closureStart.initialState.playerHp - 20,
    'the two non-lethal enemy turns retaliate; the killing blow does not');

  const closureCompletion = await eventuallyComplete(closureStart.permitId, {}, 'closure-active-player');
  assert.equal(closureCompletion.reward.tier, 'full');
  assert.equal(closureCompletion.reward.xp, 75);
  assert.equal(closureCompletion.reward.currency, 30);
  assert.equal(closureCompletion.worldEvent.cycleId, 'closure-cycle',
    'completion remains attributed to the permit original cycle after closure');
  assert.equal(closureCompletion.worldEvent.phase, 'sealed');
  assert.equal(closureCompletion.worldEvent.fullRewardClears, 1);
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_history WHERE id = '${closureStart.permitId}:victory'`), 1);
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits WHERE id = '${closureStart.permitId}'
    AND cycle_id = 'closure-cycle' AND battle_status = 'victory' AND reward_state = 'awarded'
    AND player_mana = 0 AND enemy_hp = 0 AND turn_count = 3`), 1,
    'the closed-cycle encounter must retain one authoritative awarded receipt');

  // A Worker-resolved victory that committed before expiry remains recoverable if the
  // response was lost and the player retries only after the permit has expired.
  const expiredVictoryActionResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'integration-player', permitId: 'permit-expired-victory',
      abilityId: 'slash', expectedTurnCount: 0,
    }),
  });
  const expiredVictoryAction = await expiredVictoryActionResponse.json();
  assert.equal(expiredVictoryActionResponse.status, 200, JSON.stringify(expiredVictoryAction));
  assert.equal(expiredVictoryAction.status, 'victory');
  assert.deepEqual(
    [expiredVictoryAction.playerHp, expiredVictoryAction.playerMana, expiredVictoryAction.enemyHp, expiredVictoryAction.turnCount],
    [80, 0, 0, 1],
  );
  assertPersistedPermitState('permit-expired-victory', {
    status: 'victory', playerHp: 80, playerMana: 0, enemyHp: 0, turnCount: 1,
  });
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist,
    "--command=UPDATE battle_permits SET expires_at = datetime('now','-1 minute') WHERE id = 'permit-expired-victory'"]);

  const expiredVictoryActionReplayResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'integration-player', permitId: 'permit-expired-victory',
      abilityId: 'slash', expectedTurnCount: 1,
    }),
  });
  const expiredVictoryActionReplay = await expiredVictoryActionReplayResponse.json();
  assert.equal(expiredVictoryActionReplayResponse.status, 409);
  assert.equal(expiredVictoryActionReplay.error, 'Battle victory is awaiting reward completion.');
  assert.deepEqual(expiredVictoryActionReplay.battleState, {
    permitId: 'permit-expired-victory', status: 'victory',
    playerHp: 80, playerMana: 0, enemyHp: 0, turnCount: 1,
  }, 'the retry may recover a terminal snapshot but cannot apply another action');
  assertPersistedPermitState('permit-expired-victory', {
    status: 'victory', playerHp: 80, playerMana: 0, enemyHp: 0, turnCount: 1,
  });

  const expiredVictoryCompletion = await complete('permit-expired-victory');
  assert.equal(expiredVictoryCompletion.status, 200, JSON.stringify(expiredVictoryCompletion.data));
  const expiredVictoryReplay = await complete('permit-expired-victory');
  assert.equal(expiredVictoryReplay.status, 200);
  assert.deepEqual(expiredVictoryReplay.data.reward, expiredVictoryCompletion.data.reward);
  assert.equal(expiredVictoryReplay.data.player.xp, expiredVictoryCompletion.data.player.xp);
  assert.equal(expiredVictoryReplay.data.player.currency, expiredVictoryCompletion.data.player.currency);
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_history WHERE id = 'permit-expired-victory:victory'"), 1,
    'late settlement of an already-resolved victory must still award exactly once');
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits WHERE id = 'permit-expired-victory'
    AND julianday(expires_at) < julianday('now') AND battle_status = 'victory'
    AND reward_state = 'awarded' AND completed_at IS NOT NULL AND turn_count = 1`), 1);

  // Defeat also recovers as terminal presentation only; it never opens a reward path.
  const expiredDefeatActionResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'integration-player', permitId: 'permit-expired-defeat',
      abilityId: 'slash', expectedTurnCount: 0,
    }),
  });
  const expiredDefeatAction = await expiredDefeatActionResponse.json();
  assert.equal(expiredDefeatActionResponse.status, 200, JSON.stringify(expiredDefeatAction));
  assert.equal(expiredDefeatAction.status, 'defeat');
  assert.deepEqual(
    [expiredDefeatAction.playerHp, expiredDefeatAction.playerMana, expiredDefeatAction.enemyHp, expiredDefeatAction.turnCount],
    [0, 0, 63, 1],
  );
  assertPersistedPermitState('permit-expired-defeat', {
    status: 'defeat', playerHp: 0, playerMana: 0, enemyHp: 63, turnCount: 1,
  });
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist,
    "--command=UPDATE battle_permits SET expires_at = datetime('now','-1 minute') WHERE id = 'permit-expired-defeat'"]);

  const expiredDefeatReplayResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'integration-player', permitId: 'permit-expired-defeat',
      abilityId: 'slash', expectedTurnCount: 1,
    }),
  });
  const expiredDefeatReplay = await expiredDefeatReplayResponse.json();
  assert.equal(expiredDefeatReplayResponse.status, 409);
  assert.equal(expiredDefeatReplay.error, 'Battle is already defeated.');
  assert.deepEqual(expiredDefeatReplay.battleState, {
    permitId: 'permit-expired-defeat', status: 'defeat',
    playerHp: 0, playerMana: 0, enemyHp: 63, turnCount: 1,
  });
  assertPersistedPermitState('permit-expired-defeat', {
    status: 'defeat', playerHp: 0, playerMana: 0, enemyHp: 63, turnCount: 1,
  });
  assert.equal((await complete('permit-expired-defeat')).status, 409,
    'a recovered defeat must never be eligible for victory rewards');
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_history WHERE id = 'permit-expired-defeat:defeat' AND result = 'defeat'"), 1);
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_history WHERE id = 'permit-expired-defeat:victory'"), 0);
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_permits WHERE id = 'permit-expired-defeat' AND reward_state = 'pending' AND completed_at IS NULL"), 1);

  // Awarded receipts may replay only when their stored reward and history audit agree.
  // Preserve the legitimate awarded-receipt replay above, where only the old combat
  // snapshot was corrupted; these fixtures corrupt the independent reward receipt.
  const corruptReceiptSeed = join(scratch, 'corrupt-awarded-receipts.sql');
  writeFileSync(corruptReceiptSeed, `
    UPDATE battle_permits SET reward_state='awarded', reward_clear_number=1,
      reward_xp=999999, reward_currency=30, reward_tier='full', reward_level=2,
      reward_remaining_xp=50, reward_claim_token='corrupt-reward-token',
      reward_claimed_at=CURRENT_TIMESTAMP, completed_at=CURRENT_TIMESTAMP
    WHERE id='permit-corrupt-awarded-reward';
    UPDATE battle_permits SET reward_state='awarded', reward_clear_number=1,
      reward_xp=75, reward_currency=30, reward_tier='full', reward_level=2,
      reward_remaining_xp=50, reward_claim_token='missing-history-token',
      reward_claimed_at=CURRENT_TIMESTAMP, completed_at=CURRENT_TIMESTAMP
    WHERE id='permit-awarded-without-history';
    UPDATE battle_permits SET reward_state='awarded', reward_clear_number=999999,
      reward_xp=10, reward_currency=3, reward_tier='reduced', reward_level=2,
      reward_remaining_xp=50, reward_claim_token='ahead-clear-token',
      reward_claimed_at=CURRENT_TIMESTAMP, completed_at=CURRENT_TIMESTAMP
    WHERE id='permit-awarded-clear-ahead';
    UPDATE battle_permits SET reward_state='awarded', reward_clear_number=1,
      reward_xp=75, reward_currency=30, reward_tier='full', reward_level=2,
      reward_remaining_xp=50, reward_claim_token='missing-counter-token',
      reward_claimed_at=CURRENT_TIMESTAMP, completed_at=CURRENT_TIMESTAMP
    WHERE id='permit-awarded-no-counter';
    UPDATE battle_permits SET reward_state='awarded', reward_clear_number=1,
      reward_xp=75, reward_currency=30, reward_tier='full', reward_level=2,
      reward_remaining_xp=175, reward_claim_token='invalid-xp-residual-token',
      reward_claimed_at=CURRENT_TIMESTAMP, completed_at=CURRENT_TIMESTAMP
    WHERE id='permit-awarded-invalid-xp-residual';
    UPDATE battle_permits SET reward_state='awarded', reward_clear_number=1,
      reward_xp=75, reward_currency=30, reward_tier='full', reward_level=2,
      reward_remaining_xp=174, reward_claim_token='xp-residual-boundary-token',
      reward_claimed_at=CURRENT_TIMESTAMP, completed_at=CURRENT_TIMESTAMP
    WHERE id='permit-awarded-xp-residual-boundary';
    UPDATE battle_permits SET reward_state='awarded', reward_clear_number=1,
      reward_xp=75, reward_currency=30, reward_tier='full', reward_level=2,
      reward_remaining_xp=-1, reward_claim_token='negative-xp-residual-token',
      reward_claimed_at=CURRENT_TIMESTAMP, completed_at=CURRENT_TIMESTAMP
    WHERE id='permit-awarded-negative-xp-residual';
    UPDATE battle_permits SET reward_state='awarded', reward_clear_number=1,
      reward_xp=75, reward_currency=30, reward_tier='full', reward_level=2,
      reward_remaining_xp=1.5, reward_claim_token='fractional-xp-residual-token',
      reward_claimed_at=CURRENT_TIMESTAMP, completed_at=CURRENT_TIMESTAMP
    WHERE id='permit-awarded-fractional-xp-residual';
    UPDATE battle_permits SET reward_state='awarded', reward_clear_number=1,
      reward_xp=75, reward_currency=30, reward_tier='full', reward_level=120095990063214,
      reward_remaining_xp=0, reward_claim_token='unsafe-xp-threshold-token',
      reward_claimed_at=CURRENT_TIMESTAMP, completed_at=CURRENT_TIMESTAMP
    WHERE id='permit-awarded-unsafe-xp-threshold';
    INSERT INTO world_event_clears (player_id, event_key, cycle_id, full_reward_clears)
      VALUES ('integration-player', 'underpass', 'invalid-xp-residual-cycle', 1),
        ('xp-boundary-player', 'underpass', 'xp-residual-boundary-cycle', 1),
        ('integration-player', 'underpass', 'negative-xp-residual-cycle', 1),
        ('integration-player', 'underpass', 'fractional-xp-residual-cycle', 1),
        ('integration-player', 'underpass', 'unsafe-xp-threshold-cycle', 1);
    INSERT INTO battle_history
      (id, player_id, encounter_key, result, player_level, xp_awarded, currency_awarded)
    VALUES ('permit-corrupt-awarded-reward:victory', 'integration-player',
      'tunnel-maw', 'victory', 2, 999999, 30),
      ('permit-awarded-clear-ahead:victory', 'integration-player',
      'tunnel-maw', 'victory', 2, 10, 3),
      ('permit-awarded-no-counter:victory', 'integration-player',
      'tunnel-maw', 'victory', 2, 75, 30),
      ('permit-awarded-invalid-xp-residual:victory', 'integration-player',
      'tunnel-maw', 'victory', 2, 75, 30),
      ('permit-awarded-xp-residual-boundary:victory', 'xp-boundary-player',
      'tunnel-maw', 'victory', 2, 75, 30),
      ('permit-awarded-negative-xp-residual:victory', 'integration-player',
      'tunnel-maw', 'victory', 2, 75, 30),
      ('permit-awarded-fractional-xp-residual:victory', 'integration-player',
      'tunnel-maw', 'victory', 2, 75, 30),
      ('permit-awarded-unsafe-xp-threshold:victory', 'integration-player',
      'tunnel-maw', 'victory', 120095990063214, 75, 30);
    INSERT INTO world_event_clears (player_id, event_key, cycle_id, full_reward_clears)
    SELECT 'integration-player', 'underpass', 'duplicate-receipt-cycle', reward_clear_number
      FROM battle_permits WHERE id='permit-a';
    UPDATE battle_permits SET reward_state='awarded',
      reward_clear_number=(SELECT reward_clear_number FROM battle_permits WHERE id='permit-a'),
      reward_xp=(SELECT reward_xp FROM battle_permits WHERE id='permit-a'),
      reward_currency=(SELECT reward_currency FROM battle_permits WHERE id='permit-a'),
      reward_tier=(SELECT reward_tier FROM battle_permits WHERE id='permit-a'),
      reward_level=(SELECT reward_level FROM battle_permits WHERE id='permit-a'),
      reward_remaining_xp=(SELECT reward_remaining_xp FROM battle_permits WHERE id='permit-a'),
      reward_claim_token='duplicate-clear-token-a', reward_claimed_at=CURRENT_TIMESTAMP,
      completed_at=CURRENT_TIMESTAMP
    WHERE id='permit-awarded-duplicate-clear';
    UPDATE battle_permits SET reward_state='awarded',
      reward_clear_number=(SELECT reward_clear_number FROM battle_permits WHERE id='permit-a'),
      reward_xp=(SELECT reward_xp FROM battle_permits WHERE id='permit-a'),
      reward_currency=(SELECT reward_currency FROM battle_permits WHERE id='permit-a'),
      reward_tier=(SELECT reward_tier FROM battle_permits WHERE id='permit-a'),
      reward_level=(SELECT reward_level FROM battle_permits WHERE id='permit-a'),
      reward_remaining_xp=(SELECT reward_remaining_xp FROM battle_permits WHERE id='permit-a'),
      reward_claim_token='duplicate-clear-token-b', reward_claimed_at=CURRENT_TIMESTAMP,
      completed_at=CURRENT_TIMESTAMP
    WHERE id='permit-awarded-duplicate-peer';
    INSERT INTO battle_history
      (id, player_id, encounter_key, result, player_level, xp_awarded, currency_awarded)
    SELECT 'permit-awarded-duplicate-clear:victory', player_id, encounter_key,
      'victory', reward_level, reward_xp, reward_currency
    FROM battle_permits WHERE id='permit-awarded-duplicate-clear';
    INSERT INTO battle_history
      (id, player_id, encounter_key, result, player_level, xp_awarded, currency_awarded)
    SELECT 'permit-awarded-duplicate-peer:victory', player_id, encounter_key,
      'victory', reward_level, reward_xp, reward_currency
    FROM battle_permits WHERE id='permit-awarded-duplicate-peer';
  `);
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist, '--file=' + corruptReceiptSeed]);

  for (const [permitId, expectedHistoryCount, expectedClearNumber] of [
    ['permit-corrupt-awarded-reward', 1, 1],
    ['permit-awarded-without-history', 0, 1],
    ['permit-awarded-clear-ahead', 1, 999999],
    ['permit-awarded-no-counter', 1, 1],
    ['permit-awarded-invalid-xp-residual', 1, 1],
    ['permit-awarded-negative-xp-residual', 1, 1],
    ['permit-awarded-fractional-xp-residual', 1, 1],
    ['permit-awarded-unsafe-xp-threshold', 1, 1],
  ]) {
    const rejectedReceipt = await complete(permitId, 'integration-player', {
      victory: true, xp: 999999, currency: 999999, items: ['forged-item'],
    });
    assert.equal(rejectedReceipt.status, 409, JSON.stringify(rejectedReceipt.data));
    assert.equal(rejectedReceipt.data.error, 'Battle reward receipt is invalid.');
    assert.equal('reward' in rejectedReceipt.data, false,
      'invalid awarded receipts must not return an unaudited reward payload');
    assert.equal('player' in rejectedReceipt.data, false,
      'invalid awarded receipts must not return a misleading progression snapshot');
    assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits WHERE id='${permitId}'
      AND reward_state='awarded' AND completed_at IS NOT NULL AND reward_clear_number=${expectedClearNumber}`), 1,
      'receipt validation must not rewrite or release an already-awarded permit');
    assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_history WHERE id='${permitId}:victory'`),
      expectedHistoryCount, 'receipt validation must not create or duplicate history');
  }
  assert.deepEqual(queryRows(`SELECT reward_remaining_xp FROM battle_permits
    WHERE id='permit-awarded-invalid-xp-residual'`), [{ reward_remaining_xp: 175 }],
    'receipt audit must reject a remainder exactly at the next-level threshold without rewriting the historical receipt');
  assert.deepEqual(queryRows(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id='integration-player' AND event_key='underpass'
      AND cycle_id='invalid-xp-residual-cycle'`), [{ full_reward_clears: 1 }],
    'invalid XP remainder must not mutate the already-reserved clear counter');
  assert.deepEqual(queryRows(`SELECT reward_remaining_xp FROM battle_permits
    WHERE id='permit-awarded-negative-xp-residual'`), [{ reward_remaining_xp: -1 }]);
  assert.deepEqual(queryRows(`SELECT reward_remaining_xp FROM battle_permits
    WHERE id='permit-awarded-fractional-xp-residual'`), [{ reward_remaining_xp: 1.5 }]);
  assert.deepEqual(queryRows(`SELECT reward_level, reward_remaining_xp FROM battle_permits
    WHERE id='permit-awarded-unsafe-xp-threshold'`), [{ reward_level: 120095990063214, reward_remaining_xp: 0 }],
    'an unsafe XP threshold must reject replay without rewriting the historical receipt');
  assert.deepEqual(queryRows(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id='integration-player' AND event_key='underpass'
      AND cycle_id='unsafe-xp-threshold-cycle'`), [{ full_reward_clears: 1 }],
    'an unsafe XP threshold must not alter the already-reserved clear counter');
  for (const cycleId of ['negative-xp-residual-cycle', 'fractional-xp-residual-cycle']) {
    assert.equal(countRows(`SELECT full_reward_clears AS n FROM world_event_clears
      WHERE player_id='integration-player' AND event_key='underpass' AND cycle_id='${cycleId}'`), 1,
      'malformed XP remainder must not mutate the reserved clear counter');
  }

  const boundaryReplay = await complete('permit-awarded-xp-residual-boundary', 'xp-boundary-player');
  assert.equal(boundaryReplay.status, 200, JSON.stringify(boundaryReplay.data));
  assert.deepEqual(boundaryReplay.data.reward, {
    xp: 75, currency: 30, items: ['underpass-scrap'],
    furniture: ['tunnel-trophy'], tier: 'full',
  }, 'the maximum valid post-level XP remainder must remain replayable');
  assert.equal(boundaryReplay.data.player.level, 2);
  assert.equal(boundaryReplay.data.player.xp, 174);
  assert.equal(boundaryReplay.data.player.currency, 30);
  assert.deepEqual(queryRows(`SELECT reward_remaining_xp FROM battle_permits
    WHERE id='permit-awarded-xp-residual-boundary' AND reward_state='awarded'`), [{ reward_remaining_xp: 174 }],
    'replaying the boundary receipt must not rewrite the original remainder');
  assert.equal(countRows(`SELECT full_reward_clears AS n FROM world_event_clears
    WHERE player_id='xp-boundary-player' AND event_key='underpass'
      AND cycle_id='xp-residual-boundary-cycle'`), 1,
    'replaying a valid boundary receipt must not increment the clear counter');
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id='permit-awarded-xp-residual-boundary:victory'`), 1,
    'replaying a valid boundary receipt must not duplicate victory history');

  // Two internally consistent awarded receipts cannot claim the same sequence slot.
  // Seed a duplicate only after permit-a has completed normally, so both rows carry
  // canonical reward fields and matching history; replay must still fail closed.
  for (const permitId of ['permit-awarded-duplicate-clear', 'permit-awarded-duplicate-peer']) {
    const duplicateReplay = await complete(permitId, 'integration-player', {
      victory: true, xp: 999999, currency: 999999, items: ['forged-item'],
    });
    assert.equal(duplicateReplay.status, 409, JSON.stringify(duplicateReplay.data));
    assert.equal(duplicateReplay.data.error, 'Battle reward receipt is invalid.');
    assert.equal('reward' in duplicateReplay.data, false);
    assert.equal('player' in duplicateReplay.data, false);
  }
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits
    WHERE player_id='integration-player' AND event_key='underpass'
      AND cycle_id='duplicate-receipt-cycle'
      AND reward_clear_number=(SELECT reward_clear_number FROM battle_permits WHERE id='permit-awarded-duplicate-clear')`), 2,
    'the isolated fixture must prove exactly two receipts share the same cycle sequence slot');
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id IN ('permit-awarded-duplicate-clear:victory','permit-awarded-duplicate-peer:victory')`), 2,
    'both matching history rows remain unchanged when duplicate receipt replay is rejected');
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM world_event_clears
    WHERE player_id='integration-player' AND event_key='underpass'
      AND cycle_id='duplicate-receipt-cycle'
      AND full_reward_clears=(SELECT reward_clear_number FROM battle_permits WHERE id='permit-awarded-duplicate-clear')`), 1,
    'duplicate receipt replay must not alter the isolated cycle clear counter');
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM world_event_clears
    WHERE player_id='integration-player' AND event_key='underpass'
      AND cycle_id='integration-cycle' AND full_reward_clears=6`), 1,
    'invalid receipt replay must not reserve another event clear');
  // A corrupt cycle counter must not let a new victory reuse an already-reserved sequence slot.
  const progressBeforeCounterLag = queryRows(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id='integration-player'`);
  const counterLagCompletion = await complete('permit-counter-lag-pending');
  assert.equal(counterLagCompletion.status, 409, JSON.stringify(counterLagCompletion.data));
  assert.equal(counterLagCompletion.data.error, 'Unable to assign authoritative reward clear.');
  assert.equal('reward' in counterLagCompletion.data, false);
  assert.equal('player' in counterLagCompletion.data, false);
  assert.deepEqual(queryRows(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id='integration-player'`), progressBeforeCounterLag,
    'an inconsistent clear sequence must be rejected before progression or economy writes');
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits WHERE id='permit-counter-lag-pending'
    AND battle_status='victory' AND reward_state='pending' AND reward_clear_number IS NULL
    AND completed_at IS NULL AND reward_claim_token IS NULL AND reward_claimed_at IS NULL`), 1,
    'the rejected permit must remain retryable without a forged clear reservation');
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_history WHERE id='permit-counter-lag-pending:victory'`), 0,
    'no victory history is written when the sequence audit fails');
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM world_event_clears
    WHERE player_id='integration-player' AND event_key='underpass'
      AND cycle_id='counter-lag-cycle' AND full_reward_clears=0`), 1,
    'the corrupt cycle counter is not advanced by a rejected claim');

  // The last safe integer is a valid sequence slot; the following allocation must fail
  // closed rather than round the counter through JavaScript's unsafe integer range.
  const lastSafeCompletion = await complete('permit-counter-last-safe');
  assert.equal(lastSafeCompletion.status, 200, JSON.stringify(lastSafeCompletion.data));
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits
    WHERE id='permit-counter-last-safe' AND reward_state='awarded'
      AND reward_clear_number=9007199254740991`), 1);
  assert.deepEqual(queryRows(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id='integration-player' AND event_key='underpass'
      AND cycle_id='counter-boundary-cycle'`), [{ full_reward_clears: 9007199254740991 }]);

  const progressBeforeOverflow = queryRows(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id='integration-player'`);
  const overflowCompletion = await complete('permit-counter-overflow');
  assert.equal(overflowCompletion.status, 409, JSON.stringify(overflowCompletion.data));
  assert.equal(overflowCompletion.data.error, 'Unable to assign authoritative reward clear.');
  assert.equal('reward' in overflowCompletion.data, false);
  assert.equal('player' in overflowCompletion.data, false);
  assert.deepEqual(queryRows(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id='integration-player'`), progressBeforeOverflow);
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits WHERE id='permit-counter-overflow'
    AND battle_status='victory' AND reward_state='pending' AND reward_clear_number IS NULL
    AND completed_at IS NULL AND reward_claim_token IS NULL AND reward_claimed_at IS NULL`), 1);
  assert.deepEqual(queryRows(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id='integration-player' AND event_key='underpass'
      AND cycle_id='counter-boundary-cycle'`), [{ full_reward_clears: 9007199254740991 }],
    'overflow rejection must not round or advance the maximum safe counter');

  for (const [permitId, cycleId, expectedCounter] of [
    ['permit-counter-fractional', 'counter-fractional-cycle', 1.5],
    ['permit-counter-negative', 'counter-negative-cycle', -1],
  ]) {
    const progressBeforeCorruptCounter = queryRows(`SELECT level, xp, currency, last_reward_claim_token
      FROM characters WHERE player_id='integration-player'`);
    const rejected = await complete(permitId);
    assert.equal(rejected.status, 409, JSON.stringify(rejected.data));
    assert.equal(rejected.data.error, 'Unable to assign authoritative reward clear.');
    assert.equal('reward' in rejected.data, false);
    assert.equal('player' in rejected.data, false);
    assert.deepEqual(queryRows(`SELECT level, xp, currency, last_reward_claim_token
      FROM characters WHERE player_id='integration-player'`), progressBeforeCorruptCounter);
    assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits WHERE id='${permitId}'
      AND battle_status='victory' AND reward_state='pending' AND reward_clear_number IS NULL
      AND completed_at IS NULL AND reward_claim_token IS NULL AND reward_claimed_at IS NULL`), 1);
    assert.deepEqual(queryRows(`SELECT full_reward_clears FROM world_event_clears
      WHERE player_id='integration-player' AND event_key='underpass'
        AND cycle_id='${cycleId}'`), [{ full_reward_clears: expectedCounter }],
      'invalid counters must remain unchanged when reward allocation is rejected');
    assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_history
      WHERE id='${permitId}:victory'`), 0);
  }


  // A legacy terminal victory created before Mana existed must remain reward-recoverable
  // after expiry. The Worker may project a display Mana value, but must not invent a
  // persisted value or change the already-resolved combat outcome.
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits
    WHERE id='permit-legacy-terminal-victory' AND player_mana IS NULL
      AND battle_status='victory' AND reward_state='pending' AND completed_at IS NULL`), 1);
  const legacyVictory = await complete('permit-legacy-terminal-victory');
  assert.equal(legacyVictory.status, 200, JSON.stringify(legacyVictory.data));
  assert.equal(legacyVictory.data.reward.xp, 75);
  assert.equal(legacyVictory.data.reward.currency, 30);
  assert.equal(legacyVictory.data.reward.tier, 'full');
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits
    WHERE id='permit-legacy-terminal-victory' AND player_mana IS NULL
      AND battle_status='victory' AND reward_state='awarded' AND completed_at IS NOT NULL`), 1,
    'legacy reward recovery must not fabricate or persist an unknown Mana value');
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id='permit-legacy-terminal-victory:victory'`), 1);
  assert.deepEqual(queryRows(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id='integration-player' AND event_key='underpass'
      AND cycle_id='legacy-terminal-cycle'`), [{ full_reward_clears: 1 }]);
  const legacyProgressAfterAward = queryRows(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id='integration-player'`);
  const legacyReplay = await complete('permit-legacy-terminal-victory');
  assert.equal(legacyReplay.status, 200, JSON.stringify(legacyReplay.data));
  assert.deepEqual(legacyReplay.data.reward, legacyVictory.data.reward);
  assert.deepEqual(queryRows(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id='integration-player'`), legacyProgressAfterAward,
    'legacy terminal replay must not grant duplicate progression');
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id='permit-legacy-terminal-victory:victory'`), 1);

  // Legacy NULL-Mana defeat must not be converted into a reward by client-supplied victory/economy fields.
  const progressBeforeLegacyDefeat = queryRows(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id='integration-player'`);
  const legacyDefeat = await complete('permit-legacy-terminal-defeat', 'integration-player', {
    victory: true, status: 'victory', playerHp: 80, playerMana: 12, turnCount: 99,
    xp: 999999, currency: 999999, items: ['forged-item'],
    reward: { xp: 999999, currency: 999999, items: ['forged-item'] },
  });
  assert.equal(legacyDefeat.status, 409, JSON.stringify(legacyDefeat.data));
  assert.equal(legacyDefeat.data.error, 'Battle is not an authoritative victory.');
  assert.equal('reward' in legacyDefeat.data, false);
  assert.equal('player' in legacyDefeat.data, false);
  assert.deepEqual(queryRows(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id='integration-player'`), progressBeforeLegacyDefeat);
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits
    WHERE id='permit-legacy-terminal-defeat' AND player_mana IS NULL
      AND battle_status='defeat' AND player_hp=0 AND enemy_hp=40 AND turn_count=3
      AND reward_state='pending' AND reward_clear_number IS NULL
      AND reward_claim_token IS NULL AND reward_claimed_at IS NULL
      AND completed_at IS NULL`), 1, 'legacy defeat remains unchanged and unawarded');
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id IN ('permit-legacy-terminal-defeat:victory','permit-legacy-terminal-defeat:defeat')`), 0,
    'completion attempts must not invent terminal history for a seeded legacy defeat');
  assert.deepEqual(queryRows(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id='integration-player' AND event_key='underpass'
      AND cycle_id='legacy-terminal-cycle'`), [{ full_reward_clears: 1 }],
    'a rejected legacy defeat must not consume another clear slot');

  // NULL Mana does not relax the terminal outcome invariant for reward completion.
  const progressBeforeMalformedLegacyVictory = queryRows(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id='integration-player'`);
  const malformedLegacyVictory = await complete('permit-legacy-malformed-victory', 'integration-player', {
    victory: true, status: 'victory', playerHp: 80, playerMana: 12, enemyHp: 0, turnCount: 99,
    xp: 999999, currency: 999999, items: ['forged-item'],
    reward: { xp: 999999, currency: 999999, items: ['forged-item'] },
  });
  assert.equal(malformedLegacyVictory.status, 409, JSON.stringify(malformedLegacyVictory.data));
  assert.equal(malformedLegacyVictory.data.error, 'Battle state is invalid.');
  assert.equal('reward' in malformedLegacyVictory.data, false);
  assert.equal('player' in malformedLegacyVictory.data, false);
  assert.deepEqual(queryRows(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id='integration-player'`), progressBeforeMalformedLegacyVictory);
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits
    WHERE id='permit-legacy-malformed-victory' AND player_mana IS NULL
      AND battle_status='victory' AND player_hp=70 AND enemy_hp=40 AND turn_count=3
      AND reward_state='pending' AND reward_clear_number IS NULL
      AND reward_claim_token IS NULL AND reward_claimed_at IS NULL
      AND completed_at IS NULL`), 1, 'malformed legacy victory remains unchanged and unawarded');
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id='permit-legacy-malformed-victory:victory'`), 0);
  assert.deepEqual(queryRows(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id='integration-player' AND event_key='underpass'
      AND cycle_id='legacy-terminal-cycle'`), [{ full_reward_clears: 1 }],
    'malformed legacy victory must not consume another clear slot');

  // Corrupt persisted character progression must not create an award receipt that fails its own replay audit.
  // The failed attempt keeps its already-reserved clear slot so repair + retry can settle exactly once.
  const invalidProgressBefore = queryRows(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id='invalid-progression-player'`);
  const invalidProgressCompletion = await complete('permit-invalid-progression', 'invalid-progression-player');
  assert.equal(invalidProgressCompletion.status, 409, JSON.stringify(invalidProgressCompletion.data));
  assert.equal(invalidProgressCompletion.data.error, 'Player progression state is invalid.');
  assert.equal('reward' in invalidProgressCompletion.data, false);
  assert.equal('player' in invalidProgressCompletion.data, false);
  assert.deepEqual(queryRows(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id='invalid-progression-player'`), invalidProgressBefore,
    'invalid progression must not mutate character XP, level, currency, or the idempotency token');
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits
    WHERE id='permit-invalid-progression' AND battle_status='victory' AND reward_state='pending'
      AND reward_clear_number=1 AND reward_claim_token IS NULL AND reward_claimed_at IS NULL
      AND completed_at IS NULL`), 1,
    'a rejected progression state must release its claim but retain the same reserved clear slot for retry');
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id='permit-invalid-progression:victory'`), 0);
  assert.deepEqual(queryRows(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id='invalid-progression-player' AND event_key='underpass'
      AND cycle_id='invalid-progression-cycle'`), [{ full_reward_clears: 1 }]);

  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist,
    "--command=UPDATE characters SET level=2, xp=174, currency=0 WHERE player_id='invalid-progression-player'"]);
  const repairedRetry = await complete('permit-invalid-progression', 'invalid-progression-player');
  assert.equal(repairedRetry.status, 200, JSON.stringify(repairedRetry.data));
  assert.equal(repairedRetry.data.player.level, 3);
  assert.equal(repairedRetry.data.player.xp, 74);
  assert.equal(repairedRetry.data.player.currency, 30);
  assert.deepEqual(repairedRetry.data.reward, {
    xp: 75, currency: 30, items: ['underpass-scrap'],
    furniture: ['tunnel-trophy'], tier: 'full',
  });
  assert.deepEqual(queryRows(`SELECT reward_state, reward_clear_number, reward_level, reward_remaining_xp
    FROM battle_permits WHERE id='permit-invalid-progression'`), [{
      reward_state: 'awarded', reward_clear_number: 1, reward_level: 3, reward_remaining_xp: 74,
    }]);
  assert.deepEqual(queryRows(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id='invalid-progression-player' AND event_key='underpass'
      AND cycle_id='invalid-progression-cycle'`), [{ full_reward_clears: 1 }],
    'retry must reuse the reserved clear slot rather than incrementing the counter');
  const repairedProgressAfterAward = queryRows(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id='invalid-progression-player'`);
  const repairedReplay = await complete('permit-invalid-progression', 'invalid-progression-player');
  assert.equal(repairedReplay.status, 200, JSON.stringify(repairedReplay.data));
  assert.deepEqual(queryRows(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id='invalid-progression-player'`), repairedProgressAfterAward,
    'the recovered receipt replay must not apply progression twice');
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id='permit-invalid-progression:victory'`), 1);
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits
    WHERE id='permit-invalid-progression' AND reward_state='awarded' AND reward_clear_number=1`), 1);

  // A valid pre-award level/XP pair can still cross into a level whose XP threshold is unsafe.
  // The post-award validator must reject before the character or victory receipt is written.
  const postAwardOverflowBefore = queryRows(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id='post-award-overflow-player'`);
  const postAwardOverflow = await complete('permit-post-award-overflow', 'post-award-overflow-player');
  assert.equal(postAwardOverflow.status, 409, JSON.stringify(postAwardOverflow.data));
  assert.equal(postAwardOverflow.data.error, 'Player progression state is invalid.');
  assert.equal('reward' in postAwardOverflow.data, false);
  assert.equal('player' in postAwardOverflow.data, false);
  assert.deepEqual(queryRows(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id='post-award-overflow-player'`), postAwardOverflowBefore,
    'post-award unsafe level threshold must not mutate progression or claim token');
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits
    WHERE id='permit-post-award-overflow' AND battle_status='victory' AND reward_state='pending'
      AND reward_clear_number=1 AND reward_claim_token IS NULL AND reward_claimed_at IS NULL
      AND completed_at IS NULL`), 1,
    'post-award rejection must retain the reserved clear slot and release the claim');
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id='permit-post-award-overflow:victory'`), 0);
  assert.deepEqual(queryRows(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id='post-award-overflow-player' AND event_key='underpass'
      AND cycle_id='post-award-overflow-cycle'`), [{ full_reward_clears: 1 }]);

  // Currency addition must stay within JavaScript's safe-integer range before settlement.
  const currencyOverflowBefore = queryRows(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id='currency-overflow-player'`);
  const currencyOverflow = await complete('permit-currency-overflow', 'currency-overflow-player');
  assert.equal(currencyOverflow.status, 409, JSON.stringify(currencyOverflow.data));
  assert.equal(currencyOverflow.data.error, 'Player progression state is invalid.');
  assert.equal('reward' in currencyOverflow.data, false);
  assert.equal('player' in currencyOverflow.data, false);
  assert.deepEqual(queryRows(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id='currency-overflow-player'`), currencyOverflowBefore,
    'unsafe post-award currency must not be persisted');
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits
    WHERE id='permit-currency-overflow' AND battle_status='victory' AND reward_state='pending'
      AND reward_clear_number=1 AND reward_claim_token IS NULL AND reward_claimed_at IS NULL
      AND completed_at IS NULL`), 1,
    'currency overflow rejection must retain the reserved clear slot and release the claim');
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id='permit-currency-overflow:victory'`), 0);
  assert.deepEqual(queryRows(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id='currency-overflow-player' AND event_key='underpass'
      AND cycle_id='currency-overflow-cycle'`), [{ full_reward_clears: 1 }]);

  // D1 quantity guards reject non-positive, fractional, and JS-unsafe quantities
  // without rewriting the existing stack.
  expectInventoryGuardFailure(`UPDATE player_inventory SET quantity = 0
    WHERE id = 'inventory-cap-player:item:underpass-scrap'`);
  expectInventoryGuardFailure(`UPDATE player_inventory SET quantity = -1
    WHERE id = 'inventory-cap-player:item:underpass-scrap'`);
  expectInventoryGuardFailure(`UPDATE player_inventory SET quantity = 1.5
    WHERE id = 'inventory-cap-player:item:underpass-scrap'`);
  expectInventoryGuardFailure(`UPDATE player_inventory SET quantity = 9007199254740992
    WHERE id = 'inventory-cap-player:item:underpass-scrap'`);
  assert.deepEqual(queryRows(`SELECT quantity FROM player_inventory
    WHERE id = 'inventory-cap-player:item:underpass-scrap'`), [{ quantity: 10000 }],
    'failed quantity updates must leave the existing stack unchanged');

  // Corrupt/oversized legacy inventory is rejected before array expansion or reward replay.
  const oversizedBootstrapResponse = await fetch(base + '/api/player/bootstrap', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: 'inventory-oversized-player', displayName: 'Oversized' }),
  });
  const oversizedBootstrap = await oversizedBootstrapResponse.json();
  assert.equal(oversizedBootstrapResponse.status, 409, JSON.stringify(oversizedBootstrap));
  assert.equal(oversizedBootstrap.error, 'Player inventory exceeds the supported snapshot size.');
  assert.equal('player' in oversizedBootstrap, false);

  // A full clear at snapshot capacity must not award XP, currency, history, or loot.
  const capBefore = queryRows(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'inventory-cap-player'`);
  const capRejected = await complete('permit-inventory-cap', 'inventory-cap-player');
  assert.equal(capRejected.status, 409, JSON.stringify(capRejected.data));
  assert.equal(capRejected.data.error, 'Player inventory is at its supported snapshot limit.');
  assert.equal('reward' in capRejected.data, false);
  assert.equal('player' in capRejected.data, false);
  assert.deepEqual(queryRows(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'inventory-cap-player'`), capBefore);
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id = 'permit-inventory-cap:victory'`), 0);
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits
    WHERE id = 'permit-inventory-cap' AND reward_state = 'pending'
      AND reward_clear_number = 1 AND reward_claim_token IS NULL
      AND reward_claimed_at IS NULL AND completed_at IS NULL`), 1);
  assert.deepEqual(queryRows(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'inventory-cap-player' AND event_key = 'underpass'
      AND cycle_id = 'integration-cycle'`), [{ full_reward_clears: 1 }],
    'capacity rejection retains the reserved clear slot for a repair/retry');

  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist,
    `--command=UPDATE player_inventory SET quantity = 9999 WHERE id = 'inventory-cap-player:item:underpass-scrap'`]);
  const capRetry = await complete('permit-inventory-cap', 'inventory-cap-player');
  assert.equal(capRetry.status, 200, JSON.stringify(capRetry.data));
  assert.equal(capRetry.data.reward.tier, 'full');
  assert.equal(capRetry.data.player.inventory.length, 10000);
  assert.equal(countRows(`SELECT quantity AS n FROM player_inventory
    WHERE id = 'inventory-cap-player:item:underpass-scrap'`), 10000);
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id = 'permit-inventory-cap:victory'`), 1);
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits
    WHERE id = 'permit-inventory-cap' AND reward_state = 'awarded'
      AND reward_clear_number = 1 AND completed_at IS NOT NULL`), 1);

  // Inject a failure after the character CAS, history insert, and clear reservation
  // have started. D1 batch atomicity must roll all settlement writes back; retrying
  // the same reserved permit after removing the injected fault must award once.
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist,
    `--command=CREATE TRIGGER test_abort_inventory_award BEFORE UPDATE OF quantity ON player_inventory
      WHEN OLD.id = 'inventory-atomic-player:item:underpass-scrap'
      BEGIN SELECT RAISE(ABORT, 'injected inventory settlement failure'); END`]);
  const atomicCharacterBefore = queryRows(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'inventory-atomic-player'`);
  const atomicFailure = await complete('permit-inventory-atomic', 'inventory-atomic-player');
  assert.equal(atomicFailure.status, 500, JSON.stringify(atomicFailure.data));
  assert.equal(atomicFailure.data.error, 'Internal server error');
  assert.doesNotMatch(JSON.stringify(atomicFailure.data), /injected inventory settlement failure/i);
  assert.deepEqual(queryRows(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'inventory-atomic-player'`), atomicCharacterBefore,
    'inventory write failure must roll back character progression');
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id = 'permit-inventory-atomic:victory'`), 0,
    'inventory write failure must roll back victory history');
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM defeated_bosses
    WHERE player_id = 'inventory-atomic-player' AND boss_key = 'tunnel-maw'`), 0,
    'inventory write failure must roll back the boss trophy marker');
  assert.deepEqual(queryRows(`SELECT quantity FROM player_inventory
    WHERE id = 'inventory-atomic-player:item:underpass-scrap'`), [{ quantity: 1 }],
    'inventory stack must remain unchanged after batch rollback');
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM player_inventory
    WHERE player_id = 'inventory-atomic-player' AND item_key = 'tunnel-trophy'`), 0);
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits
    WHERE id = 'permit-inventory-atomic' AND reward_state = 'pending'
      AND reward_clear_number = 1 AND reward_claim_token IS NULL
      AND reward_claimed_at IS NULL AND completed_at IS NULL`), 1,
    'failed settlement releases only its claim and retains its clear slot');
  assert.deepEqual(queryRows(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'inventory-atomic-player' AND event_key = 'underpass'
      AND cycle_id = 'integration-cycle'`), [{ full_reward_clears: 1 }]);

  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist,
    '--command=DROP TRIGGER test_abort_inventory_award']);
  const atomicRetry = await complete('permit-inventory-atomic', 'inventory-atomic-player');
  assert.equal(atomicRetry.status, 200, JSON.stringify(atomicRetry.data));
  assert.equal(atomicRetry.data.reward.tier, 'full');
  assert.equal(atomicRetry.data.player.level, 1);
  assert.equal(atomicRetry.data.player.xp, 75);
  assert.equal(atomicRetry.data.player.currency, 30);
  assert.deepEqual(queryRows(`SELECT quantity FROM player_inventory
    WHERE id = 'inventory-atomic-player:item:underpass-scrap'`), [{ quantity: 2 }]);
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM player_inventory
    WHERE player_id = 'inventory-atomic-player' AND item_key = 'tunnel-trophy'`), 1);
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id = 'permit-inventory-atomic:victory'`), 1);
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits
    WHERE id = 'permit-inventory-atomic' AND reward_state = 'awarded'
      AND reward_clear_number = 1 AND completed_at IS NOT NULL`), 1);

  // Two simultaneous full-clear completions share a player with one remaining
  // inventory slot. The character CAS must allow at most one reward to consume it.
  const inventoryCapacityRaceResults = await Promise.all([
    complete('permit-inventory-race-a', 'inventory-race-player'),
    complete('permit-inventory-race-b', 'inventory-race-player'),
  ]);
  const inventoryCapacityRaceWinners = inventoryCapacityRaceResults.filter((result) => result.status === 200);
  const inventoryCapacityRaceRejected = inventoryCapacityRaceResults.filter((result) => result.status === 409);
  assert.equal(inventoryCapacityRaceWinners.length, 1, JSON.stringify(inventoryCapacityRaceResults));
  assert.equal(inventoryCapacityRaceRejected.length, 1, JSON.stringify(inventoryCapacityRaceResults));
  assert.equal(inventoryCapacityRaceRejected[0].data.error, 'Player inventory is at its supported snapshot limit.');
  assert.equal('reward' in inventoryCapacityRaceRejected[0].data, false);
  assert.equal('player' in inventoryCapacityRaceRejected[0].data, false);
  assert.equal(inventoryCapacityRaceWinners[0].data.reward.tier, 'full');
  assert.equal(inventoryCapacityRaceWinners[0].data.player.inventory.length, 10000);
  assert.deepEqual(queryRows(`SELECT quantity FROM player_inventory
    WHERE id = 'inventory-race-player:item:underpass-scrap'`), [{ quantity: 10000 }]);
  assert.deepEqual(queryRows(`SELECT level, xp, currency FROM characters
    WHERE player_id = 'inventory-race-player'`), [{ level: 1, xp: 75, currency: 30 }],
    'only one concurrent full clear may award progression at inventory capacity');
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_history
    WHERE player_id = 'inventory-race-player' AND result = 'victory'`), 1);
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM player_inventory
    WHERE player_id = 'inventory-race-player' AND item_key = 'tunnel-trophy' AND item_type = 'furniture'`), 1);
  assert.deepEqual(queryRows(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'inventory-race-player' AND event_key = 'underpass'
      AND cycle_id = 'integration-cycle'`), [{ full_reward_clears: 2 }],
    'both clear numbers stay reserved for idempotent retry even though only one reward fits');
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits
    WHERE id IN ('permit-inventory-race-a','permit-inventory-race-b')
      AND reward_state = 'awarded' AND completed_at IS NOT NULL`), 1);
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits
    WHERE id IN ('permit-inventory-race-a','permit-inventory-race-b')
      AND reward_state = 'pending' AND reward_clear_number IN (1,2)
      AND reward_claim_token IS NULL AND reward_claimed_at IS NULL AND completed_at IS NULL`), 1);
  assert.equal(countRows(`SELECT COUNT(DISTINCT reward_clear_number) AS n FROM battle_permits
    WHERE id IN ('permit-inventory-race-a','permit-inventory-race-b')
      AND reward_clear_number IN (1,2)`), 2,
    'concurrent completions must retain distinct reserved clear numbers');

  // All HTTP assertions are complete. Stop Miniflare before direct D1 writes and
  // final snapshots: using the CLI against the same local store while workerd is
  // serving can contend on SQLite or close its HTTP socket.
  if (server && server.exitCode === null) {
    const worker = server;
    worker.kill('SIGTERM');
    await Promise.race([new Promise(r => worker.once('exit', r)), sleep(2000)]);
    if (worker.exitCode === null) {
      worker.kill('SIGKILL');
      await Promise.race([new Promise(r => worker.once('exit', r)), sleep(1000)]);
    }
    server = undefined;
  }

  // With workerd stopped, exercise the INSERT trigger independently. These
  // direct local D1 writes must not contend with a live Worker; do not retry an
  // ambiguous mutation just to hide a transient SQLite lock.
  expectInventoryGuardFailure(`INSERT INTO player_inventory
    (id, player_id, item_key, item_type, quantity)
    VALUES ('invalid-insert-zero', 'inventory-cap-player', 'probe', 'item', 0)`);
  expectInventoryGuardFailure(`INSERT INTO player_inventory
    (id, player_id, item_key, item_type, quantity)
    VALUES ('invalid-insert-negative', 'inventory-cap-player', 'probe', 'item', -1)`);
  expectInventoryGuardFailure(`INSERT INTO player_inventory
    (id, player_id, item_key, item_type, quantity)
    VALUES ('invalid-insert-fractional', 'inventory-cap-player', 'probe', 'item', 1.5)`);
  expectInventoryGuardFailure(`INSERT INTO player_inventory
    (id, player_id, item_key, item_type, quantity)
    VALUES ('invalid-insert-unsafe', 'inventory-cap-player', 'probe', 'item', 9007199254740992)`);
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM player_inventory
    WHERE id LIKE 'invalid-insert-%'`), 0,
    'invalid insert attempts must not create inventory rows');

  const openBoundaryPermitAfter = queryRows(`SELECT permit.started_at, cycle.opens_at, permit.battle_status,
    permit.player_hp, permit.player_mana, permit.enemy_hp, permit.turn_count, permit.reward_state,
    permit.reward_clear_number, permit.reward_claim_token, permit.reward_claimed_at, permit.completed_at
    FROM battle_permits AS permit JOIN world_event_cycles AS cycle ON cycle.id=permit.cycle_id
    WHERE permit.id='permit-start-at-open' AND permit.player_id='open-boundary-player'`);
  assert.equal(openBoundaryPermitAfter.length, 1);
  assert.equal(openBoundaryPermitAfter[0].started_at, openBoundaryPermitAfter[0].opens_at,
    'the persisted permit must retain the exact inclusive lower-bound timestamp');
  assert.equal(openBoundaryPermitAfter[0].battle_status, 'active');
  assert.equal(openBoundaryPermitAfter[0].player_hp, exactOpenAction.playerHp);
  assert.equal(openBoundaryPermitAfter[0].player_mana, exactOpenAction.playerMana);
  assert.equal(openBoundaryPermitAfter[0].enemy_hp, exactOpenAction.enemyHp);
  assert.equal(openBoundaryPermitAfter[0].turn_count, 1);
  assert.equal(openBoundaryPermitAfter[0].reward_state, 'pending');
  assert.equal(openBoundaryPermitAfter[0].reward_clear_number, null);
  assert.equal(openBoundaryPermitAfter[0].reward_claim_token, null);
  assert.equal(openBoundaryPermitAfter[0].reward_claimed_at, null);
  assert.equal(openBoundaryPermitAfter[0].completed_at, null);
  assert.deepEqual(queryRows("SELECT level, xp, currency, last_reward_claim_token FROM characters WHERE player_id='open-boundary-player'"), openBoundaryCharacterBefore,
    'an accepted action must not grant progression');
  assert.deepEqual(queryRows("SELECT item_key, item_type, quantity FROM player_inventory WHERE player_id='open-boundary-player' ORDER BY item_type, item_key"), openBoundaryInventoryBefore,
    'an accepted action must not grant inventory before completion');
  assert.deepEqual(queryRows("SELECT cycle_id, full_reward_clears FROM world_event_clears WHERE player_id='open-boundary-player' ORDER BY cycle_id"), openBoundaryClearsBefore,
    'a valid lower-bound permit must not reserve a clear before victory settlement');
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_history WHERE player_id='open-boundary-player'"), openBoundaryHistoryBefore,
    'an active lower-bound encounter must not create terminal history');

  assert.deepEqual(queryRows(`SELECT started_at, battle_status, player_hp, player_mana,
    enemy_hp, turn_count, reward_state, reward_clear_number, reward_xp, reward_currency, reward_tier,
    reward_level, reward_remaining_xp, reward_claim_token, reward_claimed_at, completed_at
    FROM battle_permits WHERE id='permit-awarded-start-after-close'`), invalidStartAwardedPermitBefore,
    'rejected awarded receipt must remain unchanged');
  assert.deepEqual(queryRows("SELECT level, xp, currency, last_reward_claim_token FROM characters WHERE player_id='out-of-cycle-award-player'"), invalidStartAwardedCharacterBefore);
  assert.deepEqual(queryRows("SELECT item_key, item_type, quantity FROM player_inventory WHERE player_id='out-of-cycle-award-player' ORDER BY item_type, item_key"), invalidStartAwardedInventoryBefore);
  assert.deepEqual(queryRows("SELECT cycle_id, full_reward_clears FROM world_event_clears WHERE player_id='out-of-cycle-award-player' AND cycle_id='start-after-close-cycle'"), invalidStartAwardedClearsBefore);
  assert.deepEqual(queryRows("SELECT id, player_id, encounter_key, result, player_level, xp_awarded, currency_awarded FROM battle_history WHERE id='permit-awarded-start-after-close:victory'"), invalidStartAwardedHistoryBefore);
  assert.deepEqual(queryRows("SELECT id, started_at, expires_at, battle_status, player_hp, player_mana, enemy_hp, turn_count, reward_state, reward_clear_number, reward_claim_token, reward_claimed_at, completed_at FROM battle_permits WHERE id='permit-future-start'"), futureStartPermitBefore,
    'future permit start must not mutate or normalize the permit');
  assert.deepEqual(queryRows("SELECT level, xp, currency, last_reward_claim_token FROM characters WHERE player_id='future-start-player'"), futureStartCharacterBefore);
  assert.deepEqual(queryRows("SELECT item_key, item_type, quantity FROM player_inventory WHERE player_id='future-start-player' ORDER BY item_type, item_key"), futureStartInventoryBefore);
  assert.deepEqual(queryRows("SELECT cycle_id, full_reward_clears FROM world_event_clears WHERE player_id='future-start-player'"), futureStartClearsBefore);
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_history WHERE player_id='future-start-player'"), futureStartHistoryBefore);
  assert.deepEqual(queryRows("SELECT id, started_at, expires_at, battle_status, player_hp, player_mana, enemy_hp, turn_count, reward_state, reward_clear_number, reward_claim_token, reward_claimed_at, completed_at FROM battle_permits WHERE id='permit-future-start-terminal'"), futureTerminalPermitBefore,
    'future-dated terminal recovery must not mutate its permit');
  assert.deepEqual(queryRows("SELECT level, xp, currency, last_reward_claim_token FROM characters WHERE player_id='future-terminal-player'"), futureTerminalCharacterBefore);
  assert.deepEqual(queryRows("SELECT item_key, item_type, quantity FROM player_inventory WHERE player_id='future-terminal-player' ORDER BY item_type, item_key"), futureTerminalInventoryBefore);
  assert.deepEqual(queryRows("SELECT cycle_id, full_reward_clears FROM world_event_clears WHERE player_id='future-terminal-player'"), futureTerminalClearsBefore);
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_history WHERE player_id='future-terminal-player'"), futureTerminalHistoryBefore);
  assert.deepEqual(queryRows("SELECT id, started_at, battle_status, player_hp, player_mana, enemy_hp, turn_count, reward_state, reward_clear_number, reward_claim_token, reward_claimed_at, completed_at FROM battle_permits WHERE id='permit-malformed-start'"), malformedStartPermitBefore,
    'a malformed start timestamp must not advance or normalize the permit');
  assert.deepEqual(queryRows("SELECT level, xp, currency, last_reward_claim_token FROM characters WHERE player_id='malformed-start-player'"), malformedStartCharacterBefore,
    'malformed permit chronology must not mutate progression');
  assert.deepEqual(queryRows("SELECT item_key, item_type, quantity FROM player_inventory WHERE player_id='malformed-start-player' ORDER BY item_type, item_key"), malformedStartInventoryBefore,
    'malformed permit chronology must not award inventory');
  assert.deepEqual(queryRows("SELECT cycle_id, full_reward_clears FROM world_event_clears WHERE player_id='malformed-start-player' AND cycle_id='malformed-start-cycle'"), malformedStartClearsBefore,
    'malformed permit chronology must not reserve a clear');
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_history WHERE player_id='malformed-start-player'"), malformedStartHistoryBefore,
    'malformed permit chronology must not create a battle receipt');

  assert.deepEqual(queryRows("SELECT id, started_at, battle_status, player_hp, player_mana, enemy_hp, turn_count, reward_state, reward_clear_number, reward_claim_token, reward_claimed_at, completed_at FROM battle_permits WHERE id IN ('permit-malformed-open-cycle','permit-malformed-close-cycle') ORDER BY id"), malformedCyclePermitsBefore,
    'malformed cycle timestamps must not advance, normalize, or claim permits');
  assert.deepEqual(queryRows("SELECT level, xp, currency, last_reward_claim_token FROM characters WHERE player_id='malformed-cycle-player'"), malformedCycleCharacterBefore,
    'malformed cycle timestamps must not mutate progression');
  assert.deepEqual(queryRows("SELECT item_key, item_type, quantity FROM player_inventory WHERE player_id='malformed-cycle-player' ORDER BY item_type, item_key"), malformedCycleInventoryBefore,
    'malformed cycle timestamps must not award inventory');
  assert.deepEqual(queryRows("SELECT cycle_id, full_reward_clears FROM world_event_clears WHERE player_id='malformed-cycle-player' AND cycle_id IN ('malformed-open-cycle','malformed-close-cycle') ORDER BY cycle_id"), malformedCycleClearsBefore,
    'malformed cycle timestamps must not reserve a clear');
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_history WHERE id IN ('permit-malformed-open-cycle:victory','permit-malformed-open-cycle:defeat','permit-malformed-close-cycle:victory','permit-malformed-close-cycle:defeat')"), malformedCycleHistoryBefore,
    'malformed cycle timestamps must not create battle history');
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_permits WHERE id IN ('permit-malformed-open-cycle','permit-malformed-close-cycle') AND reward_state='pending' AND reward_clear_number IS NULL AND reward_claim_token IS NULL AND reward_claimed_at IS NULL AND completed_at IS NULL"), 2,
    'malformed cycle timestamps must leave both permits unclaimed');

  assert.deepEqual(queryRows("SELECT started_at, expires_at, battle_status, player_hp, player_mana, enemy_hp, turn_count, reward_state, reward_clear_number, reward_claim_token, reward_claimed_at, completed_at FROM battle_permits WHERE id='permit-malformed-expiry'"), malformedExpiryPermitBefore,
    'a malformed expiry must not mutate or complete the active permit');
  assert.deepEqual(queryRows("SELECT level, xp, currency, last_reward_claim_token FROM characters WHERE player_id='malformed-expiry-player'"), malformedExpiryCharacterBefore);
  assert.deepEqual(queryRows("SELECT item_key, item_type, quantity FROM player_inventory WHERE player_id='malformed-expiry-player' ORDER BY item_type, item_key"), malformedExpiryInventoryBefore);
  assert.deepEqual(queryRows("SELECT cycle_id, full_reward_clears FROM world_event_clears WHERE player_id='malformed-expiry-player' ORDER BY cycle_id"), malformedExpiryClearsBefore);
  assert.deepEqual(queryRows("SELECT id, player_id, encounter_key, result, player_level, xp_awarded, currency_awarded FROM battle_history WHERE player_id='malformed-expiry-player' ORDER BY id"), malformedExpiryHistoryBefore);
  assert.equal(countRows("SELECT COUNT(*) AS n FROM battle_permits WHERE id='permit-malformed-expiry' AND reward_state='pending' AND reward_clear_number IS NULL AND reward_claim_token IS NULL AND reward_claimed_at IS NULL AND completed_at IS NULL"), 1,
    'a malformed expiry must not reserve a reward claim or clear slot');

  console.log('PASS isolated Worker/D1: inventory quantity triggers, bounded inventory snapshots, capacity rejection/retry, injected atomic award rollback/recovery, concurrent full-clear capacity race, corrupt and post-award progression rejection, currency overflow rejection, legacy NULL-Mana victory recovery and defeat rejection, reward idempotency, receipt audit, safe clear-counter boundaries, action/completion race, expiry, reward tiers, level-up, inclusive-open/exclusive-close permit boundaries, malformed start/expiry/cycle timestamps, future start rejection, permit survives event closure');
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(r => server.once('exit', r)), sleep(2000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  rmSync(scratch, { recursive: true, force: true });
}
