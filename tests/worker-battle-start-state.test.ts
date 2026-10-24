import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';
import { canUseAbility, resolveCombatTurn } from '../src/game/combat/rules.ts';
import { UNDERPASS_FULL_REWARD_LIMIT, advanceLevel, underpassRewardForClear } from '../src/game/progression.ts';

// Execute the real Worker start handler with an isolated D1-shaped adapter.
const source = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/^export default\s*\{/m, 'const worker = {');
const handlerSource = stripTypeScriptTypes(source, { mode: 'transform' }) + '\nhandleStartBattle;';
const handleStartBattle = runInNewContext(handlerSource, {
  TEST_DEGEN, TUNNEL_MAW, canUseAbility, resolveCombatTurn,
  UNDERPASS_FULL_REWARD_LIMIT, advanceLevel, underpassRewardForClear,
  crypto: globalThis.crypto, Request, Response, URL, console, Uint32Array,
}) as (request: Request, env: { DB: unknown }) => Promise<Response>;

function makeEnv(cycle: { id: string; event_key: string; opens_at: string; closes_at: string }) {
  const inserts: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      return {
        first: async () => {
          if (sql.includes('FROM world_event_cycles')) return cycle;
          throw new Error('Unexpected unbound Worker query: ' + sql);
        },
        bind(...params: unknown[]) {
          return {
            first: async () => {
              if (sql.includes('FROM world_event_cycles')) return cycle;
              throw new Error('Unexpected bound Worker query: ' + sql);
            },
            run: async () => {
              if (!sql.includes('INSERT INTO battle_permits')) {
                throw new Error('Unexpected Worker write: ' + sql);
              }
              inserts.push(params);
              return { success: true };
            },
          };
        },
      };
    },
  };
  return { env: { DB: db }, inserts };
}

function request(cycleId = 'open-cycle') {
  return new Request('https://degen-api.example/api/battle/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'player-1',
      eventKey: 'underpass',
      cycleId,
      encounterKey: TUNNEL_MAW.id,
    }),
  });
}

test('battle start returns exactly the authoritative HP/Mana/Shield state it persists on the permit', async () => {
  const cycle = {
    id: 'open-cycle',
    event_key: 'underpass',
    opens_at: new Date(Date.now() - 60_000).toISOString(),
    closes_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const { env, inserts } = makeEnv(cycle);
  const response = await handleStartBattle(request(cycle.id), env);
  assert.equal(response.status, 200);
  const result = await response.json() as {
    permitId: string;
    initialState: {
      permitId: string; status: string; playerHp: number; playerMana: number;
      playerShield: number; shieldAbsorbed: number; retaliationDamage: number; enemyHp: number; turnCount: number;
    };
  };

  assert.ok(result.permitId);
  assert.deepEqual(result.initialState, {
    permitId: result.permitId,
    status: 'active',
    playerHp: TEST_DEGEN.maxHp,
    playerMana: TEST_DEGEN.maxMana,
    playerShield: 0,
    shieldAbsorbed: 0,
    retaliationDamage: 0,
    enemyHp: TUNNEL_MAW.maxHp,
    turnCount: 0,
  });
  assert.equal(inserts.length, 1);
  const [, playerId, cycleId, encounterKey, , playerHp, playerMana, enemyHp] = inserts[0] as unknown[];
  assert.deepEqual(
    [playerId, cycleId, encounterKey, playerHp, playerMana, enemyHp],
    ['player-1', cycle.id, TUNNEL_MAW.id, result.initialState.playerHp,
      result.initialState.playerMana, result.initialState.enemyHp],
  );
});

test('monster definitions do not acquire a Mana resource namespace', () => {
  assert.equal(Object.keys(TUNNEL_MAW).some((key) => /mana/i.test(key)), false);
});
