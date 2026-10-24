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

  const start = await post('/api/battle/start', {
    playerId: 'shield-player', eventKey: 'underpass', cycleId: 'shield-cycle', encounterKey: 'tunnel-maw',
  });
  assert.equal(start.status, 200);
  assert.equal(start.data.initialState.retaliationDamage, 0, 'battle start has no retaliation event');
  assert.equal(start.data.initialState.playerShield, 0, 'battle start initializes Degen Shield to zero');
  assert.equal(start.data.initialState.shieldAbsorbed, 0, 'battle start has no Shield absorption event');
  assert.deepEqual(sql(`SELECT player_shield FROM battle_permits WHERE id='${start.data.permitId}'`), [{ player_shield: 0 }],
    'server battle start initializes player Shield to zero');

  const action = await post('/api/battle/action', {
    playerId: 'shield-player', permitId: 'shielded', abilityId: 'slash', expectedTurnCount: 0,
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

  console.log('PASS isolated Worker/D1: authoritative Shield initialization, absorption, and persistence');
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
