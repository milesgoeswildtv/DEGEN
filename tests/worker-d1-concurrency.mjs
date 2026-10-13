// Isolated local Worker/D1 integration test; never connects to production.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

function resolveSharedTurns(cases) {
  const dataUrl = pathToFileURL(join(root, 'src/data/combatPrototype.ts')).href;
  const rulesUrl = pathToFileURL(join(root, 'src/game/combat/rules.ts')).href;
  const script = `
    import { TEST_DEGEN, TUNNEL_MAW } from ${JSON.stringify(dataUrl)};
    import { resolveCombatTurn } from ${JSON.stringify(rulesUrl)};
    const cases = ${JSON.stringify(cases)};
    const results = cases.map(({ name, abilityId, ...input }) => {
      const ability = TEST_DEGEN.abilities.find(candidate => candidate.id === abilityId);
      if (!ability) throw new Error('Unknown ability ' + abilityId);
      return resolveCombatTurn({ ...input, ability, degen: TEST_DEGEN, enemy: TUNNEL_MAW });
    });
    console.log(JSON.stringify(results));
  `;
  const result = spawnSync(process.execPath, [
    '--experimental-strip-types', '--input-type=module', '-e', script,
  ], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
  if (result.error || result.status !== 0) {
    throw new Error(`shared combat resolver failed: ${result.error ?? ''} ${result.stdout} ${result.stderr}`);
  }
  return JSON.parse(result.stdout.trim());
}

function assertMatchesSharedTurn(actual, expected, turnCount) {
  assert.deepEqual([
    actual.status, actual.playerHp, actual.playerMana, actual.enemyHp, actual.turnCount,
  ], [
    expected.status, expected.playerHp, expected.playerMana, expected.enemyHp, turnCount,
  ]);
}

function permitState(permitId) {
  const sql = `SELECT player_hp, player_mana, enemy_hp, battle_status, turn_count
    FROM battle_permits WHERE id = '${permitId}'`;
  const r = spawnSync(wrangler, [
    'd1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist,
    '--command', sql, '--json',
  ], { cwd: root, env, encoding: 'utf8', timeout: 120000 });
  if (r.error || r.status !== 0) {
    throw new Error(`wrangler state read failed: ${r.error ?? ''} ${r.stdout} ${r.stderr}`);
  }
  const payload = JSON.parse(r.stdout);
  const rows = [];
  const visit = value => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'player_hp') && Object.hasOwn(value, 'player_mana')
      && Object.hasOwn(value, 'battle_status') && Object.hasOwn(value, 'turn_count')) {
      rows.push(value);
      return;
    }
    Object.values(value).forEach(visit);
  };
  visit(payload);
  if (rows.length !== 1) throw new Error(`Expected one permit state row for ${permitId}; got ${rows.length}: ${r.stdout}`);
  const row = rows[0];
  return {
    player_hp: row.player_hp,
    player_mana: row.player_mana,
    enemy_hp: row.enemy_hp,
    battle_status: row.battle_status,
    turn_count: row.turn_count,
  };
}
function battleHistoryRows(id) {
  const escapedId = id.replaceAll("'", "''");
  const sql = `SELECT id, player_id, encounter_key, result, player_level, xp_awarded, currency_awarded
    FROM battle_history WHERE id = '${escapedId}'`;
  const r = spawnSync(wrangler, [
    'd1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist,
    '--command', sql, '--json',
  ], { cwd: root, env, encoding: 'utf8', timeout: 120000 });
  if (r.error || r.status !== 0) {
    throw new Error(`wrangler history read failed: ${r.error ?? ''} ${r.stdout} ${r.stderr}`);
  }
  const payload = JSON.parse(r.stdout);
  const rows = [];
  const visit = value => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'player_level') && Object.hasOwn(value, 'xp_awarded')
      && Object.hasOwn(value, 'currency_awarded') && Object.hasOwn(value, 'encounter_key')) {
      rows.push({
        id: value.id, player_id: value.player_id, encounter_key: value.encounter_key,
        result: value.result, player_level: value.player_level,
        xp_awarded: value.xp_awarded, currency_awarded: value.currency_awarded,
      });
      return;
    }
    Object.values(value).forEach(visit);
  };
  visit(payload);
  return rows;
}

