import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';
import { canUseAbility, resolveCombatTurn } from '../src/game/combat/rules.ts';
import { UNDERPASS_FULL_REWARD_LIMIT, advanceLevel, underpassRewardForClear } from '../src/game/progression.ts';

const source = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/^export default\s*\{/m, 'const worker = {');
const handleBattleAction = runInNewContext(
  stripTypeScriptTypes(source, { mode: 'transform' }) + '\nhandleBattleAction;',
  {
    TEST_DEGEN, TUNNEL_MAW, canUseAbility, resolveCombatTurn,
    UNDERPASS_FULL_REWARD_LIMIT, advanceLevel, underpassRewardForClear,
    crypto: webcrypto, Request, Response, URL, console, Uint32Array,
  },
) as (request: Request, env: { DB: unknown }) => Promise<Response>;

const actionRequest = (permitId: string, expectedTurnCount = 0): Request => new Request(
  'https://degen-api.example/api/battle/action',
  {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'shield-player', permitId, abilityId: 'slash', expectedTurnCount,
    }),
  },
);

const battleState = (row: {
  permitId: string; battle_status: string; player_hp: number; player_mana: number;
  player_shield: number; last_shield_absorbed: number; last_retaliation_damage: number; enemy_hp: number; turn_count: number;
}) => ({
  permitId: row.permitId,
  status: row.battle_status,
  playerHp: row.player_hp,
  playerMana: row.player_mana,
  playerShield: row.player_shield,
  shieldAbsorbed: row.last_shield_absorbed,
  retaliationDamage: row.last_retaliation_damage,
  enemyHp: row.enemy_hp,
  turnCount: row.turn_count,
});

test('replayed action after reward settlement returns the persisted Shield victory snapshot', async () => {
  const completed = {
    cycle_id: 'cycle-1',
    encounter_key: TUNNEL_MAW.id,
    player_hp: 120,
    player_mana: 8,
    player_shield: 5,
    last_shield_absorbed: 0,
    last_retaliation_damage: 0,
    enemy_hp: 0,
    battle_status: 'victory',
    turn_count: 3,
  };
  const reads: string[] = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            first: async () => {
              reads.push(sql);
              assert.deepEqual(params.slice(0, 2), ['shield-permit', 'shield-player']);
              if (sql.includes('completed_at IS NULL')) return null;
              if (sql.includes('completed_at IS NOT NULL')) return completed;
              throw new Error('Unexpected query in Shield completed-action recovery: ' + sql);
            },
          };
        },
      };
    },
  };

  const response = await handleBattleAction(actionRequest('shield-permit', 3), { DB: db });
  const result = await response.json() as { error: string; battleState?: unknown };

  assert.equal(response.status, 409);
  assert.equal(result.error, 'Battle permit is already completed.');
  assert.deepEqual(result.battleState, battleState({ permitId: 'shield-permit', ...completed }));
  assert.equal(reads.length, 2, 'completed victory replay reads state but never advances a turn');
});

test('expired pending Shield victory and defeat recover snapshots without applying an action', async () => {
  const terminalStates = [
    {
      permitId: 'shield-pending-victory',
      row: {
        cycle_id: 'cycle-1', encounter_key: TUNNEL_MAW.id,
        player_hp: 120, player_mana: 8, player_shield: 5,
        last_shield_absorbed: 0, last_retaliation_damage: 0,
        enemy_hp: 0, battle_status: 'victory', turn_count: 1,
        completed_at: null, reward_state: 'pending',
      },
      error: 'Battle victory is awaiting reward completion.',
    },
    {
      permitId: 'shield-pending-defeat',
      row: {
        cycle_id: 'cycle-1', encounter_key: TUNNEL_MAW.id,
        player_hp: 0, player_mana: 0, player_shield: 0,
        last_shield_absorbed: 2, last_retaliation_damage: 10,
        enemy_hp: TUNNEL_MAW.maxHp - 29, battle_status: 'defeat', turn_count: 1,
        completed_at: null, reward_state: 'pending',
      },
      error: 'Battle is already defeated.',
    },
  ];

  for (const { permitId, row, error } of terminalStates) {
    const reads: string[] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              first: async () => {
                reads.push(sql);
                assert.deepEqual(params.slice(0, 2), [permitId, 'shield-player']);
                if (sql.includes("battle_status IN ('victory', 'defeat')")) return row;
                if (sql.includes('completed_at IS NOT NULL')) return null;
                if (sql.includes('completed_at IS NULL')) return null;
                throw new Error('Unexpected query in Shield terminal recovery: ' + sql);
              },
            };
          },
        };
      },
    };

    const response = await handleBattleAction(actionRequest(permitId), { DB: db });
    const result = await response.json() as { error: string; battleState?: unknown };

    assert.equal(response.status, 409);
    assert.equal(result.error, error);
    assert.deepEqual(result.battleState, battleState({ permitId, ...row }));
    assert.equal(reads.length, 3, 'expired terminal recovery only reads persisted state');
  }
});

