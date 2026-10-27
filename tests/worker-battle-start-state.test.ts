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

function makeEnv(
  cycle: { id: string; event_key: string; opens_at: string; closes_at: string },
  permitInsertAllowed = true,
  existingPermit: Record<string, unknown> | null = null,
  existingPermitAfterConflict: Record<string, unknown> | null = null,
) {
  const inserts: unknown[][] = [];
  let replayLookupCount = 0;
  const persistedExpiry = new Date(Date.now() + 20 * 60_000).toISOString();
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
              if (sql.includes('FROM battle_permits AS permit')) {
                replayLookupCount += 1;
                return replayLookupCount === 1 ? existingPermit : (existingPermitAfterConflict ?? existingPermit);
              }
              if (sql.includes('INSERT INTO battle_permits')) {
                assert.match(sql, /WHERE EXISTS\s*\(\s*SELECT 1 FROM world_event_cycles/);
                assert.match(sql, /strftime\('%Y-%m-%dT%H:%M:%fZ', 'now'\)/);
                assert.match(sql, /strftime\('%Y-%m-%dT%H:%M:%fZ', 'now', '\+20 minutes'\)/);
                assert.match(sql, /julianday\(opens_at\)\s*<=\s*julianday\(strftime\('%Y-%m-%dT%H:%M:%fZ', 'now'\)\)/);
                assert.match(sql, /julianday\(strftime\('%Y-%m-%dT%H:%M:%fZ', 'now'\)\)\s*<\s*julianday\(closes_at\)/);
                assert.match(sql, /julianday\(closes_at\)\s*>\s*julianday\('now'\)/);
                assert.match(sql, /AND NOT EXISTS\s*\(\s*SELECT 1 FROM battle_permits AS existing/);
                assert.match(sql, /AND existing\.event_key = 'underpass'/);
                assert.match(sql, /AND existing\.battle_status = 'active'/);
                assert.match(sql, /julianday\(existing\.expires_at\) > julianday\(strftime\('%Y-%m-%dT%H:%M:%fZ', 'now'\)\)/);
                assert.match(sql, /ON CONFLICT\(id\) DO NOTHING/);
                assert.match(sql, /RETURNING id, expires_at/);
                if (!permitInsertAllowed) return null;
                inserts.push(params);
                return { id: params[0], expires_at: persistedExpiry };
              }
              if (sql.includes('FROM world_event_cycles')) return cycle;
              throw new Error('Unexpected bound Worker query: ' + sql);
            },
          };
        },
      };
    },
  };
  return { env: { DB: db }, inserts, persistedExpiry };
}

function request(cycleId = 'open-cycle', extraFields: Record<string, unknown> = {}) {
  return new Request('https://degen-api.example/api/battle/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'player-1',
      eventKey: 'underpass',
      cycleId,
      encounterKey: TUNNEL_MAW.id,
      ...extraFields,
    }),
  });
}

