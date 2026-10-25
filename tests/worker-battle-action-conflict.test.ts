import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';
import { canUseAbility, resolveCombatTurn } from '../src/game/combat/rules.ts';
import { UNDERPASS_FULL_REWARD_LIMIT, advanceLevel, underpassRewardForClear } from '../src/game/progression.ts';

// Execute the real Worker action handler with a deterministic D1 read race:
// the permit SELECT sees the old snapshot, while the conflict re-read sees
// the action another request already committed.
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

test('unaffordable battle conflict returns the latest persisted snapshot after a concurrent turn', async () => {
  const staleSnapshot = {
    cycle_id: 'cycle-1',
    encounter_key: TUNNEL_MAW.id,
    player_hp: 80,
    player_mana: 0,
    enemy_hp: 50,
    battle_status: 'active',
    turn_count: 0,
  };
  const latestSnapshot = {
    ...staleSnapshot,
    player_hp: 70,
    enemy_hp: 63,
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
              assert.deepEqual(params.slice(0, 2), ['permit-1', 'player-1']);
              if (sql.includes('completed_at IS NULL')) return staleSnapshot;
              if (sql.includes('FROM battle_permits WHERE id = ? AND player_id = ?')) return latestSnapshot;
              throw new Error('Unexpected query in deterministic conflict test: ' + sql);
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
      playerId: 'player-1',
      permitId: 'permit-1',
      abilityId: 'crack',
      expectedTurnCount: 0,
    }),
  });

  const response = await handleBattleAction(request, { DB: db });
  const result = await response.json() as {
    error: string;
    battleState?: {
      permitId: string; status: string; playerHp: number; playerMana: number;
      enemyHp: number; turnCount: number;
    };
  };

  assert.equal(response.status, 409);
  assert.equal(result.error, 'Not enough Mana for that ability.');
  assert.deepEqual(result.battleState, {
    permitId: 'permit-1',
    status: 'active',
    playerHp: 70,
    playerMana: 0,
    enemyHp: 63,
    turnCount: 1,
  }, 'a rejected request must not resynchronize the client to a pre-race snapshot');
  assert.equal(reads.length, 2, 'the conflict path must re-read persisted state');
});