async function action(permitId, abilityId, playerId = 'integration-player', expectedTurnCount = 0) {
  const r = await fetch(base + '/api/battle/action', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, permitId, abilityId, expectedTurnCount }),
  });
  return { status: r.status, data: await r.json() };
}
async function complete(permitId, playerId = 'integration-player') {
  const r = await fetch(base + '/api/battle/complete', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, permitId }),
  });
  return { status: r.status, data: await r.json() };
}
async function post(path, payload) {
  const r = await fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: r.status, data: await r.json() };
}
async function eventuallyComplete(id, playerId = 'integration-player') {
  for (let n = 0; n < 10; n++) {
    const r = await complete(id, playerId);
    if (r.status === 200) return r.data;
    if (r.status !== 409 && r.status !== 500) throw new Error(id + ': ' + JSON.stringify(r));
    await sleep(100 + 50 * n);
  }
  throw new Error('Reward retry exhausted for ' + id);
}
try {
  const mathCases = [
    { name: 'zeroManaFree', playerHp: 120, playerMana: 0, enemyHp: 60, abilityId: 'slash' },
    { name: 'paidKill', playerHp: 120, playerMana: 4, enemyHp: 30, abilityId: 'crack' },
    { name: 'defeat', playerHp: 1, playerMana: 0, enemyHp: 60, abilityId: 'slash' },
    { name: 'paidNonlethalFirst', playerHp: 120, playerMana: 8, enemyHp: 60, abilityId: 'crack' },
    { name: 'paidNonlethalSecond', playerHp: 110, playerMana: 4, enemyHp: 25, abilityId: 'crack' },
    { name: 'zeroCostKill', playerHp: 5, playerMana: 0, enemyHp: 20, abilityId: 'slash' },
    { name: 'parallelFirst', playerHp: 120, playerMana: 4, enemyHp: 92, abilityId: 'crack' },
    { name: 'parallelFollowup', playerHp: 110, playerMana: 0, enemyHp: 57, abilityId: 'slash' },
    { name: 'closedCycleKill', playerHp: 120, playerMana: 4, enemyHp: 30, abilityId: 'crack' },
    { name: 'verticalFirst', playerHp: 120, playerMana: 12, enemyHp: 92, abilityId: 'crack' },
    { name: 'verticalSecond', playerHp: 110, playerMana: 8, enemyHp: 57, abilityId: 'crack' },
    { name: 'verticalThird', playerHp: 100, playerMana: 4, enemyHp: 22, abilityId: 'crack' },
  ];
  const sharedResults = resolveSharedTurns(mathCases);
  const sharedMath = Object.fromEntries(mathCases.map((input, index) => [input.name, sharedResults[index]]));
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist, '--file=db/schema.sql']);
  cli(['d1', 'migrations', 'apply', 'DEGEN', '--local', '--persist-to=' + persist]);
  const seed = join(scratch, 'seed.sql');
  writeFileSync(seed, `
    INSERT INTO players(id,display_name) VALUES
      ('integration-player','Integration'),('expired-player','Expired Victory'),('vertical-player','Vertical Slice');
    INSERT INTO characters(player_id,level,xp,currency,degen_key)
      VALUES('integration-player',1,0,0,'test-degen'),('expired-player',1,0,0,'test-degen'),('vertical-player',1,0,0,'test-degen');
    INSERT INTO world_event_cycles(id,event_key,opens_at,closes_at)
      VALUES('integration-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+90 minutes'));
    INSERT INTO world_event_cycles(id,event_key,opens_at,closes_at)
      VALUES('closed-cycle','underpass',datetime('now','-90 minutes'),datetime('now','-5 minutes'));
    INSERT INTO world_event_cycles(id,event_key,opens_at,closes_at)
      VALUES('expired-cycle','underpass',datetime('now','-90 minutes'),datetime('now','-5 minutes'));
    INSERT INTO battle_permits(id,player_id,event_key,cycle_id,encounter_key,expires_at,
      battle_status,player_hp,player_mana,enemy_hp,turn_count)
    VALUES
      ('permit-a','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-b','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-c','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-d','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('expired','expired-player','underpass','expired-cycle','tunnel-maw',datetime('now','-20 minutes'),'active',120,4,30,0),
      ('expired-victory','expired-player','underpass','expired-cycle','tunnel-maw',datetime('now','-1 minute'),'victory',70,0,0,3),
      ('zero-mana','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',120,0,60,0),
      ('paid-kill','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',120,4,30,0),
      ('defeat-case','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',5,0,60,0),
      ('expired-action','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','-20 minutes'),'active',120,4,30,0),
      ('paid-nonlethal','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',120,8,60,0),
      ('zero-cost-kill','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',5,0,20,0),
      ('parallel-action','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',120,4,92,0),
      ('closed-cycle-valid','integration-player','underpass','closed-cycle','tunnel-maw',datetime('now','+10 minutes'),'active',120,4,30,0);
    UPDATE battle_permits SET started_at=datetime('now','-30 minutes') WHERE id='expired';
    UPDATE battle_permits SET started_at=datetime('now','-10 minutes') WHERE id IN ('closed-cycle-valid','expired-victory');
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

  // Exercise the full server-backed spine against isolated Worker/D1: bootstrap,
  // world snapshot, permit issuance, three authoritative turns, and reward receipt.
  const bootstrap = await post('/api/player/bootstrap', {
    playerId: 'vertical-player', displayName: 'Vertical Slice', platform: 'browser', platformUserId: 'vertical-player',
  });
  assert.equal(bootstrap.status, 200, JSON.stringify(bootstrap));
  assert.equal(bootstrap.data.id, 'vertical-player');
  assert.equal(bootstrap.data.level, 1);
  const worldResponse = await fetch(base + '/api/world/underpass?playerId=vertical-player');
  assert.equal(worldResponse.status, 200);
  const world = await worldResponse.json();
  assert.equal(world.source, 'server');
  assert.equal(world.phase, 'open');
  assert.equal(world.cycleId, 'integration-cycle');
  const started = await post('/api/battle/start', {
    playerId: 'vertical-player', eventKey: 'underpass', cycleId: world.cycleId, encounterKey: 'tunnel-maw',
  });
  assert.equal(started.status, 200, JSON.stringify(started));
  const verticalPermit = started.data.permitId;
  assert.ok(typeof verticalPermit === 'string' && verticalPermit.length > 0);
  const expectedInitial = mathCases.find(({ name }) => name === 'verticalFirst');
  assert.ok(expectedInitial, 'vertical-slice initial combat fixture must exist');
  const initialState = started.data.initialState;
  assert.deepEqual(initialState, {
    permitId: verticalPermit,
    status: 'active',
    playerHp: expectedInitial.playerHp,
    playerMana: expectedInitial.playerMana,
    enemyHp: expectedInitial.enemyHp,
    turnCount: 0,
  });
  assert.deepEqual(permitState(verticalPermit), {
    player_hp: initialState.playerHp,
    player_mana: initialState.playerMana,
    enemy_hp: initialState.enemyHp,
    battle_status: initialState.status,
    turn_count: initialState.turnCount,
  }, 'server-issued initial state must match the D1 permit before the first action');
  const verticalFirst = await action(verticalPermit, 'crack', 'vertical-player', 0);
  assert.equal(verticalFirst.status, 200, JSON.stringify(verticalFirst));
  assertMatchesSharedTurn(verticalFirst.data, sharedMath.verticalFirst, 1);
  const verticalSecond = await action(verticalPermit, 'crack', 'vertical-player', 1);
  assert.equal(verticalSecond.status, 200, JSON.stringify(verticalSecond));
  assertMatchesSharedTurn(verticalSecond.data, sharedMath.verticalSecond, 2);
  const verticalThird = await action(verticalPermit, 'crack', 'vertical-player', 2);
  assert.equal(verticalThird.status, 200, JSON.stringify(verticalThird));
  assertMatchesSharedTurn(verticalThird.data, sharedMath.verticalThird, 3);
  const verticalReceipt = await eventuallyComplete(verticalPermit, 'vertical-player');
  assert.equal(verticalReceipt.reward.tier, 'full');
  assert.equal(verticalReceipt.player.xp, 75);
  assert.equal(verticalReceipt.player.currency, 30);
  assert.ok(verticalReceipt.player.inventory.includes('underpass-scrap'));
  assert.equal(verticalReceipt.worldEvent.fullRewardClears, 1);

  assert.equal((await complete('expired', 'expired-player')).status, 409,
    'an expired active encounter is not a server-recorded victory');
  const recoveredExpiredVictory = await complete('expired-victory', 'expired-player');
  assert.equal(recoveredExpiredVictory.status, 200, JSON.stringify(recoveredExpiredVictory));
  assert.equal(recoveredExpiredVictory.data.reward.tier, 'full');
  assert.equal(recoveredExpiredVictory.data.worldEvent.cycleId, 'expired-cycle');
  assert.equal(recoveredExpiredVictory.data.worldEvent.fullRewardClears, 1);
  const replayedExpiredVictory = await complete('expired-victory', 'expired-player');
  assert.equal(replayedExpiredVictory.status, 200, JSON.stringify(replayedExpiredVictory));
  assert.equal(replayedExpiredVictory.data.worldEvent.fullRewardClears, 1,
    'expired-victory recovery must replay the persisted receipt without duplicating the clear');
  assert.equal((await complete('permit-a', 'wrong-player')).status, 409);

  // Race two completion requests for the same server-earned victory. A losing
  // claim may receive 409; replay must converge on the single persisted receipt.
  const duplicateCompletionRace = await Promise.all([
    complete('permit-a'),
    complete('permit-a'),
  ]);
  assert.ok(duplicateCompletionRace.every(result => result.status === 200 || result.status === 409),
    JSON.stringify(duplicateCompletionRace));
  assert.ok(duplicateCompletionRace.some(result => result.status === 200),
    JSON.stringify(duplicateCompletionRace));

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
  assert.equal((await complete('expired', 'expired-player')).status, 409);
  const zeroManaBefore = permitState('zero-mana');
  assert.deepEqual(zeroManaBefore, {
    player_hp: 120, player_mana: 0, enemy_hp: 60, battle_status: 'active', turn_count: 0,
  });
  const unaffordable = await action('zero-mana', 'crack');
  assert.equal(unaffordable.status, 409, JSON.stringify(unaffordable));
  assert.deepEqual(permitState('zero-mana'), zeroManaBefore,
    'rejected unaffordable action must not damage either side, spend Mana, or advance the turn');
  const free = await action('zero-mana', 'slash');
  assert.equal(free.status, 200, JSON.stringify(free));
  assertMatchesSharedTurn(free.data, sharedMath.zeroManaFree, 1);
  const paid = await action('paid-kill', 'crack');
  assert.equal(paid.status, 200, JSON.stringify(paid));
  assertMatchesSharedTurn(paid.data, sharedMath.paidKill, 1);
  const defeat = await action('defeat-case', 'slash');
  assert.equal(defeat.status, 200, JSON.stringify(defeat));
  assertMatchesSharedTurn(defeat.data, sharedMath.defeat, 1);
  assert.equal((await complete('defeat-case')).status, 409);
  const defeatHistory = battleHistoryRows('defeat-case:defeat');
  assert.equal(defeatHistory.length, 1, 'defeat turn and history must commit together exactly once');
  assert.deepEqual(defeatHistory[0], {
    id: 'defeat-case:defeat', player_id: 'integration-player', encounter_key: 'tunnel-maw',
    result: 'defeat', player_level: 2, xp_awarded: 0, currency_awarded: 0,
  });
  const defeatState = permitState('defeat-case');
  const duplicateDefeat = await action('defeat-case', 'slash', 'integration-player', 1);
  assert.equal(duplicateDefeat.status, 409);
  assert.equal(duplicateDefeat.data.battleState.status, 'defeat');
  assert.deepEqual(permitState('defeat-case'), defeatState);
  assert.equal(battleHistoryRows('defeat-case:defeat').length, 1, 'terminal retries cannot duplicate history');
  assert.equal((await action('expired-action', 'slash')).status, 409);
  assert.equal((await action('unknown-permit', 'slash')).status, 409);
  const paidFirst = await action('paid-nonlethal', 'crack');
  assert.equal(paidFirst.status, 200, JSON.stringify(paidFirst));
  assertMatchesSharedTurn(paidFirst.data, sharedMath.paidNonlethalFirst, 1);
  const paidSecond = await action('paid-nonlethal', 'crack', 'integration-player', 1);
  assert.equal(paidSecond.status, 200, JSON.stringify(paidSecond));
  assertMatchesSharedTurn(paidSecond.data, sharedMath.paidNonlethalSecond, 2);
  assert.equal((await eventuallyComplete('paid-nonlethal')).reward.tier, 'reduced');
  assert.equal((await eventuallyComplete('paid-nonlethal')).reward.tier, 'reduced');
  const freeKill = await action('zero-cost-kill', 'slash');
  assert.equal(freeKill.status, 200, JSON.stringify(freeKill));
  assertMatchesSharedTurn(freeKill.data, sharedMath.zeroCostKill, 1);
  const beforeInvalidTurn = permitState('parallel-action');
  assert.equal((await action('parallel-action', 'crack', 'integration-player', -1)).status, 400);
  assert.equal((await action('parallel-action', 'crack', 'integration-player', 0.5)).status, 400);
  assert.deepEqual(permitState('parallel-action'), beforeInvalidTurn,
    'invalid turn preconditions must not mutate the permit');
  const racing = await Promise.all(Array.from({ length: 4 }, () => action('parallel-action', 'crack')));
  assert.equal(racing.filter(r => r.status === 200).length, 1, JSON.stringify(racing));
  assert.equal(racing.filter(r => r.status === 409).length, 3, JSON.stringify(racing));
  const accepted = racing.find(r => r.status === 200).data;
  assertMatchesSharedTurn(accepted, sharedMath.parallelFirst, 1);
  assert.equal((await action('parallel-action', 'crack')).status, 409);
  const beforeStaleTurn = permitState('parallel-action');
  const staleReplay = await action('parallel-action', 'crack', 'integration-player', 0);
  assert.equal(staleReplay.status, 409, JSON.stringify(staleReplay));
  assert.equal(staleReplay.data.battleState.turnCount, 1);
  assert.deepEqual(permitState('parallel-action'), beforeStaleTurn,
    'replaying a stale expected turn must not apply a second action');
  const followup = await action('parallel-action', 'slash', 'integration-player', 1);
  assert.equal(followup.status, 200, JSON.stringify(followup));
  assertMatchesSharedTurn(followup.data, sharedMath.parallelFollowup, 2);
  const closed = await action('closed-cycle-valid', 'crack');
  assert.equal(closed.status, 200, JSON.stringify(closed));
  assertMatchesSharedTurn(closed.data, sharedMath.closedCycleKill, 1);
  const closedReward = await eventuallyComplete('closed-cycle-valid');
  assert.equal(closedReward.reward.tier, 'full');
  assert.equal(closedReward.worldEvent.cycleId, 'closed-cycle');
  assert.equal(closedReward.worldEvent.phase, 'sealed');
  assert.equal(closedReward.worldEvent.fullRewardClears, 1,
    'closed cycle must count its own reward independently');
  const currentWorldResponse = await fetch(base + '/api/world/underpass?playerId=integration-player');
  assert.equal(currentWorldResponse.status, 200);
  const currentWorld = await currentWorldResponse.json();
  assert.equal(currentWorld.cycleId, 'integration-cycle');
  assert.equal(currentWorld.fullRewardClears, 5,
    'settling an old-cycle victory must not consume the current cycle reward quota');
  console.log('PASS isolated Worker/D1: reward replay, authoritative Mana, action CAS, terminal outcomes, and legal closed-cycle permit');
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(r => server.once('exit', r)), sleep(2000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  rmSync(scratch, { recursive: true, force: true });
}
