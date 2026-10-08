import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { webcrypto } from 'node:crypto';
import test from 'node:test';
import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';
import { canUseAbility, resolveCombatTurn } from '../src/game/combat/rules.ts';

const workerSource = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/^export default\s*\{/m, 'const worker = {');
const action = runInNewContext(stripTypeScriptTypes(workerSource, { mode: 'transform' }) + '\nhandleBattleAction;',
  { TEST_DEGEN, TUNNEL_MAW, canUseAbility, resolveCombatTurn, crypto: webcrypto,
    Request, Response, URL, console, Uint32Array },
) as (request: Request, env: unknown) => Promise<Response>;

function setup(hp = 1) {
  const db = new DatabaseSync(':memory:');
  const root = new URL('../db/', import.meta.url);
  db.exec(readFileSync(new URL('schema.sql', root), 'utf8'));
  for (const name of ['0002_authoritative_battle_state.sql', '0003_degen_mana.sql',
    '0004_reward_receipt.sql', '0005_reward_claim_character_guard.sql']) {
    db.exec(readFileSync(new URL('migrations/' + name, root), 'utf8'));
  }
  db.exec("INSERT INTO players(id,display_name) VALUES ('p1','Player')");
  db.exec("INSERT INTO characters(player_id,degen_key,level) VALUES ('p1','test-degen',3)");
  db.exec("INSERT INTO world_event_cycles(id,event_key,opens_at,closes_at) VALUES ('cycle','underpass',datetime('now','-4 hours'),datetime('now','-2 hours'))");
  db.prepare(`INSERT INTO battle_permits(id,player_id,event_key,cycle_id,encounter_key,expires_at,
    battle_status,player_hp,player_mana,enemy_hp,turn_count) VALUES
    ('permit','p1','underpass','cycle','tunnel-maw',datetime('now','+20 minutes'),'active',?,12,92,0)`).run(hp);
  let beforeBatch: (() => void) | undefined;
  let afterFirstBatchStatement: (() => void) | undefined;
  const adapter = {
    prepare(sql: string) { return { bind(...params: unknown[]) { return {
      first: async () => db.prepare(sql).get(...params) ?? null,
      run: async () => db.prepare(sql).run(...params),
      sql, params,
    }; } }; },
    async batch(statements: Array<{sql: string; params: unknown[]}>) {
      if (beforeBatch) { const hook = beforeBatch; beforeBatch = undefined; hook(); }
      db.exec('BEGIN');
      try {
        const results: Array<{results: unknown[]}> = [];
        for (const [index, stmt] of statements.entries()) {
          if (/\bRETURNING\b/i.test(stmt.sql)) {
            results.push({results: db.prepare(stmt.sql).all(...stmt.params)});
          } else {
            db.prepare(stmt.sql).run(...stmt.params);
            results.push({results: []});
          }
          if (index === 0 && afterFirstBatchStatement) {
            const hook = afterFirstBatchStatement;
            afterFirstBatchStatement = undefined;
            hook();
          }
        }
        db.exec('COMMIT');
        return results;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
  const request = (abilityId = 'slash') => new Request('https://example.com/api/battle/action', {
    method:'POST', body:JSON.stringify({playerId:'p1',permitId:'permit',abilityId}),
  });
  const act = (abilityId = 'slash') => action(request(abilityId), {DB:adapter});
  const state = () => db.prepare("SELECT battle_status,player_hp,player_mana,enemy_hp,turn_count FROM battle_permits WHERE id='permit'").get();
  const history = () => db.prepare("SELECT id FROM battle_history WHERE player_id='p1'").all();
  return {db,act,state,history,expireAfterCas:() => {afterFirstBatchStatement=() => {
    db.exec("UPDATE battle_permits SET expires_at=datetime('now','-1 minute') WHERE id='permit'");
  };},expireBeforeBatch:() => {beforeBatch=() => {
    db.exec("UPDATE battle_permits SET expires_at=datetime('now','-1 minute') WHERE id='permit'");
  };}};
}

test('defeat history failure rolls back the terminal turn, then retry succeeds', async () => {
  const s=setup();
  s.db.exec("CREATE TRIGGER reject_history BEFORE INSERT ON battle_history BEGIN SELECT RAISE(ABORT,'QA_HISTORY_FAILURE'); END;");
  await assert.rejects(s.act(), /QA_HISTORY_FAILURE/);
  assert.equal((s.state() as {battle_status:string}).battle_status,'active');
  assert.equal((s.state() as {turn_count:number}).turn_count,0);
  assert.equal(s.history().length,0);
  s.db.exec('DROP TRIGGER reject_history');
  assert.equal((await s.act()).status,200);
  assert.deepEqual(s.history().map((x) => x.id),['permit:defeat']);
  s.db.close();
});

test('64 concurrent and 100 sequential retries persist one defeat', async () => {
  const s=setup();
  const outcomes=await Promise.all(Array.from({length:64},()=>s.act()));
  assert.equal(outcomes.filter((x)=>x.status===200).length,1);
  assert.equal(outcomes.filter((x)=>x.status===409).length,63);
  const terminal=s.state();
  for(let i=0;i<100;i++) assert.equal((await s.act()).status,409);
  assert.deepEqual(s.state(),terminal);
  assert.deepEqual(s.history().map((x)=>x.id),['permit:defeat']);
  s.db.close();
});

test('zero Mana leaves free abilities usable without defeat history', async () => {
  const s=setup(TEST_DEGEN.maxHp);
  s.db.exec("UPDATE battle_permits SET player_mana=0 WHERE id='permit'");
  const response=await s.act();
  assert.equal(response.status,200);
  assert.equal((await response.json() as {playerMana:number}).playerMana,0);
  assert.equal(s.history().length,0);
  s.db.close();
});

test('expiry between snapshot and CAS rejects without terminal history', async () => {
  const s=setup();
  s.expireBeforeBatch();
  assert.equal((await s.act()).status,409);
  assert.equal((s.state() as {battle_status:string}).battle_status,'active');
  assert.equal((s.state() as {turn_count:number}).turn_count,0);
  assert.equal(s.history().length,0);
  s.db.close();
});

test('expiry after authorized terminal CAS still records defeat history', async () => {
  const s=setup();
  s.expireAfterCas();
  const response=await s.act();
  assert.equal(response.status,200);
  assert.equal((s.state() as {battle_status:string}).battle_status,'defeat');
  assert.equal((s.state() as {turn_count:number}).turn_count,1);
  assert.deepEqual(s.history().map((row) => row.id),['permit:defeat']);
  for (let i=0;i<10;i++) assert.equal((await s.act()).status,409);
  assert.deepEqual(s.history().map((row) => row.id),['permit:defeat']);
  s.db.close();
});

test('mixed victory/defeat race chooses exactly one terminal result', async () => {
  const s=setup();
  s.db.exec("UPDATE battle_permits SET enemy_hp=32 WHERE id='permit'");
  const outcomes=await Promise.all([s.act('crack'),s.act('slash')]);
  assert.equal(outcomes.filter(x=>x.status===200).length,1);
  assert.equal(outcomes.filter(x=>x.status===409).length,1);
  const state=s.state() as {battle_status:string;turn_count:number;player_mana:number};
  assert.equal(state.turn_count,1);
  assert.ok(state.battle_status==='victory'||state.battle_status==='defeat');
  assert.equal(s.history().length,state.battle_status==='defeat'?1:0);
  assert.equal(state.player_mana,state.battle_status==='victory'?8:12);
  s.db.close();
});

test('missing character rejects without a terminal state or history', async () => {
  const s=setup();
  s.db.exec("DELETE FROM characters WHERE player_id='p1'");
  assert.equal((await s.act()).status,404);
  assert.equal((s.state() as {battle_status:string}).battle_status,'active');
  assert.equal((s.state() as {turn_count:number}).turn_count,0);
  assert.equal(s.history().length,0);
  s.db.close();
});

test('defeat grants no XP, currency, or inventory', async () => {
  const s=setup();
  const before=s.db.prepare("SELECT level,xp,currency FROM characters WHERE player_id='p1'").get();
  const items=s.db.prepare("SELECT COUNT(*) AS n FROM player_inventory WHERE player_id='p1'").get();
  assert.equal((await s.act()).status,200);
  assert.deepEqual(s.db.prepare("SELECT level,xp,currency FROM characters WHERE player_id='p1'").get(),before);
  assert.deepEqual(s.db.prepare("SELECT COUNT(*) AS n FROM player_inventory WHERE player_id='p1'").get(),items);
  assert.deepEqual(s.history().map(x=>x.id),['permit:defeat']);
  s.db.close();
});
