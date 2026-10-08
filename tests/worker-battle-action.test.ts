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
  const adapter = {
    prepare(sql: string) {
      return { bind(...params: unknown[]) {
        const statement = db.prepare(sql);
        return { first: () => statement.get(...params), run: () => statement.run(...params) };
      } };
    },
  };
  const act = async (abilityId = 'slash', permitId = 'permit', playerId = 'p1') => {
    const request = new Request('https://degen-api.example/api/battle/action', {
      method: 'POST', body: JSON.stringify({ playerId, permitId, abilityId }),
    });
    const response = await handleBattleAction(request, { DB: adapter });
    return { status: response.status, data: await response.json() as Record<string, unknown> };
  };
  const state = () => db.prepare('SELECT player_hp, player_mana, enemy_hp, battle_status, turn_count FROM battle_permits WHERE id = ?').get('permit') as Record<string, unknown>;
  return { db, act, state };
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
