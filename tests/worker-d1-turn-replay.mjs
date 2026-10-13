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
async function act(permitId, abilityId, expectedTurnCount, playerId = 'qa-player') {
  const r = await fetch(origin + '/api/battle/action', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, permitId, abilityId, expectedTurnCount }),
    signal: AbortSignal.timeout(15000),
  });
  return { status: r.status, data: await r.json() };
}
async function complete(permitId, playerId = 'qa-player') {
  const r = await fetch(origin + '/api/battle/complete', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId, permitId }),
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
    "INSERT INTO world_event_cycles(id,event_key,opens_at,closes_at) VALUES('closed-cycle','underpass',datetime('now','-4 hours'),datetime('now','-2 hours'));" +
    "INSERT INTO world_event_cycles(id,event_key,opens_at,closes_at) VALUES('open-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+90 minutes'));");
  cli(['d1','execute','DEGEN','--local','--persist-to=' + persist,'--file=' + file]);
  seed('concurrent', 120, 12, 92);
  seed('zero-mana', 120, 0, 92);
  seed('victory', 5, 4, 20);
  seed('defeat', 1, 0, 92);
  seed('race-complete', 5, 4, 20);
  seed('expired', 120, 12, 92);
  seed('expired-victory', 5, 4, 20);
  seed('expired-defeat', 1, 0, 92);
  seed('cas-race-victory', 120, 12, 92);
  seed('cas-race-defeat', 120, 12, 92);
  sql("UPDATE battle_permits SET expires_at=datetime('now','-2 minutes') WHERE id='expired'");
  // Test-only triggers produce genuine terminal turns followed by expiry, and
  // deterministic lost-CAS races. They operate only on isolated local D1.
  sql(`CREATE TRIGGER qa_expire_terminal AFTER UPDATE OF battle_status ON battle_permits
    WHEN (NEW.id='expired-victory' AND NEW.battle_status='victory')
      OR (NEW.id='expired-defeat' AND NEW.battle_status='defeat')
    BEGIN UPDATE battle_permits SET expires_at=datetime('now','-2 minutes')
      WHERE id=NEW.id; END`);
  sql(`CREATE TRIGGER qa_cas_terminal BEFORE UPDATE OF player_hp ON battle_permits
    WHEN OLD.id IN ('cas-race-victory','cas-race-defeat') AND OLD.battle_status='active'
    BEGIN
      UPDATE battle_permits SET
        battle_status=CASE WHEN OLD.id='cas-race-victory' THEN 'victory' ELSE 'defeat' END,
        player_hp=CASE WHEN OLD.id='cas-race-victory' THEN 5 ELSE 0 END,
        player_mana=0,
        enemy_hp=CASE WHEN OLD.id='cas-race-victory' THEN 0 ELSE 40 END,
        turn_count=1, completed_at=CURRENT_TIMESTAMP,
        expires_at=datetime('now','-2 minutes') WHERE id=OLD.id;
      SELECT RAISE(IGNORE);
    END`);
  await start();

  // Exercise real Worker battle entry; the server initializes Degen Mana and HP.
  const worldResponse = await fetch(origin + '/api/world/underpass?playerId=qa-player');
  assert.equal(worldResponse.status, 200);
  const world = await worldResponse.json();
  assert.equal(world.cycleId, 'open-cycle');
  assert.equal(world.phase, 'open');
  const startResponse = await fetch(origin + '/api/battle/start', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({playerId:'qa-player',eventKey:'underpass',
      cycleId:world.cycleId,encounterKey:'tunnel-maw'}),
  });
  assert.equal(startResponse.status, 200);
  const started = await startResponse.json();
  assert.ok(typeof started.permitId === 'string' && started.permitId.length > 0);
  const serverPermitId = started.permitId;
  const serverFirst = await act(serverPermitId, 'crack', 0);
  assert.equal(serverFirst.status, 200);
  assert.equal(serverFirst.data.playerMana, 8);
  assert.equal(serverFirst.data.playerHp, 110);
  assert.equal(serverFirst.data.enemyHp, 57);
  assert.equal(serverFirst.data.turnCount, 1);

  const first = await Promise.all(Array.from({ length: 16 }, () => act('concurrent', 'crack', 0)));
  assert.equal(first.filter(r => r.status === 200).length, 1);
  assert.equal(first.filter(r => r.status === 409).length, 15);
  for (const r of first.filter(r => r.status === 409)) {
    assert.equal(r.data.battleState.turnCount, 1);
    assert.equal(r.data.battleState.playerMana, 8);
  }
  // A retry without a turn precondition must not become a second valid action.
  const missingPrecondition = await act('concurrent', 'slash', undefined);
  assert.equal(missingPrecondition.status, 400);
  const nullPrecondition = await act('concurrent', 'slash', null);
  assert.equal(nullPrecondition.status, 400);
  const negativePrecondition = await act('concurrent', 'slash', -1);
  assert.equal(negativePrecondition.status, 400);
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

  // Completion racing the killing blow may initially see an active battle.
  // Once the Worker resolves victory, retry must settle exactly one reward.
  const [raceAction, raceCompletion] = await Promise.all([
    act('race-complete', 'crack', 0),
    complete('race-complete'),
  ]);
  assert.equal(raceAction.status, 200);
  assert.equal(raceAction.data.status, 'victory');
  assert.ok([200, 409].includes(raceCompletion.status));
  let raceReward;
  for (let attempt = 0; attempt < 12; attempt++) {
    const response = await complete('race-complete');
    if (response.status === 200) { raceReward = response; break; }
    assert.equal(response.status, 409);
    await sleep(40);
  }
  assert.ok(raceReward, 'A server-resolved concurrent victory must remain claimable');
  const raceReplay = await complete('race-complete');
  assert.equal(raceReplay.status, 200);
  assert.deepEqual(raceReplay.data.reward, raceReward.data.reward);
  assert.equal(raceReplay.data.player.xp, raceReward.data.player.xp);
  assert.equal(raceReplay.data.player.currency, raceReward.data.player.currency);

  // Expired active permits are neither actionable nor eligible for completion.
  assert.equal((await act('expired', 'slash', 0)).status, 409);
  assert.equal((await complete('expired')).status, 409);

  // The Worker must recover a genuinely resolved win after its permit expires.
  const earnedWin = await act('expired-victory', 'crack', 0);
  assert.equal(earnedWin.status, 200);
  assert.equal(earnedWin.data.status, 'victory');
  assert.equal(earnedWin.data.playerMana, 0);
  const terminal = await act('expired-victory', 'slash', 0);
  assert.equal(terminal.status, 409);
  assert.equal(terminal.data.battleState.status, 'victory');
  assert.equal(terminal.data.battleState.turnCount, 1);
  assert.equal(terminal.data.battleState.playerMana, 0);
  const stolen = await act('expired-victory', 'slash', 0, 'wrong-player');
  assert.equal(stolen.status, 409);
  assert.equal(stolen.data.battleState, undefined);
  assert.equal((await complete('expired-victory', 'wrong-player')).status, 409);

  const earnedDefeat = await act('expired-defeat', 'slash', 0);
  assert.equal(earnedDefeat.status, 200);
  assert.equal(earnedDefeat.data.status, 'defeat');
  const defeatReplay = await act('expired-defeat', 'slash', 0);
  assert.equal(defeatReplay.status, 409);
  assert.equal(defeatReplay.data.battleState.status, 'defeat');
  assert.equal(defeatReplay.data.battleState.playerMana, 0);
  assert.equal(defeatReplay.data.battleState.turnCount, 1);
  assert.equal((await complete('expired-defeat')).status, 409);

  // A competing transaction can resolve the battle after the action's first
  // SELECT. The losing action returns that authoritative terminal state.
  const casVictory = await act('cas-race-victory', 'slash', 0);
  assert.equal(casVictory.status, 409);
  assert.equal(casVictory.data.battleState.status, 'victory');
  assert.equal(casVictory.data.battleState.turnCount, 1);
  assert.equal(casVictory.data.battleState.playerMana, 0);
  const casDefeat = await act('cas-race-defeat', 'slash', 0);
  assert.equal(casDefeat.status, 409);
  assert.equal(casDefeat.data.battleState.status, 'defeat');
  assert.equal(casDefeat.data.battleState.turnCount, 1);
  assert.equal(casDefeat.data.battleState.playerMana, 0);
  const wrongCasOwner = await act('cas-race-victory', 'slash', 0, 'wrong-player');
  assert.equal(wrongCasOwner.status, 409);
  assert.equal(wrongCasOwner.data.battleState, undefined);

  const recovered = await complete('expired-victory');
  assert.equal(recovered.status, 200);
  const replay = await complete('expired-victory');
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data.reward, recovered.data.reward);
  assert.equal(replay.data.player.xp, recovered.data.player.xp);
  const stateBefore = sql("SELECT player_hp,player_mana,enemy_hp,battle_status,turn_count,reward_state FROM battle_permits WHERE id='expired-victory'");
  for (let retry = 0; retry < 5; retry += 1) {
    const postAward = await act('expired-victory', 'slash', 0);
    assert.equal(postAward.status, 409);
    assert.equal(postAward.data.battleState.status, 'victory');
    assert.equal(postAward.data.battleState.playerMana, 0);
  }
  assert.deepEqual(sql("SELECT player_hp,player_mana,enemy_hp,battle_status,turn_count,reward_state FROM battle_permits WHERE id='expired-victory'"), stateBefore);
  const defeatBefore = sql("SELECT player_hp,player_mana,enemy_hp,battle_status,turn_count FROM battle_permits WHERE id='expired-defeat'");
  for (let retry = 0; retry < 5; retry += 1) {
    const postDefeat = await act('expired-defeat', 'slash', 0);
    assert.equal(postDefeat.status, 409);
    assert.equal(postDefeat.data.battleState.status, 'defeat');
  }
  assert.deepEqual(sql("SELECT player_hp,player_mana,enemy_hp,battle_status,turn_count FROM battle_permits WHERE id='expired-defeat'"), defeatBefore);

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
  assert.equal(sql("SELECT id FROM battle_history WHERE player_id='qa-player' AND result='victory'").length,3);
  assert.equal(sql("SELECT id FROM battle_history WHERE id='race-complete:victory'").length,1);
  assert.deepEqual(sql("SELECT battle_status,reward_state FROM battle_permits WHERE id='race-complete'"),
    [{battle_status:'victory',reward_state:'awarded'}]);
  assert.deepEqual(sql("SELECT battle_status,turn_count FROM battle_permits WHERE id='expired'"),
    [{battle_status:'active',turn_count:0}]);
  assert.equal(sql("SELECT id FROM battle_history WHERE player_id='qa-player' AND result='defeat'").length,2);
  assert.deepEqual(sql("SELECT battle_status,reward_state,turn_count,player_mana FROM battle_permits WHERE id='expired-victory'"),
    [{battle_status:'victory',reward_state:'awarded',turn_count:1,player_mana:0}]);
  assert.deepEqual(sql("SELECT battle_status,turn_count,player_mana FROM battle_permits WHERE id='expired-defeat'"),
    [{battle_status:'defeat',turn_count:1,player_mana:0}]);
  for (const [id,status] of [['cas-race-victory','victory'],['cas-race-defeat','defeat']]) {
    const state = sql("SELECT battle_status,turn_count,player_mana,completed_at FROM battle_permits WHERE id='" + id + "'")[0];
    assert.equal(state.battle_status, status);
    assert.equal(state.turn_count, 1);
    assert.equal(state.player_mana, 0);
    assert.ok(state.completed_at);
  }
  assert.deepEqual(sql("SELECT player_hp,player_mana,enemy_hp,turn_count FROM battle_permits WHERE id='" + serverPermitId + "'"),
    [{player_hp:110,player_mana:8,enemy_hp:57,turn_count:1}]);
  console.log('PASS local Worker/D1 server battle start, Mana, turn CAS, terminal replay, rewards and persisted state');
} finally {
  if (worker && worker.exitCode === null) {
    worker.kill('SIGTERM');
    await Promise.race([new Promise(r => worker.once('exit', r)), sleep(2000)]);
    if (worker.exitCode === null) worker.kill('SIGKILL');
  }
  rmSync(scratch, { recursive: true, force: true });
}