test('expired terminal recovery rejects corrupt persisted Shield instead of echoing it', async () => {
  const corrupt = {
    cycle_id: 'cycle-1',
    encounter_key: TUNNEL_MAW.id,
    player_hp: 120,
    player_mana: 8,
    player_shield: 1.5,
    last_shield_absorbed: 0,
    last_retaliation_damage: 0,
    enemy_hp: 0,
    battle_status: 'victory',
    turn_count: 1,
    completed_at: null,
    reward_state: 'pending',
  };
  const db = {
    prepare(sql: string) {
      return {
        bind() {
          return {
            first: async () => {
              if (sql.includes("battle_status IN ('victory', 'defeat')")) return corrupt;
              if (sql.includes('completed_at IS NOT NULL')) return null;
              if (sql.includes('completed_at IS NULL')) return null;
              throw new Error('Unexpected query in corrupt Shield recovery: ' + sql);
            },
          };
        },
      };
    },
  };

  const response = await handleBattleAction(actionRequest('corrupt-shield'), { DB: db });
  const result = await response.json() as { error: string; battleState?: unknown };
  assert.equal(response.status, 409);
  assert.equal(result.error, 'Battle permit is invalid, expired, or already completed.');
  assert.equal('battleState' in result, false, 'invalid persisted Shield must not be echoed as authoritative');
});

test('completed permits for unsupported encounters are not returned as this battle snapshot', async () => {
  const unsupported = {
    cycle_id: 'cycle-1',
    encounter_key: 'unapproved-encounter',
    player_hp: 120,
    player_mana: 8,
    player_shield: 5,
    last_shield_absorbed: 0,
    last_retaliation_damage: 0,
    enemy_hp: 0,
    battle_status: 'victory',
    turn_count: 3,
  };
  let reads = 0;
  const db = {
    prepare(sql: string) {
      return {
        bind() {
          return {
            first: async () => {
              reads += 1;
              if (sql.includes('completed_at IS NULL')) return null;
              if (sql.includes('completed_at IS NOT NULL')) return unsupported;
              throw new Error('Unexpected query in unsupported Shield recovery: ' + sql);
            },
          };
        },
      };
    },
  };

  const response = await handleBattleAction(actionRequest('unsupported-shield-permit', 3), { DB: db });
  const result = await response.json() as { error: string; battleState?: unknown };
  assert.equal(response.status, 409);
  assert.equal(result.error, 'Battle permit is invalid, expired, or already completed.');
  assert.equal('battleState' in result, false, 'unsupported encounter data must not be projected as Tunnel Maw');
  assert.equal(reads, 3, 'unsupported completed state fails closed after owner-scoped recovery reads');
});

test('expired terminal recovery rejects inconsistent persisted Shield event audit', async () => {
  const corrupt = {
    cycle_id: 'cycle-1',
    encounter_key: TUNNEL_MAW.id,
    player_hp: 0,
    player_mana: 0,
    player_shield: 0,
    last_shield_absorbed: 11,
    last_retaliation_damage: 10,
    enemy_hp: TUNNEL_MAW.maxHp - 29,
    battle_status: 'defeat',
    turn_count: 1,
    completed_at: null,
    reward_state: 'pending',
  };
  const db = {
    prepare(sql: string) {
      return {
        bind() {
          return {
            first: async () => {
              if (sql.includes("battle_status IN ('victory', 'defeat')")) return corrupt;
              if (sql.includes('completed_at IS NOT NULL')) return null;
              if (sql.includes('completed_at IS NULL')) return null;
              throw new Error('Unexpected query in invalid Shield event recovery: ' + sql);
            },
          };
        },
      };
    },
  };

  const response = await handleBattleAction(actionRequest('corrupt-shield-event'), { DB: db });
  const result = await response.json() as { error: string; battleState?: unknown };
  assert.equal(response.status, 409);
  assert.equal(result.error, 'Battle permit is invalid, expired, or already completed.');
  assert.equal('battleState' in result, false, 'inconsistent Shield absorption must never be projected as authoritative');
});

test('expired terminal recovery rejects retaliation audit above the supported monster damage', async () => {
  const corrupt = {
    cycle_id: 'cycle-1',
    encounter_key: TUNNEL_MAW.id,
    player_hp: 0,
    player_mana: 0,
    player_shield: 0,
    last_shield_absorbed: 0,
    last_retaliation_damage: TUNNEL_MAW.damage + 1,
    enemy_hp: TUNNEL_MAW.maxHp - 29,
    battle_status: 'defeat',
    turn_count: 1,
    completed_at: null,
    reward_state: 'pending',
  };
  const db = {
    prepare(sql: string) {
      return {
        bind() {
          return {
            first: async () => {
              if (sql.includes("battle_status IN ('victory', 'defeat')")) return corrupt;
              if (sql.includes('completed_at IS NOT NULL')) return null;
              if (sql.includes('completed_at IS NULL')) return null;
              throw new Error('Unexpected query in invalid retaliation audit recovery: ' + sql);
            },
          };
        },
      };
    },
  };

  const response = await handleBattleAction(actionRequest('corrupt-retaliation'), { DB: db });
  const result = await response.json() as { error: string; battleState?: unknown };
  assert.equal(response.status, 409);
  assert.equal(result.error, 'Battle permit is invalid, expired, or already completed.');
  assert.equal('battleState' in result, false,
    'a persisted retaliation value impossible for the supported enemy must not be echoed as authoritative');
});
