import assert from 'node:assert/strict';
import test from 'node:test';
import { GameApi, GameApiProtocolError } from '../src/app/api.ts';

test('malformed JSON from a successful API response is a protocol error', async () => {
  const api = new GameApi('https://example.test', async () =>
    new Response('{', { status: 200, headers: { 'content-type': 'application/json' } }),
  );

  await assert.rejects(
    api.getPendingBattleRewards('player-1'),
    GameApiProtocolError,
  );
});

test('malformed pending-reward payload shape is a protocol error', async () => {
  const api = new GameApi('https://example.test', async () =>
    new Response(JSON.stringify({ permitIds: ['valid-permit', 17] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );

  await assert.rejects(
    api.getPendingBattleRewards('player-1'),
    GameApiProtocolError,
  );
});
