// Isolated local Worker/D1 integration test; never connects to production.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
const SESSION_TOKEN = Buffer.alloc(32, 7).toString('base64url');
const SESSION_HASH = createHash('sha256').update(SESSION_TOKEN).digest('hex');
const WRONG_SESSION_TOKEN = Buffer.alloc(32, 8).toString('base64url');
const WRONG_SESSION_HASH = createHash('sha256').update(WRONG_SESSION_TOKEN).digest('hex');
const AUTH_HEADERS = { 'content-type': 'application/json', authorization: 'Bearer ' + SESSION_TOKEN };
let server;
let logs = '';
function cli(args) {
  const r = spawnSync(wrangler, args, { cwd: root, env, encoding: 'utf8', timeout: 120000 });
  if (r.error || r.status !== 0) throw new Error(`wrangler ${args.join(' ')}: ${r.error ?? ''} ${r.stdout} ${r.stderr}`);
}
async function complete(permitId, sessionToken = SESSION_TOKEN) {
  const r = await fetch(base + '/api/battle/complete', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + sessionToken },
    body: JSON.stringify({ permitId }),
  });
  return { status: r.status, data: await r.json() };
}
async function eventuallyComplete(id) {
  for (let n = 0; n < 10; n++) {
    const r = await complete(id);
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
try {
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist, '--file=db/schema.sql']);
  cli(['d1', 'migrations', 'apply', 'DEGEN', '--local', '--persist-to=' + persist]);
  const seed = join(scratch, 'seed.sql');
  writeFileSync(seed, `
    INSERT INTO players(id,display_name) VALUES('integration-player','Integration');
    INSERT INTO players(id,display_name) VALUES('wrong-player','Wrong Player');
    INSERT INTO characters(player_id,level,xp,currency,degen_key)
      VALUES('integration-player',1,0,0,'test-degen');
    INSERT INTO player_sessions(token_hash,player_id,created_at_ms,expires_at_ms,revoked_at_ms)
      VALUES('${SESSION_HASH}','integration-player',${Date.now()},${Date.now()+3600000},NULL),
            ('${WRONG_SESSION_HASH}','wrong-player',${Date.now()},${Date.now()+3600000},NULL);
    INSERT INTO world_event_cycles(id,event_key,opens_at,closes_at)
      VALUES('integration-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+90 minutes'));
    INSERT INTO battle_permits(id,player_id,event_key,cycle_id,encounter_key,expires_at,
      battle_status,player_hp,player_mana,enemy_hp,turn_count)
    VALUES
      ('permit-a','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-b','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-c','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-d','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-mana-zero','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,0,50,0),
      ('permit-killing-blow','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,4,30,0),
      ('permit-defeat','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',10,0,92,0),
      ('permit-turn-race','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,0,100,0),
      ('permit-e','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',80,12,1,0),
      ('expired','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','-20 minutes'),'victory',70,0,0,3);
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
  const startResponse = await fetch(base + '/api/battle/start', {
    method: 'POST',
    headers: AUTH_HEADERS,
    body: JSON.stringify({
      playerId: 'integration-player',
      eventKey: 'underpass',
      cycleId: 'integration-cycle',
      encounterKey: 'tunnel-maw',
    }),
  });
  const started = await startResponse.json();
  assert.equal(startResponse.status, 200, JSON.stringify(started));
  assert.equal(started.initialState.permitId, started.permitId);
  assert.equal(started.initialState.status, 'active');
  assert.ok(Number.isSafeInteger(started.initialState.playerHp) && started.initialState.playerHp > 0);
  assert.ok(Number.isSafeInteger(started.initialState.playerMana) && started.initialState.playerMana >= 0);
  assert.ok(Number.isSafeInteger(started.initialState.enemyHp) && started.initialState.enemyHp > 0);
  assert.equal(started.initialState.turnCount, 0);

  const firstActionResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: AUTH_HEADERS,
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
  assert.equal(firstAction.permitId, started.permitId);
  assert.equal(firstAction.playerMana, started.initialState.playerMana - 4);
  assert.equal(firstAction.playerHp, started.initialState.playerHp - 10);
  assert.equal(firstAction.enemyHp, started.initialState.enemyHp - 35);
  assert.equal(firstAction.turnCount, started.initialState.turnCount + 1);
  assert.equal(firstAction.status, 'active');
  assertPersistedPermitState(started.permitId, firstAction);

  const staleReplayResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: AUTH_HEADERS,
    body: JSON.stringify({
      playerId: 'integration-player',
      permitId: started.permitId,
      abilityId: 'crack',
      expectedTurnCount: started.initialState.turnCount,
    }),
  });
  const staleReplay = await staleReplayResponse.json();
  assert.equal(staleReplayResponse.status, 409, 'replaying the observed turn must not apply a second action');
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
    headers: AUTH_HEADERS,
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
    headers: AUTH_HEADERS,
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
  assert.deepEqual(unaffordable.battleState, {
    permitId: 'permit-mana-zero', status: 'active', playerHp: 80, playerMana: 0,
    enemyHp: 50, turnCount: 0,
  });
  assertPersistedPermitState('permit-mana-zero', unaffordable.battleState);

  const freeAtZeroResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: AUTH_HEADERS,
    body: JSON.stringify({
      playerId: 'integration-player',
      permitId: 'permit-mana-zero',
      abilityId: 'slash',
      expectedTurnCount: 0,
    }),
  });
  const freeAtZero = await freeAtZeroResponse.json();
  assert.equal(freeAtZeroResponse.status, 200, JSON.stringify(freeAtZero));
  assert.equal(freeAtZero.playerMana, 0);
  assert.equal(freeAtZero.turnCount, 1, 'rejected paid action must not advance the turn');
  assert.equal(freeAtZero.playerHp, 70, 'only the accepted free action may apply retaliation');
  assert.equal(freeAtZero.enemyHp, 21, 'only the accepted free action may damage the enemy');
  assertPersistedPermitState('permit-mana-zero', freeAtZero);

  const killingBlowResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: AUTH_HEADERS,
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
    headers: AUTH_HEADERS,
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
    headers: AUTH_HEADERS,
    body: JSON.stringify({
      playerId: 'integration-player', permitId: 'permit-turn-race',
      abilityId: 'slash', expectedTurnCount: -1,
    }),
  });
  assert.equal(malformedTurnResponse.status, 400, 'invalid expected-turn preconditions must reject');

  const raceRequest = () => fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: AUTH_HEADERS,
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
  assert.equal((await complete('permit-a', WRONG_SESSION_TOKEN)).status, 409);
  const [a, b] = await Promise.all([eventuallyComplete('permit-a'), eventuallyComplete('permit-b')]);
  assert.equal(a.reward.xp, 75);
  assert.equal(b.reward.xp, 75);
  const replay = await eventuallyComplete('permit-a');
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
      method: 'POST', headers: AUTH_HEADERS,
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
    headers: AUTH_HEADERS,
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
    headers: AUTH_HEADERS,
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
    headers: AUTH_HEADERS,
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
    headers: AUTH_HEADERS,
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
      headers: AUTH_HEADERS,
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

  console.log('PASS isolated Worker/D1: action/completion race, duplicate receipt, expiry, reward tiers, level-up, permit survives event closure');
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(r => server.once('exit', r)), sleep(2000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  rmSync(scratch, { recursive: true, force: true });
}
