import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';
import { canUseAbility, resolveCombatTurn } from '../src/game/combat/rules.ts';
import { UNDERPASS_FULL_REWARD_LIMIT, advanceLevel, underpassRewardForClear } from '../src/game/progression.ts';

// Execute the real Shield-enabled Worker handler with a deterministic D1 read race:
// the first read sees turn 0, while the conflict re-read sees the concurrent turn 1.
const source = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\\r?\\n/gm, '')
  .replace(/^export default\\s*\\{/m, 'const worker = {');
const handleBattleAction = runInNewContext(
  stripTypeScriptTypes(source, { mode: 'transform' }) + '\\nhandleBattleAction;',
  {
    TEST_DEGEN, TUNNEL_MAW, canUseAbility, resolveCombatTurn,
    UNDERPASS_FULL_REWARD_LIMIT, advanceLevel, underpassRewardForClear,
    crypto: webcrypto, Request, Response, URL, console, Uint32Array,
  },
) as (request: Request, env: { DB: unknown }) => Promise<Response>;

test('stale-turn conflict returns the latest persisted Shield state after a concurrent action', async () => {
  const staleSnapshot = {
    cycle_id: 'cycle-1',
    encounter_key: TUNNEL_MAW.id,
    player_hp: 120,
    player_mana: 0,
    player_shield: 12,
    last_shield_absorbed: 0,
    last_retaliation_damage: 0,
    enemy_hp: TUNNEL_MAW.maxHp,
    battle_status: 'active',
    turn_count: 0,
  };
  const latestSnapshot = {
    ...staleSnapshot,
    player_shield: 2,
    last_shield_absorbed: 10,
    last_retaliation_damage: 10,
    enemy_hp: TUNNEL_MAW.maxHp - 29,
    turn_count: 1,
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
              if (sql.includes('completed_at IS NULL')) return staleSnapshot;
              if (sql.includes('FROM battle_permits WHERE id = ? AND player_id = ?')) return latestSnapshot;
              throw new Error('Unexpected query in Shield conflict test: ' + sql);
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
      playerId: 'shield-player',
      permitId: 'shield-permit',
      abilityId: 'slash',
      expectedTurnCount: 1,
    }),
  });

  const response = await handleBattleAction(request, { DB: db });
  const result = await response.json() as {
    error: string;
    battleState?: {
      permitId: string; status: string; playerHp: number; playerMana: number;
      playerShield: number; shieldAbsorbed: number; retaliationDamage: number;
      enemyHp: number; turnCount: number;
    };
  };

  assert.equal(response.status, 409);
  assert.equal(result.error, 'Stale battle turn.');
  assert.deepEqual(result.battleState, {
    permitId: 'shield-permit',
    status: 'active',
    playerHp: 120,
    playerMana: 0,
    playerShield: 2,
    shieldAbsorbed: 0,
    retaliationDamage: 0,
    enemyHp: TUNNEL_MAW.maxHp - 29,
    turnCount: 1,
  }, 'the rejected action must not roll the client back to the pre-race Shield value');
  assert.equal(reads.length, 2, 'the conflict path must re-read the persisted permit');
});
