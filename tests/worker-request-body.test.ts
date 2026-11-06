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
  crypto: globalThis.crypto, Request, Response, URL, Uint32Array, TextDecoder,
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


test('invalid UTF-8 JSON bytes are rejected before touching D1', async () => {
  // A replacement-character decoder would turn these invalid bytes into a
  // valid-looking player ID and allow the request to reach persistence.
  const malformedUtf8Json = Uint8Array.from([
    0x7b, 0x22, 0x70, 0x6c, 0x61, 0x79, 0x65, 0x72, 0x49, 0x64,
    0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d,
  ]);
  let d1Touched = false;
  const response = await worker.fetch(new Request('https://degen-api.example/api/player/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: malformedUtf8Json,
  }), {
    DB: {
      prepare() {
        d1Touched = true;
        throw new Error('Invalid UTF-8 must be rejected before D1.');
      },
    },
  });

  assert.equal(d1Touched, false);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Request body must be valid JSON.' });
});

const MAX_REQUEST_BODY_BYTES = 64 * 1024;

test('JSON request bodies accept the exact 64 KiB boundary and reject larger bodies before D1', async () => {
  const emptyPayload = JSON.stringify({ playerId: 'p', displayName: '' });
  const paddingLength = MAX_REQUEST_BODY_BYTES - new TextEncoder().encode(emptyPayload).byteLength;
  const exactBody = JSON.stringify({ playerId: 'p', displayName: 'x'.repeat(paddingLength) });
  assert.equal(new TextEncoder().encode(exactBody).byteLength, MAX_REQUEST_BODY_BYTES);

  let exactBoundaryReachedD1 = false;
  const exactResponse = await worker.fetch(new Request('https://degen-api.example/api/player/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: exactBody,
  }), {
    DB: {
      prepare() {
        exactBoundaryReachedD1 = true;
        throw new Error('Stop after proving the exact body-size boundary was parsed.');
      },
    },
  });
  assert.equal(exactBoundaryReachedD1, true);
  assert.equal(exactResponse.status, 500);

  const overLimitBody = JSON.stringify({ playerId: 'p', displayName: 'x'.repeat(paddingLength + 1) });
  assert.equal(new TextEncoder().encode(overLimitBody).byteLength, MAX_REQUEST_BODY_BYTES + 1);
  let oversizedBodyReachedD1 = false;
  const oversizedResponse = await worker.fetch(new Request('https://degen-api.example/api/player/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: overLimitBody,
  }), {
    DB: {
      prepare() {
        oversizedBodyReachedD1 = true;
        throw new Error('Oversized JSON must be rejected before D1.');
      },
    },
  });
  assert.equal(oversizedBodyReachedD1, false);
  assert.equal(oversizedResponse.status, 413);
  assert.deepEqual(await oversizedResponse.json(), { error: 'Request body exceeds the 64 KiB limit.' });

  let declaredOversizeReachedD1 = false;
  const declaredOversizeResponse = await worker.fetch(new Request('https://degen-api.example/api/player/bootstrap', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(MAX_REQUEST_BODY_BYTES + 1),
    },
    body: JSON.stringify({ playerId: 'p' }),
  }), {
    DB: {
      prepare() {
        declaredOversizeReachedD1 = true;
        throw new Error('An oversized declared body must be rejected before reading or D1 access.');
      },
    },
  });
  assert.equal(declaredOversizeReachedD1, false);
  assert.equal(declaredOversizeResponse.status, 413);
  assert.deepEqual(await declaredOversizeResponse.json(), { error: 'Request body exceeds the 64 KiB limit.' });
});

test('chunked JSON bodies are bounded while streaming without Content-Length', async () => {
  const prefix = new TextEncoder().encode('{"playerId":"p","displayName":"');
  const suffix = new TextEncoder().encode('"}');
  const padding = new Uint8Array(MAX_REQUEST_BODY_BYTES - prefix.byteLength - suffix.byteLength + 1).fill(0x78);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(prefix);
      controller.enqueue(padding);
      controller.enqueue(suffix);
      controller.close();
    },
  });
  const request = new Request('https://degen-api.example/api/player/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: stream,
    duplex: 'half',
  } as RequestInit);
  assert.equal(request.headers.get('content-length'), null);

  let d1Touched = false;
  const response = await worker.fetch(request, {
    DB: { prepare() { d1Touched = true; throw new Error('Chunked oversized JSON must not reach D1.'); } },
  });
  assert.equal(d1Touched, false);
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'Request body exceeds the 64 KiB limit.' });
});

