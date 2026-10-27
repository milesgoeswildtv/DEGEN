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
const { GameApi, GameApiError, isAuthoritativeBattleActionState } = runInNewContext(stripTypeScriptTypes(source, { mode: 'transform' }) + '\n({ GameApi, GameApiError, isAuthoritativeBattleActionState });', {
  __API_BASE: 'https://degen-api.example', TEST_DEGEN, TUNNEL_MAW,
  fetch: (...args: any[]) => globalThis.fetch(...args), Response, URL, AbortController, setTimeout, clearTimeout,
  crypto: globalThis.crypto, Date, Number, JSON, Error, encodeURIComponent, console,
}) as {
  GameApi: new (apiBase?: string, fetcher?: typeof fetch, actionTimeoutMs?: number, completionTimeoutMs?: number, startTimeoutMs?: number) => {
    startUnderpass(playerId: string, cycleId: string): Promise<unknown>;
    actUnderpass(playerId: string, permitId: string, abilityId: string, expectedTurnCount: number): Promise<unknown>;
  };
  GameApiError: new (status: number, payload: unknown, message: string) => Error & { status: number; payload: unknown };
  isAuthoritativeBattleActionState: (value: unknown, permitId: string) => boolean;
};

const controllerSource = readFileSync(new URL('../src/app/AppController.ts', import.meta.url), 'utf8');
const controllerMethod = controllerSource.match(/private async useBattleAbility\(abilityId: string\): Promise<void> \{([\s\S]*?)\n  \}\n\n  private setAbilityButtonsDisabled/);
assert.ok(controllerMethod, 'AppController action handler must remain available for the recovery regression');
const useBattleAbility = runInNewContext(
  stripTypeScriptTypes(`async function useBattleAbility(abilityId: string): Promise<void> {${controllerMethod[1]}\n}\nuseBattleAbility;`, { mode: 'transform' }),
  { GameApiError, isAuthoritativeBattleActionState, console: { warn() {} } },
) as (this: any, abilityId: string) => Promise<void>;

const validPermit = (permitId = 'permit-1') => {
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
  const oldFetch = globalThis.fetch;
  let sent: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify(validPermit(String(sent.requestId))), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const result = await new GameApi().startUnderpass('player-1', 'cycle-1') as any;
    assert.equal(result.permitId, sent?.requestId, 'the authoritative permit ID should match the start request key');
    assert.deepEqual(Object.keys(sent ?? {}).sort(), [
      'cycleId', 'encounterKey', 'eventKey', 'playerId', 'requestId',
    ]);
    assert.match(String(sent?.requestId), /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      'each start attempt needs an opaque random idempotency key');
    for (const key of ['playerHp', 'playerMana', 'enemyHp', 'turnCount', 'status']) {
      assert.equal(key in (sent ?? {}), false, `battle start must not submit ${key}`);
    }
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('battle start retries a lost response with the identical request id and body', async () => {
  const sent: string[] = [];
  let calls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    calls += 1;
    const body = String(init?.body);
    sent.push(body);
    if (calls === 1) throw new TypeError('simulated connection reset after Worker commit');
    const payload = JSON.parse(body) as { requestId: string };
    return new Response(JSON.stringify(validPermit(payload.requestId)), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const api = new GameApi('https://degen-api.example', fetcher);
  const result = await api.startUnderpass('player-1', 'cycle-1') as ReturnType<typeof validPermit>;

  assert.equal(calls, 2);
  assert.equal(sent[0], sent[1], 'retry must reuse the exact request body and idempotency key');
  const request = JSON.parse(sent[0]) as { requestId: string; playerId: string };
  assert.equal(request.playerId, 'player-1');
  assert.equal((result as any).permitId, request.requestId,
    'the Worker permit identity must be the key used to recover a lost start response');
});

test('battle start aborts and retries one timed-out request, then stops after two hangs', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    calls += 1;
    if (calls === 1) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return reject(new Error('missing start AbortSignal'));
        if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }
    const body = JSON.parse(String(init?.body)) as { requestId: string };
    return new Response(JSON.stringify(validPermit(body.requestId)), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const api = new GameApi('https://degen-api.example', fetcher, 12_000, 20_000, 0);
  const result = await api.startUnderpass('player-1', 'cycle-1') as ReturnType<typeof validPermit>;
  assert.equal(calls, 2);
  assert.equal((result as any).permitId, (result as any).initialState.permitId);

  calls = 0;
  const hungFetcher: typeof fetch = async (_input, init) => {
    calls += 1;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return reject(new Error('missing start AbortSignal'));
      if (signal.aborted) return reject(new DOMException('aborted', 'AbortError'));
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
  };
  const hungApi = new GameApi('https://degen-api.example', hungFetcher, 12_000, 20_000, 0);
  await assert.rejects(hungApi.startUnderpass('player-1', 'cycle-1'));
  assert.equal(calls, 2, 'a permanently stalled start must terminate after one retry');
});

test('battle start does not retry a Worker 4xx rejection', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: 'The Underpass is sealed.' }), {
      status: 409, headers: { 'content-type': 'application/json' },
    });
  };
  await assert.rejects(
    new GameApi('https://degen-api.example', fetcher).startUnderpass('player-1', 'cycle-1'),
    (error: unknown) => error instanceof GameApiError && error.status === 409,
  );
  assert.equal(calls, 1, 'authoritative 4xx rejection must not be retried');
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


