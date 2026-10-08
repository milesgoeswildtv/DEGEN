// HTTP-level replay protection against an isolated local Wrangler/D1 database. Never --remote.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const wrangler = resolve(root, 'node_modules/.bin/wrangler');
const scratch = mkdtempSync(join(tmpdir(), 'degen-turn-d1-'));
const persist = join(scratch, 'db');
const origin = 'http://127.0.0.1:8795';
const env = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' };
let worker;
let logs = '';
function cli(args) {
  const r = spawnSync(wrangler, args, { cwd: root, env, encoding: 'utf8', timeout: 120000 });
  if (r.error || r.status !== 0) throw Error('wrangler ' + args.join(' ') + ': ' + r.error + '\n' + r.stdout + '\n' + r.stderr);
  return r.stdout;
}
function sql(query) {
  const raw = JSON.parse(cli(['d1','execute','DEGEN','--local','--persist-to=' + persist,'--json','--command=' + query]));
  const row = Array.isArray(raw) ? raw[0] : raw;
  return row?.results ?? row?.result?.[0]?.results ?? [];
}
function seed(id, hp, mana, enemyHp) {
  sql("INSERT INTO battle_permits(id,player_id,event_key,cycle_id,encounter_key,expires_at,battle_status,player_hp,player_mana,enemy_hp,turn_count) VALUES('" +
    id + "','qa-player','underpass','closed-cycle','tunnel-maw',datetime('now','+20 minutes'),'active'," +
    hp + ',' + mana + ',' + enemyHp + ',0)');
}
async function start() {
  worker = spawn(wrangler, ['dev','--local','--persist-to=' + persist,'--ip=127.0.0.1','--port=8795'],
    { cwd: root, env, stdio: ['ignore','pipe','pipe'] });
  for (const stream of [worker.stdout, worker.stderr]) stream.on('data', d => { logs = (logs + d.toString()).slice(-10000); });
  for (let i = 0; i < 80; i++) {
    if (worker.exitCode !== null) throw Error('Worker exited: ' + logs);
    try {
      const r = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(600) });
      if (r.ok && (await r.json()).ok) return;
    } catch {}
    await sleep(250);
  }
  throw Error('Worker did not start: ' + logs);
}
async function act(permitId, abilityId, expectedTurnCount) {
  const r = await fetch(origin + '/api/battle/action', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: 'qa-player', permitId, abilityId, expectedTurnCount }),
    signal: AbortSignal.timeout(15000),
  });
  return { status: r.status, data: await r.json() };
}
async function complete(permitId) {
  const r = await fetch(origin + '/api/battle/complete', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: 'qa-player', permitId }),
    signal: AbortSignal.timeout(15000),
  });
  return { status: r.status, data: await r.json() };
}
try {
  cli(['d1','execute','DEGEN','--local','--persist-to=' + persist,'--file=db/schema.sql']);
  cli(['d1','migrations','apply','DEGEN','--local','--persist-to=' + persist]);
  const file = join(scratch, 'seed.sql');
  writeFileSync(file, "INSERT INTO players(id,display_name) VALUES('qa-player','QA');" +
    "INSERT INTO characters(player_id,degen_key,level) VALUES('qa-player','test-degen',3);" +
    "INSERT INTO world_event_cycles(id,event_key,opens_at,closes_at) VALUES('closed-cycle','underpass',datetime('now','-4 hours'),datetime('now','-2 hours'));");
  cli(['d1','execute','DEGEN','--local','--persist-to=' + persist,'--file=' + file]);
  seed('concurrent', 120, 12, 92);
  seed('zero-mana', 120, 0, 92);
  seed('victory', 5, 4, 20);
  seed('defeat', 1, 0, 92);
  await start();

  const first = await Promise.all(Array.from({ length: 16 }, () => act('concurrent', 'crack', 0)));
  assert.equal(first.filter(r => r.status === 200).length, 1);
  assert.equal(first.filter(r => r.status === 409).length, 15);
  for (const r of first.filter(r => r.status === 409)) {
    assert.equal(r.data.battleState.turnCount, 1);
    assert.equal(r.data.battleState.playerMana, 8);
  }
  const stale = await act('concurrent', 'crack', 0);
  assert.equal(stale.status, 409);
  assert.equal(stale.data.battleState.turnCount, 1);
  const next = await act('concurrent', 'crack', 1);
  assert.equal(next.status, 200);
  assert.equal(next.data.turnCount, 2);
  assert.equal(next.data.playerMana, 4);

  const unaffordable = await act('zero-mana', 'crack', 0);
  assert.equal(unaffordable.status, 409);
  assert.equal(unaffordable.data.battleState.playerMana, 0);
  assert.equal(unaffordable.data.battleState.turnCount, 0);
  const free = await act('zero-mana', 'slash', 0);
  assert.equal(free.status, 200);
  assert.equal(free.data.playerMana, 0);

  const win = await act('victory', 'crack', 0);
  assert.equal(win.status, 200);
  assert.equal(win.data.status, 'victory');
  assert.equal(win.data.playerHp, 5);
  assert.equal(win.data.playerMana, 0);
  const winRetry = await act('victory', 'crack', 0);
  assert.equal(winRetry.status, 409);
  assert.equal(winRetry.data.battleState.status, 'victory');

  const loss = await act('defeat', 'slash', 0);
  assert.equal(loss.status, 200);
  assert.equal(loss.data.status, 'defeat');
  const lossRetry = await act('defeat', 'slash', 0);
  assert.equal(lossRetry.status, 409);
  assert.equal(lossRetry.data.battleState.status, 'defeat');

  const reward = await complete('victory');
  assert.equal(reward.status, 200);
  const duplicate = await complete('victory');
  assert.equal(duplicate.status, 200);
  assert.deepEqual(duplicate.data.reward, reward.data.reward);
  assert.equal((await complete('defeat')).status, 409);
  // Inspect the persisted local D1 state after shutting down the Worker.
  const child = worker;
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(2000)]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(2000)]);
  }
  worker = undefined;
  assert.deepEqual(sql("SELECT turn_count,player_mana FROM battle_permits WHERE id='concurrent'"),
    [{turn_count:2,player_mana:4}]);
  assert.deepEqual(sql("SELECT turn_count,player_mana FROM battle_permits WHERE id='zero-mana'"),
    [{turn_count:1,player_mana:0}]);
  assert.deepEqual(sql("SELECT battle_status,turn_count,player_mana,reward_state FROM battle_permits WHERE id='victory'"),
    [{battle_status:'victory',turn_count:1,player_mana:0,reward_state:'awarded'}]);
  assert.deepEqual(sql("SELECT battle_status,turn_count,player_mana FROM battle_permits WHERE id='defeat'"),
    [{battle_status:'defeat',turn_count:1,player_mana:0}]);
  assert.equal(sql("SELECT id FROM battle_history WHERE player_id='qa-player' AND result='victory'").length,1);
  assert.equal(sql("SELECT id FROM battle_history WHERE player_id='qa-player' AND result='defeat'").length,1);
  console.log('PASS local Worker/D1 turn CAS, Mana, terminal replay, reward replay and persisted state');
} finally {
  if (worker && worker.exitCode === null) {
    worker.kill('SIGTERM');
    await Promise.race([new Promise(r => worker.once('exit', r)), sleep(2000)]);
    if (worker.exitCode === null) worker.kill('SIGKILL');
  }
  rmSync(scratch, { recursive: true, force: true });
}
