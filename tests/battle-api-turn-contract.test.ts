import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { withBattleActionRetry } from '../src/app/battleActionRetry.ts';
import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';

// Exercise the real API adapter with a deterministic fetch stub. This verifies
// the client/Worker turn contract without pretending to run a browser or Worker.
const source = readFileSync(new URL('../src/app/api.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/^const API_BASE = .*;$/m, 'const API_BASE = globalThis.__API_BASE;')
  .replace(/^export class /gm, 'class ');
const compiled = stripTypeScriptTypes(source, { mode: 'transform' });

function createApi(fetchImpl: typeof fetch) {
  return runInNewContext(compiled + '\n({ GameApi, BattleTurnConflictError });', {
    __API_BASE: 'https://degen-api.example',
    fetch: fetchImpl,
    Response,
    AbortController,
    setTimeout,
    clearTimeout,
    withBattleActionRetry,
    TEST_DEGEN,
    TUNNEL_MAW,
  }) as {
    GameApi: new () => {
      startUnderpass(playerId: string, cycleId: string): Promise<{
        permitId: string; eventKey: string; cycleId: string; encounterKey: string; expiresAt: string;
        initialState: {
          permitId: string; status: string; playerHp: number; playerMana: number;
          enemyHp: number; turnCount: number;
        };
      }>;
      actUnderpass(playerId: string, permitId: string, abilityId: string, expectedTurnCount: number): Promise<{
        permitId: string; status: string; playerHp: number; playerMana: number;
        enemyHp: number; turnCount: number;
      }>;
    };
    BattleTurnConflictError: new (...args: never[]) => Error & {
      battleState: {
        permitId: string; status: string; playerHp: number; playerMana: number;
        enemyHp: number; turnCount: number;
      };
    };
  };
}

test('server-backed battle start accepts only a complete authoritative HP/Mana snapshot', async () => {
  const permit = {
    permitId: 'permit-start',
    eventKey: 'underpass',
    cycleId: 'cycle-1',
    encounterKey: 'tunnel-maw',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    initialState: {
      permitId: 'permit-start', status: 'active', playerHp: 120,
      playerMana: 12, enemyHp: 92, turnCount: 0,
    },
  };
  let capturedUrl = '';
  let capturedBody: unknown;
  const { GameApi } = createApi(async (input, init) => {
    capturedUrl = String(input);
    capturedBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(permit), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  });

  const result = await new GameApi().startUnderpass('player-1', 'cycle-1');
  assert.equal(capturedUrl, 'https://degen-api.example/api/battle/start');
  assert.deepEqual(capturedBody, {
    playerId: 'player-1', eventKey: 'underpass', cycleId: 'cycle-1', encounterKey: 'tunnel-maw',
  });
  assert.deepEqual(result, permit);
  assert.equal(result.initialState.playerMana, 12);
  assert.equal(result.initialState.turnCount, 0);
});

test('server-backed battle start rejects missing, mismatched, malformed, or expired authoritative state', async () => {
  const valid = {
    permitId: 'permit-start',
    eventKey: 'underpass',
    cycleId: 'cycle-1',
    encounterKey: 'tunnel-maw',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    initialState: {
      permitId: 'permit-start', status: 'active', playerHp: 120,
      playerMana: 12, enemyHp: 92, turnCount: 0,
    },
  };
  const invalidResponses = [
    { ...valid, initialState: undefined },
    { ...valid, initialState: { ...valid.initialState, permitId: 'different-permit' } },
    { ...valid, initialState: { ...valid.initialState, playerMana: undefined } },
    { ...valid, initialState: { ...valid.initialState, playerMana: -1 } },
    { ...valid, initialState: { ...valid.initialState, playerHp: TEST_DEGEN.maxHp + 1 } },
    { ...valid, initialState: { ...valid.initialState, playerMana: TEST_DEGEN.maxMana + 1 } },
    { ...valid, initialState: { ...valid.initialState, enemyHp: TUNNEL_MAW.maxHp + 1 } },
    { ...valid, initialState: { ...valid.initialState, playerHp: 0 } },
    { ...valid, initialState: { ...valid.initialState, enemyHp: 0 } },
    { ...valid, initialState: { ...valid.initialState, status: 'victory' } },
    { ...valid, initialState: { ...valid.initialState, turnCount: 1 } },
    { ...valid, cycleId: 'another-cycle' },
    { ...valid, expiresAt: new Date(Date.now() - 60_000).toISOString() },
    { ...valid, expiresAt: 'not-a-date' },
  ];

  for (const responseBody of invalidResponses) {
    const { GameApi } = createApi(async () => new Response(JSON.stringify(responseBody), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    await assert.rejects(
      new GameApi().startUnderpass('player-1', 'cycle-1'),
      /authoritative battle start state/i,
      JSON.stringify(responseBody),
    );
  }
});

test('battle action sends only the ability and expected turn, never client-owned combat or reward state', async () => {
  let capturedUrl = '';
  let capturedInit: RequestInit | undefined;
  const responseBody = {
    permitId: 'permit-1', status: 'active', playerHp: 103, playerMana: 8,
    enemyHp: 57, turnCount: 1,
  };
  const { GameApi } = createApi(async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return new Response(JSON.stringify(responseBody), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  });

  const api = new GameApi();
  const result = await api.actUnderpass('player-1', 'permit-1', 'crack', 0);

  assert.equal(capturedUrl, 'https://degen-api.example/api/battle/action');
  assert.equal(capturedInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    playerId: 'player-1', permitId: 'permit-1', abilityId: 'crack', expectedTurnCount: 0,
  });
  const requestBody = JSON.parse(String(capturedInit?.body)) as Record<string, unknown>;
  for (const forbidden of ['playerHp', 'playerMana', 'enemyHp', 'turnCount', 'victory', 'reward', 'xp', 'currency']) {
    assert.equal(Object.hasOwn(requestBody, forbidden), false, `client must not submit ${forbidden}`);
  }
  assert.deepEqual(
    [result.permitId, result.status, result.playerHp, result.playerMana, result.enemyHp, result.turnCount],
    ['permit-1', 'active', 103, 8, 57, 1],
  );
});

test('stale-turn 409 is surfaced as the exact Worker-owned state for client synchronization', async () => {
  const state = {
    permitId: 'permit-2', status: 'active', playerHp: 91, playerMana: 4,
    enemyHp: 28, turnCount: 3,
  };
  const { GameApi, BattleTurnConflictError } = createApi(async () => new Response(JSON.stringify({
    error: 'Stale battle turn.', battleState: state,
  }), { status: 409, headers: { 'content-type': 'application/json' } }));

  let caught: (Error & { battleState?: typeof state }) | undefined;
  try {
    await new GameApi().actUnderpass('player-1', 'permit-2', 'slash', 2);
  } catch (error) {
    caught = error as Error & { battleState?: typeof state };
  }

  assert.ok(caught);
  assert.equal(caught.name, 'BattleTurnConflictError');
  assert.ok(caught instanceof BattleTurnConflictError);
  assert.deepEqual(
    [caught.battleState?.permitId, caught.battleState?.status, caught.battleState?.playerHp,
      caught.battleState?.playerMana, caught.battleState?.enemyHp, caught.battleState?.turnCount],
    ['permit-2', 'active', 91, 4, 28, 3],
  );
});

test('insufficient-Mana conflict returns the unchanged Worker state for safe client synchronization', async () => {
  const state = {
    permitId: 'permit-mana', status: 'active', playerHp: 110, playerMana: 0,
    enemyHp: 57, turnCount: 2,
  };
  const { GameApi, BattleTurnConflictError } = createApi(async (input, init) => {
    assert.equal(String(input), 'https://degen-api.example/api/battle/action');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      playerId: 'player-1', permitId: 'permit-mana', abilityId: 'crack', expectedTurnCount: 2,
    });
    return new Response(JSON.stringify({
      error: 'Not enough Mana for that ability.', battleState: state,
    }), { status: 409, headers: { 'content-type': 'application/json' } });
  });

  let caught: (Error & { battleState?: typeof state }) | undefined;
  try {
    await new GameApi().actUnderpass('player-1', 'permit-mana', 'crack', 2);
  } catch (error) {
    caught = error as Error & { battleState?: typeof state };
  }

  assert.ok(caught);
  assert.ok(caught instanceof BattleTurnConflictError);
  assert.deepEqual(
    [caught.battleState?.permitId, caught.battleState?.status, caught.battleState?.playerHp,
      caught.battleState?.playerMana, caught.battleState?.enemyHp, caught.battleState?.turnCount],
    ['permit-mana', 'active', 110, 0, 57, 2],
  );
});

test('malformed conflict payload is rejected instead of being treated as authoritative state', async () => {
  const invalidStates = [
    { permitId: 'permit-3', status: 'active', turnCount: -1 },
    { permitId: 'permit-3', status: 'active', playerHp: 120, playerMana: TEST_DEGEN.maxMana + 1, enemyHp: 57, turnCount: 1 },
    { permitId: 'permit-3', status: 'active', playerHp: 120, playerMana: 8, enemyHp: TUNNEL_MAW.maxHp + 1, turnCount: 1 },
  ];

  for (const battleState of invalidStates) {
    const { GameApi } = createApi(async () => new Response(JSON.stringify({
      error: 'Conflict', battleState,
    }), { status: 409, headers: { 'content-type': 'application/json' } }));

    await assert.rejects(
      new GameApi().actUnderpass('player-1', 'permit-3', 'slash', 0),
      /DEGEN API 409|Malformed authoritative battle conflict response/,
      JSON.stringify(battleState),
    );
  }
});


test('successful battle actions reject malformed or out-of-turn Worker state before presentation', async () => {
  const valid = {
    permitId: 'permit-action', status: 'active', playerHp: 103, playerMana: 8,
    enemyHp: 57, turnCount: 1,
  };
  const invalidResponses = [
    { ...valid, permitId: 'another-permit' },
    { ...valid, status: 'unknown' },
    { ...valid, turnCount: 2 },
    { ...valid, playerHp: -1 },
    { ...valid, playerMana: -1 },
    { ...valid, enemyHp: -1 },
    { ...valid, playerHp: TEST_DEGEN.maxHp + 1 },
    { ...valid, playerMana: TEST_DEGEN.maxMana + 1 },
    { ...valid, enemyHp: TUNNEL_MAW.maxHp + 1 },
    { ...valid, status: 'active', playerHp: 0 },
    { ...valid, status: 'active', enemyHp: 0 },
    { ...valid, status: 'victory' },
    { ...valid, status: 'defeat' },
    { ...valid, status: 'victory', playerHp: 0, enemyHp: 0 },
  ];

  for (const responseBody of invalidResponses) {
    const { GameApi } = createApi(async () => new Response(JSON.stringify(responseBody), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    await assert.rejects(
      new GameApi().actUnderpass('player-1', 'permit-action', 'slash', 0),
      /Malformed authoritative battle action response/,
      JSON.stringify(responseBody),
    );
  }
});

test('successful terminal action responses require Worker-consistent victory or defeat HP', async () => {
  const terminalStates = [
    { permitId: 'permit-action', status: 'victory', playerHp: 1, playerMana: 0, enemyHp: 0, turnCount: 1 },
    { permitId: 'permit-action', status: 'defeat', playerHp: 0, playerMana: 0, enemyHp: 1, turnCount: 1 },
  ];
  for (const responseBody of terminalStates) {
    const { GameApi } = createApi(async () => new Response(JSON.stringify(responseBody), {
      status: 200, headers: { 'content-type': 'application/json' },
    }));
    await assert.doesNotReject(
      () => new GameApi().actUnderpass('player-1', 'permit-action', 'slash', 0),
      JSON.stringify(responseBody),
    );
  }
});
