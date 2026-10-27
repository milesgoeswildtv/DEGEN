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
const { GameApi, GameApiError } = runInNewContext(
  stripTypeScriptTypes(source, { mode: 'transform' }) + '\n({ GameApi, GameApiError });',
  {
    __API_BASE: '',
    TEST_DEGEN,
    TUNNEL_MAW,
    fetch: globalThis.fetch,
    AbortController,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    Response,
    URL,
    Date,
    Number,
    JSON,
    Error,
    DOMException,
    encodeURIComponent,
    console,
  },
) as {
  GameApi: new (apiBase?: string, fetcher?: typeof fetch, actionTimeoutMs?: number, completionTimeoutMs?: number) => {
    actUnderpass(playerId: string, permitId: string, abilityId: string, expectedTurnCount: number): Promise<unknown>;
    completeUnderpass(playerId: string, permitId: string): Promise<unknown>;
  };
  GameApiError: new (status: number, payload: unknown, message: string) => Error & { status: number; payload: unknown };
};

const authoritativeTurn = {
  permitId: 'permit-1',
  status: 'active',
  playerHp: 110,
  playerMana: 8,
  enemyHp: 57,
  turnCount: 1,
};

const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const actionBody = (init: RequestInit | undefined): string => String(init?.body ?? '');

test('a transport failure retries the same compare-and-swap action once', async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: actionBody(init) });
    if (calls.length === 1) throw new TypeError('simulated connection reset');
    return jsonResponse(authoritativeTurn);
  };

  const api = new GameApi('https://degen-api.example', fetcher);
  const result = await api.actUnderpass('player-1', 'permit-1', 'crack', 0);

  assert.deepEqual(result, authoritativeTurn);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.url === 'https://degen-api.example/api/battle/action'));
  assert.equal(calls[0]?.body, calls[1]?.body);
  assert.deepEqual(JSON.parse(calls[0]?.body ?? ''), {
    playerId: 'player-1',
    permitId: 'permit-1',
    abilityId: 'crack',
    expectedTurnCount: 0,
  });
});

test('a hung action request is aborted and safely retried once with the same turn precondition', async () => {
  const calls: Array<{ body: string; signal?: AbortSignal }> = [];
  const fetcher: typeof fetch = async (_input, init) => {
    calls.push({ body: actionBody(init), signal: init?.signal as AbortSignal | undefined });
    if (calls.length === 1) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        const rejectOnAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
        if (signal.aborted) rejectOnAbort();
        else signal.addEventListener('abort', rejectOnAbort, { once: true });
      });
    }
    return jsonResponse(authoritativeTurn);
  };

  const api = new GameApi('https://degen-api.example', fetcher, 0);
  const result = await api.actUnderpass('player-1', 'permit-1', 'crack', 0);

  assert.deepEqual(result, authoritativeTurn);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.signal?.aborted, true, 'the stalled request must be actively aborted');
  assert.equal(calls[0]?.body, calls[1]?.body);
});

test('two hung action attempts terminate after the bounded retry', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    calls += 1;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal;
      const rejectOnAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
      if (signal.aborted) rejectOnAbort();
      else signal.addEventListener('abort', rejectOnAbort, { once: true });
    });
  };

  const api = new GameApi('https://degen-api.example', fetcher, 0);
  await assert.rejects(
    api.actUnderpass('player-1', 'permit-1', 'crack', 0),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  );
  assert.equal(calls, 2, 'the original request and one retry are the hard limit');
});

test('a 5xx after a committed turn retries safely and preserves the Worker conflict snapshot', async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const conflictPayload = {
    error: 'Stale battle turn.',
    battleState: authoritativeTurn,
  };
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: actionBody(init) });
    return calls.length === 1
      ? jsonResponse({ error: 'Internal server error' }, 500)
      : jsonResponse(conflictPayload, 409);
  };

  const api = new GameApi('https://degen-api.example', fetcher);
  await assert.rejects(
    api.actUnderpass('player-1', 'permit-1', 'crack', 0),
    (error: unknown) => {
      assert.ok(error instanceof GameApiError);
      assert.equal(error.status, 409);
      assert.deepEqual(error.payload, conflictPayload);
      return true;
    },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.body, calls[1]?.body,
    'a retry must keep the original expected turn so a committed action cannot apply twice');
});

