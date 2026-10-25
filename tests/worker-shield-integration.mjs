// Isolated local Worker/D1 Shield integration test; never connects to production.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const wrangler = resolve(root, 'node_modules/.bin/wrangler');
const scratch = mkdtempSync(join(tmpdir(), 'degen-shield-worker-d1-'));
const persist = join(scratch, 'state');
const base = 'http://127.0.0.1:8790';
const env = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' };
let server;
let logs = '';

function cli(args) {
  const result = spawnSync(wrangler, args, { cwd: root, env, encoding: 'utf8', timeout: 120000 });
  if (result.error || result.status !== 0) {
    throw new Error(`wrangler ${args.join(' ')}: ${result.error ?? ''} ${result.stdout} ${result.stderr}`);
  }
  return result.stdout;
}

function sql(query) {
  const raw = JSON.parse(cli([
    'd1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist, '--json', '--command=' + query,
  ]));
  return Array.isArray(raw) ? raw[0]?.results : raw?.results ?? raw?.result?.[0]?.results;
}

async function post(path, payload) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, data: await response.json() };
}

async function until(label, check) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) throw new Error('Worker exited: ' + logs);
    try {
      const result = await check();
      if (result) return result;
    } catch { /* Worker startup */ }
    await sleep(250);
  }
  throw new Error('Timed out waiting for ' + label + ': ' + logs);
}

