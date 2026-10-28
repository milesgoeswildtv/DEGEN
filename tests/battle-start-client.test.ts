import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test, { beforeEach } from 'node:test';
import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';

const startRequestStorage = new Map<string, string>();
const testLocalStorage = {
  get length() { return startRequestStorage.size; },
  key(index: number) { return [...startRequestStorage.keys()][index] ?? null; },
  getItem(key: string) { return startRequestStorage.get(key) ?? null; },
  setItem(key: string, value: string) { startRequestStorage.set(key, String(value)); },
  removeItem(key: string) { startRequestStorage.delete(key); },
};
beforeEach(() => startRequestStorage.clear());

const source = readFileSync(new URL('../src/app/api.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace('import.meta.env.VITE_API_BASE', 'globalThis.__API_BASE')
  .replace(/\bexport class /g, 'class ')
  .replace(/\bexport const /g, 'const ');
const { GameApi, GameApiError, isAuthoritativeBattleActionState } = runInNewContext(stripTypeScriptTypes(source, { mode: 'transform' }) + '\n({ GameApi, GameApiError, isAuthoritativeBattleActionState });', {
  __API_BASE: 'https://degen-api.example', TEST_DEGEN, TUNNEL_MAW,
  fetch: (...args: any[]) => globalThis.fetch(...args), Response, URL, AbortController, setTimeout, clearTimeout,
  crypto: globalThis.crypto, localStorage: testLocalStorage, Date, Number, JSON, Error, encodeURIComponent, console,
}) as {
  GameApi: new (apiBase?: string, fetcher?: typeof fetch, actionTimeoutMs?: number, completionTimeoutMs?: number, startTimeoutMs?: number) => {
    getUnderpass(playerId: string): Promise<unknown>;
    startUnderpass(playerId: string, cycleId: string): Promise<unknown>;
    acknowledgeUnderpassStart(playerId: string, cycleId: string, permitId: string): void;
    acknowledgeUnderpassCompletion(playerId: string, permitId: string): void;
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

const startControllerMethod = controllerSource.match(/private async enterUnderpass\(\): Promise<void> \{([\s\S]*?)\n  \}\n\n  private mountBattle/);
assert.ok(startControllerMethod, 'AppController start handler must remain available for the durable-key regression');
const enterUnderpass = runInNewContext(
  stripTypeScriptTypes(`async function enterUnderpass(): Promise<void> {${startControllerMethod[1]}\n}\nenterUnderpass;`, { mode: 'transform' }),
  { console: { warn() {} }, Error },
) as (this: any) => Promise<void>;

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
  globalThis.fetch = async (_input, init) => {
    const requestId = (JSON.parse(String(init?.body)) as { requestId: string }).requestId;
    const permit = value as any;
    const originalPermitId = permit.permitId;
    permit.permitId = requestId;
    if (permit.initialState && permit.initialState.permitId === originalPermitId) {
      permit.initialState.permitId = requestId;
    }
    return new Response(JSON.stringify(permit), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  try { return await api.startUnderpass('player-1', 'cycle-1'); }
  finally { globalThis.fetch = oldFetch; }
}

test('AppController acknowledges the start key only after attaching the permit for the active player', async () => {
  const events: string[] = [];
  const permit = validPermit('permit-accepted');
  const controller: any = {
    underpassEvent: { phase: 'open', cycleId: 'cycle-1' },
    store: { snapshot: { id: 'player-1' } },
    api: {
      enabled: true,
      async startUnderpass(playerId: string, cycleId: string) {
        assert.equal(playerId, 'player-1');
        assert.equal(cycleId, 'cycle-1');
        return permit;
      },
      acknowledgeUnderpassStart(playerId: string, cycleId: string, permitId: string) {
        events.push(`ack:${playerId}:${cycleId}:${permitId}`);
      },
    },
    navigate(route: string) { events.push(`navigate:${route}`); },
    async refreshWorld() { events.push('refresh'); },
    render() { events.push('render'); },
    battlePermit: undefined,
    battlePermitOwnerId: undefined,
  };

  await enterUnderpass.call(controller);
  assert.equal(controller.battlePermit, permit);
  assert.equal(controller.battlePermitOwnerId, 'player-1');
  assert.deepEqual(events, ['navigate:battle', 'ack:player-1:cycle-1:permit-accepted']);
});

test('AppController retains the start key when the active player changes during the request', async () => {
  const events: string[] = [];
  const permit = validPermit('permit-player-1');
  const controller: any = {
    underpassEvent: { phase: 'open', cycleId: 'cycle-1' },
    store: { snapshot: { id: 'player-1' } },
    api: {
      enabled: true,
      async startUnderpass() {
        controller.store.snapshot.id = 'player-2';
        return permit;
      },
      acknowledgeUnderpassStart() { events.push('ack'); },
    },
    navigate(route: string) { events.push(`navigate:${route}`); },
    async refreshWorld() { events.push('refresh'); },
    render() { events.push('render'); },
    battlePermit: undefined,
    battlePermitOwnerId: undefined,
  };

  await enterUnderpass.call(controller);
  assert.equal(controller.battlePermit, undefined);
  assert.equal(controller.battlePermitOwnerId, undefined);
  assert.deepEqual(events, [], "a foreign player's response must not be attached or acknowledged");
});

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

test('battle start retries a transient 5xx with the identical request ID and body', async () => {
  const sent: string[] = [];
  let calls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    const body = String(init?.body);
    sent.push(body);
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ error: 'temporary Worker failure' }), {
        status: 503, headers: { 'content-type': 'application/json' },
      });
    }
    const request = JSON.parse(body) as { requestId: string };
    return new Response(JSON.stringify(validPermit(request.requestId)), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const api = new GameApi('https://degen-api.example', fetcher);
  const result = await api.startUnderpass('player-1', 'cycle-1') as ReturnType<typeof validPermit>;
  const request = JSON.parse(sent[0]) as { requestId: string };

  assert.equal(calls, 2);
  assert.equal(sent[0], sent[1], 'a transient 5xx retry must reuse the exact start key and body');
  assert.equal(result.permitId, request.requestId);
});

test('battle start rejects a valid-looking permit response bound to another request ID', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify(validPermit('other-permit')), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const api = new GameApi('https://degen-api.example', fetcher);
  await assert.rejects(
    api.startUnderpass('player-1', 'cycle-1'),
    /Missing or malformed authoritative battle start state/,
  );
  assert.equal(calls, 1, 'a mismatched successful response must fail closed, not be retried as a transport error');
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

test('battle start preserves an uncertain request ID across failed retries and a new GameApi instance', async () => {
  const failedBodies: string[] = [];
  const failedFetcher: typeof fetch = async (_input, init) => {
    failedBodies.push(String(init?.body));
    throw new TypeError('simulated response loss after the Worker may have committed');
  };
  const failedApi = new GameApi('https://degen-api.example', failedFetcher, 12_000, 20_000, 0);
  await assert.rejects(failedApi.startUnderpass('player-1', 'cycle-1'));
  assert.equal(failedBodies.length, 2);
  assert.equal(failedBodies[0], failedBodies[1], 'the bounded in-call retry must keep the same key and body');
  assert.equal(startRequestStorage.size, 1, 'uncertain failure must retain the durable idempotency key');

  const recoveredBodies: string[] = [];
  const recoveredFetcher: typeof fetch = async (_input, init) => {
    const body = String(init?.body);
    recoveredBodies.push(body);
    const request = JSON.parse(body) as { requestId: string };
    return new Response(JSON.stringify(validPermit(request.requestId)), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const recoveredApi = new GameApi('https://degen-api.example', recoveredFetcher);
  const recovered = await recoveredApi.startUnderpass('player-1', 'cycle-1') as ReturnType<typeof validPermit>;
  const originalRequestId = (JSON.parse(failedBodies[0] ?? '{}') as { requestId: string }).requestId;
  assert.equal(recoveredBodies.length, 1);
  assert.equal((JSON.parse(recoveredBodies[0] ?? '{}') as { requestId: string }).requestId, originalRequestId,
    'a later GameApi instance must recover the same server permit after both prior responses were lost');
  assert.equal(recovered.permitId, originalRequestId);
  assert.equal(startRequestStorage.size, 1, 'keep the key until the controller confirms it accepted the permit');
  recoveredApi.acknowledgeUnderpassStart('player-1', 'cycle-1', 'wrong-permit');
  assert.equal(startRequestStorage.size, 1, 'a mismatched acknowledgement must not clear another permit key');
  recoveredApi.acknowledgeUnderpassStart('player-1', 'cycle-1', recovered.permitId);
  assert.equal(startRequestStorage.size, 1, 'the same per-player correlation record remains after acknowledgement');
  const activeRecord = JSON.parse([...startRequestStorage.values()][0] ?? '{}') as {
    requestId: string; cycleId: string; state: string;
  };
  assert.equal(activeRecord.requestId, recovered.permitId);
  assert.equal(activeRecord.cycleId, 'cycle-1');
  assert.equal(activeRecord.state, 'active', 'acknowledgement changes lifecycle state without duplicating storage');
});

test('one per-player battle key survives reload and cycle rollover until reward completion', async () => {
  let originalRequestId = '';
  const firstFetcher: typeof fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { requestId: string; cycleId: string };
    originalRequestId = body.requestId;
    return new Response(JSON.stringify(validPermit(body.requestId)), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const firstApi = new GameApi('https://degen-api.example', firstFetcher);
  const firstPermit = await firstApi.startUnderpass('player-1', 'cycle-1') as ReturnType<typeof validPermit>;
  firstApi.acknowledgeUnderpassStart('player-1', 'cycle-1', firstPermit.permitId);

  let recoveryBody: { requestId: string; cycleId: string } | undefined;
  const recoveryFetcher: typeof fetch = async (_input, init) => {
    recoveryBody = JSON.parse(String(init?.body)) as { requestId: string; cycleId: string };
    return new Response(JSON.stringify(validPermit(recoveryBody.requestId)), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const reloadedApi = new GameApi('https://degen-api.example', recoveryFetcher);
  const recovered = await reloadedApi.startUnderpass('player-1', 'cycle-2') as ReturnType<typeof validPermit>;
  assert.equal(recoveryBody?.requestId, originalRequestId,
    'a new GameApi instance must reuse the active permit ID rather than create a distinct key');
  assert.equal(recoveryBody?.cycleId, 'cycle-1',
    'cycle rollover must not invalidate the still-live permit or replace its original cycle');
  assert.equal(recovered.permitId, firstPermit.permitId);
  reloadedApi.acknowledgeUnderpassCompletion('player-1', recovered.permitId);
  assert.equal(startRequestStorage.size, 0,
    'only authoritative completion acknowledgement clears the per-player correlation record');
});

test('legacy uncertain-start keys migrate into the single per-player record across cycle rollover', async () => {
  const legacyId = '00000000-0000-4000-8000-000000000011';
  const legacyKey = 'degen:pending-battle-start:player-1:previous-cycle';
  startRequestStorage.set(legacyKey, legacyId);
  let requestBody: { requestId: string; cycleId: string } | undefined;
  const fetcher: typeof fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body)) as { requestId: string; cycleId: string };
    const permit = validPermit(requestBody.requestId);
    permit.cycleId = requestBody.cycleId;
    return new Response(JSON.stringify(permit), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const api = new GameApi('https://degen-api.example', fetcher);
  const result = await api.startUnderpass('player-1', 'current-cycle') as ReturnType<typeof validPermit>;
  assert.equal(requestBody?.requestId, legacyId);
  assert.equal(requestBody?.cycleId, 'previous-cycle');
  assert.equal(result.permitId, legacyId);
  assert.equal(startRequestStorage.has(legacyKey), false, 'the legacy per-cycle key is migrated and removed');
  assert.equal(startRequestStorage.size, 1, 'only one per-player correlation record remains');
});

test('battle start clears a persisted key after a definitive Worker rejection', async () => {
  let rejectedRequestId = '';
  const rejectedFetcher: typeof fetch = async (_input, init) => {
    rejectedRequestId = (JSON.parse(String(init?.body)) as { requestId: string }).requestId;
    return new Response(JSON.stringify({ error: 'The Underpass is sealed.' }), {
      status: 409, headers: { 'content-type': 'application/json' },
    });
  };
  const rejectedApi = new GameApi('https://degen-api.example', rejectedFetcher);
  await assert.rejects(rejectedApi.startUnderpass('player-1', 'cycle-1'));
  assert.equal(startRequestStorage.size, 0, 'a definitive 4xx proves the key cannot recover a valid start');

  let nextRequestId = '';
  const successFetcher: typeof fetch = async (_input, init) => {
    nextRequestId = (JSON.parse(String(init?.body)) as { requestId: string }).requestId;
    return new Response(JSON.stringify(validPermit(nextRequestId)), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  await new GameApi('https://degen-api.example', successFetcher).startUnderpass('player-1', 'cycle-1');
  assert.notEqual(nextRequestId, rejectedRequestId, 'a new start after a definitive rejection gets a fresh key');
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

test('server-backed battle start accepts a valid progressed snapshot when recovering a lost response', async () => {
  const permit = validPermit();
  permit.initialState.playerHp = 64;
  permit.initialState.playerMana = 4;
  permit.initialState.enemyHp = 50;
  permit.initialState.turnCount = 2;

  const result = await apiReturning(permit) as typeof permit;
  assert.deepEqual(result.initialState, permit.initialState);
});

test('server-backed battle start rejects active snapshots outside battle invariants', async () => {
  const deadPlayer = validPermit();
  deadPlayer.initialState.playerHp = 0;
  await assert.rejects(apiReturning(deadPlayer), /Missing or malformed authoritative battle start state/);

  const exhaustedTurnCounter = validPermit();
  exhaustedTurnCounter.initialState.turnCount = Number.MAX_SAFE_INTEGER;
  await assert.rejects(apiReturning(exhaustedTurnCounter), /Missing or malformed authoritative battle start state/);
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



const validWorldSnapshot = () => ({
  eventKey: 'underpass',
  cycleId: 'cycle-1',
  phase: 'open',
  opensAt: '2026-10-27T00:00:00.000Z',
  closesAt: '2026-10-28T00:00:00.000Z',
  fullRewardClears: 0,
  fullRewardLimit: 3,
  source: 'server',
});

test('getUnderpass accepts a complete Worker-owned snapshot', async () => {
  const snapshot = validWorldSnapshot();
  let requestedUrl = '';
  const api = new GameApi('https://degen-api.example', async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify(snapshot), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  assert.deepEqual(await api.getUnderpass('player 1'), snapshot);
  assert.match(requestedUrl, /playerId=player%201/);
});

test('getUnderpass rejects malformed or non-server world snapshots even on HTTP 200', async () => {
  const valid = validWorldSnapshot();
  const malformed = [
    { ...valid, eventKey: 'other-event' },
    { ...valid, cycleId: '   ' },
    { ...valid, phase: 'almost-open' },
    { ...valid, opensAt: 'not-a-date' },
    { ...valid, closesAt: valid.opensAt },
    { ...valid, fullRewardClears: -1 },
    { ...valid, fullRewardClears: 0.5 },
    { ...valid, fullRewardLimit: 0 },
    { ...valid, source: 'preview' },
  ];

  for (const payload of malformed) {
    const api = new GameApi('https://degen-api.example', async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await assert.rejects(
      api.getUnderpass('player-1'),
      /Malformed authoritative Underpass snapshot/,
      'invalid server snapshots must fail closed',
    );
  }
});