test('a second 5xx ends the bounded retry instead of looping', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return jsonResponse({ error: 'temporarily unavailable' }, 503);
  };
  const api = new GameApi('https://degen-api.example', fetcher);

  await assert.rejects(
    api.actUnderpass('player-1', 'permit-1', 'crack', 0),
    (error: unknown) => error instanceof GameApiError && error.status === 503,
  );
  assert.equal(calls, 2, 'one original request plus one retry; never an unbounded retry loop');
});

test('client validation/conflict responses are not retried', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return jsonResponse({ error: 'Not enough Mana for that ability.' }, 409);
  };
  const api = new GameApi('https://degen-api.example', fetcher);

  await assert.rejects(
    api.actUnderpass('player-1', 'permit-1', 'crack', 0),
    (error: unknown) => error instanceof GameApiError && error.status === 409,
  );
  assert.equal(calls, 1);
});


const authoritativeCompletion = {
  player: { id: 'player-1', level: 2, xp: 10, currency: 40 },
  reward: { xp: 75, currency: 30, items: [], furniture: [], tier: 'full' },
  worldEvent: { eventKey: 'underpass', cycleId: 'cycle-1', phase: 'open', source: 'server' },
};

test('a hung completion request is aborted and retried once with the same permit receipt request', async () => {
  const calls: Array<{ body: string; signal?: AbortSignal }> = [];
  const fetcher: typeof fetch = async (_input, init) => {
    calls.push({ body: actionBody(init), signal: init?.signal as AbortSignal | undefined });
    if (calls.length === 1) {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        const rejectOnAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
        if (signal.aborted) rejectOnAbort();
        else signal.addEventListener('abort', rejectOnAbort, { once: true });
      });
    }
    return jsonResponse(authoritativeCompletion);
  };

  const api = new GameApi('https://degen-api.example', fetcher, 0, 0);
  const result = await api.completeUnderpass('player-1', 'permit-1');

  assert.deepEqual(result, authoritativeCompletion);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.signal?.aborted, true, 'the hung completion request must be aborted');
  assert.equal(calls[0]?.body, calls[1]?.body, 'completion retry must reuse the same permit request');
  assert.deepEqual(JSON.parse(calls[0]?.body ?? ''), { playerId: 'player-1', permitId: 'permit-1' });
});

test('two hung completion attempts terminate after the bounded retry', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    calls += 1;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal as AbortSignal;
      const rejectOnAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
      if (signal.aborted) rejectOnAbort();
      else signal.addEventListener('abort', rejectOnAbort, { once: true });
    });
  };
  const api = new GameApi('https://degen-api.example', fetcher, 0, 0);

  await assert.rejects(
    api.completeUnderpass('player-1', 'permit-1'),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  );
  assert.equal(calls, 2, 'one completion attempt plus one retry is the hard limit');
});

test('a transient completion 5xx retries the same idempotent receipt request', async () => {
  const calls: Array<{ body: string }> = [];
  const fetcher: typeof fetch = async (_input, init) => {
    calls.push({ body: actionBody(init) });
    return calls.length === 1
      ? jsonResponse({ error: 'temporary settlement failure' }, 503)
      : jsonResponse(authoritativeCompletion);
  };
  const api = new GameApi('https://degen-api.example', fetcher, 0, 1_000);

  const result = await api.completeUnderpass('player-1', 'permit-1');
  assert.deepEqual(result, authoritativeCompletion);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.body, calls[1]?.body);
});

test('a client or conflict completion 4xx is not retried', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls += 1;
    return jsonResponse({ error: 'Battle reward is already being claimed.' }, 409);
  };
  const api = new GameApi('https://degen-api.example', fetcher, 0, 1_000);

  await assert.rejects(
    api.completeUnderpass('player-1', 'permit-1'),
    (error: unknown) => error instanceof GameApiError && error.status === 409,
  );
  assert.equal(calls, 1, '4xx responses remain under Worker retry/recovery policy');
});
