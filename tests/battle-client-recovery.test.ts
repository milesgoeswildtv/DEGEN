import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';
import { canUseAbility, resolveCombatTurn } from '../src/game/combat/rules.ts';

const src = readFileSync(new URL('../src/game/combat/engine.ts',import.meta.url),'utf8')
  .replace(/^import .*;\n/gm,'').replace('export class BattleEngine','class BattleEngine');
const BattleEngine = runInNewContext(stripTypeScriptTypes(src,{mode:'transform'})+'\nBattleEngine;',
  {canUseAbility,resolveCombatTurn});
const turn = (status,playerMana,enemyHp,turnCount) =>
  ({permitId:'permit',status,playerHp:110,playerMana,enemyHp,turnCount});

test('duplicate Worker response never deducts Mana twice',()=>{
  const engine=new BattleEngine(TEST_DEGEN,TUNNEL_MAW,()=>{});
  const response=turn('active',8,57,1);
  engine.applyAuthoritativeAction('crack',response);
  const before=engine.snapshot;
  engine.applyAuthoritativeAction('crack',response);
  assert.deepEqual(engine.snapshot,before);
});

test('lost response recovery ignores older Worker state',()=>{
  const engine=new BattleEngine(TEST_DEGEN,TUNNEL_MAW,()=>{});
  engine.syncAuthoritativeState(turn('active',4,22,2));
  const before=engine.snapshot;
  engine.syncAuthoritativeState(turn('active',8,57,1));
  assert.deepEqual(engine.snapshot,before);
});

test('recovered victory calls completion once without client rewards',()=>{
  const calls=[];
  const engine=new BattleEngine(TEST_DEGEN,TUNNEL_MAW,(status,reward)=>calls.push({status,reward}));
  const victory=turn('victory',0,0,3);
  engine.syncAuthoritativeState(victory);
  engine.syncAuthoritativeState(victory);
  assert.equal(calls.length,1);
  assert.equal(calls[0].reward,undefined);
});

test('zero Mana keeps Degen manifested and free action usable',()=>{
  const engine=new BattleEngine(TEST_DEGEN,TUNNEL_MAW,()=>{});
  engine.syncAuthoritativeState({...turn('active',0,92,0),playerHp:120});
  engine.useAbility('slash');
  assert.equal(engine.snapshot.playerMana,0);
  assert.equal(engine.snapshot.turnCount,1);
  assert.equal(engine.snapshot.status,'active');
});

const apiSource=readFileSync(new URL('../src/app/api.ts',import.meta.url),'utf8')
  .replace(/^import .*;\n/gm,'').replace('import.meta.env.VITE_API_BASE',"'https://api.example'")
  .replaceAll('export class ','class ');
function apiWith(handler) {
  const calls=[];
  const classes=runInNewContext(stripTypeScriptTypes(apiSource,{mode:'transform'})+
    '\n({GameApi,BattleTurnConflictError});',
    {Response,fetch:async(url,init)=>{calls.push({url,init});return handler(url,init);}});
  return {api:new classes.GameApi(),calls,BattleTurnConflictError:classes.BattleTurnConflictError};
}

test('client submits expected turn count to Worker',async()=>{
  const {api,calls}=apiWith(()=>Response.json(turn('active',8,57,1)));
  await api.actUnderpass('p1','permit','crack',0);
  assert.deepEqual(JSON.parse(calls[0].init.body),
    {playerId:'p1',permitId:'permit',abilityId:'crack',expectedTurnCount:0});
});

test('409 with authoritative state is recoverable; Mana rejection is not',async()=>{
  const stale=apiWith(()=>Response.json({battleState:turn('active',8,57,1)},{status:409}));
  await assert.rejects(stale.api.actUnderpass('p1','permit','crack',0),
    error=>error instanceof stale.BattleTurnConflictError);
  const mana=apiWith(()=>Response.json({error:'Not enough Mana'},{status:409}));
  await assert.rejects(mana.api.actUnderpass('p1','permit','crack',0),
    error=>!(error instanceof mana.BattleTurnConflictError));
});

test('skipped authoritative turns are reconciled without fabricated ability damage',()=>{
  const engine=new BattleEngine(TEST_DEGEN,TUNNEL_MAW,()=>{});
  engine.applyAuthoritativeAction('crack',turn('active',4,22,2));
  assert.equal(engine.snapshot.turnCount,2);
  assert.equal(engine.snapshot.playerMana,4);
  assert.equal(engine.snapshot.enemyHp,22);
  assert.ok(engine.snapshot.log.some(line=>line.includes('synchronized with server')));
  assert.equal(engine.snapshot.log.some(line=>line.includes('Crack: 70 damage')),false);
});
