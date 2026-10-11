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
async function action(permitId, abilityId, playerId = 'integration-player') {
  const r = await fetch(base + '/api/battle/action', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, permitId, abilityId }),
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
    INSERT INTO world_event_cycles(id,event_key,opens_at,closes_at)
      VALUES('closed-cycle','underpass',datetime('now','-90 minutes'),datetime('now','-5 minutes'));
    INSERT INTO battle_permits(id,player_id,event_key,cycle_id,encounter_key,expires_at,
      battle_status,player_hp,player_mana,enemy_hp,turn_count)
    VALUES
      ('permit-a','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-b','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-c','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('permit-d','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'victory',70,0,0,3),
      ('expired','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','-20 minutes'),'victory',70,0,0,3),
      ('zero-mana','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',120,0,60,0),
      ('paid-kill','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',120,4,30,0),
      ('defeat-case','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',5,0,60,0),
      ('expired-action','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','-20 minutes'),'active',120,4,30,0),
      ('paid-nonlethal','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',120,8,60,0),
      ('zero-cost-kill','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',5,0,20,0),
      ('parallel-action','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',120,4,92,0),
      ('closed-cycle-valid','integration-player','underpass','closed-cycle','tunnel-maw',datetime('now','+10 minutes'),'active',120,4,30,0);
    UPDATE battle_permits SET started_at=datetime('now','-10 minutes') WHERE id='closed-cycle-valid';
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
  assert.equal((await action('zero-mana', 'crack')).status, 409);
  const free = await action('zero-mana', 'slash');
  assert.equal(free.status, 200, JSON.stringify(free));
  assert.deepEqual([free.data.playerHp, free.data.playerMana, free.data.enemyHp, free.data.turnCount], [110, 0, 31, 1]);
  const paid = await action('paid-kill', 'crack');
  assert.equal(paid.status, 200, JSON.stringify(paid));
  assert.deepEqual([paid.data.status, paid.data.playerHp, paid.data.playerMana, paid.data.enemyHp, paid.data.turnCount], ['victory', 120, 0, 0, 1]);
  const defeat = await action('defeat-case', 'slash');
  assert.equal(defeat.status, 200, JSON.stringify(defeat));
  assert.equal(defeat.data.status, 'defeat');
  assert.equal((await complete('defeat-case')).status, 409);
  assert.equal((await action('expired-action', 'slash')).status, 409);
  assert.equal((await action('unknown-permit', 'slash')).status, 409);
  const paidFirst = await action('paid-nonlethal', 'crack');
  assert.equal(paidFirst.status, 200, JSON.stringify(paidFirst));
  assert.deepEqual([paidFirst.data.status, paidFirst.data.playerHp, paidFirst.data.playerMana,
    paidFirst.data.enemyHp, paidFirst.data.turnCount], ['active', 110, 4, 25, 1]);
  const paidSecond = await action('paid-nonlethal', 'crack');
  assert.equal(paidSecond.status, 200, JSON.stringify(paidSecond));
  assert.deepEqual([paidSecond.data.status, paidSecond.data.playerHp, paidSecond.data.playerMana,
    paidSecond.data.enemyHp, paidSecond.data.turnCount], ['victory', 110, 0, 0, 2]);
  assert.equal((await eventuallyComplete('paid-nonlethal')).reward.tier, 'reduced');
  assert.equal((await eventuallyComplete('paid-nonlethal')).reward.tier, 'reduced');
  const freeKill = await action('zero-cost-kill', 'slash');
  assert.equal(freeKill.status, 200, JSON.stringify(freeKill));
  assert.deepEqual([freeKill.data.status, freeKill.data.playerHp, freeKill.data.playerMana,
    freeKill.data.enemyHp, freeKill.data.turnCount], ['victory', 5, 0, 0, 1]);
  const racing = await Promise.all(Array.from({ length: 4 }, () => action('parallel-action', 'crack')));
  assert.equal(racing.filter(r => r.status === 200).length, 1, JSON.stringify(racing));
  assert.equal(racing.filter(r => r.status === 409).length, 3, JSON.stringify(racing));
  const accepted = racing.find(r => r.status === 200).data;
  assert.deepEqual([accepted.playerHp, accepted.playerMana, accepted.enemyHp, accepted.turnCount], [110, 0, 57, 1]);
  assert.equal((await action('parallel-action', 'crack')).status, 409);
  const followup = await action('parallel-action', 'slash');
  assert.equal(followup.status, 200, JSON.stringify(followup));
  assert.deepEqual([followup.data.playerMana, followup.data.enemyHp, followup.data.turnCount], [0, 28, 2]);
  const closed = await action('closed-cycle-valid', 'crack');
  assert.equal(closed.status, 200, JSON.stringify(closed));
  assert.deepEqual([closed.data.status, closed.data.playerHp, closed.data.playerMana,
    closed.data.enemyHp, closed.data.turnCount], ['victory', 120, 0, 0, 1]);
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
