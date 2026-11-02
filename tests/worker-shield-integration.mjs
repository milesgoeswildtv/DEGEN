import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const wrangler = resolve(root, 'node_modules/.bin/wrangler');
const scratch = mkdtempSync(join(tmpdir(), 'degen-shield-d1-'));
const persist = join(scratch, 'state');
const base = 'http://127.0.0.1:8791';
const env = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' };
let server;
let logs = '';
function cli(args) {
  const result = spawnSync(wrangler, args, { cwd: root, env, encoding: 'utf8', timeout: 120000 });
  if (result.error || result.status !== 0) throw new Error(`wrangler ${args.join(' ')}: ${result.error ?? ''} ${result.stdout} ${result.stderr}`);
  return result.stdout;
}
function sql(query) {
  const raw = JSON.parse(cli(['d1','execute','DEGEN','--local','--persist-to='+persist,'--json','--command='+query]));
  return Array.isArray(raw) ? raw[0]?.results : raw?.results ?? raw?.result?.[0]?.results;
}
async function post(path, payload) {
  const response = await fetch(base + path, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(payload) });
  return { status:response.status, data:await response.json() };
}
async function until(check) {
  for (let i=0;i<80;i++) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) throw new Error('Worker exited: '+logs);
    try { const ok=await check(); if(ok) return; } catch {}
    await sleep(250);
  }
  throw new Error('Worker did not become ready: '+logs);
}
try {
  cli(['d1','execute','DEGEN','--local','--persist-to='+persist,'--file=db/schema.sql']);
  cli(['d1','migrations','apply','DEGEN','--local','--persist-to='+persist]);
  const seed=join(scratch,'seed.sql');
  writeFileSync(seed,`
    INSERT INTO players(id,display_name) VALUES
      ('shield-start','Shield Start'),('shield-action','Shield Action'),
      ('shield-carry','Shield Carry'),('shield-kill','Shield Kill'),('shield-defeat','Shield Defeat'),('shield-race','Shield Race');
    INSERT INTO characters(player_id,level,xp,currency,degen_key) VALUES
      ('shield-start',1,0,0,'test-degen'),('shield-action',1,0,0,'test-degen'),
      ('shield-carry',1,0,0,'test-degen'),('shield-kill',1,0,0,'test-degen'),
      ('shield-defeat',1,0,0,'test-degen'),('shield-race',1,0,0,'test-degen');
    INSERT INTO world_event_cycles(id,event_key,opens_at,closes_at)
      VALUES('shield-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+90 minutes'));
    INSERT INTO battle_permits(id,player_id,event_key,cycle_id,encounter_key,started_at,expires_at,
      battle_status,player_hp,player_mana,player_shield,enemy_hp,turn_count)
    VALUES
      ('shield-action-permit','shield-action','underpass','shield-cycle','tunnel-maw',datetime('now'),datetime('now','+20 minutes'),'active',120,0,5,92,0),
      ('shield-carry-permit','shield-carry','underpass','shield-cycle','tunnel-maw',datetime('now'),datetime('now','+20 minutes'),'active',120,0,12,92,0),
      ('shield-kill-permit','shield-kill','underpass','shield-cycle','tunnel-maw',datetime('now'),datetime('now','+20 minutes'),'active',5,12,5,1,0),
      ('shield-defeat-permit','shield-defeat','underpass','shield-cycle','tunnel-maw',datetime('now'),datetime('now','+20 minutes'),'active',1,0,2,92,0),
      ('shield-race-permit','shield-race','underpass','shield-cycle','tunnel-maw',datetime('now'),datetime('now','+20 minutes'),'active',120,0,10,92,0);
  `);
  cli(['d1','execute','DEGEN','--local','--persist-to='+persist,'--file='+seed]);
  server=spawn(wrangler,['dev','--local','--persist-to='+persist,'--ip=127.0.0.1','--port=8791'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  for(const stream of [server.stdout,server.stderr]) stream.on('data',d=>{logs=(logs+d.toString()).slice(-10000);});
  await until(async()=>{const r=await fetch(base+'/api/health',{signal:AbortSignal.timeout(600)});return r.ok&&(await r.json()).ok;});

  const start=await post('/api/battle/start',{playerId:'shield-start',eventKey:'underpass',cycleId:'shield-cycle',encounterKey:'tunnel-maw',playerShield:999,playerHp:0,playerMana:0,enemyHp:0,turnCount:99,status:'victory'});
  assert.equal(start.status,200);
  assert.deepEqual(start.data.initialState,{
    permitId:start.data.permitId,status:'active',playerHp:120,playerMana:12,
    playerShield:0,shieldAbsorbed:0,retaliationDamage:0,enemyHp:92,turnCount:0,
  });
  assert.deepEqual(sql(`SELECT player_hp,player_mana,player_shield,enemy_hp,turn_count,battle_status FROM battle_permits WHERE id='${start.data.permitId}'`),[
    {player_hp:120,player_mana:12,player_shield:0,enemy_hp:92,turn_count:0,battle_status:'active'},
  ]);

  const action=await post('/api/battle/action',{playerId:'shield-action',permitId:'shield-action-permit',abilityId:'slash',expectedTurnCount:0,playerShield:999});
  assert.equal(action.status,200);
  assert.deepEqual([action.data.playerHp,action.data.playerMana,action.data.playerShield,action.data.shieldAbsorbed,action.data.retaliationDamage,action.data.enemyHp,action.data.turnCount,action.data.status],
    [115,0,0,5,10,63,1,'active']);
  assert.deepEqual(sql("SELECT player_hp,player_mana,player_shield,enemy_hp,turn_count,battle_status FROM battle_permits WHERE id='shield-action-permit'"),[
    {player_hp:115,player_mana:0,player_shield:0,enemy_hp:63,turn_count:1,battle_status:'active'},
  ]);

  const rejected=await post('/api/battle/action',{playerId:'shield-carry',permitId:'shield-carry-permit',abilityId:'crack',expectedTurnCount:0});
  assert.equal(rejected.status,409);
  assert.equal(rejected.data.battleState.playerShield,12);
  assert.deepEqual(sql("SELECT player_hp,player_mana,player_shield,enemy_hp,turn_count FROM battle_permits WHERE id='shield-carry-permit'"),[
    {player_hp:120,player_mana:0,player_shield:12,enemy_hp:92,turn_count:0},
  ]);
  const carry=await post('/api/battle/action',{playerId:'shield-carry',permitId:'shield-carry-permit',abilityId:'slash',expectedTurnCount:0});
  assert.equal(carry.status,200);
  assert.deepEqual([carry.data.playerHp,carry.data.playerShield,carry.data.shieldAbsorbed,carry.data.retaliationDamage],[120,2,10,10]);

  const race = await Promise.all([
    post('/api/battle/action',{playerId:'shield-race',permitId:'shield-race-permit',abilityId:'slash',expectedTurnCount:0}),
    post('/api/battle/action',{playerId:'shield-race',permitId:'shield-race-permit',abilityId:'slash',expectedTurnCount:0}),
  ]);
  assert.deepEqual(race.map((result) => result.status).sort(), [200,409]);
  const raceConflict = race.find((result) => result.status === 409);
  assert.equal(raceConflict?.data.battleState.playerShield, 0);
  assert.equal(raceConflict?.data.battleState.turnCount, 1);
  assert.deepEqual(sql("SELECT player_hp,player_mana,player_shield,enemy_hp,turn_count,battle_status FROM battle_permits WHERE id='shield-race-permit'"),[
    {player_hp:120,player_mana:0,player_shield:0,enemy_hp:63,turn_count:1,battle_status:'active'},
  ]);

  const kill=await post('/api/battle/action',{playerId:'shield-kill',permitId:'shield-kill-permit',abilityId:'crack',expectedTurnCount:0});
  assert.equal(kill.status,200);
  assert.equal(kill.data.status,'victory');
  assert.equal(kill.data.playerShield,5);
  assert.equal(kill.data.retaliationDamage,0);
  assert.equal(kill.data.shieldAbsorbed,0);

  const defeat=await post('/api/battle/action',{playerId:'shield-defeat',permitId:'shield-defeat-permit',abilityId:'slash',expectedTurnCount:0});
  assert.equal(defeat.status,200);
  assert.equal(defeat.data.status,'defeat');
  assert.equal(defeat.data.playerHp,0);
  assert.equal(defeat.data.playerShield,0);
  assert.equal(defeat.data.shieldAbsorbed,2);
  assert.equal(defeat.data.retaliationDamage,10);
  assert.deepEqual(sql("SELECT player_hp,player_mana,player_shield,enemy_hp,turn_count,battle_status FROM battle_permits WHERE id='shield-defeat-permit'"),[
    {player_hp:0,player_mana:0,player_shield:0,enemy_hp:63,turn_count:1,battle_status:'defeat'},
  ]);
  console.log('Worker/D1 Shield integration PASS');
} finally {
  if(server && server.exitCode===null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolve=>server.once('exit',resolve)),sleep(3000)]);
    if(server.exitCode===null) { server.kill('SIGKILL'); await new Promise(resolve=>server.once('exit',resolve)); }
  }
  rmSync(scratch,{recursive:true,force:true});
}