test('AppController synchronizes terminal snapshots returned with expired action conflicts', async () => {
  const terminalStates = [
    { permitId: 'permit-1', status: 'victory', playerHp: 80, playerMana: 0, enemyHp: 0, turnCount: 1 },
    { permitId: 'permit-1', status: 'defeat', playerHp: 0, playerMana: 0, enemyHp: 63, turnCount: 1 },
  ];

  for (const battleState of terminalStates) {
    const synchronized: unknown[] = [];
    const applied: unknown[] = [];
    const disabledStates: boolean[] = [];
    let requestArgs: unknown[] | undefined;
    const engine = {
      snapshot: { permitId: 'permit-1', status: 'active', playerHp: 80, playerMana: 0, enemyHp: 1, turnCount: 0 } as typeof battleState | { permitId: string; status: string; playerHp: number; playerMana: number; enemyHp: number; turnCount: number },
      synchronizeAuthoritativeState(state: typeof battleState) {
        synchronized.push(state);
        this.snapshot = state;
      },
      applyAuthoritativeAction(...args: unknown[]) { applied.push(args); },
    };
    const controller = {
      battleEngine: engine,
      battlePermit: { permitId: 'permit-1' },
      battlePermitOwnerId: 'player-1',
      battleActionPending: false,
      api: {
        enabled: true,
        async actUnderpass(...args: unknown[]) {
          requestArgs = args;
          throw new GameApiError(409, { error: 'Terminal state recovered.', battleState }, 'Terminal state recovered.');
        },
      },
      store: { snapshot: { id: 'player-1' } },
      setBattleActionStatus() {},
      setAbilityButtonsDisabled(disabled: boolean) { disabledStates.push(disabled); },
    };

    await useBattleAbility.call(controller, 'slash');

    assert.deepEqual(requestArgs, ['player-1', 'permit-1', 'slash', 0]);
    assert.deepEqual(synchronized, [battleState], 'only the validated Worker snapshot is synchronized');
    assert.equal(engine.snapshot.status, battleState.status);
    assert.deepEqual(applied, [], 'a 409 recovery must not apply combat math or another action locally');
    assert.equal(controller.battleActionPending, false);
    assert.deepEqual(disabledStates, [true], 'terminal recovery must not re-enable terminal action buttons');
  }
});

test('AppController ignores malformed terminal snapshots from battle conflicts', async () => {
  const invalidStates = [
    { permitId: 'another-permit', status: 'victory', playerHp: 80, playerMana: 0, enemyHp: 0, turnCount: 1 },
    { permitId: 'permit-1', status: 'victory', playerHp: 80, playerMana: 0, enemyHp: 1, turnCount: 1 },
  ];

  for (const battleState of invalidStates) {
    const synchronized: unknown[] = [];
    const applied: unknown[] = [];
    const disabledStates: boolean[] = [];
    const engine = {
      snapshot: {
        permitId: 'permit-1', status: 'active', playerHp: 80, playerMana: 0, enemyHp: 50, turnCount: 0,
      },
      synchronizeAuthoritativeState(state: unknown) {
        synchronized.push(state);
        this.snapshot = state as typeof this.snapshot;
      },
      applyAuthoritativeAction(...args: unknown[]) { applied.push(args); },
    };
    const controller = {
      battleEngine: engine,
      battlePermit: { permitId: 'permit-1' },
      battlePermitOwnerId: 'player-1',
      battleActionPending: false,
      api: {
        enabled: true,
        async actUnderpass() {
          throw new GameApiError(409, { error: 'Malformed terminal snapshot.', battleState }, 'Malformed terminal snapshot.');
        },
      },
      store: { snapshot: { id: 'player-1' } },
      setBattleActionStatus() {},
      setAbilityButtonsDisabled(disabled: boolean) { disabledStates.push(disabled); },
    };

    await useBattleAbility.call(controller, 'slash');

    assert.deepEqual(synchronized, [], 'malformed or cross-permit snapshots must never become client state');
    assert.deepEqual(applied, [], 'a rejected action must never fall back to local combat math');
    assert.equal(engine.snapshot.status, 'active');
    assert.equal(controller.battleActionPending, false);
    assert.deepEqual(disabledStates, [true, false], 'active controls recover after an invalid conflict response');
  }
});

