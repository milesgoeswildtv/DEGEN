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
const { GameApi, GameApiError, isAuthoritativeBattleActionState } = runInNewContext(stripTypeScriptTypes(source, { mode: 'transform' }) + '\n({ GameApi, GameApiError });', {
  __API_BASE: 'https://degen-api.example', TEST_DEGEN, TUNNEL_MAW,
  fetch: (...args: any[]) => globalThis.fetch(...args), Response, URL, AbortController, setTimeout, clearTimeout,
  Date, Number, JSON, Error, encodeURIComponent, console,
}) as {
  GameApi: new () => {
    startUnderpass(playerId: string, cycleId: string): Promise<unknown>;
    actUnderpass(playerId: string, permitId: string, abilityId: string, expectedTurnCount: number): Promise<unknown>;
    bootstrap(identity: { platform: 'telegram'; displayName: string; telegramInitData?: string }): Promise<unknown>;
    setIdentityProvider(provider: () => Promise<{ platform: 'telegram'; displayName: string; telegramInitData?: string }>): void;
  };
  GameApiError: new (status: number, payload: unknown, message: string) => Error & { status: number; payload: unknown };
  isAuthoritativeBattleActionState: (value: unknown, permitId: string) => boolean;
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

test('battle start request sends no client-owned combat state', async () => {
  const api = new GameApi();
  const token = 'A'.repeat(43);
  const oldFetch = globalThis.fetch;
  let sent: Record<string, unknown> | undefined;
  globalThis.fetch = async (input, init) => {
    const path = String(input).replace('https://degen-api.example', '');
    if (path === '/api/player/bootstrap') {
      return new Response(JSON.stringify({
        player: { id: 'server-player', displayName: 'Verified' },
        session: { token, expiresAtMs: Date.now() + 60_000 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (path === '/api/battle/start') {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify(validPermit()), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error('Unexpected API request: ' + path);
  };
  try {
    await api.bootstrap({ platform: 'telegram', displayName: 'Verified', telegramInitData: 'signed-proof' });
    await api.startUnderpass('server-player', 'cycle-1');
    assert.deepEqual(Object.keys(sent ?? {}).sort(), ['cycleId', 'encounterKey', 'eventKey']);
    for (const key of ['playerId', 'playerHp', 'playerMana', 'enemyHp', 'turnCount', 'status']) {
      assert.equal(key in (sent ?? {}), false, `battle start must not submit ${key}`);
    }
  } finally {
    globalThis.fetch = oldFetch;
  }
});

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
      permitId: 'permit-1', abilityId: 'crack', expectedTurnCount: 3,
    });
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('player-owned API requests use the server session and never submit playerId', async () => {
  const api = new GameApi();
  const token = 'A'.repeat(43);
  const oldFetch = globalThis.fetch;
  const calls: Array<{ path: string; headers: Record<string, string>; body?: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input).replace('https://degen-api.example', '');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ path, headers, body });
    if (path === '/api/player/bootstrap') {
      return new Response(JSON.stringify({
        player: { id: 'server-player', displayName: 'Verified' },
        session: { token, expiresAtMs: Date.now() + 60_000 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      permitId: 'permit-1', status: 'active', playerHp: 70, playerMana: 0, enemyHp: 20, turnCount: 4,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await api.bootstrap({ platform: 'telegram', displayName: 'Untrusted', telegramInitData: 'signed-proof' });
    await api.actUnderpass('server-player', 'permit-1', 'crack', 3);
    const action = calls.find(call => call.path === '/api/battle/action');
    assert.ok(action);
    assert.equal(action.headers.authorization, 'Bearer ' + token);
    assert.equal(action.body?.playerId, undefined);
    assert.deepEqual(action.body, { permitId: 'permit-1', abilityId: 'crack', expectedTurnCount: 3 });
  } finally { globalThis.fetch = oldFetch; }
});

test('expired session retries only after a fresh verified platform bootstrap', async () => {
  const api = new GameApi();
  const identity = { platform: 'telegram' as const, displayName: 'Verified', telegramInitData: 'signed-proof' };
  const tokens = ['A'.repeat(43), 'B'.repeat(43)];
  const oldFetch = globalThis.fetch;
  let bootstraps = 0;
  let actions = 0;
  const actionTokens: string[] = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input).replace('https://degen-api.example', '');
    if (path === '/api/player/bootstrap') {
      const token = tokens[bootstraps++];
      return new Response(JSON.stringify({
        player: { id: 'server-player', displayName: 'Verified' },
        session: { token, expiresAtMs: Date.now() + 60_000 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (path === '/api/battle/action') {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      actionTokens.push(headers.authorization ?? '');
      actions += 1;
      if (actions === 1) return new Response(JSON.stringify({ error: 'expired' }), { status: 401 });
      return new Response(JSON.stringify({
        permitId: 'permit-1', status: 'active', playerHp: 70, playerMana: 0, enemyHp: 20, turnCount: 4,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('Unexpected API request: ' + path);
  };
  api.setIdentityProvider(async () => identity);
  try {
    await api.bootstrap(identity);
    const result = await api.actUnderpass('server-player', 'permit-1', 'crack', 3);
    assert.equal((result as { turnCount: number }).turnCount, 4);
    assert.equal(bootstraps, 2);
    assert.equal(actions, 2);
    assert.deepEqual(actionTokens, ['Bearer ' + tokens[0], 'Bearer ' + tokens[1]]);
  } finally { globalThis.fetch = oldFetch; }
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


test('successful battle actions reject malformed or out-of-turn Worker state before presentation', async () => {
  const valid = {
    permitId: 'permit-1', status: 'active', playerHp: 70, playerMana: 0,
    enemyHp: 20, turnCount: 4,
  };
  const invalidResponses = [
    { ...valid, permitId: 'another-permit' },
    { ...valid, turnCount: 5 },
    { ...valid, playerMana: TEST_DEGEN.maxMana + 1 },
    { ...valid, status: 'active', playerHp: 0 },
    { ...valid, status: 'active', enemyHp: 0 },
    { ...valid, status: 'victory', enemyHp: 20 },
    { ...valid, status: 'victory', playerHp: 0, enemyHp: 0 },
    { ...valid, status: 'defeat', playerHp: 70 },
    { ...valid, status: 'defeat', playerHp: 0, enemyHp: 0 },
    { ...valid, status: 'unknown' },
    { ...valid, turnCount: Number.MAX_SAFE_INTEGER + 1 },
  ];

  for (const responseBody of invalidResponses) {
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify(responseBody), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    try {
      await assert.rejects(
        new GameApi().actUnderpass('player-1', 'permit-1', 'crack', 3),
        /Malformed authoritative battle action response/,
        JSON.stringify(responseBody),
      );
    } finally {
      globalThis.fetch = oldFetch;
    }
  }
});

test('successful terminal battle actions accept only Worker-consistent victory and defeat states', async () => {
  const terminalStates = [
    { permitId: 'permit-1', status: 'victory', playerHp: 70, playerMana: 0, enemyHp: 0, turnCount: 1 },
    { permitId: 'permit-1', status: 'defeat', playerHp: 0, playerMana: 0, enemyHp: 20, turnCount: 1 },
  ];

  for (const state of terminalStates) {
    const oldFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify(state), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
    try {
      assert.deepEqual(await new GameApi().actUnderpass('player-1', 'permit-1', 'crack', 0), state);
    } finally {
      globalThis.fetch = oldFetch;
    }
  }
});

test('battle action rejects unsafe expected turn counts before issuing a request', async () => {
  const oldFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    for (const turnCount of [-1, 1.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(
        new GameApi().actUnderpass('player-1', 'permit-1', 'crack', turnCount),
        /Invalid expected turn count/,
      );
    }
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = oldFetch;
  }
});


test('client battle-state validation mirrors Worker active-turn and terminal-state invariants', () => {
  const active = {
    permitId: 'permit-1', status: 'active', playerHp: 70, playerMana: 0,
    enemyHp: 20, turnCount: Number.MAX_SAFE_INTEGER - 1,
  };
  assert.equal(isAuthoritativeBattleActionState(active, 'permit-1'), true,
    'the last incrementable active snapshot remains valid before an action');
  assert.equal(isAuthoritativeBattleActionState({ ...active, turnCount: Number.MAX_SAFE_INTEGER }, 'permit-1'), false,
    'an active snapshot at the terminal safe-integer boundary is invalid');
  assert.equal(isAuthoritativeBattleActionState({ ...active, status: 'victory', enemyHp: 0, turnCount: 0 }, 'permit-1'), false,
    'victory requires at least one resolved turn');
  assert.equal(isAuthoritativeBattleActionState({ ...active, status: 'defeat', playerHp: 0, turnCount: 0 }, 'permit-1'), false,
    'defeat requires at least one resolved turn');
  assert.equal(isAuthoritativeBattleActionState({ ...active, status: 'victory', enemyHp: 0, turnCount: 1 }, 'permit-1'), true);
  assert.equal(isAuthoritativeBattleActionState({ ...active, status: 'defeat', playerHp: 0, turnCount: 1 }, 'permit-1'), true);
});
