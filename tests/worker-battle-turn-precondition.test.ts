import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';
import { canUseAbility, resolveCombatTurn } from '../src/game/combat/rules.ts';

const source = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '').replace(/^export default\s*\{/m, 'const worker = {');
const handleBattleAction = runInNewContext(
  stripTypeScriptTypes(source, { mode: 'transform' }) + '\nhandleBattleAction;',
  { TEST_DEGEN, TUNNEL_MAW, canUseAbility, resolveCombatTurn, crypto, Request, Response, URL, console, Uint32Array },
) as (request: Request, env: unknown) => Promise<Response>;

function setup(overrides: { expiresAt?: string; playerHp?: number; playerMana?: number; enemyHp?: number } = {}) {
  const db = new DatabaseSync(':memory:');
  const base = new URL('../db/', import.meta.url);
  db.exec(readFileSync(new URL('schema.sql', base), 'utf8'));
  for (const name of [
    '0002_authoritative_battle_state.sql', '0003_degen_mana.sql',
    '0004_reward_receipt.sql', '0005_reward_claim_character_guard.sql',
  ]) db.exec(readFileSync(new URL('migrations/' + name, base), 'utf8'));
  db.prepare('INSERT INTO players (id, display_name) VALUES (?, ?)').run('p1', 'Player');
  db.prepare("INSERT INTO characters (player_id, degen_key) VALUES (?, 'test-degen')").run('p1');
  db.prepare("INSERT INTO world_event_cycles (id, event_key, opens_at, closes_at) VALUES ('cycle', 'underpass', datetime('now', '-4 hours'), datetime('now', '-2 hours'))").run();
  const expires = new Date(Date.now() + 20 * 60_000).toISOString();
  db.prepare(`INSERT INTO battle_permits
    (id, player_id, event_key, cycle_id, encounter_key, expires_at,
     player_hp, player_mana, enemy_hp, battle_status, turn_count)
    VALUES ('permit', 'p1', 'underpass', 'cycle', 'tunnel-maw', ?, ?, ?, ?, 'active', 0)`)
    .run(overrides.expiresAt ?? expires, overrides.playerHp ?? TEST_DEGEN.maxHp,
      overrides.playerMana ?? TEST_DEGEN.maxMana, overrides.enemyHp ?? TUNNEL_MAW.maxHp);
  let beforeCas: (() => void) | undefined;
  const adapter = {
    prepare(sql: string) {
      return { bind(...params: unknown[]) {
        const statement = db.prepare(sql);
        const applyRace = () => {
          if (sql.startsWith('UPDATE battle_permits') && beforeCas) {
            const hook = beforeCas;
            beforeCas = undefined;
            hook();
          }
        };
        return {
          first: () => {
            applyRace();
            return statement.get(...params);
          },
          run: () => statement.run(...params),
          // D1.batch returns per-statement rows and rolls back all writes on error.
          execute: () => {
            applyRace();
            if (/\bRETURNING\b/i.test(sql)) return { results: statement.all(...params) };
            statement.run(...params);
            return { results: [] };
          },
        };
      } };
    },
    batch(statements: Array<{ execute: () => { results: unknown[] } }>) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => statement.execute());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  const act = async (abilityId = 'slash', permitId = 'permit', playerId = 'p1', expectedTurnCount?: unknown) => {
    const request = new Request('https://degen-api.example/api/battle/action', {
      method: 'POST', body: JSON.stringify({ playerId, permitId, abilityId, ...(expectedTurnCount === undefined ? {} : { expectedTurnCount }) }),
    });
    const response = await handleBattleAction(request, { DB: adapter });
    return { status: response.status, data: await response.json() as Record<string, unknown> };
  };
  const state = () => db.prepare('SELECT player_hp, player_mana, enemy_hp, battle_status, turn_count FROM battle_permits WHERE id = ?').get('permit') as Record<string, unknown>;
  return { db, act, state, injectCasRace: () => {
    beforeCas = () => db.prepare(`UPDATE battle_permits
      SET player_hp = 110, player_mana = 8, enemy_hp = 57, turn_count = 1
      WHERE id = 'permit'`).run();
  } };
}

test('paid ability consumes exactly its cost and persists one turn', async () => {
  const { db, act, state } = setup();
  const cost = TEST_DEGEN.abilities.find((a) => a.id === 'crack')!.manaCost;
  const result = await act('crack');
  assert.equal(result.status, 200);
  assert.equal(result.data.playerMana, TEST_DEGEN.maxMana - cost);
  assert.equal(result.data.turnCount, 1);
  assert.equal(state().player_mana, TEST_DEGEN.maxMana - cost);
  assert.equal(state().turn_count, 1);
  db.close();
});

test('unaffordable ability rejects without changing HP, Mana, enemy, or turn', async () => {
  const { db, act, state } = setup({ playerMana: 0 });
  const before = state();
  const result = await act('crack');
  assert.equal(result.status, 409);
  assert.match(String(result.data.error), /Not enough Mana/);
  assert.deepEqual(state(), before);
  db.close();
});

test('zero-cost ability works at zero Mana without reverting Degen', async () => {
  const { db, act, state } = setup({ playerMana: 0 });
  const result = await act('slash');
  assert.equal(result.status, 200);
  assert.equal(result.data.playerMana, 0);
  assert.equal(state().turn_count, 1);
  db.close();
});

test('killing blow spends Mana but skips retaliation', async () => {
  const cost = TEST_DEGEN.abilities.find((a) => a.id === 'crack')!.manaCost;
  const { db, act, state } = setup({ playerHp: 5, playerMana: cost, enemyHp: 20 });
  const result = await act('crack');
  assert.equal(result.status, 200);
  assert.equal(result.data.status, 'victory');
  assert.equal(result.data.playerHp, 5);
  assert.equal(result.data.playerMana, 0);
  assert.equal(state().battle_status, 'victory');
  db.close();
});

test('defeat persists authoritative state and one history row', async () => {
  const { db, act, state } = setup({ playerHp: 1 });
  const result = await act('slash');
  assert.equal(result.status, 200);
  assert.equal(result.data.status, 'defeat');
  assert.equal(state().player_hp, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM battle_history WHERE result = 'defeat'").get()!.n, 1);
  db.close();
});

test('two concurrent actions cannot both apply the same turn', async () => {
  const { db, act, state } = setup();
  const results = await Promise.all([act('crack'), act('crack')]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(state().turn_count, 1);
  assert.equal(state().player_mana, TEST_DEGEN.maxMana - TEST_DEGEN.abilities.find((a) => a.id === 'crack')!.manaCost);
  db.close();
});

test('expired permit cannot act or mutate battle state', async () => {
  const { db, act, state } = setup({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
  const before = state();
  assert.equal((await act()).status, 409);
  assert.deepEqual(state(), before);
  db.close();
});

test('already issued permit stays valid after event cycle closure', async () => {
  const { db, act, state } = setup();
  assert.equal((await act('slash')).status, 200);
  assert.equal(state().turn_count, 1);
  db.close();
});

test('invalid permit and mismatched player cannot mutate encounter', async () => {
  const { db, act, state } = setup();
  const before = state();
  assert.equal((await act('slash', 'missing')).status, 409);
  assert.equal((await act('slash', 'permit', 'someone-else')).status, 409);
  assert.deepEqual(state(), before);
  db.close();
});

test('resolved victory cannot accept a subsequent action', async () => {
  const cost = TEST_DEGEN.abilities.find((a) => a.id === 'crack')!.manaCost;
  const { db, act, state } = setup({ playerHp: 5, playerMana: cost, enemyHp: 20 });
  assert.equal((await act('crack')).status, 200);
  const before = state();
  assert.equal((await act('slash')).status, 409);
  assert.deepEqual(state(), before);
  db.close();
});

test('unknown ability cannot mutate battle state', async () => {
  const { db, act, state } = setup();
  const before = state();
  assert.equal((await act('unapproved-ability')).status, 400);
  assert.deepEqual(state(), before);
  db.close();
});

test('completed permit cannot be replayed', async () => {
  const { db, act, state } = setup();
  db.prepare("UPDATE battle_permits SET completed_at = CURRENT_TIMESTAMP WHERE id = 'permit'").run();
  const before = state();
  assert.equal((await act('slash')).status, 409);
  assert.deepEqual(state(), before);
  db.close();
});

test('expected-turn replay returns the latest Worker-owned Mana and never applies again', async () => {
  const { db, act, state } = setup();
  const first = await act('crack', 'permit', 'p1', 0);
  assert.equal(first.status, 200);
  assert.equal(first.data.turnCount, 1);
  const committed = state();
  for (let i = 0; i < 100; i++) {
    const retry = await act('crack', 'permit', 'p1', 0);
    assert.equal(retry.status, 409);
    const battleState = retry.data.battleState as {turnCount:number;playerMana:number};
    assert.equal(battleState.turnCount, 1);
    assert.equal(battleState.playerMana, committed.player_mana);
  }
  assert.deepEqual(state(), committed);
  assert.equal((await act('crack', 'permit', 'p1', 1)).status, 200);
  assert.equal(state().turn_count, 2);
  db.close();
});

test('64 concurrent actions with one expected turn cannot double-spend Mana', async () => {
  const { db, act, state } = setup();
  const replies = await Promise.all(Array.from({length:64}, () => act('crack','permit','p1',0)));
  assert.equal(replies.filter((r) => r.status === 200).length, 1);
  assert.equal(replies.filter((r) => r.status === 409).length, 63);
  assert.equal(state().turn_count, 1);
  assert.equal(state().player_mana, TEST_DEGEN.maxMana - 4);
  db.close();
});

test('stale killing blow and defeat responses recover terminal state', async () => {
  for (const overrides of [{enemyHp:20,playerHp:5,playerMana:4},{playerHp:1}]) {
    const {db,act,state} = setup(overrides);
    const ability = overrides.enemyHp ? 'crack' : 'slash';
    assert.equal((await act(ability,'permit','p1',0)).status,200);
    const terminal = state();
    const retry = await act(ability,'permit','p1',0);
    assert.equal(retry.status,409);
    const battleState = retry.data.battleState as {status:string;turnCount:number;playerMana:number};
    assert.equal(battleState.status, terminal.battle_status);
    assert.equal(battleState.turnCount,1);
    assert.equal(battleState.playerMana,terminal.player_mana);
    assert.deepEqual(state(),terminal);
    db.close();
  }
});

test('invalid expected turn rejects without changing battle state', async () => {
  const {db,act,state} = setup();
  const before = state();
  for(const value of [-1,0.25,null,'0',Number.MAX_SAFE_INTEGER+1]){
    assert.equal((await act('slash','permit','p1',value)).status,400);
  }
  assert.deepEqual(state(),before);
  db.close();
});

test('unaffordable paid action returns authoritative Mana and free action remains usable', async () => {
  const {db,act,state} = setup({playerMana:0});
  const before = state();
  const rejected = await act('crack','permit','p1',0);
  assert.equal(rejected.status,409);
  const battleState = rejected.data.battleState as {playerMana:number;turnCount:number};
  assert.equal(battleState.playerMana,0);
  assert.equal(battleState.turnCount,0);
  assert.deepEqual(state(),before);
  assert.equal((await act('slash','permit','p1',0)).status,200);
  assert.equal(state().player_mana,0);
  db.close();
});

test('invalid and expired permits do not expose authoritative state', async () => {
  const {db,act,state} = setup({expiresAt:new Date(Date.now()-60_000).toISOString()});
  const before = state();
  for(const result of [
    await act('slash','permit','p1',0),
    await act('slash','unknown','p1',0),
    await act('slash','permit','wrong-player',0),
  ]){
    assert.equal(result.status,409);
    assert.equal(result.data.battleState,undefined);
  }
  assert.deepEqual(state(),before);
  db.close();
});

test('CAS conflict re-reads the latest Worker state instead of replaying stale damage', async () => {
  const { db, act, state, injectCasRace } = setup();
  injectCasRace();
  const result = await act('crack', 'permit', 'p1', 0);
  assert.equal(result.status, 409);
  const authoritative = result.data.battleState as {
    permitId: string; status: string; turnCount: number;
    playerHp: number; playerMana: number; enemyHp: number;
  };
  assert.equal(authoritative.permitId, 'permit');
  assert.equal(authoritative.status, 'active');
  assert.equal(authoritative.turnCount, 1);
  assert.equal(authoritative.playerMana, 8);
  assert.equal(authoritative.enemyHp, 57);
  assert.equal(authoritative.playerHp, 110);
  assert.equal(state().turn_count, 1);
  assert.equal(state().player_mana, 8);
  db.close();
});
