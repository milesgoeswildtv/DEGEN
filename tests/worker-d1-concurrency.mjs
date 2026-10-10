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
  return r.stdout;
}
function sql(query) {
  const raw = JSON.parse(cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist,
    '--json', '--command=' + query]));
  const row = Array.isArray(raw) ? raw[0] : raw;
  return row?.results ?? row?.result?.[0]?.results ?? [];
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
      ('expired','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','-20 minutes'),'victory',70,0,0,3),
      ('client-first','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',120,12,92,0),
      ('expired-active','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','-20 minutes'),'active',120,12,92,0),
      ('zero-mana','integration-player','underpass','integration-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',120,0,92,0);
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
  // The currently deployed permissive Worker must accept the future client's
  // turn precondition before the strict Worker release is allowed.
  const clientFirstResponse = await fetch(base + '/api/battle/action', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: 'integration-player', permitId: 'client-first',
      abilityId: 'crack', expectedTurnCount: 0 }),
  });
  assert.equal(clientFirstResponse.status, 200);
  const clientFirstAction = await clientFirstResponse.json();
  assert.equal(clientFirstAction.turnCount, 1);
  assert.equal(clientFirstAction.playerMana, 8);
  assert.equal(clientFirstAction.status, 'active');
  // A bad, expired, or wrong-account permit cannot authorize an action.
  const rejectAction = async (permitId, playerId = 'integration-player') => {
    const response = await fetch(base + '/api/battle/action', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId, permitId, abilityId: 'crack', expectedTurnCount: 0 }),
    });
    return response.status;
  };
  assert.equal(await rejectAction('missing-permit'), 409);
  assert.equal(await rejectAction('expired-active'), 409);
  assert.equal(await rejectAction('client-first', 'wrong-player'), 409);
  assert.equal((await complete('expired-active')).status, 409);
  assert.equal((await complete('missing-permit')).status, 409);
  assert.equal((await complete('client-first')).status, 409);
  assert.deepEqual(sql("SELECT player_hp,player_mana,enemy_hp,turn_count FROM battle_permits WHERE id='expired-active'"),
    [{player_hp:120,player_mana:12,enemy_hp:92,turn_count:0}]);
  assert.deepEqual(sql("SELECT player_hp,player_mana,enemy_hp,turn_count FROM battle_permits WHERE id='client-first'"),
    [{player_hp:110,player_mana:8,enemy_hp:57,turn_count:1}]);
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

  // Real local Worker/D1 HTTP vertical slice: no client-computed rewards.
  const post = async (path, payload) => {
    const r = await fetch(base + path, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: r.status, data: await r.json() };
  };
  const pid = 'vertical-player';
  const bootstrap = await post('/api/player/bootstrap', {
    playerId: pid, displayName: 'Vertical', platform: 'browser', platformUserId: pid,
  });
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.data.id, pid);
  assert.equal(bootstrap.data.level, 1);
  const worldResponse = await fetch(base + '/api/world/underpass?playerId=' + pid);
  assert.equal(worldResponse.status, 200);
  const world = await worldResponse.json();
  assert.equal(world.source, 'server');
  assert.equal(world.phase, 'open');
  assert.equal(world.cycleId, 'integration-cycle');
  const start = await post('/api/battle/start', {
    playerId: pid, eventKey: 'underpass', cycleId: world.cycleId, encounterKey: 'tunnel-maw',
  });
  assert.equal(start.status, 200);
  const permitId = start.data.permitId;
  assert.ok(typeof permitId === 'string' && permitId.length > 0);
  assert.equal((await complete(permitId, pid)).status, 409);
  // A legitimate permit must remain playable after the world event closes.
  sql("UPDATE world_event_cycles SET closes_at=datetime('now','-1 minute') WHERE id='integration-cycle'");
  const sealedEntry = await post('/api/battle/start', {
    playerId: pid, eventKey: 'underpass', cycleId: world.cycleId, encounterKey: 'tunnel-maw',
  });
  assert.equal(sealedEntry.status, 409, 'closure blocks new entry but not issued permits');
  for (const [index, expected] of [
    { playerHp: 110, playerMana: 8, enemyHp: 57, status: 'active' },
    { playerHp: 100, playerMana: 4, enemyHp: 22, status: 'active' },
    { playerHp: 100, playerMana: 0, enemyHp: 0, status: 'victory' },
  ].entries()) {
    const action = await post('/api/battle/action', {
      playerId: pid, permitId, abilityId: 'crack', expectedTurnCount: index,
    });
    assert.equal(action.status, 200);
    assert.equal(action.data.turnCount, index + 1);
    assert.equal(action.data.permitId, permitId);
    for (const [key, value] of Object.entries(expected)) assert.equal(action.data[key], value, key);
    assert.equal('enemyMana' in action.data, false);
  }
  // Concurrent completion of the same earned victory must never double-pay.
  const competingClaims = await Promise.all(Array.from({ length: 8 }, () => complete(permitId, pid)));
  assert.ok(competingClaims.every(({ status }) => [200, 409, 500].includes(status)));
  const earlyHistory = sql("SELECT COUNT(*) AS count FROM battle_history WHERE id='" + permitId + ":victory'");
  assert.ok(earlyHistory[0].count <= 1, 'concurrent claims cannot duplicate victory history');
  let receipt;
  for (let attempt = 0; attempt < 10; attempt++) {
    const result = await complete(permitId, pid);
    if (result.status === 200) { receipt = result.data; break; }
    assert.ok([409, 500].includes(result.status));
    await sleep(100 + 50 * attempt);
  }
  assert.ok(receipt, 'Worker must eventually settle valid victory');
  assert.equal(receipt.reward.tier, 'full');
  assert.equal(receipt.player.xp, 75);
  assert.equal(receipt.player.currency, 30);
  assert.ok(receipt.player.inventory.includes('underpass-scrap'));
  assert.ok(receipt.player.housing.inventory.includes('tunnel-trophy'));
  assert.ok(receipt.player.defeatedBosses.includes('tunnel-maw'));
  assert.equal(receipt.worldEvent.phase, 'sealed');
  const verticalReplay = await complete(permitId, pid);
  assert.equal(verticalReplay.status, 200);
  assert.deepEqual(verticalReplay.data.player, receipt.player);
  assert.deepEqual(verticalReplay.data.reward, receipt.reward);
  assert.deepEqual(sql("SELECT COUNT(*) AS count FROM battle_history WHERE id='" + permitId + ":victory'"), [{ count: 1 }]);
  assert.deepEqual(sql("SELECT player_mana,turn_count,battle_status,reward_state FROM battle_permits WHERE id='" + permitId + "'"),
    [{ player_mana: 0, turn_count: 3, battle_status: 'victory', reward_state: 'awarded' }]);

  const denied = await post('/api/battle/action', {
    playerId: 'integration-player', permitId: 'zero-mana', abilityId: 'crack', expectedTurnCount: 0,
  });
  assert.equal(denied.status, 409);
  assert.deepEqual(sql("SELECT player_hp,player_mana,enemy_hp,turn_count,battle_status FROM battle_permits WHERE id='zero-mana'"),
    [{ player_hp: 120, player_mana: 0, enemy_hp: 92, turn_count: 0, battle_status: 'active' }]);
  const free = await post('/api/battle/action', {
    playerId: 'integration-player', permitId: 'zero-mana', abilityId: 'slash', expectedTurnCount: 0,
  });
  assert.equal(free.status, 200);
  assert.equal(free.data.playerMana, 0);
  assert.equal(free.data.enemyHp, 63);
  assert.equal(free.data.turnCount, 1);
  assert.equal(free.data.status, 'active');
  console.log('PASS local Worker/D1 HTTP: bootstrap, world, combat, Mana, event closure, reward replay');

  console.log('PASS isolated Worker/D1: concurrent grants, replay, expiry, reward tiers, level-up');
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(r => server.once('exit', r)), sleep(2000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  rmSync(scratch, { recursive: true, force: true });
}
