import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';
import { canUseAbility, resolveCombatTurn } from '../src/game/combat/rules.ts';
import { UNDERPASS_FULL_REWARD_LIMIT, advanceLevel, underpassRewardForClear } from '../src/game/progression.ts';

const source = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/^export default\s*\{/m, 'const worker = {');
const worker = runInNewContext(stripTypeScriptTypes(source, { mode: 'transform' }) + '\nworker;', {
  TEST_DEGEN, TUNNEL_MAW, canUseAbility, resolveCombatTurn,
  UNDERPASS_FULL_REWARD_LIMIT, advanceLevel, underpassRewardForClear,
  crypto: globalThis.crypto, Request, Response, URL, Uint32Array,
  console: { error() {} },
}) as {
  fetch(request: Request, env: { DB: unknown }): Promise<Response>;
};

test('malformed and non-object JSON request bodies return 400 before touching D1', async () => {
  const cases = [
    { body: '{', error: 'Request body must be valid JSON.' },
    { body: 'null', error: 'Request body must be a JSON object.' },
    { body: '[]', error: 'Request body must be a JSON object.' },
    { body: '"not-an-object"', error: 'Request body must be a JSON object.' },
  ];
  for (const scenario of cases) {
    const response = await worker.fetch(new Request('https://degen-api.example/api/battle/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: scenario.body,
    }), {
      DB: { prepare() { throw new Error('D1 must not be touched for invalid input'); } },
    });
    assert.equal(response.status, 400, scenario.body);
    assert.deepEqual(await response.json(), { error: scenario.error });
  }
});

test('unexpected Worker exceptions return a generic 500 without exposing internal details', async () => {
  const response = await worker.fetch(
    new Request('https://degen-api.example/api/world/underpass?playerId=player-1'),
    { DB: { prepare() { throw new Error('private SQL text and internal binding details'); } } },
  );
  assert.equal(response.status, 500);
  const payload = await response.json() as { error: string };
  assert.deepEqual(payload, { error: 'Internal server error' });
  assert.doesNotMatch(JSON.stringify(payload), /private SQL text|internal binding details/i);
});


test('non-JSON content types are rejected before touching D1', async () => {
  const jsonBody = JSON.stringify({ playerId: 'player-1' });
  const cases = [
    { label: 'missing content type', headers: undefined, body: new TextEncoder().encode(jsonBody) },
    { label: 'text/plain', headers: { 'content-type': 'text/plain' }, body: jsonBody },
    { label: 'form encoded', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: jsonBody },
  ];
  for (const scenario of cases) {
    const response = await worker.fetch(new Request('https://degen-api.example/api/battle/start', {
      method: 'POST',
      ...(scenario.headers ? { headers: scenario.headers } : {}),
      body: scenario.body,
    }), {
      DB: { prepare() { throw new Error('D1 must not be touched for non-JSON content type'); } },
    });
    assert.equal(response.status, 400, scenario.label);
    assert.deepEqual(await response.json(), { error: 'Content-Type must be application/json.' });
  }
});


