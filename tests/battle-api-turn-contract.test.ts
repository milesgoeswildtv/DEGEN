import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

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
  }) as {
    GameApi: new () => {
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

test('malformed conflict payload is rejected instead of being treated as authoritative state', async () => {
  const { GameApi } = createApi(async () => new Response(JSON.stringify({
    error: 'Conflict', battleState: { permitId: 'permit-3', status: 'active', turnCount: -1 },
  }), { status: 409, headers: { 'content-type': 'application/json' } }));

  await assert.rejects(
    new GameApi().actUnderpass('player-1', 'permit-3', 'slash', 0),
    /DEGEN API 409/,
  );
});
