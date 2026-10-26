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
    event_key: 'underpass', cycle_event_key: 'underpass', cycle_id: 'cycle-1',
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
              if (sql.includes('WHERE permit.id = ? AND permit.player_id = ?')) return latestSnapshot;
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

test('replayed action after reward settlement returns the persisted victory snapshot', async () => {
  const completedSnapshot = {
    event_key: 'underpass', cycle_event_key: 'underpass', cycle_id: 'cycle-1',
    encounter_key: TUNNEL_MAW.id,
    player_hp: 70,
    player_mana: 0,
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
              assert.deepEqual(params.slice(0, 2), ['permit-1', 'player-1']);
              if (sql.includes('completed_at IS NULL')) return null;
              if (sql.includes('completed_at IS NOT NULL')) return completedSnapshot;
              throw new Error('Unexpected query in completed-action recovery test: ' + sql);
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
      abilityId: 'slash',
      expectedTurnCount: 3,
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
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(result.error, 'Battle permit is already completed.');
  assert.deepEqual(result.battleState, {
    permitId: 'permit-1',
    status: 'victory',
    playerHp: 70,
    playerMana: 0,
    enemyHp: 0,
    turnCount: 3,
  });
  assert.equal(reads.length, 2, 'the handler must recover from persisted completed state, not client state');
});

test('completed permits for unsupported encounters, events, or cycles are not returned as battle snapshots', async () => {
  const unsupportedSnapshots = [
    {
      event_key: 'underpass', cycle_event_key: 'underpass', cycle_id: 'cycle-1',
      encounter_key: 'different-monster', player_hp: 70, player_mana: 0, enemy_hp: 0,
      battle_status: 'victory', turn_count: 3,
    },
    {
      event_key: 'unapproved-event', cycle_event_key: 'underpass', cycle_id: 'cycle-1',
      encounter_key: TUNNEL_MAW.id, player_hp: 70, player_mana: 0, enemy_hp: 0,
      battle_status: 'victory', turn_count: 3,
    },
    {
      event_key: 'underpass', cycle_event_key: 'unapproved-event', cycle_id: 'cycle-foreign',
      encounter_key: TUNNEL_MAW.id, player_hp: 70, player_mana: 0, enemy_hp: 0,
      battle_status: 'victory', turn_count: 3,
    },
  ];
  for (const unsupportedSnapshot of unsupportedSnapshots) {
    const db = {
      prepare(sql: string) {
        return {
          bind(..._params: unknown[]) {
            return {
              first: async () => sql.includes('completed_at IS NOT NULL') ? unsupportedSnapshot : null,
            };
          },
        };
      },
    };
    const request = new Request('https://degen-api.example/api/battle/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId: 'player-1', permitId: 'permit-1', abilityId: 'slash', expectedTurnCount: 3,
      }),
    });

    const response = await handleBattleAction(request, { DB: db });
    const result = await response.json() as { error: string; battleState?: unknown };
    assert.equal(response.status, 409);
    assert.equal(result.error, 'Battle permit is invalid, expired, or already completed.');
    assert.equal('battleState' in result, false,
      'an unsupported encounter, event, or cycle must not be projected as a battle snapshot');
  }
});


test('expired terminal retries recover only valid pending victory or defeat snapshots', async () => {
  const cases = [
    {
      state: {
        event_key: 'underpass', cycle_event_key: 'underpass', cycle_id: 'cycle-1', encounter_key: TUNNEL_MAW.id,
        player_hp: 70, player_mana: 0, enemy_hp: 0,
        battle_status: 'victory', turn_count: 3,
        completed_at: null, reward_state: 'pending',
      },
      expectedError: 'Battle victory is awaiting reward completion.',
      expectedState: {
        permitId: 'permit-1', status: 'victory',
        playerHp: 70, playerMana: 0, enemyHp: 0, turnCount: 3,
      },
    },
    {
      state: {
        event_key: 'underpass', cycle_event_key: 'underpass', cycle_id: 'cycle-1', encounter_key: TUNNEL_MAW.id,
        player_hp: 0, player_mana: 0, enemy_hp: 63,
        battle_status: 'defeat', turn_count: 1,
        completed_at: null, reward_state: 'pending',
      },
      expectedError: 'Battle is already defeated.',
      expectedState: {
        permitId: 'permit-1', status: 'defeat',
        playerHp: 0, playerMana: 0, enemyHp: 63, turnCount: 1,
      },
    },
  ];

  for (const scenario of cases) {
    const reads: string[] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              first: async () => {
                reads.push(sql);
                assert.deepEqual(params.slice(0, 2), ['permit-1', 'player-1']);
                if (sql.includes("julianday(expires_at) > julianday('now')")) return null;
                if (sql.includes('completed_at IS NOT NULL')) return null;
                if (sql.includes("battle_status IN ('victory', 'defeat')")) return scenario.state;
                throw new Error('Unexpected query in expired terminal recovery test: ' + sql);
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
        playerId: 'player-1', permitId: 'permit-1', abilityId: 'slash', expectedTurnCount: 1,
      }),
    });

    const response = await handleBattleAction(request, { DB: db });
    const result = await response.json() as { error: string; battleState?: unknown };
    assert.equal(response.status, 409);
    assert.equal(result.error, scenario.expectedError);
    assert.deepEqual(result.battleState, scenario.expectedState);
    assert.equal(reads.length, 3, 'expired terminal recovery must read persisted state without mutating it');
  }
});


