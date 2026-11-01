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
    bootstrap(playerId: string, identity: { platform: string; platformUserId: string; displayName: string }): Promise<any>;
    getUnderpass(playerId: string): Promise<unknown>;
    getPendingBattleRewards(playerId: string): Promise<string[]>;
    startUnderpass(playerId: string, cycleId: string): Promise<unknown>;
    actUnderpass(playerId: string, permitId: string, abilityId: string, expectedTurnCount: number): Promise<unknown>;
    completeUnderpass(playerId: string, permitId: string): Promise<unknown>;
  };
  GameApiProtocolError: new (...args: any[]) => Error;
};

const validPlayerSnapshot = (id = 'player-1') => ({
  id,
  displayName: 'Player One',
  level: 1,
  xp: 0,
  currency: 0,
  degenId: 'test-degen',
  inventory: [],
  unlockedLocations: ['home', 'downtown', 'underpass'],
  housing: {
    inventory: ['starter-bed'],
    placements: [{ instanceId: 'bed-1', furnitureId: 'starter-bed', x: 1, y: 1 }],
  },
  defeatedBosses: [],
});

const identity = { platform: 'browser', platformUserId: 'browser-1', displayName: 'Player One' };

test('valid Worker bootstrap snapshot is accepted for its requested player', async () => {
  let requests = 0;
  const api = new apiModule.GameApi('https://example.test', async (_input, init) => {
    requests += 1;
    assert.equal(JSON.parse(String(init?.body)).playerId, 'player-1');
    return new Response(JSON.stringify(validPlayerSnapshot()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  const player = await api.bootstrap('player-1', identity);
  assert.equal(player?.id, 'player-1');
  assert.equal(player?.housing.placements[0]?.instanceId, 'bed-1');
  assert.equal(requests, 1);
});

test('malformed Worker bootstrap snapshot is a protocol error without retry', async () => {
  let requests = 0;
  const api = new apiModule.GameApi('https://example.test', async () => {
    requests += 1;
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  await assert.rejects(
    api.bootstrap('player-1', identity),
    apiModule.GameApiProtocolError,
  );
  assert.equal(requests, 1, 'a malformed player snapshot must not be treated as a transport failure');
});

test('bootstrap rejects a snapshot belonging to a different player ID', async () => {
  let requests = 0;
  const api = new apiModule.GameApi('https://example.test', async () => {
    requests += 1;
    return new Response(JSON.stringify(validPlayerSnapshot('other-player')), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  await assert.rejects(
    api.bootstrap('player-1', identity),
    apiModule.GameApiProtocolError,
  );
  assert.equal(requests, 1, 'a cross-player snapshot must be rejected without retry');
});

test('bootstrap rejects malformed and out-of-bounds housing placements before replacing player state', async () => {
  for (const [x, y] of [[-1, 1], [8, 1], [1, -1], [1, 6]]) {
    let requests = 0;
    const snapshot = validPlayerSnapshot();
    snapshot.housing.placements[0]!.x = x;
    snapshot.housing.placements[0]!.y = y;
    const api = new apiModule.GameApi('https://example.test', async () => {
      requests += 1;
      return new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await assert.rejects(
      api.bootstrap('player-1', identity),
      apiModule.GameApiProtocolError,
      `placement at ${x},${y} must be rejected`,
    );
    assert.equal(requests, 1, 'invalid housing data must not be retried as a transport failure');
  }
});

test('bootstrap rejects over-capacity and duplicate housing layouts without retry', async () => {
  const invalidLayouts = [
    {
      label: 'more than the 48 cells in the room',
      placements: Array.from({ length: 49 }, (_, index) => ({
        instanceId: `placement-${index}`,
        furnitureId: 'starter-bed',
        x: index % 8,
        y: Math.floor(index / 8) % 6,
      })),
    },
    {
      label: 'duplicate placement identifiers',
      placements: [
        { instanceId: 'shared-id', furnitureId: 'starter-bed', x: 1, y: 1 },
        { instanceId: 'shared-id', furnitureId: 'starter-chair', x: 2, y: 2 },
      ],
    },
    {
      label: 'duplicate occupied cells',
      placements: [
        { instanceId: 'bed-1', furnitureId: 'starter-bed', x: 1, y: 1 },
        { instanceId: 'chair-1', furnitureId: 'starter-chair', x: 1, y: 1 },
      ],
    },
  ];

  for (const layout of invalidLayouts) {
    let requests = 0;
    const snapshot = validPlayerSnapshot() as any;
    snapshot.housing.placements = layout.placements;
    const api = new apiModule.GameApi('https://example.test', async () => {
      requests += 1;
      return new Response(JSON.stringify(snapshot), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await assert.rejects(
      api.bootstrap('player-1', identity),
      apiModule.GameApiProtocolError,
      layout.label,
    );
    assert.equal(requests, 1, `${layout.label} must not be retried as a transport failure`);
  }
});

test('completion receipt rejects duplicate housing cells before client state replacement', async () => {
  let requests = 0;
  const player = validPlayerSnapshot() as any;
  player.housing.placements = [
    { instanceId: 'bed-1', furnitureId: 'starter-bed', x: 1, y: 1 },
    { instanceId: 'chair-1', furnitureId: 'starter-chair', x: 1, y: 1 },
  ];
  const receipt = {
    player,
    reward: { xp: 10, currency: 5, items: [], furniture: [], tier: 'full' },
    levelTransition: { previousLevel: 1, currentLevel: 1 },
    worldEvent: {
      eventKey: 'underpass',
      cycleId: 'cycle-1',
      phase: 'open',
      opensAt: '2026-10-29T00:00:00.000Z',
      closesAt: '2026-10-30T00:00:00.000Z',
      fullRewardClears: 0,
      fullRewardLimit: 3,
      source: 'server',
    },
  };
  const api = new apiModule.GameApi('https://example.test', async () => {
    requests += 1;
    return new Response(JSON.stringify(receipt), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  await assert.rejects(
    api.completeUnderpass('player-1', 'permit-1'),
    apiModule.GameApiProtocolError,
  );
  assert.equal(requests, 1, 'a malformed completion snapshot must not be accepted or retried');
});

const validCompletionReceipt = () => ({
  player: { ...validPlayerSnapshot(), level: 2 },
  reward: {
    xp: 75,
    currency: 30,
    items: ['underpass-scrap'],
    furniture: ['tunnel-trophy'],
    tier: 'full',
  },
  levelTransition: { previousLevel: 1, currentLevel: 2 },
  worldEvent: {
    eventKey: 'underpass',
    cycleId: 'cycle-1',
    phase: 'open',
    opensAt: '2026-10-29T00:00:00.000Z',
    closesAt: '2026-10-30T00:00:00.000Z',
    fullRewardClears: 0,
    fullRewardLimit: 3,
    source: 'server',
  },
});

test('valid Worker completion receipt is accepted with the exact reward fields used by the UI', async () => {
  let requests = 0;
  const receipt = validCompletionReceipt();
  const api = new apiModule.GameApi('https://example.test', async () => {
    requests += 1;
    return new Response(JSON.stringify(receipt), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  const result = await api.completeUnderpass('player-1', 'permit-1') as any;
  assert.equal(result.player.id, 'player-1');
  assert.equal(result.reward.xp, 75);
  assert.equal(result.reward.currency, 30);
  assert.equal(result.reward.items[0], 'underpass-scrap');
  assert.equal(result.reward.furniture[0], 'tunnel-trophy');
  assert.equal(result.reward.tier, 'full');
  assert.equal(requests, 1);
});

test('completion rejects malformed Worker reward level transitions before they reach the receipt UI', async () => {
  const invalidTransitions = [
    null,
    { previousLevel: 0, currentLevel: 2 },
    { previousLevel: 2, currentLevel: 1 },
    { previousLevel: 1, currentLevel: 3 },
    { previousLevel: 1.5, currentLevel: 2 },
  ];
  for (const levelTransition of invalidTransitions) {
    const receipt = validCompletionReceipt() as any;
    receipt.levelTransition = levelTransition;
    const api = new apiModule.GameApi('https://example.test', async () => new Response(JSON.stringify(receipt), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await assert.rejects(api.completeUnderpass('player-1', 'permit-1'), apiModule.GameApiProtocolError);
  }
});

test('completion rejects malformed Worker reward fields before they reach the receipt UI', async () => {
  const invalidRewards: Array<{ label: string; mutate: (reward: any) => void }> = [
    { label: 'negative XP', mutate: reward => { reward.xp = -1; } },
    { label: 'fractional currency', mutate: reward => { reward.currency = 1.5; } },
    { label: 'non-string item key', mutate: reward => { reward.items = ['underpass-scrap', 7]; } },
    { label: 'non-array furniture', mutate: reward => { reward.furniture = 'tunnel-trophy'; } },
    { label: 'missing furniture array', mutate: reward => { delete reward.furniture; } },
    { label: 'unknown reward tier', mutate: reward => { reward.tier = 'bonus'; } },
  ];

  for (const { label, mutate } of invalidRewards) {
    const receipt = validCompletionReceipt() as any;
    mutate(receipt.reward);
    let requests = 0;
    const api = new apiModule.GameApi('https://example.test', async () => {
      requests += 1;
      return new Response(JSON.stringify(receipt), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await assert.rejects(
      api.completeUnderpass('player-1', 'permit-1'),
      apiModule.GameApiProtocolError,
      label,
    );
    assert.equal(requests, 1, `${label} must fail closed without a completion retry`);
  }
});

test('malformed JSON from a successful API response is a protocol error', async () => {
  const api = new apiModule.GameApi('https://example.test', async () =>
    new Response('{', { status: 200, headers: { 'content-type': 'application/json' } }),
  );

  await assert.rejects(
    api.getPendingBattleRewards('player-1'),
    apiModule.GameApiProtocolError,
  );
});

test('malformed JSON battle-start response is a protocol error without retry', async () => {
  let requests = 0;
  const api = new apiModule.GameApi('https://example.test', async () => {
    requests += 1;
    return new Response('{', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  await assert.rejects(
    api.startUnderpass('player-1', 'cycle-1'),
    apiModule.GameApiProtocolError,
  );
  assert.equal(requests, 1, 'malformed battle-start JSON must not be retried as a transport failure');
});

test('malformed battle-start snapshot is a protocol error without retry', async () => {
  let requests = 0;
  const api = new apiModule.GameApi('https://example.test', async () => {
    requests += 1;
    return new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  await assert.rejects(
    api.startUnderpass('player-1', 'cycle-1'),
    apiModule.GameApiProtocolError,
  );
  assert.equal(requests, 1, 'a malformed start snapshot must not be mistaken for a transport failure');
});

test('malformed JSON battle-action response is a protocol error without retry', async () => {
  let requests = 0;
  const api = new apiModule.GameApi('https://example.test', async () => {
    requests += 1;
    return new Response('{', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  await assert.rejects(
    api.actUnderpass('player-1', 'permit-1', 'slash', 0),
    apiModule.GameApiProtocolError,
  );
  assert.equal(requests, 1, 'invalid JSON is not a transient action transport failure');
});

test('malformed JSON battle-completion response is a protocol error without retry', async () => {
  let requests = 0;
  const api = new apiModule.GameApi('https://example.test', async () => {
    requests += 1;
    return new Response('{', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  await assert.rejects(
    api.completeUnderpass('player-1', 'permit-1'),
    apiModule.GameApiProtocolError,
  );
  assert.equal(requests, 1, 'invalid JSON must not trigger a second completion request');
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