test('malformed route identity fields return 400 before touching D1', async () => {
  const cases = [
    { path: '/api/player/bootstrap', body: { playerId: {} }, error: 'playerId is required' },
    { path: '/api/player/bootstrap', body: { playerId: 'player-1', displayName: {} }, error: 'displayName must be a string.' },
    { path: '/api/player/bootstrap', body: { playerId: 'player-1', platform: {}, platformUserId: 'discord-1' }, error: 'platform must be a string.' },
    { path: '/api/player/bootstrap', body: { playerId: 'player-1', platform: 'steam', platformUserId: 'account-1' }, error: 'platform must be browser, discord, or telegram.' },
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



test('Discord and Telegram identity IDs reject empty or whitespace-padded values before D1 access', async () => {
  for (const platform of ['discord', 'telegram'] as const) {
    for (const platformUserId of ['', '   ', ' discord-1 ', '\ttelegram-1']) {
      const response = await worker.fetch(new Request('https://degen-api.example/api/player/bootstrap', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ playerId: 'player-1', platform, platformUserId }),
      }), {
        DB: { prepare() { throw new Error('D1 must not be touched for a non-canonical platform identity'); } },
      });
      assert.equal(response.status, 400, JSON.stringify({ platform, platformUserId }));
      assert.deepEqual(await response.json(), {
        error: 'platformUserId must be a non-empty canonical string.',
      });
    }
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


test('padded route identifiers are rejected before touching D1', async () => {
  const cases = [
    { path: '/api/player/bootstrap', method: 'POST', body: { playerId: ' player-1 ' }, error: 'playerId is required' },
    {
      path: '/api/battle/start', method: 'POST',
      body: { playerId: 'player-1', eventKey: 'underpass', cycleId: ' cycle-1 ', encounterKey: TUNNEL_MAW.id },
      error: 'Invalid battle start request',
    },
    {
      path: '/api/battle/action', method: 'POST',
      body: { playerId: 'player-1', permitId: ' permit-1 ', abilityId: 'slash', expectedTurnCount: 0 },
      error: 'playerId, permitId, and abilityId are required',
    },
    {
      path: '/api/battle/action', method: 'POST',
      body: { playerId: 'player-1', permitId: 'permit-1', abilityId: ' slash ', expectedTurnCount: 0 },
      error: 'playerId, permitId, and abilityId are required',
    },
    {
      path: '/api/battle/complete', method: 'POST',
      body: { playerId: 'player-1', permitId: ' permit-1 ' },
      error: 'playerId and permitId are required',
    },
    {
      path: '/api/player/housing', method: 'PUT',
      body: { playerId: ' player-1 ', housing: { placements: [] } },
      error: 'playerId and housing are required',
    },
  ];

  for (const scenario of cases) {
    const response = await worker.fetch(new Request(`https://degen-api.example${scenario.path}`, {
      method: scenario.method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(scenario.body),
    }), {
      DB: { prepare() { throw new Error('D1 must not be touched for padded route identifiers'); } },
    });
    assert.equal(response.status, 400, scenario.path);
    assert.deepEqual(await response.json(), { error: scenario.error }, scenario.path);
  }
});

test('padded player IDs on read routes are rejected before touching D1', async () => {
  for (const path of [
    '/api/world/underpass?playerId=%20player-1%20',
    '/api/battle/pending-rewards?playerId=%20player-1%20',
  ]) {
    const response = await worker.fetch(new Request(`https://degen-api.example${path}`), {
      DB: { prepare() { throw new Error('D1 must not be touched for a padded player ID'); } },
    });
    assert.equal(response.status, 400, path);
    assert.deepEqual(await response.json(), { error: 'playerId is required' }, path);
  }
});


test('tab and line-break padding on opaque route identifiers is rejected before D1 access', async () => {
  const cases = [
    {
      path: '/api/player/bootstrap', method: 'POST',
      body: { playerId: '\tplayer-1' }, error: 'playerId is required',
    },
    {
      path: '/api/battle/start', method: 'POST',
      body: { playerId: 'player-1', eventKey: 'underpass', cycleId: 'cycle-1\n', encounterKey: TUNNEL_MAW.id },
      error: 'Invalid battle start request',
    },
    {
      path: '/api/battle/action', method: 'POST',
      body: { playerId: 'player-1', permitId: '\tpermit-1', abilityId: 'slash', expectedTurnCount: 0 },
      error: 'playerId, permitId, and abilityId are required',
    },
    {
      path: '/api/battle/action', method: 'POST',
      body: { playerId: 'player-1', permitId: 'permit-1', abilityId: 'slash\r', expectedTurnCount: 0 },
      error: 'playerId, permitId, and abilityId are required',
    },
    {
      path: '/api/battle/complete', method: 'POST',
      body: { playerId: 'player-1', permitId: 'permit-1\n' },
      error: 'playerId and permitId are required',
    },
    {
      path: '/api/player/housing', method: 'PUT',
      body: { playerId: 'player-1\t', housing: { placements: [] } },
      error: 'playerId and housing are required',
    },
  ];

  for (const scenario of cases) {
    const response = await worker.fetch(new Request(`https://degen-api.example${scenario.path}`, {
      method: scenario.method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(scenario.body),
    }), {
      DB: { prepare() { throw new Error('D1 must not be touched for control-whitespace route identifiers'); } },
    });
    assert.equal(response.status, 400, scenario.path);
    assert.deepEqual(await response.json(), { error: scenario.error }, scenario.path);
  }

  for (const path of [
    '/api/world/underpass?playerId=%09player-1',
    '/api/battle/pending-rewards?playerId=player-1%0A',
  ]) {
    const response = await worker.fetch(new Request(`https://degen-api.example${path}`), {
      DB: { prepare() { throw new Error('D1 must not be touched for control-whitespace read identifiers'); } },
    });
    assert.equal(response.status, 400, path);
    assert.deepEqual(await response.json(), { error: 'playerId is required' }, path);
  }
});


test('embedded control characters in route identifiers are rejected before D1 access', async () => {
  const cases = [
    {
      path: '/api/player/bootstrap', method: 'POST',
      body: { playerId: 'player-\u0000id' }, error: 'playerId is required',
    },
    {
      path: '/api/player/bootstrap', method: 'POST',
      body: { playerId: 'player-1', platform: 'discord', platformUserId: 'discord-\u0000id' },
      error: 'platformUserId must be a non-empty canonical string.',
    },
    {
      path: '/api/battle/start', method: 'POST',
      body: { playerId: 'player-1', eventKey: 'underpass', cycleId: 'cycle-\u001fid', encounterKey: TUNNEL_MAW.id },
      error: 'Invalid battle start request',
    },
    {
      path: '/api/battle/action', method: 'POST',
      body: { playerId: 'player-1', permitId: 'permit-\u007fid', abilityId: 'slash', expectedTurnCount: 0 },
      error: 'playerId, permitId, and abilityId are required',
    },
    {
      path: '/api/battle/action', method: 'POST',
      body: { playerId: 'player-1', permitId: 'permit-1', abilityId: 'slash-\u0085id', expectedTurnCount: 0 },
      error: 'playerId, permitId, and abilityId are required',
    },
    {
      path: '/api/battle/complete', method: 'POST',
      body: { playerId: 'player-1', permitId: 'permit-\u009fid' },
      error: 'playerId and permitId are required',
    },
    {
      path: '/api/player/housing', method: 'PUT',
      body: { playerId: 'player-\u001fid', housing: { placements: [] } },
      error: 'playerId and housing are required',
    },
  ];

  for (const scenario of cases) {
    const response = await worker.fetch(new Request(`https://degen-api.example${scenario.path}`, {
      method: scenario.method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(scenario.body),
    }), {
      DB: { prepare() { throw new Error('D1 must not be touched for embedded control characters'); } },
    });
    assert.equal(response.status, 400, scenario.path);
    assert.deepEqual(await response.json(), { error: scenario.error }, scenario.path);
  }

  for (const path of [
    '/api/world/underpass?playerId=player-%00id',
    '/api/battle/pending-rewards?playerId=player-%7Fid',
  ]) {
    const response = await worker.fetch(new Request(`https://degen-api.example${path}`), {
      DB: { prepare() { throw new Error('D1 must not be touched for control characters in read identifiers'); } },
    });
    assert.equal(response.status, 400, path);
    assert.deepEqual(await response.json(), { error: 'playerId is required' }, path);
  }
});


test('invisible Unicode format controls in route identifiers are rejected before D1 access', async () => {
  const cases = [
    {
      path: '/api/player/bootstrap', method: 'POST',
      body: { playerId: 'player-\u200Bid' }, error: 'playerId is required',
    },
    {
      path: '/api/player/bootstrap', method: 'POST',
      body: { playerId: 'player-1', platform: 'discord', platformUserId: 'discord-\u202Eid' },
      error: 'platformUserId must be a non-empty canonical string.',
    },
    {
      path: '/api/battle/start', method: 'POST',
      body: { playerId: 'player-1', eventKey: 'underpass', cycleId: 'cycle-\u2066id', encounterKey: TUNNEL_MAW.id },
      error: 'Invalid battle start request',
    },
    {
      path: '/api/battle/action', method: 'POST',
      body: { playerId: 'player-1', permitId: 'permit-\uFEFFid', abilityId: 'slash', expectedTurnCount: 0 },
      error: 'playerId, permitId, and abilityId are required',
    },
    {
      path: '/api/battle/action', method: 'POST',
      body: { playerId: 'player-1', permitId: 'permit-1', abilityId: 'slash-\u200Bid', expectedTurnCount: 0 },
      error: 'playerId, permitId, and abilityId are required',
    },
  ];

  for (const scenario of cases) {
    const response = await worker.fetch(new Request('https://degen-api.example' + scenario.path, {
      method: scenario.method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(scenario.body),
    }), {
      DB: { prepare() { throw new Error('D1 must not be touched for invisible Unicode format controls'); } },
    });
    assert.equal(response.status, 400, scenario.path);
    assert.deepEqual(await response.json(), { error: scenario.error }, scenario.path);
  }

  const encodedPlayerId = encodeURIComponent('player-\u202Eid');
  const readResponse = await worker.fetch(new Request(
    'https://degen-api.example/api/world/underpass?playerId=' + encodedPlayerId,
  ), {
    DB: { prepare() { throw new Error('D1 must not be touched for an invisible format control in a read ID'); } },
  });
  assert.equal(readResponse.status, 400);
  assert.deepEqual(await readResponse.json(), { error: 'playerId is required' });
});


test('overlong opaque identifiers are rejected before D1 access', async () => {
  const overlong = 'x'.repeat(129);
  const cases = [
    {
      path: '/api/player/bootstrap', method: 'POST',
      body: { playerId: overlong }, error: 'playerId is required',
    },
    {
      path: '/api/player/bootstrap', method: 'POST',
      body: { playerId: 'player-1', platform: 'discord', platformUserId: overlong },
      error: 'platformUserId must be a non-empty canonical string.',
    },
    {
      path: '/api/battle/start', method: 'POST',
      body: { playerId: 'player-1', eventKey: 'underpass', cycleId: overlong, encounterKey: TUNNEL_MAW.id },
      error: 'Invalid battle start request',
    },
    {
      path: '/api/battle/action', method: 'POST',
      body: { playerId: 'player-1', permitId: overlong, abilityId: 'slash', expectedTurnCount: 0 },
      error: 'playerId, permitId, and abilityId are required',
    },
    {
      path: '/api/battle/action', method: 'POST',
      body: { playerId: 'player-1', permitId: 'permit-1', abilityId: overlong, expectedTurnCount: 0 },
      error: 'playerId, permitId, and abilityId are required',
    },
    {
      path: '/api/battle/complete', method: 'POST',
      body: { playerId: 'player-1', permitId: overlong },
      error: 'playerId and permitId are required',
    },
    {
      path: '/api/player/housing', method: 'PUT',
      body: { playerId: overlong, housing: { placements: [] } },
      error: 'playerId and housing are required',
    },
  ];

  for (const scenario of cases) {
    const response = await worker.fetch(new Request('https://degen-api.example' + scenario.path, {
      method: scenario.method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(scenario.body),
    }), {
      DB: { prepare() { throw new Error('D1 must not be touched for overlong route identifiers'); } },
    });
    assert.equal(response.status, 400, scenario.path);
    assert.deepEqual(await response.json(), { error: scenario.error }, scenario.path);
  }

  for (const path of [
    '/api/world/underpass?playerId=' + overlong,
    '/api/battle/pending-rewards?playerId=' + overlong,
  ]) {
    const response = await worker.fetch(new Request('https://degen-api.example' + path), {
      DB: { prepare() { throw new Error('D1 must not be touched for overlong read identifiers'); } },
    });
    assert.equal(response.status, 400, path);
    assert.deepEqual(await response.json(), { error: 'playerId is required' }, path);
  }
});


test('128-code-unit opaque identifiers pass validation before D1 access', async () => {
  let d1Touched = false;
  const response = await worker.fetch(new Request('https://degen-api.example/api/battle/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      playerId: 'p'.repeat(128),
      eventKey: 'underpass',
      cycleId: 'c'.repeat(128),
      encounterKey: TUNNEL_MAW.id,
    }),
  }), {
    DB: {
      prepare() {
        d1Touched = true;
        throw new Error('Stop after proving canonical 128-code-unit IDs pass validation.');
      },
    },
  });

  assert.equal(d1Touched, true);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'Internal server error' });
});