test('expired pre-Mana terminal outcomes recover display snapshots without reopening combat', async () => {
  const scenarios = [
    {
      status: 'victory' as const,
      playerHp: 70,
      enemyHp: 0,
      expectedError: 'Battle victory is awaiting reward completion.',
    },
    {
      status: 'defeat' as const,
      playerHp: 0,
      enemyHp: 40,
      expectedError: 'Battle is already defeated.',
    },
  ];

  for (const scenario of scenarios) {
    const legacyTerminal = {
      event_key: 'underpass', cycle_event_key: 'underpass', cycle_id: 'cycle-1',
      encounter_key: TUNNEL_MAW.id,
      player_hp: scenario.playerHp,
      player_mana: null,
      enemy_hp: scenario.enemyHp,
      battle_status: scenario.status,
      turn_count: 3,
      completed_at: null,
      reward_state: 'pending' as const,
    };
    const reads: string[] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(..._params: unknown[]) {
            return {
              first: async () => {
                reads.push(sql);
                if (sql.includes("julianday(expires_at)")) return null;
                if (sql.includes("reward_state = 'awarded'")) return null;
                if (sql.includes("battle_status IN ('victory', 'defeat')")) return legacyTerminal;
                throw new Error('Unexpected query in expired legacy terminal Mana recovery test: ' + sql);
              },
            };
          },
        };
      },
    };
    const permitId = `permit-legacy-${scenario.status}`;
    const request = new Request('https://degen-api.example/api/battle/action', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId: 'player-1',
        permitId,
        abilityId: 'slash',
        expectedTurnCount: 3,
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
    assert.equal(result.error, scenario.expectedError);
    assert.deepEqual(result.battleState, {
      permitId,
      status: scenario.status,
      playerHp: scenario.playerHp,
      playerMana: TEST_DEGEN.maxMana,
      enemyHp: scenario.enemyHp,
      turnCount: 3,
    }, 'legacy Mana is projected only to render a terminal snapshot; no action is accepted');
    assert.equal(reads.length, 3, 'expired terminal recovery must query active, awarded, then terminal state without mutation');
  }
});


test('malformed pre-Mana terminal snapshots fail closed without display fallback', async () => {
  const scenarios = [
    { status: 'victory', playerHp: 0, enemyHp: 0, turnCount: 3 },
    { status: 'victory', playerHp: 70, enemyHp: 10, turnCount: 3 },
    { status: 'victory', playerHp: 70, enemyHp: 0, turnCount: 0 },
    { status: 'defeat', playerHp: 1, enemyHp: 40, turnCount: 3 },
    { status: 'defeat', playerHp: 0, enemyHp: 0, turnCount: 3 },
  ] as const;

  for (const scenario of scenarios) {
    const malformedTerminal = {
      event_key: 'underpass', cycle_event_key: 'underpass', cycle_id: 'cycle-legacy',
      encounter_key: TUNNEL_MAW.id,
      player_hp: scenario.playerHp,
      player_mana: null,
      enemy_hp: scenario.enemyHp,
      battle_status: scenario.status,
      turn_count: scenario.turnCount,
      completed_at: null,
      reward_state: 'pending' as const,
    };
    const reads: string[] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(..._params: unknown[]) {
            return {
              first: async () => {
                reads.push(sql);
                if (sql.includes("julianday(expires_at)")) return null;
                if (sql.includes("reward_state = 'awarded'")) return null;
                if (sql.includes("battle_status IN ('victory', 'defeat')")) return malformedTerminal;
                throw new Error('Unexpected query in malformed legacy terminal recovery test: ' + sql);
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
        permitId: 'permit-malformed-legacy',
        abilityId: 'slash',
        expectedTurnCount: scenario.turnCount,
      }),
    });

    const response = await handleBattleAction(request, { DB: db });
    const result = await response.json() as { error: string; battleState?: unknown };
    assert.equal(response.status, 409, JSON.stringify(scenario));
    assert.equal(result.error, 'Battle permit is invalid, expired, or already completed.');
    assert.equal('battleState' in result, false, 'malformed terminal rows must not receive a fabricated display Mana value');
    assert.equal(reads.length, 3, 'invalid terminal recovery is read-only');
  }
});

test('replayed action after reward settlement projects display Mana for a legacy victory', async () => {
  const completedSnapshot = {
    event_key: 'underpass', cycle_event_key: 'underpass', cycle_id: 'cycle-legacy',
    encounter_key: TUNNEL_MAW.id,
    player_hp: 70,
    player_mana: null,
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
              assert.deepEqual(params.slice(0, 2), ['permit-legacy-victory', 'player-1']);
              if (sql.includes('completed_at IS NULL')) return null;
              if (sql.includes('completed_at IS NOT NULL')) return completedSnapshot;
              throw new Error('Unexpected query in legacy completed-victory replay test: ' + sql);
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
      permitId: 'permit-legacy-victory',
      abilityId: 'slash',
      expectedTurnCount: 3,
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
  assert.equal(result.error, 'Battle permit is already completed.');
  assert.deepEqual(result.battleState, {
    permitId: 'permit-legacy-victory',
    status: 'victory',
    playerHp: 70,
    playerMana: TEST_DEGEN.maxMana,
    enemyHp: 0,
    turnCount: 3,
  }, 'a completed pre-Mana victory needs a valid terminal display snapshot but remains non-actionable');
  assert.equal(reads.length, 2, 'completed legacy replay must use reads only and must not reopen the permit');
});