test('battle start ignores forged client combat state and returns exactly the Degen state persisted on the permit', async () => {
  const cycle = {
    id: 'open-cycle',
    event_key: 'underpass',
    opens_at: new Date(Date.now() - 60_000).toISOString(),
    closes_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const requestId = '00000000-0000-4000-8000-000000000001';
  const { env, inserts, persistedExpiry } = makeEnv(cycle);
  const response = await handleStartBattle(request(cycle.id, {
    requestId,
    playerHp: 1,
    playerMana: 0,
    enemyHp: 1,
    turnCount: 99,
    status: 'victory',
  }), env);
  assert.equal(response.status, 200);
  const result = await response.json() as {
    permitId: string;
    expiresAt: string;
    initialState: {
      permitId: string; status: string; playerHp: number; playerMana: number;
      enemyHp: number; turnCount: number;
    };
  };

  assert.equal(result.permitId, requestId, 'the request key is used only as the permit identity; the Worker still owns all combat state');
  assert.deepEqual(result.initialState, {
    permitId: result.permitId,
    status: 'active',
    playerHp: TEST_DEGEN.maxHp,
    playerMana: TEST_DEGEN.maxMana,
    enemyHp: TUNNEL_MAW.maxHp,
    turnCount: 0,
  });
  assert.equal(inserts.length, 1);
  const [permitId, playerId, cycleId, encounterKey, playerHp, playerMana, enemyHp, cycleGuardId, activePlayerGuardId] = inserts[0] as unknown[];
  assert.equal(permitId, result.permitId);
  assert.equal(cycleGuardId, cycle.id);
  assert.equal(activePlayerGuardId, 'player-1', 'the same-player active-permit guard must bind the current owner');
  assert.equal(inserts[0]?.length, 9, 'start/expiry timestamps come from D1 and the atomic insert binds both cycle and player guards');
  assert.equal(result.expiresAt, persistedExpiry, 'the API must return the expiry returned from the persisted D1 row');
  assert.deepEqual(
    [playerId, cycleId, encounterKey, playerHp, playerMana, enemyHp],
    ['player-1', cycle.id, TUNNEL_MAW.id, result.initialState.playerHp,
      result.initialState.playerMana, result.initialState.enemyHp],
  );
});


test('battle start rejects malformed request IDs before issuing a permit', async () => {
  const cycle = {
    id: 'open-cycle', event_key: 'underpass',
    opens_at: new Date(Date.now() - 60_000).toISOString(),
    closes_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const { env, inserts } = makeEnv(cycle);
  const response = await handleStartBattle(request(cycle.id, { requestId: 'not-a-uuid' }), env);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Invalid battle start request id' });
  assert.equal(inserts.length, 0);
});

test('battle start replays the same active permit after event closure without inserting another', async () => {
  const requestId = '00000000-0000-4000-8000-000000000002';
  const persistedExpiry = new Date(Date.now() + 5 * 60_000).toISOString();
  const closedCycle = {
    id: 'open-cycle', event_key: 'underpass',
    opens_at: new Date(Date.now() - 60 * 60_000).toISOString(),
    closes_at: new Date(Date.now() - 60_000).toISOString(),
  };
  const existingPermit = {
    id: requestId, player_id: 'player-1', event_key: 'underpass', cycle_id: 'open-cycle',
    encounter_key: TUNNEL_MAW.id, expires_at: persistedExpiry, completed_at: null,
    reward_state: 'pending', reward_clear_number: null, reward_xp: null, reward_currency: null,
    reward_tier: null, reward_level: null, reward_remaining_xp: null,
    reward_claim_token: null, reward_claimed_at: null,
    player_hp: 64, player_mana: 4, enemy_hp: 50, battle_status: 'active', turn_count: 2,
    cycle_event_key: 'underpass', permit_started_in_cycle: 1, permit_is_unexpired: 1,
  };
  const { env, inserts } = makeEnv(closedCycle, true, existingPermit);
  const response = await handleStartBattle(request('open-cycle', { requestId }), env);

  assert.equal(response.status, 200, 'a lost start response can be recovered while the issued permit remains valid');
  assert.deepEqual(await response.json(), {
    permitId: requestId,
    eventKey: 'underpass',
    cycleId: 'open-cycle',
    encounterKey: TUNNEL_MAW.id,
    expiresAt: persistedExpiry,
    initialState: {
      permitId: requestId, status: 'active', playerHp: 64, playerMana: 4, enemyHp: 50, turnCount: 2,
    },
  });
  assert.equal(inserts.length, 0, 'recovery must return the persisted snapshot without issuing a second permit');
});

test('battle start rejects foreign, expired, terminal, or corrupt request ID reuse', async () => {
  const requestId = '00000000-0000-4000-8000-000000000003';
  const cycle = {
    id: 'open-cycle', event_key: 'underpass',
    opens_at: new Date(Date.now() - 60_000).toISOString(),
    closes_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const base = {
    id: requestId, event_key: 'underpass', cycle_id: cycle.id, encounter_key: TUNNEL_MAW.id,
    expires_at: new Date(Date.now() + 60_000).toISOString(), completed_at: null,
    reward_state: 'pending', reward_clear_number: null, reward_xp: null, reward_currency: null,
    reward_tier: null, reward_level: null, reward_remaining_xp: null,
    reward_claim_token: null, reward_claimed_at: null,
    player_hp: 80, player_mana: 12, enemy_hp: 92, battle_status: 'active', turn_count: 0,
    cycle_event_key: 'underpass', permit_started_in_cycle: 1, permit_is_unexpired: 1,
  };
  for (const existingPermit of [
    { ...base, player_id: 'different-player' },
    { ...base, player_id: 'player-1', permit_is_unexpired: 0 },
    { ...base, player_id: 'player-1', reward_state: 'claiming', reward_claim_token: 'stale-token', reward_claimed_at: '2026-10-27T00:00:00.000Z' },
    { ...base, player_id: 'player-1', battle_status: 'victory', enemy_hp: 0, turn_count: 1, completed_at: '2026-10-27T00:00:00.000Z' },
    { ...base, player_id: 'player-1', player_mana: TEST_DEGEN.maxMana + 1 },
    { ...base, player_id: 'player-1', player_hp: 0 },
    { ...base, player_id: 'player-1', enemy_hp: 0 },
    { ...base, player_id: 'player-1', turn_count: 0.5 },
  ]) {
    const { env, inserts } = makeEnv(cycle, true, existingPermit);
    const response = await handleStartBattle(request(cycle.id, { requestId }), env);
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'Battle start request is already used or invalid.' });
    assert.equal(inserts.length, 0, 'a reused, foreign, expired, or terminal request id must not create another permit');
  }
});

test('battle start recovers a concurrent request-ID insert without issuing a duplicate permit', async () => {
  const requestId = '00000000-0000-4000-8000-000000000004';
  const cycle = {
    id: 'open-cycle', event_key: 'underpass',
    opens_at: new Date(Date.now() - 60_000).toISOString(),
    closes_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const persistedExpiry = new Date(Date.now() + 5 * 60_000).toISOString();
  const racedPermit = {
    id: requestId, player_id: 'player-1', event_key: 'underpass', cycle_id: cycle.id,
    encounter_key: TUNNEL_MAW.id, expires_at: persistedExpiry, completed_at: null,
    reward_state: 'pending', reward_clear_number: null, reward_xp: null, reward_currency: null,
    reward_tier: null, reward_level: null, reward_remaining_xp: null,
    reward_claim_token: null, reward_claimed_at: null,
    player_hp: 72, player_mana: 0, enemy_hp: 41, battle_status: 'active', turn_count: 1,
    cycle_event_key: 'underpass', permit_started_in_cycle: 1, permit_is_unexpired: 1,
  };
  const { env, inserts } = makeEnv(cycle, false, null, racedPermit);
  const response = await handleStartBattle(request(cycle.id, { requestId }), env);

  assert.equal(response.status, 200);
  const result = await response.json() as { permitId: string; initialState: Record<string, unknown> };
  assert.equal(result.permitId, requestId);
  assert.deepEqual(result.initialState, {
    permitId: requestId, status: 'active', playerHp: 72, playerMana: 0, enemyHp: 41, turnCount: 1,
  });
  assert.equal(inserts.length, 0, 'a concurrent winner owns the one permit row; the retry must only replay it');
});

test('battle start rechecks the Underpass window atomically before issuing a permit', async () => {
  const cycle = {
    id: 'open-cycle',
    event_key: 'underpass',
    opens_at: new Date(Date.now() - 60_000).toISOString(),
    closes_at: new Date(Date.now() + 60_000).toISOString(),
  };
  // The first snapshot is open, but the conditional D1 insert models the cycle
  // closing before the permit-issuing statement executes.
  const { env, inserts } = makeEnv(cycle, false);
  const response = await handleStartBattle(request(cycle.id), env);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'The Underpass is sealed.' });
  assert.equal(inserts.length, 0, 'no permit may be issued after the cycle closes');
});
test('monster definitions do not acquire a Mana resource namespace', () => {
  assert.equal(Object.keys(TUNNEL_MAW).some((key) => /mana/i.test(key)), false);
});