test('an underreported Content-Length cannot bypass the streamed JSON byte limit', async () => {
  const oversizedBytes = new TextEncoder().encode(JSON.stringify({
    playerId: 'p',
    displayName: 'x'.repeat(MAX_REQUEST_BODY_BYTES),
  }));
  assert.ok(oversizedBytes.byteLength > MAX_REQUEST_BODY_BYTES);

  const request = new Request('https://degen-api.example/api/player/bootstrap', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Treat this as an untrusted early hint: the stream still exceeds the cap.
      'content-length': '1',
    },
    body: oversizedBytes,
  });
  assert.equal(request.headers.get('content-length'), '1');

  let d1Touched = false;
  const response = await worker.fetch(request, {
    DB: {
      prepare() {
        d1Touched = true;
        throw new Error('A dishonest Content-Length must not bypass the streamed byte limit.');
      },
    },
  });

  assert.equal(d1Touched, false);
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'Request body exceeds the 64 KiB limit.' });
});


test('malformed Content-Length values are rejected before reading or touching D1', async () => {
  const cases = [
    { value: 'abc', error: 'Content-Length must be a non-negative integer.' },
    { value: '-1', error: 'Content-Length must be a non-negative integer.' },
    { value: '1.5', error: 'Content-Length must be a non-negative integer.' },
    { value: '1e3', error: 'Content-Length must be a non-negative integer.' },
    { value: '9007199254740992', error: 'Content-Length must be a safe integer.' },
  ];

  for (const scenario of cases) {
    const request = new Request('https://degen-api.example/api/player/bootstrap', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': scenario.value,
      },
      body: JSON.stringify({ playerId: 'player-1' }),
    });
    assert.equal(request.headers.get('content-length'), scenario.value);

    let d1Touched = false;
    const response = await worker.fetch(request, {
      DB: {
        prepare() {
          d1Touched = true;
          throw new Error('Malformed Content-Length must be rejected before D1 access.');
        },
      },
    });

    assert.equal(d1Touched, false, scenario.value);
    assert.equal(response.status, 400, scenario.value);
    assert.deepEqual(await response.json(), { error: scenario.error }, scenario.value);
  }
});

test('a failed request-body stream is rejected without exposing stream errors or touching D1', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error('private upstream stream failure'));
    },
  });
  const request = new Request('https://degen-api.example/api/player/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: stream,
    duplex: 'half',
  } as RequestInit);

  let d1Touched = false;
  const response = await worker.fetch(request, {
    DB: {
      prepare() {
        d1Touched = true;
        throw new Error('An unreadable request body must not reach D1.');
      },
    },
  });

  assert.equal(d1Touched, false);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Request body must be readable JSON.' });
});
