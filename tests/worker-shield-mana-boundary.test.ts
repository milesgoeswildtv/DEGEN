import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';
import { canUseAbility, resolveCombatTurn } from '../src/game/combat/rules.ts';
import {
  UNDERPASS_FULL_REWARD_LIMIT,
  advanceLevel,
  underpassRewardForClear,
  xpNeededForLevel,
} from '../src/game/progression.ts';

const degenWithShieldCosts = {
  ...TEST_DEGEN,
  maxMana: 0,
  abilities: TEST_DEGEN.abilities.map((ability) => ({
    ...ability,
    ...(ability.id === 'slash' ? { shieldGain: 3 } : {}),
    ...(ability.id === 'crack' ? { shieldGain: 9 } : {}),
  })),
};

const source = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/^export default\s*\{/m, 'const worker = {');

const handleBattleAction = runInNewContext(
  stripTypeScriptTypes(source, { mode: 'transform' }) + '\nhandleBattleAction;',
  {
    TEST_DEGEN: degenWithShieldCosts,
    TUNNEL_MAW,
    canUseAbility,
    resolveCombatTurn,
    UNDERPASS_FULL_REWARD_LIMIT,
    advanceLevel,
    underpassRewardForClear,
    xpNeededForLevel,
    validateHousingPlacements: () => [],
    crypto: webcrypto,
    Request,
    Response,
    URL,
    console,
    Uint32Array,
  },
) as (request: Request, env: { DB: unknown }) => Promise<Response>;

test('Worker rejects a paid Shield-gain ability at zero Mana without mutating the permit', async () => {
  const persisted = {
    event_key: 'underpass',
    cycle_event_key: 'underpass',
    cycle_id: 'shield-mana-cycle',
    encounter_key: TUNNEL_MAW.id,
    player_hp: TEST_DEGEN.maxHp,
    player_mana: 0,
    player_shield: 0,
    last_shield_absorbed: 0,
    last_retaliation_damage: 0,
    enemy_hp: TUNNEL_MAW.maxHp,
    enemy_shield: 0,
    battle_status: 'active',
    turn_count: 0,
    victory_history_marker_count: 0,
    defeat_history_marker_count: 0,
    permit_is_unexpired: 1,
  };
  const statements: string[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(..._params: unknown[]) {
          return {
            first: async () => {
              statements.push(sql);
              return { ...persisted };
            },
            run: async () => {
              statements.push(sql);
              throw new Error('An unaffordable action must not issue a D1 mutation.');
            },
          };
        },
      };
    },
  };
  const request = new Request('https://degen-api.example/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'shield-mana-player',
      permitId: 'shield-mana-permit',
      abilityId: 'crack',
      expectedTurnCount: 0,
      shieldGain: Number.MAX_SAFE_INTEGER,
      playerMana: Number.MAX_SAFE_INTEGER,
      playerShield: Number.MAX_SAFE_INTEGER,
      enemyHp: 0,
      victory: true,
      reward: { xp: 999999, currency: 999999 },
    }),
  });

  const response = await handleBattleAction(request, { DB: db });
  const result = await response.json() as {
    error: string;
    battleState?: {
      permitId: string;
      status: string;
      playerHp: number;
      playerMana: number;
      playerShield: number;
      shieldAbsorbed: number;
      retaliationDamage: number;
      enemyHp: number;
      turnCount: number;
    };
  };

  assert.equal(response.status, 409);
  assert.equal(result.error, 'Not enough Mana for that ability.');
  assert.deepEqual(result.battleState, {
    permitId: 'shield-mana-permit',
    status: 'active',
    playerHp: TEST_DEGEN.maxHp,
    playerMana: 0,
    playerShield: 0,
    shieldAbsorbed: 0,
    retaliationDamage: 0,
    enemyHp: TUNNEL_MAW.maxHp,
    turnCount: 0,
  });
  assert.equal(statements.length, 2, 'the Worker reads the permit and its latest conflict snapshot only');
  assert.ok(statements.every((sql) => !/\b(?:UPDATE|INSERT|DELETE)\b/i.test(sql)),
    'no D1 mutation may occur for an unaffordable Shield-gain ability');
});


test('Worker accepts a free Shield-gain ability at zero Mana and persists the authoritative result', async () => {
  const persisted = {
    event_key: 'underpass',
    cycle_event_key: 'underpass',
    cycle_id: 'shield-mana-cycle',
    encounter_key: TUNNEL_MAW.id,
    player_hp: TEST_DEGEN.maxHp,
    player_mana: 0,
    player_shield: 0,
    last_shield_absorbed: 0,
    last_retaliation_damage: 0,
    enemy_hp: TUNNEL_MAW.maxHp,
    enemy_shield: 0,
    battle_status: 'active',
    turn_count: 0,
    victory_history_marker_count: 0,
    defeat_history_marker_count: 0,
    permit_is_unexpired: 1,
  };
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            first: async () => {
              statements.push({ sql, params });
              return /^UPDATE battle_permits/i.test(sql.trim())
                ? { turn_count: 1 }
                : { ...persisted };
            },
          };
        },
      };
    },
  };
  const request = new Request('https://degen-api.example/api/battle/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'shield-mana-player',
      permitId: 'shield-mana-permit',
      abilityId: 'slash',
      expectedTurnCount: 0,
      playerMana: Number.MAX_SAFE_INTEGER,
      playerShield: Number.MAX_SAFE_INTEGER,
      enemyShield: Number.MAX_SAFE_INTEGER,
      enemyHp: 0,
      victory: true,
      reward: { xp: 999999, currency: 999999 },
    }),
  });

  const response = await handleBattleAction(request, { DB: db });
  const result = await response.json() as {
    permitId: string;
    status: string;
    playerHp: number;
    playerMana: number;
    playerShield: number;
    shieldAbsorbed: number;
    retaliationDamage: number;
    enemyHp: number;
    turnCount: number;
    reward?: unknown;
  };

  assert.equal(response.status, 200);
  assert.deepEqual(result, {
    permitId: 'shield-mana-permit',
    status: 'active',
    playerHp: 113,
    playerMana: 0,
    playerShield: 0,
    shieldAbsorbed: 3,
    retaliationDamage: 10,
    enemyHp: 63,
    turnCount: 1,
  });
  assert.equal('reward' in result, false, 'combat actions never accept or return client reward payloads');
  assert.equal(statements.length, 2, 'the Worker reads the permit and applies one authoritative turn');
  assert.deepEqual(statements[1]?.params.slice(0, 8), [113, 0, 0, 3, 10, 63, 0, 'active'],
    'the D1 compare-and-swap persists exact HP, zero Mana, Shield absorption, and turn result');
});
