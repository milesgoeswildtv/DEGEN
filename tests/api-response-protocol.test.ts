import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

// Run the real API module through Node's TypeScript transform, injecting only
// its two shared prototype definitions and platform globals.
const source = readFileSync(new URL('../src/app/api.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '')
  .replace(/^export /gm, '')
  .replace(/^const API_BASE = .*;\n/m, "const API_BASE = '';\n");
const compiled = stripTypeScriptTypes(source, { mode: 'transform' });
const apiModule = runInNewContext(compiled + '\n({ GameApi, GameApiProtocolError });', {
  TEST_DEGEN: { maxHp: 120, maxMana: 12 },
  TUNNEL_MAW: { maxHp: 92 },
  AbortController,
  Response,
  URL,
  crypto: globalThis.crypto,
  setTimeout,
  clearTimeout,
  SyntaxError: globalThis.SyntaxError,
  console,
}) as {
  GameApi: new (apiBase: string, fetcher: typeof fetch) => {
    getUnderpass(playerId: string): Promise<unknown>;
    getPendingBattleRewards(playerId: string): Promise<string[]>;
    actUnderpass(playerId: string, permitId: string, abilityId: string, expectedTurnCount: number): Promise<unknown>;
    completeUnderpass(playerId: string, permitId: string): Promise<unknown>;
  };
  GameApiProtocolError: new (...args: any[]) => Error;
};

test('malformed JSON from a successful API response is a protocol error', async () => {
  const api = new apiModule.GameApi('https://example.test', async () =>
    new Response('{', { status: 200, headers: { 'content-type': 'application/json' } }),
  );

  await assert.rejects(
    api.getPendingBattleRewards('player-1'),
    apiModule.GameApiProtocolError,
  );
});

test('malformed pending-reward payload shape is a protocol error', async () => {
  const api = new apiModule.GameApi('https://example.test', async () =>
    new Response(JSON.stringify({ permitIds: ['valid-permit', 17] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );

  await assert.rejects(
    api.getPendingBattleRewards('player-1'),
    apiModule.GameApiProtocolError,
  );
});

test('whitespace-padded pending-reward permit IDs are a protocol error', async () => {
  const api = new apiModule.GameApi('https://example.test', async () =>
    new Response(JSON.stringify({ permitIds: [' valid-permit '] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );

  await assert.rejects(
    api.getPendingBattleRewards('player-1'),
    apiModule.GameApiProtocolError,
  );
});

test('malformed Underpass snapshot is a protocol error', async () => {
  const api = new apiModule.GameApi('https://example.test', async () =>
    new Response(JSON.stringify({ eventKey: 'underpass', phase: 'open' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );

  await assert.rejects(
    api.getUnderpass('player-1'),
    apiModule.GameApiProtocolError,
  );
});

test('malformed battle-action snapshot is a protocol error without a retry', async () => {
  let requests = 0;
  const api = new apiModule.GameApi('https://example.test', async () => {
    requests += 1;
    return new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  await assert.rejects(
    api.actUnderpass('player-1', 'permit-1', 'slash', 0),
    apiModule.GameApiProtocolError,
  );
  assert.equal(requests, 1, 'a malformed authoritative action snapshot is not a transport retry');
});

test('malformed completion receipt is a protocol error without client recovery data', async () => {
  let requests = 0;
  const api = new apiModule.GameApi('https://example.test', async () => {
    requests += 1;
    return new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  await assert.rejects(
    api.completeUnderpass('player-1', 'permit-1'),
    apiModule.GameApiProtocolError,
  );
  assert.equal(requests, 1, 'a malformed receipt must not be treated as a valid completion');
});
