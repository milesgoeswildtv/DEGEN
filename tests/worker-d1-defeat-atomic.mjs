// Real local Worker + D1 fault injection. This script never uses --remote.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const wrangler = resolve(root, 'node_modules/.bin/wrangler');
const scratch = mkdtempSync(join(tmpdir(), 'degen-defeat-d1-'));
const persist = join(scratch, 'db');
const env = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' };
const origin = 'http://127.0.0.1:8793';
let worker;
let logs = '';
function cli(args) {
  const r = spawnSync(wrangler, args, {cwd:root,env,encoding:'utf8',timeout:120_000});
  if (r.error || r.status !== 0) throw Error(`wrangler ${args.join(' ')}: ${r.error ?? ''}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}
function sql(query) {
  const raw = cli(['d1','execute','DEGEN','--local',`--persist-to=${persist}`,'--json',`--command=${query}`]);
  const parsed = JSON.parse(raw);
  const row = Array.isArray(parsed) ? parsed[0] : parsed;
  return row?.results ?? row?.result?.[0]?.results ?? [];
}
async function start() {
  logs = '';
  worker = spawn(wrangler,['dev','--local',`--persist-to=${persist}`,'--ip=127.0.0.1','--port=8793'],
    {cwd:root,env,stdio:['ignore','pipe','pipe']});
  for (const stream of [worker.stdout,worker.stderr]) {
    stream.on('data',d=>{logs=(logs+d.toString()).slice(-10000);});
  }
  for (let i=0;i<80;i++) {
    if (worker.exitCode !== null) throw Error('Worker exited: '+logs);
    try {
      const r=await fetch(origin+'/api/health',{signal:AbortSignal.timeout(600)});
      if (r.ok && (await r.json()).ok) return;
    } catch {}
    await sleep(250);
  }
  throw Error('Worker did not start: '+logs);
}
async function stop() {
  if (!worker || worker.exitCode !== null) return;
  const child=worker;
  child.kill('SIGTERM');
  await Promise.race([new Promise(done=>child.once('exit',done)),sleep(2000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
  worker=undefined;
}
async function act(id, abilityId = 'slash') {
  const r=await fetch(origin+'/api/battle/action',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({playerId:'qa-player',permitId:id,abilityId,expectedTurnCount:0}),
    signal:AbortSignal.timeout(15000),
  });
  const raw = await r.text();
  // Wrangler's local development error overlay is HTML for thrown D1 errors.
  // The rollback case intentionally causes that 500; inspect persisted state after stopping the Worker.
  let body;
  try { body = JSON.parse(raw); } catch {
    body = { errorPage: raw.slice(0, 200), workerLogs: logs.slice(-2000) };
  }
  return {status:r.status,body};
}
function seed(id) {
  sql(`INSERT INTO battle_permits(id,player_id,event_key,cycle_id,encounter_key,expires_at,
    battle_status,player_hp,player_mana,enemy_hp,turn_count)
    VALUES('${id}','qa-player','underpass','closed-cycle','tunnel-maw',
    datetime('now','+20 minutes'),'active',1,12,92,0)`);
}
try {
  cli(['d1','execute','DEGEN','--local',`--persist-to=${persist}`,'--file=db/schema.sql']);
  cli(['d1','migrations','apply','DEGEN','--local',`--persist-to=${persist}`]);
  const seedFile=join(scratch,'seed.sql');
  writeFileSync(seedFile,`INSERT INTO players(id,display_name) VALUES('qa-player','QA');
    INSERT INTO characters(player_id,degen_key,level) VALUES('qa-player','test-degen',3);
    INSERT INTO world_event_cycles(id,event_key,opens_at,closes_at)
    VALUES('closed-cycle','underpass',datetime('now','-4 hours'),datetime('now','-2 hours'));`);
  cli(['d1','execute','DEGEN','--local',`--persist-to=${persist}`,`--file=${seedFile}`]);
  seed('boundary');
  sql(`CREATE TRIGGER qa_expire_after_defeat AFTER UPDATE OF battle_status ON battle_permits
    WHEN NEW.id='boundary' AND NEW.battle_status='defeat'
    BEGIN UPDATE battle_permits SET expires_at=datetime('now','-1 minute') WHERE id=NEW.id; END`);
  await start();
  assert.equal((await act('boundary')).status,200);
  for(let i=0;i<10;i++) assert.equal((await act('boundary')).status,409);
  await stop();
  assert.equal(sql("SELECT battle_status FROM battle_permits WHERE id='boundary'")[0]?.battle_status,'defeat');
  assert.equal(sql("SELECT id FROM battle_history WHERE id='boundary:defeat'").length,1);
  sql('DROP TRIGGER qa_expire_after_defeat');

  seed('rollback');
  sql(`CREATE TRIGGER qa_fail_history BEFORE INSERT ON battle_history
    WHEN NEW.id='rollback:defeat' BEGIN SELECT RAISE(ABORT,'QA_HISTORY_FAILURE'); END`);
  await start();
  assert.equal((await act('rollback')).status,500);
  await stop();
  assert.equal(sql("SELECT battle_status FROM battle_permits WHERE id='rollback'")[0]?.battle_status,'active');
  assert.equal(sql("SELECT turn_count FROM battle_permits WHERE id='rollback'")[0]?.turn_count,0);
  assert.equal(sql("SELECT id FROM battle_history WHERE id='rollback:defeat'").length,0);
  sql('DROP TRIGGER qa_fail_history');
  await start();
  assert.equal((await act('rollback')).status,200);
  await stop();
  assert.equal(sql("SELECT id FROM battle_history WHERE id='rollback:defeat'").length,1);
  assert.deepEqual(sql("SELECT xp,currency FROM characters WHERE player_id='qa-player'"),[{xp:0,currency:0}]);
  seed('paid-rollback');
  sql(`CREATE TRIGGER qa_fail_paid_history BEFORE INSERT ON battle_history
    WHEN NEW.id='paid-rollback:defeat' BEGIN SELECT RAISE(ABORT,'QA_PAID_HISTORY_FAILURE'); END`);
  await start();
  assert.equal((await act('paid-rollback', 'crack')).status,500);
  await stop();
  assert.deepEqual(sql("SELECT player_hp,player_mana,enemy_hp,turn_count,battle_status FROM battle_permits WHERE id='paid-rollback'"),
    [{player_hp:1,player_mana:12,enemy_hp:92,turn_count:0,battle_status:'active'}]);
  assert.equal(sql("SELECT id FROM battle_history WHERE id='paid-rollback:defeat'").length,0);
  sql('DROP TRIGGER qa_fail_paid_history');
  await start();
  assert.equal((await act('paid-rollback', 'crack')).status,200);
  const repeated=await Promise.all(Array.from({length:12},()=>act('paid-rollback', 'crack')));
  assert.ok(repeated.every((result)=>result.status===409));
  await stop();
  assert.deepEqual(sql("SELECT player_hp,player_mana,turn_count,battle_status FROM battle_permits WHERE id='paid-rollback'"),
    [{player_hp:0,player_mana:8,turn_count:1,battle_status:'defeat'}]);
  assert.equal(sql("SELECT id FROM battle_history WHERE id='paid-rollback:defeat'").length,1);
  assert.deepEqual(sql("SELECT xp,currency FROM characters WHERE player_id='qa-player'"),[{xp:0,currency:0}]);
  console.log('PASS local Worker/D1 defeat expiry, free and paid rollback, retry and no rewards');
} finally {
  await stop();
  rmSync(scratch,{recursive:true,force:true});
}