try {
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist, '--file=db/schema.sql']);
  cli(['d1', 'migrations', 'apply', 'DEGEN', '--local', '--persist-to=' + persist]);

  const seed = join(scratch, 'seed.sql');
  writeFileSync(seed, `
    INSERT INTO players(id,display_name) VALUES('shield-player','Shield Test');
    INSERT INTO characters(player_id,level,xp,currency,degen_key) VALUES('shield-player',1,0,0,'test-degen');
    INSERT INTO world_event_cycles(id,event_key,opens_at,closes_at)
      VALUES('shield-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+90 minutes'));
    INSERT INTO battle_permits(
      id,player_id,event_key,cycle_id,encounter_key,expires_at,
      battle_status,player_hp,player_mana,player_shield,enemy_hp,turn_count
    ) VALUES(
      'shielded','shield-player','underpass','shield-cycle','tunnel-maw',
      datetime('now','+20 minutes'),'active',120,0,5,92,0
    ), (
      'shield-carryover','shield-player','underpass','shield-cycle','tunnel-maw',
      datetime('now','+20 minutes'),'active',120,0,12,92,0
    ), (
      'shield-killing-blow','shield-player','underpass','shield-cycle','tunnel-maw',
      datetime('now','+20 minutes'),'active',120,12,5,1,0
    ), (
      'shield-defeat','shield-player','underpass','shield-cycle','tunnel-maw',
      datetime('now','+20 minutes'),'active',1,0,2,92,0
    );
  `);
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist, '--file=' + seed]);

  server = spawn(wrangler, [
    'dev', '--local', '--persist-to=' + persist, '--ip=127.0.0.1', '--port=8790',
  ], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [server.stdout, server.stderr]) {
    stream.on('data', (data) => { logs = (logs + data.toString()).slice(-10000); });
  }
  await until('local Worker health', async () => {
    const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(600) });
    return response.ok && (await response.json()).ok;
  });

  // Treat every submitted combat field as hostile: battle start owns the initial state.
  const start = await post('/api/battle/start', {
    playerId: 'shield-player', eventKey: 'underpass', cycleId: 'shield-cycle', encounterKey: 'tunnel-maw',
    playerHp: 0, playerMana: 0, playerShield: Number.MAX_SAFE_INTEGER,
    enemyHp: 0, turnCount: Number.MAX_SAFE_INTEGER, status: 'victory',
    shieldAbsorbed: Number.MAX_SAFE_INTEGER, retaliationDamage: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(start.status, 200);
  assert.equal(start.data.initialState.status, 'active', 'client cannot assert a terminal battle state');
  assert.equal(start.data.initialState.playerHp, 120, 'client HP is ignored at battle start');
  assert.equal(start.data.initialState.playerMana, 12, 'client Mana is ignored at battle start');
  assert.equal(start.data.initialState.enemyHp, 92, 'client enemy HP is ignored at battle start');
  assert.equal(start.data.initialState.turnCount, 0, 'client turn count is ignored at battle start');
  assert.equal(start.data.initialState.retaliationDamage, 0, 'battle start has no retaliation event');
  assert.equal(start.data.initialState.playerShield, 0, 'battle start initializes Degen Shield to zero');
  assert.equal(start.data.initialState.shieldAbsorbed, 0, 'battle start has no Shield absorption event');
  assert.deepEqual(sql(`SELECT player_hp,player_mana,player_shield,enemy_hp,turn_count,battle_status FROM battle_permits WHERE id='${start.data.permitId}'`), [{
    player_hp: 120, player_mana: 12, player_shield: 0, enemy_hp: 92, turn_count: 0, battle_status: 'active',
  }], 'server battle start persists its own initial combat state');

  // A client cannot rewrite Shield, HP, Mana, enemy HP, status, or turn count during an action.
  const action = await post('/api/battle/action', {
    playerId: 'shield-player', permitId: 'shielded', abilityId: 'slash', expectedTurnCount: 0,
    playerHp: 0, playerMana: 12, playerShield: Number.MAX_SAFE_INTEGER,
    enemyHp: 0, turnCount: Number.MAX_SAFE_INTEGER, status: 'victory',
    shieldAbsorbed: Number.MAX_SAFE_INTEGER, retaliationDamage: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(action.status, 200);
  assert.deepEqual([
    action.data.playerHp, action.data.playerShield, action.data.shieldAbsorbed, action.data.retaliationDamage,
    action.data.playerMana, action.data.enemyHp, action.data.turnCount, action.data.status,
  ], [115, 0, 5, 10, 0, 63, 1, 'active']);
  assert.equal('enemyShield' in action.data, false);
  assert.equal('enemyMana' in action.data, false);
  assert.deepEqual(sql("SELECT player_hp,player_shield,player_mana,enemy_hp,turn_count,battle_status FROM battle_permits WHERE id='shielded'"),
    [{ player_hp: 115, player_shield: 0, player_mana: 0, enemy_hp: 63, turn_count: 1, battle_status: 'active' }],
    'D1 state must persist one Shield absorption and the corresponding HP result');


  // An unaffordable paid action must not consume or rewrite the server-owned Shield.
  const rejected = await post('/api/battle/action', {
    playerId: 'shield-player', permitId: 'shield-carryover', abilityId: 'crack', expectedTurnCount: 0,
  });
  assert.equal(rejected.status, 409);
  assert.deepEqual(rejected.data.battleState, {
    permitId: 'shield-carryover', status: 'active', playerHp: 120, playerMana: 0,
    playerShield: 12, shieldAbsorbed: 0, retaliationDamage: 0, enemyHp: 92, turnCount: 0,
  });
  assert.deepEqual(sql("SELECT player_hp,player_shield,player_mana,enemy_hp,turn_count,battle_status FROM battle_permits WHERE id='shield-carryover'"),
    [{ player_hp: 120, player_shield: 12, player_mana: 0, enemy_hp: 92, turn_count: 0, battle_status: 'active' }],
    'rejected paid action must not mutate HP, Mana, Shield, enemy HP, or turn');

  // A free ability remains available at zero Mana and only the absorbed portion is consumed.
  const carryover = await post('/api/battle/action', {
    playerId: 'shield-player', permitId: 'shield-carryover', abilityId: 'slash', expectedTurnCount: 0,
  });
  assert.equal(carryover.status, 200);
  assert.deepEqual([
    carryover.data.playerHp, carryover.data.playerMana, carryover.data.playerShield,
    carryover.data.shieldAbsorbed, carryover.data.retaliationDamage, carryover.data.enemyHp, carryover.data.turnCount,
  ], [120, 0, 2, 10, 10, 63, 1]);
  assert.deepEqual(sql("SELECT player_hp,player_shield,player_mana,enemy_hp,turn_count,battle_status FROM battle_permits WHERE id='shield-carryover'"),
    [{ player_hp: 120, player_shield: 2, player_mana: 0, enemy_hp: 63, turn_count: 1, battle_status: 'active' }],
    'remaining Shield must persist after absorbing retaliation');

  // A killing blow must skip retaliation and preserve unused player Shield through victory settlement.
  const killingBlow = await post('/api/battle/action', {
    playerId: 'shield-player', permitId: 'shield-killing-blow', abilityId: 'crack', expectedTurnCount: 0,
  });
  assert.equal(killingBlow.status, 200);
  assert.deepEqual([
    killingBlow.data.status, killingBlow.data.playerHp, killingBlow.data.playerMana, killingBlow.data.playerShield,
    killingBlow.data.shieldAbsorbed, killingBlow.data.retaliationDamage, killingBlow.data.enemyHp, killingBlow.data.turnCount,
  ], ['victory', 120, 8, 5, 0, 0, 0, 1],
  'a killing blow spends Mana once, skips retaliation, and leaves unused Shield intact');
  assert.deepEqual(sql("SELECT player_hp,player_shield,player_mana,enemy_hp,turn_count,battle_status FROM battle_permits WHERE id='shield-killing-blow'"),
    [{ player_hp: 120, player_shield: 5, player_mana: 8, enemy_hp: 0, turn_count: 1, battle_status: 'victory' }],
    'the terminal Worker/D1 snapshot must preserve Shield when retaliation is skipped');

  const completion = await post('/api/battle/complete', {
    playerId: 'shield-player', permitId: 'shield-killing-blow',
  });
  assert.equal(completion.status, 200, 'a valid server-resolved killing blow can settle its reward');
  assert.ok(['full', 'reduced'].includes(completion.data.reward?.tier), 'reward tier comes from Worker settlement');
  const settled = sql("SELECT reward_state,completed_at FROM battle_permits WHERE id='shield-killing-blow'")[0];
  assert.equal(settled.reward_state, 'awarded', 'the server-owned victory is marked awarded after settlement');
  assert.equal(typeof settled.completed_at, 'string', 'settlement records completion time');

  // Defeat after partial Shield absorption must exhaust Shield, record zero rewards, and remain unclaimable.
  const defeat = await post('/api/battle/action', {
    playerId: 'shield-player', permitId: 'shield-defeat', abilityId: 'slash', expectedTurnCount: 0,
  });
  assert.equal(defeat.status, 200);
  assert.deepEqual([
    defeat.data.status, defeat.data.playerHp, defeat.data.playerMana, defeat.data.playerShield,
    defeat.data.shieldAbsorbed, defeat.data.retaliationDamage, defeat.data.enemyHp, defeat.data.turnCount,
  ], ['defeat', 0, 0, 0, 2, 10, 63, 1],
  'Shield absorbs first, only remaining retaliation damages HP, and defeat leaves no Shield');
  assert.deepEqual(sql("SELECT player_hp,player_shield,player_mana,enemy_hp,turn_count,battle_status FROM battle_permits WHERE id='shield-defeat'"),
    [{ player_hp: 0, player_shield: 0, player_mana: 0, enemy_hp: 63, turn_count: 1, battle_status: 'defeat' }],
    'persisted defeat state must exhaust Shield atomically with the terminal turn');
  assert.deepEqual(sql("SELECT result,xp_awarded,currency_awarded FROM battle_history WHERE id='shield-defeat:defeat'"),
    [{ result: 'defeat', xp_awarded: 0, currency_awarded: 0 }],
    'defeat history records no victory rewards');
  const defeatedCompletion = await post('/api/battle/complete', {
    playerId: 'shield-player', permitId: 'shield-defeat',
  });
  assert.equal(defeatedCompletion.status, 409, 'a defeated permit cannot claim victory rewards');
  assert.deepEqual(sql("SELECT reward_state,completed_at FROM battle_permits WHERE id='shield-defeat'"),
    [{ reward_state: 'pending', completed_at: null }],
    'a defeated permit remains unawarded');

  console.log('PASS isolated Worker/D1: server-owned combat start, hostile client-state rejection, Shield absorption, killing blow, defeat, and reward settlement');
} catch (error) {
  console.error('Worker/D1 Shield integration FAILED:', error);
  console.error(logs);
  throw error;
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => server.once('exit', resolve)), sleep(2000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  rmSync(scratch, { recursive: true, force: true });
}
