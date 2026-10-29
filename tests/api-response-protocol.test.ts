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
    getPendingBattleRewards(playerId: string): Promise<string[]>;
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
