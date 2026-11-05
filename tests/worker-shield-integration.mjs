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
      ('shield-start','Shield Start'),('shield-action','Shield Action'),('shield-enemy','Shield Enemy'),('shield-enemy-kill','Shield Enemy Kill'),
      ('shield-carry','Shield Carry'),('shield-kill','Shield Kill'),('shield-defeat','Shield Defeat'),('shield-race','Shield Race'),
      ('shield-legacy','Shield Legacy'),('shield-corrupt-legacy','Shield Corrupt Legacy'),
      ('shield-impossible-active','Shield Impossible Active'),('shield-partial-active','Shield Partial Active'),
      ('shield-impossible-enemy','Shield Impossible Enemy'),
      ('shield-closure','Shield Closure');
    INSERT INTO characters(player_id,level,xp,currency,degen_key) VALUES
      ('shield-start',1,0,0,'test-degen'),('shield-action',1,0,0,'test-degen'),('shield-enemy',1,0,0,'test-degen'),('shield-enemy-kill',1,0,0,'test-degen'),
      ('shield-carry',1,0,0,'test-degen'),('shield-kill',1,0,0,'test-degen'),
      ('shield-defeat',1,0,0,'test-degen'),('shield-race',1,0,0,'test-degen'),
      ('shield-legacy',1,0,0,'test-degen'),('shield-corrupt-legacy',1,0,0,'test-degen'),
      ('shield-impossible-active',1,0,0,'test-degen'),('shield-partial-active',1,0,0,'test-degen'),
      ('shield-impossible-enemy',1,0,0,'test-degen'),
      ('shield-closure',1,0,0,'test-degen');
    INSERT INTO world_event_cycles(id,event_key,opens_at,closes_at)
      VALUES
        ('shield-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+90 minutes')),
        ('shield-closure-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+90 minutes'));
    -- Shield-bearing rows below are valid post-turn snapshots, not fresh turn-zero permits.
    INSERT INTO battle_permits(id,player_id,event_key,cycle_id,encounter_key,started_at,expires_at,
      battle_status,player_hp,player_mana,player_shield,last_shield_absorbed,last_retaliation_damage,enemy_hp,turn_count)
    VALUES
      ('shield-action-permit','shield-action','underpass','shield-cycle','tunnel-maw',datetime('now'),datetime('now','+20 minutes'),'active',120,0,5,10,10,63,1),
      ('shield-enemy-permit','shield-enemy','underpass','shield-cycle','tunnel-maw',datetime('now'),datetime('now','+20 minutes'),'active',110,12,0,0,10,92,1),
      ('shield-enemy-kill-permit','shield-enemy-kill','underpass','shield-cycle','tunnel-maw',datetime('now'),datetime('now','+20 minutes'),'active',110,12,0,0,10,30,1),
      ('shield-carry-permit','shield-carry','underpass','shield-cycle','tunnel-maw',datetime('now'),datetime('now','+20 minutes'),'active',120,0,12,10,10,63,1),
      ('shield-kill-permit','shield-kill','underpass','shield-cycle','tunnel-maw',datetime('now'),datetime('now','+20 minutes'),'active',5,12,5,10,10,1,1),
      ('shield-defeat-permit','shield-defeat','underpass','shield-cycle','tunnel-maw',datetime('now'),datetime('now','+20 minutes'),'active',8,0,2,10,10,63,1),
      ('shield-race-permit','shield-race','underpass','shield-cycle','tunnel-maw',datetime('now'),datetime('now','+20 minutes'),'active',120,0,10,10,10,63,1),
      ('shield-legacy-permit','shield-legacy','underpass','shield-cycle','tunnel-maw',datetime('now'),datetime('now','+20 minutes'),'active',120,0,0,NULL,NULL,92,0),
      ('shield-corrupt-legacy-permit','shield-corrupt-legacy','underpass','shield-cycle','tunnel-maw',datetime('now'),datetime('now','+20 minutes'),'active',120,0,1,NULL,NULL,92,0),
      ('shield-impossible-active-permit','shield-impossible-active','underpass','shield-cycle','tunnel-maw',datetime('now'),datetime('now','+20 minutes'),'active',110,0,0,0,0,63,1),
      ('shield-impossible-enemy-permit','shield-impossible-enemy','underpass','shield-cycle','tunnel-maw',datetime('now'),datetime('now','+20 minutes'),'active',120,12,0,0,0,92,0),
      ('shield-partial-active-permit','shield-partial-active','underpass','shield-cycle','tunnel-maw',datetime('now'),datetime('now','+20 minutes'),'active',110,0,5,0,10,63,1),
      ('shield-closure-permit','shield-closure','underpass','shield-closure-cycle','tunnel-maw',datetime('now','-5 minutes'),datetime('now','+20 minutes'),'active',120,0,4,10,10,63,1);
  `);
  cli(['d1','execute','DEGEN','--local','--persist-to='+persist,'--file='+seed]);
  sql("UPDATE battle_permits SET enemy_shield=5 WHERE id IN ('shield-enemy-permit','shield-enemy-kill-permit','shield-kill-permit','shield-closure-permit','shield-race-permit')");
  server=spawn(wrangler,['dev','--local','--persist-to='+persist,'--ip=127.0.0.1','--port=8791'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  for(const stream of [server.stdout,server.stderr]) stream.on('data',d=>{logs=(logs+d.toString()).slice(-10000);});
  await until(async()=>{const r=await fetch(base+'/api/health',{signal:AbortSignal.timeout(600)});return r.ok&&(await r.json()).ok;});

  const start=await post('/api/battle/start',{playerId:'shield-start',eventKey:'underpass',cycleId:'shield-cycle',encounterKey:'tunnel-maw',playerShield:999,playerHp:0,playerMana:0,enemyShield:999,enemyHp:0,turnCount:99,status:'victory'});
  assert.equal(start.status,200);
  assert.deepEqual(start.data.initialState,{
    permitId:start.data.permitId,status:'active',playerHp:120,playerMana:12,
    playerShield:0,shieldAbsorbed:0,retaliationDamage:0,enemyHp:92,turnCount:0,
  });
  assert.deepEqual(sql(`SELECT player_hp,player_mana,player_shield,last_shield_absorbed,last_retaliation_damage,enemy_hp,turn_count,battle_status FROM battle_permits WHERE id='${start.data.permitId}'`),[
    {player_hp:120,player_mana:12,player_shield:0,last_shield_absorbed:0,last_retaliation_damage:0,enemy_hp:92,turn_count:0,battle_status:'active'},
  ]);

  // Closing an event does not invalidate a still-unexpired permit issued during that cycle.
  // Exercise the Shield-bearing snapshot and both Shield pools through the real Worker action path.
  sql("UPDATE battle_permits SET enemy_shield=1 WHERE id='shield-impossible-enemy-permit'");
  sql("UPDATE world_event_cycles SET closes_at=datetime('now','-1 minute') WHERE id='shield-closure-cycle'");
  const afterClosure=await post('/api/battle/action',{
    playerId:'shield-closure',permitId:'shield-closure-permit',abilityId:'slash',expectedTurnCount:1,
  });
  assert.equal(afterClosure.status,200);
  assert.deepEqual([
    afterClosure.data.playerHp,afterClosure.data.playerMana,afterClosure.data.playerShield,
    afterClosure.data.shieldAbsorbed,afterClosure.data.retaliationDamage,
    afterClosure.data.enemyShield ?? 0,afterClosure.data.enemyShieldAbsorbed,
    afterClosure.data.enemyHp,afterClosure.data.turnCount,afterClosure.data.status,
  ],[114,0,0,4,10,0,5,39,2,'active']);
  assert.deepEqual(sql("SELECT player_hp,player_mana,player_shield,last_shield_absorbed,last_retaliation_damage,enemy_hp,enemy_shield,turn_count,battle_status FROM battle_permits WHERE id='shield-closure-permit'"),[
    {player_hp:114,player_mana:0,player_shield:0,last_shield_absorbed:4,last_retaliation_damage:10,enemy_hp:39,enemy_shield:0,turn_count:2,battle_status:'active'},
  ],'closed-cycle combat must preserve the accepted Shield and HP transition in the original permit');
  assert.equal(sql("SELECT COUNT(*) AS count FROM world_event_cycles WHERE id='shield-closure-cycle' AND julianday(closes_at) < julianday('now')")[0]?.count,1);
  assert.equal(sql("SELECT COUNT(*) AS count FROM battle_permits WHERE id='shield-closure-permit' AND julianday(expires_at) > julianday('now')")[0]?.count,1);

  const legacy=await post('/api/battle/action',{playerId:'shield-legacy',permitId:'shield-legacy-permit',abilityId:'slash',expectedTurnCount:0});
  assert.equal(legacy.status,200);
  assert.equal(legacy.data.playerShield,0);
  assert.deepEqual(sql("SELECT player_hp,player_mana,player_shield,last_shield_absorbed,last_retaliation_damage,enemy_hp,turn_count,battle_status FROM battle_permits WHERE id='shield-legacy-permit'"),[
    {player_hp:110,player_mana:0,player_shield:0,last_shield_absorbed:0,last_retaliation_damage:10,enemy_hp:63,turn_count:1,battle_status:'active'},
  ]);

  const corruptLegacy=await post('/api/battle/action',{playerId:'shield-corrupt-legacy',permitId:'shield-corrupt-legacy-permit',abilityId:'slash',expectedTurnCount:0});
  assert.equal(corruptLegacy.status,409);
  assert.equal(corruptLegacy.data.error,'Battle state is invalid.');
  assert.equal('battleState' in corruptLegacy.data,false);
  assert.deepEqual(sql("SELECT player_hp,player_mana,player_shield,last_shield_absorbed,last_retaliation_damage,enemy_hp,turn_count,battle_status FROM battle_permits WHERE id='shield-corrupt-legacy-permit'"),[
    {player_hp:120,player_mana:0,player_shield:1,last_shield_absorbed:null,last_retaliation_damage:null,enemy_hp:92,turn_count:0,battle_status:'active'},
  ]);

  const impossibleActive=await post('/api/battle/action',{playerId:'shield-impossible-active',permitId:'shield-impossible-active-permit',abilityId:'slash',expectedTurnCount:1});
  assert.equal(impossibleActive.status,409);
  assert.equal(impossibleActive.data.error,'Battle state is invalid.');
  assert.equal('battleState' in impossibleActive.data,false);
  assert.deepEqual(sql("SELECT player_hp,player_mana,player_shield,last_shield_absorbed,last_retaliation_damage,enemy_hp,turn_count,battle_status FROM battle_permits WHERE id='shield-impossible-active-permit'"),[
    {player_hp:110,player_mana:0,player_shield:0,last_shield_absorbed:0,last_retaliation_damage:0,enemy_hp:63,turn_count:1,battle_status:'active'},
  ]);

  // A turn-zero permit must still carry the encounter's server-owned starting enemy Shield.
  // A forged/corrupt D1 value cannot be accepted as a post-turn snapshot.
  const impossibleEnemy=await post('/api/battle/action',{
    playerId:'shield-impossible-enemy',permitId:'shield-impossible-enemy-permit',
    abilityId:'slash',expectedTurnCount:0,
  });
  assert.equal(impossibleEnemy.status,409);
  assert.equal(impossibleEnemy.data.error,'Battle state is invalid.');
  assert.equal('battleState' in impossibleEnemy.data,false);
  assert.deepEqual(sql("SELECT player_hp,player_mana,player_shield,last_shield_absorbed,last_retaliation_damage,enemy_hp,enemy_shield,turn_count,battle_status FROM battle_permits WHERE id='shield-impossible-enemy-permit'"),[
    {player_hp:120,player_mana:12,player_shield:0,last_shield_absorbed:0,last_retaliation_damage:0,enemy_hp:92,enemy_shield:1,turn_count:0,battle_status:'active'},
  ]);

  // A fresh permit cannot claim prior enemy Shield absorption even when its current
  // Shield still equals the server-owned starting value.
  sql("UPDATE battle_permits SET enemy_shield=0,last_enemy_shield_absorbed=1 WHERE id='shield-impossible-enemy-permit'");
  const impossibleEnemyAudit=await post('/api/battle/action',{
    playerId:'shield-impossible-enemy',permitId:'shield-impossible-enemy-permit',
    abilityId:'slash',expectedTurnCount:0,
  });
  assert.equal(impossibleEnemyAudit.status,409);
  assert.equal(impossibleEnemyAudit.data.error,'Battle state is invalid.');
  assert.equal('battleState' in impossibleEnemyAudit.data,false);
  assert.deepEqual(sql("SELECT player_hp,player_mana,player_shield,last_shield_absorbed,last_retaliation_damage,enemy_hp,enemy_shield,last_enemy_shield_absorbed,turn_count,battle_status FROM battle_permits WHERE id='shield-impossible-enemy-permit'"),[
    {player_hp:120,player_mana:12,player_shield:0,last_shield_absorbed:0,last_retaliation_damage:0,enemy_hp:92,enemy_shield:0,last_enemy_shield_absorbed:1,turn_count:0,battle_status:'active'},
  ],'the rejected corrupt audit must not advance or rewrite the permit');

  const partialActive=await post('/api/battle/action',{playerId:'shield-partial-active',permitId:'shield-partial-active-permit',abilityId:'slash',expectedTurnCount:1});
  assert.equal(partialActive.status,409);
  assert.equal(partialActive.data.error,'Battle state is invalid.');
  assert.equal('battleState' in partialActive.data,false);
  assert.deepEqual(sql("SELECT player_hp,player_mana,player_shield,last_shield_absorbed,last_retaliation_damage,enemy_hp,turn_count,battle_status FROM battle_permits WHERE id='shield-partial-active-permit'"),[
    {player_hp:110,player_mana:0,player_shield:5,last_shield_absorbed:0,last_retaliation_damage:10,enemy_hp:63,turn_count:1,battle_status:'active'},
  ]);

  // Every combat, outcome, and reward field supplied by the browser is hostile.
  // The Worker must derive all of them from the persisted permit and selected ability.
  const action=await post('/api/battle/action',{
    playerId:'shield-action',permitId:'shield-action-permit',abilityId:'slash',expectedTurnCount:1,
    playerHp:0,playerMana:12,playerShield:999,shieldAbsorbed:0,retaliationDamage:0,
    enemyHp:0,turnCount:Number.MAX_SAFE_INTEGER,status:'victory',victory:true,
    damage:Number.MAX_SAFE_INTEGER,manaCost:0,shieldGain:Number.MAX_SAFE_INTEGER,
    ability:{damage:Number.MAX_SAFE_INTEGER,manaCost:0,shieldGain:Number.MAX_SAFE_INTEGER},
    reward:{xp:999999,currency:999999,items:['forged-item']},
    xp:999999,currency:999999,items:['forged-item'],
  });
  assert.equal(action.status,200);
  assert.deepEqual([action.data.playerHp,action.data.playerMana,action.data.playerShield,action.data.shieldAbsorbed,action.data.retaliationDamage,action.data.enemyHp,action.data.turnCount,action.data.status],
    [115,0,0,5,10,34,2,'active']);
  assert.deepEqual(sql("SELECT player_hp,player_mana,player_shield,last_shield_absorbed,last_retaliation_damage,enemy_hp,turn_count,battle_status FROM battle_permits WHERE id='shield-action-permit'"),[
    {player_hp:115,player_mana:0,player_shield:0,last_shield_absorbed:5,last_retaliation_damage:10,enemy_hp:34,turn_count:2,battle_status:'active'},
  ]);
  assert.equal('reward' in action.data,false,'action responses never accept or return client reward payloads');
  assert.equal('xp' in action.data,false);
  assert.equal('currency' in action.data,false);
  assert.equal('victory' in action.data,false);
  assert.deepEqual(sql("SELECT level,xp,currency FROM characters WHERE player_id='shield-action'"),[
    {level:1,xp:0,currency:0},
  ],'forged XP, currency, and victory fields must not mutate progression');

  const enemyShieldAction=await post('/api/battle/action',{
    playerId:'shield-enemy',permitId:'shield-enemy-permit',abilityId:'slash',expectedTurnCount:1,
    enemyShield:0,enemyShieldAbsorbed:999,enemyHp:0,playerHp:0,turnCount:99,status:'victory',
    reward:{xp:999999,currency:999999,items:['forged-item']},
  });
  assert.equal(enemyShieldAction.status,200);
  assert.equal(enemyShieldAction.data.enemyShieldAbsorbed,5,'Worker damage must consume persisted enemy Shield before HP');
  assert.equal(enemyShieldAction.data.enemyHp,68,'only damage remaining after Shield reaches enemy HP');
  assert.equal(enemyShieldAction.data.playerHp,100,'enemy retaliation still resolves after the Shield absorbs the hit');
  assert.deepEqual(sql("SELECT enemy_shield,last_enemy_shield_absorbed,enemy_hp,turn_count FROM battle_permits WHERE id='shield-enemy-permit'"),[
    {enemy_shield:0,last_enemy_shield_absorbed:5,enemy_hp:68,turn_count:2},
  ]);
  assert.equal('reward' in enemyShieldAction.data,false,'client reward fields remain ignored');

  // A persisted last-action Shield audit cannot exceed any currently defined Degen action.
  // Corrupt D1 state must fail closed instead of being overwritten by another accepted turn.
  sql("UPDATE battle_permits SET last_enemy_shield_absorbed=9007199254740991 WHERE id='shield-enemy-permit'");
  const impossibleEnemyAbsorption=await post('/api/battle/action',{
    playerId:'shield-enemy',permitId:'shield-enemy-permit',abilityId:'slash',expectedTurnCount:2,
  });
  assert.equal(impossibleEnemyAbsorption.status,409);
  assert.equal(impossibleEnemyAbsorption.data.error,'Battle state is invalid.');
  assert.equal('battleState' in impossibleEnemyAbsorption.data,false);
  assert.deepEqual(sql("SELECT player_hp,player_mana,player_shield,last_shield_absorbed,last_retaliation_damage,enemy_hp,enemy_shield,last_enemy_shield_absorbed,turn_count,battle_status FROM battle_permits WHERE id='shield-enemy-permit'"),[
    {player_hp:100,player_mana:12,player_shield:0,last_shield_absorbed:0,last_retaliation_damage:10,enemy_hp:68,enemy_shield:0,last_enemy_shield_absorbed:9007199254740991,turn_count:2,battle_status:'active'},
  ]);

  // A paid killing blow must consume the remaining enemy Shield, skip retaliation,
  // persist the terminal state, and settle its reward receipt exactly once.
  const enemyShieldKill=await post('/api/battle/action',{
    playerId:'shield-enemy-kill',permitId:'shield-enemy-kill-permit',abilityId:'crack',expectedTurnCount:1,
    playerMana:0,enemyShield:0,enemyShieldAbsorbed:0,enemyHp:0,playerHp:0,turnCount:99,status:'defeat',
    reward:{xp:999999,currency:999999,items:['forged-item']},
  });
  assert.equal(enemyShieldKill.status,200);
  assert.deepEqual([
    enemyShieldKill.data.playerHp,enemyShieldKill.data.playerMana,enemyShieldKill.data.playerShield,
    enemyShieldKill.data.shieldAbsorbed,enemyShieldKill.data.retaliationDamage,
    enemyShieldKill.data.enemyShieldAbsorbed,enemyShieldKill.data.enemyHp,
    enemyShieldKill.data.turnCount,enemyShieldKill.data.status,
  ],[110,8,0,0,0,5,0,2,'victory']);
  assert.deepEqual(sql("SELECT player_hp,player_mana,player_shield,last_shield_absorbed,last_retaliation_damage,enemy_hp,enemy_shield,last_enemy_shield_absorbed,turn_count,battle_status FROM battle_permits WHERE id='shield-enemy-kill-permit'"),[
    {player_hp:110,player_mana:8,player_shield:0,last_shield_absorbed:0,last_retaliation_damage:0,enemy_hp:0,enemy_shield:0,last_enemy_shield_absorbed:5,turn_count:2,battle_status:'victory'},
  ]);

  const enemyKillCompletion=await post('/api/battle/complete',{playerId:'shield-enemy-kill',permitId:'shield-enemy-kill-permit'});
  assert.equal(enemyKillCompletion.status,200);
  const settledCharacter=sql("SELECT level,xp,currency FROM characters WHERE player_id='shield-enemy-kill'");
  const enemyKillReplay=await post('/api/battle/complete',{playerId:'shield-enemy-kill',permitId:'shield-enemy-kill-permit'});
  assert.equal(enemyKillReplay.status,200);
  assert.deepEqual(sql("SELECT level,xp,currency FROM characters WHERE player_id='shield-enemy-kill'"),settledCharacter,
    'replaying completion after an enemy-Shield killing blow must not award progression twice');
  assert.deepEqual(sql("SELECT COUNT(*) AS count FROM battle_history WHERE id='shield-enemy-kill-permit:victory'"),[
    {count:1},
  ]);
  assert.deepEqual(sql("SELECT reward_state,battle_status FROM battle_permits WHERE id='shield-enemy-kill-permit'"),[
    {reward_state:'awarded',battle_status:'victory'},
  ]);

  const rejected=await post('/api/battle/action',{playerId:'shield-carry',permitId:'shield-carry-permit',abilityId:'crack',expectedTurnCount:1});
  assert.equal(rejected.status,409);
  assert.equal(rejected.data.battleState.playerShield,12);
  assert.deepEqual(sql("SELECT player_hp,player_mana,player_shield,last_shield_absorbed,last_retaliation_damage,enemy_hp,turn_count FROM battle_permits WHERE id='shield-carry-permit'"),[
    {player_hp:120,player_mana:0,player_shield:12,last_shield_absorbed:10,last_retaliation_damage:10,enemy_hp:63,turn_count:1},
  ]);
  const carry=await post('/api/battle/action',{playerId:'shield-carry',permitId:'shield-carry-permit',abilityId:'slash',expectedTurnCount:1});
  assert.equal(carry.status,200);
  assert.deepEqual([carry.data.playerHp,carry.data.playerShield,carry.data.shieldAbsorbed,carry.data.retaliationDamage],[120,2,10,10]);
  assert.deepEqual(sql("SELECT last_shield_absorbed,last_retaliation_damage FROM battle_permits WHERE id='shield-carry-permit'"),[
    {last_shield_absorbed:10,last_retaliation_damage:10},
  ]);

  const race = await Promise.all([
    post('/api/battle/action',{playerId:'shield-race',permitId:'shield-race-permit',abilityId:'slash',expectedTurnCount:1}),
    post('/api/battle/action',{playerId:'shield-race',permitId:'shield-race-permit',abilityId:'slash',expectedTurnCount:1}),
  ]);
  assert.deepEqual(race.map((result) => result.status).sort(), [200,409]);
  const raceConflict = race.find((result) => result.status === 409);
  assert.equal(raceConflict?.data.battleState.playerShield, 0);
  assert.equal(raceConflict?.data.battleState.turnCount, 2);
  assert.equal(raceConflict?.data.battleState.shieldAbsorbed, 10);
  assert.equal(raceConflict?.data.battleState.retaliationDamage, 10);
  assert.equal(raceConflict?.data.battleState.enemyShieldAbsorbed, 5,
    'stale-turn recovery includes the committed enemy Shield absorption audit');
  assert.deepEqual(sql("SELECT player_hp,player_mana,player_shield,last_shield_absorbed,last_retaliation_damage,enemy_hp,enemy_shield,last_enemy_shield_absorbed,turn_count,battle_status FROM battle_permits WHERE id='shield-race-permit'"),[
    {player_hp:120,player_mana:0,player_shield:0,last_shield_absorbed:10,last_retaliation_damage:10,enemy_hp:39,enemy_shield:0,last_enemy_shield_absorbed:5,turn_count:2,battle_status:'active'},
  ]);

  const kill=await post('/api/battle/action',{playerId:'shield-kill',permitId:'shield-kill-permit',abilityId:'crack',expectedTurnCount:1});
  assert.equal(kill.status,200);
  assert.equal(kill.data.status,'victory');
  assert.equal(kill.data.playerShield,5);
  assert.equal(kill.data.retaliationDamage,0);
  assert.equal(kill.data.shieldAbsorbed,0);
  assert.equal(kill.data.enemyShieldAbsorbed,5,
    'the killing blow must preserve the final enemy Shield absorption in its action result');
  assert.deepEqual(sql("SELECT last_shield_absorbed,last_retaliation_damage,last_enemy_shield_absorbed FROM battle_permits WHERE id='shield-kill-permit'"),[
    {last_shield_absorbed:0,last_retaliation_damage:0,last_enemy_shield_absorbed:5},
  ]);

  const complete=await post('/api/battle/complete',{playerId:'shield-kill',permitId:'shield-kill-permit'});
  assert.equal(complete.status,200);
  const replay=await post('/api/battle/action',{playerId:'shield-kill',permitId:'shield-kill-permit',abilityId:'slash',expectedTurnCount:2});
  assert.equal(replay.status,409);
  assert.equal(replay.data.error,'Battle permit is already completed.');
  assert.equal(replay.data.battleState.shieldAbsorbed,0);
  assert.equal(replay.data.battleState.retaliationDamage,0);
  assert.equal(replay.data.battleState.enemyShieldAbsorbed,5,
    'completed terminal recovery preserves the final enemy Shield absorption audit');

  const defeat=await post('/api/battle/action',{playerId:'shield-defeat',permitId:'shield-defeat-permit',abilityId:'slash',expectedTurnCount:1});
  assert.equal(defeat.status,200);
  assert.equal(defeat.data.status,'defeat');
  assert.equal(defeat.data.playerHp,0);
  assert.equal(defeat.data.playerShield,0);
  assert.equal(defeat.data.shieldAbsorbed,2);
  assert.equal(defeat.data.retaliationDamage,10);
  assert.deepEqual(sql("SELECT player_hp,player_mana,player_shield,last_shield_absorbed,last_retaliation_damage,enemy_hp,turn_count,battle_status FROM battle_permits WHERE id='shield-defeat-permit'"),[
    {player_hp:0,player_mana:0,player_shield:0,last_shield_absorbed:2,last_retaliation_damage:10,enemy_hp:34,turn_count:2,battle_status:'defeat'},
  ]);
  sql("UPDATE battle_permits SET expires_at=datetime('now','-1 minute') WHERE id='shield-defeat-permit'");
  const recoveredDefeat=await post('/api/battle/action',{playerId:'shield-defeat',permitId:'shield-defeat-permit',abilityId:'slash',expectedTurnCount:2});
  assert.equal(recoveredDefeat.status,409);
  assert.equal(recoveredDefeat.data.error,'Battle is already defeated.');
  assert.equal(recoveredDefeat.data.battleState.shieldAbsorbed,2);
  assert.equal(recoveredDefeat.data.battleState.retaliationDamage,10);
  sql("UPDATE battle_permits SET last_shield_absorbed=10,last_retaliation_damage=10 WHERE id='shield-defeat-permit'");
  const corruptRecovery=await post('/api/battle/action',{playerId:'shield-defeat',permitId:'shield-defeat-permit',abilityId:'slash',expectedTurnCount:2});
  assert.equal(corruptRecovery.status,409);
  assert.equal(corruptRecovery.data.error,'Battle permit is invalid, expired, or already completed.');
  assert.equal('battleState' in corruptRecovery.data,false);
  console.log('Worker/D1 Shield integration PASS');
} finally {
  if(server && server.exitCode===null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolve=>server.once('exit',resolve)),sleep(3000)]);
    if(server.exitCode===null) { server.kill('SIGKILL'); await new Promise(resolve=>server.once('exit',resolve)); }
  }
  rmSync(scratch,{recursive:true,force:true});
}
