import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';

const source = readFileSync(new URL('../src/app/api.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace('import.meta.env.VITE_API_BASE', 'globalThis.__API_BASE')
  .replace(/\bexport class /g, 'class ')
  .replace(/\bexport const /g, 'const ');
const { GameApi, GameApiError } = runInNewContext(stripTypeScriptTypes(source, { mode: 'transform' }) + '\n({ GameApi, GameApiError });', {
  __API_BASE: 'https://degen-api.example', TEST_DEGEN, TUNNEL_MAW,
  fetch: (...args: any[]) => globalThis.fetch(...args), Response, URL, AbortController, setTimeout, clearTimeout,
  Date, Number, JSON, Error, encodeURIComponent, console,
}) as {
  GameApi: new () => {
    startUnderpass(playerId: string, cycleId: string): Promise<unknown>;
    actUnderpass(playerId: string, permitId: string, abilityId: string, expectedTurnCount: number): Promise<unknown>;
  };
  GameApiError: new (status: number, payload: unknown, message: string) => Error & { status: number; payload: unknown };
};

const validPermit = () => {
  const permitId = 'permit-1';
  return {
    permitId, eventKey: 'underpass', cycleId: 'cycle-1', encounterKey: TUNNEL_MAW.id,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    initialState: {
      permitId, status: 'active', playerHp: TEST_DEGEN.maxHp,
      playerMana: 0, enemyHp: TUNNEL_MAW.maxHp, turnCount: 0,
    },
  };
};

async function apiReturning(value: unknown) {
  const api = new GameApi();
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(value), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  try { return await api.startUnderpass('player-1', 'cycle-1'); }
  finally { globalThis.fetch = oldFetch; }
}

test('server-backed battle start accepts a valid authoritative zero-Mana snapshot', async () => {
  const permit = validPermit();
  const result = await apiReturning(permit) as typeof permit;
  assert.deepEqual(result.initialState, permit.initialState);
});

test('server-backed battle start rejects an expired permit before entering combat', async () => {
  const permit = validPermit();
  permit.expiresAt = new Date(Date.now() - 60_000).toISOString();
  await assert.rejects(apiReturning(permit), /Missing or malformed authoritative battle start state/);
});

test('server-backed battle start rejects a snapshot for another permit or an out-of-range Mana value', async () => {
  const wrongPermit = validPermit();
  wrongPermit.initialState.permitId = 'other-permit';
  await assert.rejects(apiReturning(wrongPermit), /Missing or malformed authoritative battle start state/);

  const excessiveMana = validPermit();
  excessiveMana.initialState.playerMana = TEST_DEGEN.maxMana + 1;
  await assert.rejects(apiReturning(excessiveMana), /Missing or malformed authoritative battle start state/);
});

test('server-backed battle start rejects a non-initial turn count', async () => {
  const permit = validPermit();
  permit.initialState.turnCount = 1;
  await assert.rejects(apiReturning(permit), /Missing or malformed authoritative battle start state/);
});


test('battle action sends the displayed authoritative turn as a replay precondition', async () => {
  const oldFetch = globalThis.fetch;
  let sent: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      permitId: 'permit-1', status: 'active', playerHp: 70, playerMana: 0, enemyHp: 20, turnCount: 4,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await new GameApi().actUnderpass('player-1', 'permit-1', 'crack', 3);
    assert.deepEqual(sent, {
      playerId: 'player-1', permitId: 'permit-1', abilityId: 'crack', expectedTurnCount: 3,
    });
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('battle action conflicts preserve the Worker authoritative state for safe client recovery', async () => {
  const oldFetch = globalThis.fetch;
  const battleState = {
    permitId: 'permit-1', status: 'active', playerHp: 54, playerMana: 0, enemyHp: 13, turnCount: 2,
  };
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Stale battle turn.', battleState }), {
    status: 409, headers: { 'content-type': 'application/json' },
  });
  try {
    await assert.rejects(
      new GameApi().actUnderpass('player-1', 'permit-1', 'crack', 1),
      (error: unknown) => {
        assert.ok(error instanceof GameApiError);
        assert.equal((error as InstanceType<typeof GameApiError>).status, 409);
        assert.deepEqual((error as InstanceType<typeof GameApiError>).payload, { error: 'Stale battle turn.', battleState });
        return true;
      },
    );
  } finally {
    globalThis.fetch = oldFetch;
  }
});