test('application/json with a charset parameter is accepted as JSON media type', async () => {
  const response = await worker.fetch(new Request('https://degen-api.example/api/battle/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: '{',
  }), {
    DB: { prepare() { throw new Error('malformed JSON must fail before D1'); } },
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Request body must be valid JSON.' });
});


test('malformed route identity fields return 400 before touching D1', async () => {
  const cases = [
    { path: '/api/player/bootstrap', body: { playerId: {} }, error: 'playerId is required' },
    { path: '/api/player/bootstrap', body: { playerId: 'player-1', displayName: {} }, error: 'displayName must be a string.' },
    { path: '/api/player/bootstrap', body: { playerId: 'player-1', platform: {}, platformUserId: 'discord-1' }, error: 'platform must be a string.' },
    { path: '/api/player/bootstrap', body: { playerId: 'player-1', platform: 'discord', platformUserId: {} }, error: 'platformUserId must be a string.' },
    { path: '/api/battle/start', body: { playerId: {}, eventKey: 'underpass', cycleId: 'cycle-1', encounterKey: TUNNEL_MAW.id }, error: 'Invalid battle start request' },
    { path: '/api/battle/start', body: { playerId: 'player-1', eventKey: 'underpass', cycleId: {}, encounterKey: TUNNEL_MAW.id }, error: 'Invalid battle start request' },
    { path: '/api/battle/action', body: { playerId: 'player-1', permitId: {}, abilityId: 'slash', expectedTurnCount: 0 }, error: 'playerId, permitId, and abilityId are required' },
    { path: '/api/battle/action', body: { playerId: 'player-1', permitId: 'permit-1', abilityId: {}, expectedTurnCount: 0 }, error: 'playerId, permitId, and abilityId are required' },
    { path: '/api/battle/complete', body: { playerId: 'player-1', permitId: {} }, error: 'playerId and permitId are required' },
    { path: '/api/player/housing', body: { playerId: {}, housing: { placements: [] } }, error: 'playerId and housing are required' },
  ];

  for (const scenario of cases) {
    const response = await worker.fetch(new Request(`https://degen-api.example${scenario.path}`, {
      method: scenario.path === '/api/player/housing' ? 'PUT' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(scenario.body),
    }), {
      DB: { prepare() { throw new Error('D1 must not be touched for malformed route identity fields'); } },
    });
    assert.equal(response.status, 400, scenario.path);
    assert.deepEqual(await response.json(), { error: scenario.error }, scenario.path);
  }
});

test('world and pending-reward reads reject whitespace-only player IDs before D1 access', async () => {
  for (const path of [
    '/api/world/underpass?playerId=%20%20',
    '/api/battle/pending-rewards?playerId=%20%20',
  ]) {
    const response = await worker.fetch(new Request(`https://degen-api.example${path}`), {
      DB: { prepare() { throw new Error('D1 must not be touched for an empty player ID'); } },
    });
    assert.equal(response.status, 400, path);
    assert.deepEqual(await response.json(), { error: 'playerId is required' }, path);
  }
});



test('platform identity IDs reject empty or whitespace-padded values before D1 access', async () => {
  for (const platformUserId of ['', '   ', ' discord-1 ']) {
    const response = await worker.fetch(new Request('https://degen-api.example/api/player/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: 'player-1', platform: 'discord', platformUserId }),
    }), {
      DB: { prepare() { throw new Error('D1 must not be touched for a non-canonical platform identity'); } },
    });
    assert.equal(response.status, 400, JSON.stringify({ platformUserId }));
    assert.deepEqual(await response.json(), {
      error: 'platformUserId must be a non-empty canonical string.',
    });
  }
});

test('whitespace-only identifiers on mutation routes return 400 before touching D1', async () => {
  const cases = [
    { path: '/api/player/bootstrap', method: 'POST', body: { playerId: '   ' }, error: 'playerId is required' },
    {
      path: '/api/battle/start', method: 'POST',
      body: { playerId: 'player-1', eventKey: 'underpass', cycleId: '  ', encounterKey: TUNNEL_MAW.id },
      error: 'Invalid battle start request',
    },
    {
      path: '/api/battle/action', method: 'POST',
      body: { playerId: '  ', permitId: 'permit-1', abilityId: 'slash', expectedTurnCount: 0 },
      error: 'playerId, permitId, and abilityId are required',
    },
    {
      path: '/api/battle/action', method: 'POST',
      body: { playerId: 'player-1', permitId: '  ', abilityId: 'slash', expectedTurnCount: 0 },
      error: 'playerId, permitId, and abilityId are required',
    },
    {
      path: '/api/battle/action', method: 'POST',
      body: { playerId: 'player-1', permitId: 'permit-1', abilityId: '  ', expectedTurnCount: 0 },
      error: 'playerId, permitId, and abilityId are required',
    },
    {
      path: '/api/battle/complete', method: 'POST',
      body: { playerId: 'player-1', permitId: '  ' },
      error: 'playerId and permitId are required',
    },
    {
      path: '/api/player/housing', method: 'PUT',
      body: { playerId: '  ', housing: { placements: [] } },
      error: 'playerId and housing are required',
    },
  ];

  for (const scenario of cases) {
    const response = await worker.fetch(new Request(`https://degen-api.example${scenario.path}`, {
      method: scenario.method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(scenario.body),
    }), {
      DB: { prepare() { throw new Error('D1 must not be touched for whitespace-only route identifiers'); } },
    });
    assert.equal(response.status, 400, scenario.path);
    assert.deepEqual(await response.json(), { error: scenario.error }, scenario.path);
  }
});
