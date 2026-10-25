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
  const r = await fetch(base + '/api/battle/complete', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...extraFields, playerId, permitId }),
  });
  assert.equal(r.headers.get('cache-control'), 'no-store',
    '/api/battle/complete success and error responses must not be cached');
  return { status: r.status, data: await r.json() };
}
async function eventuallyComplete(id, extraFields = {}) {
  for (let n = 0; n < 10; n++) {
    const r = await complete(id, 'integration-player', extraFields);
    if (r.status === 200) return r.data;
    if (r.status !== 409 && r.status !== 500) throw new Error(id + ': ' + JSON.stringify(r));
    await sleep(100 + 50 * n);
  }
  throw new Error('Reward retry exhausted for ' + id);
}
function countRows(query) {
  const r = spawnSync(wrangler, ['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist,
    '--command=' + query, '--json'], { cwd: root, env, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, 'local D1 query failed: ' + r.stderr);
  const result = JSON.parse(r.stdout);
  const row = Array.isArray(result) ? result[0]?.results?.[0] : result.results?.[0];
  return row?.n;
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
try {
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist, '--file=db/schema.sql']);
  cli(['d1', 'migrations', 'apply', 'DEGEN', '--local', '--persist-to=' + persist]);
  const seed = join(scratch, 'seed.sql');
  writeFileSync(seed, `
    INSERT INTO players(id,display_name) VALUES('integration-player','Integration');
    INSERT INTO characters(player_id,level,xp,currency,degen_key)
      VALUES('integration-player',1,0,0,'test-degen');
    INSERT INTO world_event_cycles(id,event_key,opens_at,closes_at)
      VALUES
        ('integration-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+90 minutes')),
        ('unsupported-cycle','unapproved-event',datetime('now','-10 minutes'),datetime('now','+90 minutes'));
    INSERT INTO battle_permits(id,player_id,event_key,cycle_id,encounter_key,expires_at,
      battle_status,player_hp,player_mana,enemy_hp,turn_count)
    VALUES
      ('permit-a','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-b','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-c','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-d','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-unsupported-encounter','integration-player','underpass','integration-cycle','unapproved-monster',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-unsupported-event','integration-player','unapproved-event','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-cycle-mismatch','integration-player','underpass','unsupported-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-corrupt-awarded-reward','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-awarded-without-history','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-awarded-clear-ahead','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-mana-zero','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,0,50,0),
      ('permit-insufficient-mana','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,0,92,0),
      ('permit-invalid-mana','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,13,92,0),
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
      ('permit-e','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,12,1,0),
      ('expired','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','-20 minutes'),'active',80,12,92,0),
      ('expired-active','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','-20 minutes'),'active',80,12,92,0),
      ('permit-expired-victory','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,0,1,0),
      ('permit-expired-defeat','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',10,0,92,0);
  `);
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist, '--file=' + seed]);
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

  const startResponse = await fetch(base + '/api/battle/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'integration-player',
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
  assertPersistedPermitState(started.permitId, started.initialState);

  const firstActionResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'integration-player',
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
      playerId: 'integration-player',
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
      playerId: 'integration-player',
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

  assert.equal((await complete('expired')).status, 409);
  assert.equal((await complete('permit-a', 'wrong-player')).status, 409);
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

  // A permit already issued while the Underpass is open remains legal until its own expiry.
  // Closing the world-event cycle must not interrupt an encounter or move its reward to a new cycle.
  const closureSeed = join(scratch, 'closure-cycle.sql');
  writeFileSync(closureSeed, `
    INSERT INTO world_event_cycles(id,event_key,opens_at,closes_at)
      VALUES('closure-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+3 hours'));
  `);
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist, '--file=' + closureSeed]);

  const closureStartResponse = await fetch(base + '/api/battle/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'integration-player',
      eventKey: 'underpass',
      cycleId: 'closure-cycle',
      encounterKey: 'tunnel-maw',
    }),
  });
  const closureStart = await closureStartResponse.json();
  assert.equal(closureStartResponse.status, 200, JSON.stringify(closureStart));
  assert.equal(closureStart.initialState.status, 'active');
  assert.equal(closureStart.initialState.turnCount, 0);

  const expiredClosureStartResponse = await fetch(base + '/api/battle/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'integration-player',
      eventKey: 'underpass',
      cycleId: 'closure-cycle',
      encounterKey: 'tunnel-maw',
    }),
  });
  const expiredClosureStart = await expiredClosureStartResponse.json();
  assert.equal(expiredClosureStartResponse.status, 200, JSON.stringify(expiredClosureStart));

  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist,
    "--command=UPDATE world_event_cycles SET closes_at = datetime('now','-1 minute') WHERE id = 'closure-cycle'"]);

  const closedCycleStartResponse = await fetch(base + '/api/battle/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'integration-player',
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
      playerId: 'integration-player',
      permitId: expiredClosureStart.permitId,
      abilityId: 'slash',
      expectedTurnCount: 0,
    }),
  });
  const expiredAfterClosure = await expiredAfterClosureResponse.json();
  assert.equal(expiredAfterClosureResponse.status, 409, 'cycle closure does not extend a permit past its own expiry');
  assert.match(expiredAfterClosure.error, /invalid, expired, or already completed/i);
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM battle_permits WHERE id = '${expiredClosureStart.permitId}'
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
        playerId: 'integration-player',
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

  const closureCompletion = await eventuallyComplete(closureStart.permitId);
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
    INSERT INTO battle_history
      (id, player_id, encounter_key, result, player_level, xp_awarded, currency_awarded)
    VALUES ('permit-corrupt-awarded-reward:victory', 'integration-player',
      'tunnel-maw', 'victory', 2, 999999, 30),
      ('permit-awarded-clear-ahead:victory', 'integration-player',
      'tunnel-maw', 'victory', 2, 10, 3);
  `);
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist, '--file=' + corruptReceiptSeed]);

  for (const [permitId, expectedHistoryCount, expectedClearNumber] of [
    ['permit-corrupt-awarded-reward', 1, 1],
    ['permit-awarded-without-history', 0, 1],
    ['permit-awarded-clear-ahead', 1, 999999],
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
  assert.equal(countRows(`SELECT COUNT(*) AS n FROM world_event_clears
    WHERE player_id='integration-player' AND event_key='underpass'
      AND cycle_id='integration-cycle' AND full_reward_clears=6`), 1,
    'invalid receipt replay must not reserve another event clear');
  console.log('PASS isolated Worker/D1: terminal recovery after expiry, reward idempotency, receipt audit, action/completion race, expiry, reward tiers, level-up, permit survives event closure');
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(r => server.once('exit', r)), sleep(2000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  rmSync(scratch, { recursive: true, force: true });
}
