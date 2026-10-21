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
async function complete(permitId, playerId = 'integration-player') {
  const r = await fetch(base + '/api/battle/complete', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, permitId }),
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
try {
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist, '--file=db/schema.sql']);
  cli(['d1', 'migrations', 'apply', 'DEGEN', '--local', '--persist-to=' + persist]);
  const seed = join(scratch, 'seed.sql');
  writeFileSync(seed, `
    INSERT INTO players(id,display_name) VALUES('integration-player','Integration');
    INSERT INTO characters(player_id,level,xp,currency,degen_key)
      VALUES('integration-player',1,0,0,'test-degen');
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
    headers: { 'content-type': 'application/json' },
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
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'integration-player',
      permitId: started.permitId,
      abilityId: 'crack',
    }),
  });
  const firstAction = await firstActionResponse.json();
  assert.equal(firstActionResponse.status, 200, JSON.stringify(firstAction));
  assert.equal(firstAction.permitId, started.permitId);
  assert.equal(firstAction.playerMana, started.initialState.playerMana - 4);
  assert.equal(firstAction.turnCount, started.initialState.turnCount + 1);
  assert.ok(firstAction.playerHp < started.initialState.playerHp);
  assert.ok(firstAction.enemyHp < started.initialState.enemyHp);

  const freeActionResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'integration-player',
      permitId: started.permitId,
      abilityId: 'slash',
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
    }),
  });
  assert.equal(unaffordableResponse.status, 409, 'an unaffordable ability must reject');

  const freeAtZeroResponse = await fetch(base + '/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'integration-player',
      permitId: 'permit-mana-zero',
      abilityId: 'slash',
    }),
  });
  const freeAtZero = await freeAtZeroResponse.json();
  assert.equal(freeAtZeroResponse.status, 200, JSON.stringify(freeAtZero));
  assert.equal(freeAtZero.playerMana, 0);
  assert.equal(freeAtZero.turnCount, 1, 'rejected paid action must not advance the turn');
  assert.equal(freeAtZero.playerHp, 67, 'only the accepted free action may apply retaliation');
  assert.equal(freeAtZero.enemyHp, 21, 'only the accepted free action may damage the enemy');

  assert.equal((await complete('expired')).status, 409);
  assert.equal((await complete('permit-a', 'wrong-player')).status, 409);
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
  console.log('PASS isolated Worker/D1: concurrent grants, replay, expiry, reward tiers, level-up');
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(r => server.once('exit', r)), sleep(2000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  rmSync(scratch, { recursive: true, force: true });
}
