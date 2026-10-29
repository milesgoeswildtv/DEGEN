import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { webcrypto } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../src/app/state.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '')
  .replace(/^export class /gm, 'class ');
const compiled = stripTypeScriptTypes(source, { mode: 'transform' });
const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };

function makeStore(
  saveHousing: (id: string, housing: unknown) => Promise<void>,
  warnings: string[] = [],
  values = new Map<string, string>(),
  bootstrap: (id: string, identity: any) => Promise<any> = async () => undefined,
  writeStorage: (key: string, value: string) => void = (key, value) => { values.set(key, value); },
  enabled = true,
) {
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { writeStorage(key, value); },
  };
  const Store = runInNewContext(compiled + '\nPlayerStore;', {
    localStorage: storage, structuredClone, crypto: webcrypto,
    console: { warn: (...args: unknown[]) => warnings.push(args.join(' ')) },
    advanceLevel: () => ({ level: 1, xp: 0 }),
  }) as new (api: unknown) => {
    placeFurniture(item: string, x: number, y: number): void;
    removeFurnitureAt(x: number, y: number): void;
    subscribe(listener: (player: any) => void): () => void;
    readonly snapshot: any;
    replaceFromServer(player: any): void;
    initialize(identity: any): Promise<void>;
  };
  return new Store({
    enabled,
    saveHousing: (playerId: string, housing: unknown) => enabled ? saveHousing(playerId, housing) : Promise.resolve(),
    bootstrap,
  });
}

test('localStorage write failures do not block server-backed housing saves or UI updates', async () => {
  const warnings: string[] = [];
  const saved: any[] = [];
  const store = makeStore(async (_playerId, housing) => {
    saved.push(structuredClone(housing));
  }, warnings, new Map(), async () => undefined, () => {
    throw new Error('storage quota exceeded');
  });
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });

  assert.doesNotThrow(() => store.placeFurniture('starter-chair', 2, 2));
  await flush();

  assert.equal(saved.length, 1, 'housing persistence must still reach the Worker');
  assert.ok(saved[0]!.placements.some((placement: any) =>
    placement.furnitureId === 'starter-chair' && placement.x === 2 && placement.y === 2));
  assert.ok(notifications >= 2, 'the UI must receive both the local edit and save-settlement snapshots');
  assert.ok(warnings.some((warning) => warning.includes('Local player storage unavailable')));
});

test('rapid edits save immutable housing snapshots in edit order', async () => {
  const calls: Array<{ housing: any; resolve: () => void }> = [];
  const store = makeStore((_id, housing) => new Promise<void>((resolve) => {
    calls.push({ housing: structuredClone(housing), resolve });
  }));
  store.placeFurniture('starter-chair', 2, 2);
  store.placeFurniture('starter-lamp', 3, 3);
  await flush();
  assert.equal(calls.length, 1, 'only first save should be in flight');
  assert.equal(calls[0]!.housing.placements.some((p: any) => p.furnitureId === 'starter-lamp'), false);
  calls[0]!.resolve();
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.housing.placements.some((p: any) => p.furnitureId === 'starter-lamp'), true);
  calls[1]!.resolve();
  await flush();
});

test('failed save does not block the next newer layout', async () => {
  const calls: Array<{ housing: any; resolve: () => void; reject: (error: Error) => void }> = [];
  const warnings: string[] = [];
  const store = makeStore((_id, housing) => new Promise<void>((resolve, reject) => {
    calls.push({ housing: structuredClone(housing), resolve, reject });
  }), warnings);
  store.placeFurniture('starter-chair', 2, 2);
  store.removeFurnitureAt(2, 2);
  await flush();
  assert.equal(calls.length, 1);
  calls[0]!.reject(new Error('network'));
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.housing.placements.some((p: any) => p.furnitureId === 'starter-chair'), false);
  assert.equal(warnings.length, 1);
  calls[1]!.resolve();
  await flush();
});

test('a failed latest save remains queued and retries on the next edit', async () => {
  const calls: Array<{ housing: any; resolve: () => void; reject: (error: Error) => void }> = [];
  const warnings: string[] = [];
  const store = makeStore((_id, housing) => new Promise<void>((resolve, reject) => {
    calls.push({ housing: structuredClone(housing), resolve, reject });
  }), warnings);

  store.placeFurniture('starter-chair', 2, 2);
  await flush();
  assert.equal(calls.length, 1);
  calls[0]!.reject(new Error('temporary network failure'));
  await flush();
  assert.equal(calls.length, 1, 'a failed snapshot must not be retried in a tight loop');
  assert.equal(warnings.length, 1);

  store.placeFurniture('starter-chair', 3, 3);
  await flush();
  assert.equal(calls.length, 2, 'the next edit should drain the retained latest snapshot');
  assert.ok(calls[1]!.housing.placements.some((placement: any) =>
    placement.furnitureId === 'starter-chair' && placement.x === 3 && placement.y === 3));
  calls[1]!.resolve();
  await flush();
  assert.equal(calls.length, 2);
});

test('a newer edit can retry after a failed save while another account save is in flight', async () => {
  const calls: Array<{ playerId: string; housing: any; resolve: () => void; reject: (error: Error) => void }> = [];
  const store = makeStore((playerId, housing) => new Promise<void>((resolve, reject) => {
    calls.push({ playerId, housing: structuredClone(housing), resolve, reject });
  }));
  const firstPlayerId = store.snapshot.id;

  store.placeFurniture('starter-chair', 2, 2);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.playerId, firstPlayerId);

  store.replaceFromServer({ ...store.snapshot, id: 'second-account',
    housing: { inventory: ['starter-chair'], placements: [] } });
  store.placeFurniture('starter-chair', 3, 3);
  calls[0]!.reject(new Error('temporary network failure'));
  await flush();
  assert.equal(calls.length, 2, 'the second account must continue after the first failure');
  assert.equal(calls[1]!.playerId, 'second-account');

  store.replaceFromServer({ ...store.snapshot, id: firstPlayerId,
    housing: { inventory: ['starter-chair'], placements: [] } });
  store.placeFurniture('starter-chair', 4, 4);
  calls[1]!.resolve();
  await flush();
  assert.equal(calls.length, 3, 'a newer snapshot must not be skipped with the failed older snapshot');
  assert.equal(calls[2]!.playerId, firstPlayerId);
  assert.ok(calls[2]!.housing.placements.some((placement: any) =>
    placement.furnitureId === 'starter-chair' && placement.x === 4 && placement.y === 4));
  calls[2]!.resolve();
  await flush();
});

test('100 rapid moves coalesce to first and final saves', async () => {
  const calls: Array<{ housing: any; resolve: () => void }> = [];
  const store = makeStore((_id, housing) => new Promise<void>((resolve) => {
    calls.push({ housing: structuredClone(housing), resolve });
  }));
  for (let index = 0; index < 100; index += 1) {
    store.placeFurniture('starter-chair', index % 8, Math.floor(index / 8) % 6);
  }
  await flush();
  assert.equal(calls.length, 1);
  calls[0]!.resolve();
  await flush();
  assert.equal(calls.length, 2);
  const latest = calls[1]!.housing.placements.find((p: any) => p.furnitureId === 'starter-chair');
  assert.equal(latest.x, 99 % 8);
  assert.equal(latest.y, Math.floor(99 / 8) % 6);
  calls[1]!.resolve();
  await flush();
  assert.equal(calls.length, 2);
});


test('a delayed housing save does not let an older reward receipt erase pending placements', async () => {
  let finish!: () => void;
  const store = makeStore(() => new Promise<void>((resolve) => { finish = resolve; }));
  store.placeFurniture('starter-chair', 2, 2);
  await flush();
  const remote = store.snapshot;
  remote.currency = 777;
  remote.housing.inventory.push('tunnel-trophy');
  remote.housing.placements = [{ instanceId: 'starter-bed-placed', furnitureId: 'starter-bed', x: 1, y: 1 }];
  store.replaceFromServer(remote);
  assert.equal(store.snapshot.currency, 777, 'reward currency stays server-owned');
  assert.ok(store.snapshot.housing.inventory.includes('tunnel-trophy'), 'reward inventory stays server-owned');
  assert.ok(store.snapshot.housing.placements.some((p: any) => p.furnitureId === 'starter-chair'),
    'newer in-flight placement must not disappear');
  finish();
  await flush();
  store.replaceFromServer(remote);
  assert.equal(store.snapshot.housing.placements.some((p: any) => p.furnitureId === 'starter-chair'), false,
    'after save settles, the next server snapshot is authoritative');
});

test('an in-flight housing save cannot leak placements across player identities', async () => {
  let finish!: () => void;
  const store = makeStore(() => new Promise<void>((resolve) => { finish = resolve; }));
  store.placeFurniture('starter-chair', 2, 2);
  await flush();
  const other = { ...store.snapshot, id: 'different-account',
    housing: { inventory: ['starter-lamp'], placements: [] } };
  store.replaceFromServer(other);
  assert.equal(store.snapshot.id, 'different-account');
  assert.equal(store.snapshot.housing.placements.length, 0);
  finish();
  await flush();
});


test('switching back while a layout is only in flight preserves it for the next edit', async () => {
  const calls: Array<{ playerId: string; housing: any; resolve: () => void }> = [];
  const store = makeStore((playerId, housing) => new Promise<void>((resolve) => {
    calls.push({ playerId, housing: structuredClone(housing), resolve });
  }));
  const firstPlayerId = store.snapshot.id;

  store.placeFurniture('starter-chair', 2, 2);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.playerId, firstPlayerId);

  store.replaceFromServer({ ...store.snapshot, id: 'second-account',
    housing: { inventory: ['starter-lamp'], placements: [] } });
  assert.equal(store.snapshot.housing.placements.length, 0, 'another account must not inherit the in-flight layout');

  store.replaceFromServer({ ...store.snapshot, id: firstPlayerId,
    housing: { inventory: ['starter-chair', 'starter-lamp'], placements: [] } });
  assert.ok(store.snapshot.housing.placements.some((placement: any) =>
    placement.furnitureId === 'starter-chair' && placement.x === 2 && placement.y === 2),
  'reactivating the first account must restore its in-flight placement');

  store.placeFurniture('starter-lamp', 3, 3);
  calls[0]!.resolve();
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.playerId, firstPlayerId);
  assert.deepEqual(calls[1]!.housing.placements.map((placement: any) =>
    [placement.furnitureId, placement.x, placement.y]).sort(),
  [['starter-bed', 1, 1], ['starter-chair', 2, 2], ['starter-lamp', 3, 3]]);
  calls[1]!.resolve();
  await flush();
});

test('queued housing edits for separate accounts only save under the active account', async () => {
  const calls: Array<{ playerId: string; housing: any; resolve: () => void }> = [];
  const store = makeStore((playerId, housing) => new Promise<void>((resolve) => {
    calls.push({ playerId, housing: structuredClone(housing), resolve });
  }));
  const firstPlayerId = store.snapshot.id;
  const secondPlayerId = 'second-account';
  const furniture = ['starter-chair', 'starter-lamp', 'starter-rug'];

  store.placeFurniture('starter-chair', 2, 2);
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.playerId, firstPlayerId);
  store.placeFurniture('starter-lamp', 3, 3);

  store.replaceFromServer({ ...store.snapshot, id: secondPlayerId,
    housing: { inventory: furniture, placements: [] } });
  store.placeFurniture('starter-chair', 4, 4);
  store.placeFurniture('starter-lamp', 5, 5);

  store.replaceFromServer({ ...store.snapshot, id: firstPlayerId,
    housing: { inventory: furniture, placements: [] } });
  assert.deepEqual(store.snapshot.housing.placements.map((placement: any) =>
    [placement.furnitureId, placement.x, placement.y]).sort(),
  [['starter-bed', 1, 1], ['starter-chair', 2, 2], ['starter-lamp', 3, 3]],
  'reactivating an account must restore its newest queued layout');
  store.placeFurniture('starter-rug', 6, 5);

  calls[0]!.resolve();
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.playerId, firstPlayerId,
    'the queue must not send the second account snapshot with the first account active');
  assert.deepEqual(calls[1]!.housing.placements.map((placement: any) =>
    [placement.furnitureId, placement.x, placement.y]).sort(),
  [['starter-bed', 1, 1], ['starter-chair', 2, 2], ['starter-lamp', 3, 3], ['starter-rug', 6, 5]]);
  calls[1]!.resolve();
  await flush();
  assert.equal(calls.length, 2, 'the second account snapshot stays queued while the first account is active');

  store.replaceFromServer({ ...store.snapshot, id: secondPlayerId,
    housing: { inventory: furniture, placements: [] } });
  assert.deepEqual(store.snapshot.housing.placements.map((placement: any) =>
    [placement.furnitureId, placement.x, placement.y]).sort(),
  [['starter-chair', 4, 4], ['starter-lamp', 5, 5]],
  'the second account must retain its own queued layout');
  await flush();
  assert.equal(calls.length, 3, 'switching back should automatically retry the queued layout');
  assert.equal(calls[2]!.playerId, secondPlayerId);
  assert.deepEqual(calls[2]!.housing.placements.map((placement: any) =>
    [placement.furnitureId, placement.x, placement.y]).sort(),
  [['starter-chair', 4, 4], ['starter-lamp', 5, 5]]);

  store.placeFurniture('starter-rug', 6, 5);
  await flush();
  assert.equal(calls.length, 3, 'the latest edit should coalesce behind the retry already in flight');
  calls[2]!.resolve();
  await flush();
  assert.equal(calls.length, 4);
  assert.equal(calls[3]!.playerId, secondPlayerId);
  assert.deepEqual(calls[3]!.housing.placements.map((placement: any) =>
    [placement.furnitureId, placement.x, placement.y]).sort(),
  [['starter-chair', 4, 4], ['starter-lamp', 5, 5], ['starter-rug', 6, 5]]);
  calls[3]!.resolve();
  await flush();
  assert.equal(calls.length, 4);
});


test('reactivating an account retries its queued housing layout without requiring another edit', async () => {
  const calls: Array<{ playerId: string; housing: any; resolve: () => void; reject: (error: Error) => void }> = [];
  const store = makeStore((playerId, housing) => new Promise<void>((resolve, reject) => {
    calls.push({ playerId, housing: structuredClone(housing), resolve, reject });
  }));
  const firstPlayerId = store.snapshot.id;

  store.placeFurniture('starter-chair', 2, 2);
  await flush();
  assert.equal(calls.length, 1);
  store.placeFurniture('starter-lamp', 3, 3);

  store.replaceFromServer({ ...store.snapshot, id: 'second-account',
    housing: { inventory: ['starter-chair', 'starter-lamp'], placements: [] } });
  calls[0]!.reject(new Error('temporary network failure'));
  await flush();
  assert.equal(calls.length, 1, 'inactive account writes stay queued');

  store.replaceFromServer({ ...store.snapshot, id: firstPlayerId,
    housing: { inventory: ['starter-bed', 'starter-chair', 'starter-lamp'], placements: [] } });
  await flush();

  assert.equal(calls.length, 2, 'reactivation should retry the queued layout without another edit');
  assert.equal(calls[1]!.playerId, firstPlayerId);
  assert.deepEqual(calls[1]!.housing.placements.map((placement: any) =>
    [placement.furnitureId, placement.x, placement.y]).sort(),
  [['starter-bed', 1, 1], ['starter-chair', 2, 2], ['starter-lamp', 3, 3]]);
  calls[1]!.resolve();
  await flush();
});


test('reactivation during an in-flight housing save retries once if that save fails', async () => {
  const calls: Array<{ playerId: string; housing: any; resolve: () => void; reject: (error: Error) => void }> = [];
  const store = makeStore((playerId, housing) => new Promise<void>((resolve, reject) => {
    calls.push({ playerId, housing: structuredClone(housing), resolve, reject });
  }));
  const firstPlayerId = store.snapshot.id;

  store.placeFurniture('starter-chair', 2, 2);
  await flush();
  assert.equal(calls.length, 1);

  store.replaceFromServer({ ...store.snapshot, id: 'second-account',
    housing: { inventory: ['starter-lamp'], placements: [] } });
  store.replaceFromServer({ ...store.snapshot, id: firstPlayerId,
    housing: { inventory: ['starter-bed', 'starter-chair', 'starter-lamp'], placements: [] } });
  assert.ok(store.snapshot.housing.placements.some((placement: any) =>
    placement.furnitureId === 'starter-chair' && placement.x === 2 && placement.y === 2));

  calls[0]!.reject(new Error('original save failed after reactivation'));
  await flush();
  assert.equal(calls.length, 2, 'reactivation during the in-flight request should permit one retry');
  assert.equal(calls[1]!.playerId, firstPlayerId);
  assert.ok(calls[1]!.housing.placements.some((placement: any) =>
    placement.furnitureId === 'starter-chair' && placement.x === 2 && placement.y === 2));

  calls[1]!.reject(new Error('retry also failed'));
  await flush();
  assert.equal(calls.length, 2, 'a repeated outage must not spin in a tight retry loop');
});


test('corrupt housing outbox layouts are discarded before server bootstrap', async () => {
  const layouts = [
    [
      { instanceId: 'cell-a', furnitureId: 'starter-bed', x: 1, y: 1 },
      { instanceId: 'cell-b', furnitureId: 'starter-chair', x: 1, y: 1 },
    ],
    [
      { instanceId: 'duplicate-id', furnitureId: 'starter-bed', x: 1, y: 1 },
      { instanceId: 'duplicate-id', furnitureId: 'starter-chair', x: 2, y: 2 },
    ],
    Array.from({ length: 49 }, (_, index) => ({
      instanceId: `over-cap-${index}`,
      furnitureId: `furniture-${index}`,
      x: index % 8,
      y: Math.floor(index / 8) % 6,
    })),
  ];
  const serverPlacements = [
    { instanceId: 'server-bed', furnitureId: 'starter-bed', x: 4, y: 4 },
  ];

  for (let index = 0; index < layouts.length; index += 1) {
    const playerId = `browser-corrupt-outbox-${index}`;
    const values = new Map<string, string>();
    const saved: unknown[] = [];
    const localPlayer = {
      id: playerId,
      displayName: 'Player',
      level: 1,
      xp: 0,
      currency: 0,
      degenId: 'test-degen',
      inventory: [],
      unlockedLocations: ['home', 'downtown', 'underpass'],
      housing: {
        inventory: ['starter-bed', 'starter-chair', 'starter-lamp', 'starter-rug'],
        placements: [],
      },
      defeatedBosses: [],
      __housingOutbox: {
        [playerId]: {
          inventory: ['starter-bed', 'starter-chair', 'starter-lamp', 'starter-rug'],
          placements: layouts[index],
        },
      },
    };
    values.set('degen.prototype.player.v2', JSON.stringify(localPlayer));
    const serverPlayer: any = {
      ...localPlayer,
      housing: { ...localPlayer.housing, placements: serverPlacements },
    };
    delete serverPlayer.__housingOutbox;

    const store = makeStore(async (_id, housing) => {
      saved.push(structuredClone(housing));
    }, [], values, async (id) => ({ ...serverPlayer, id }));

    await store.initialize({ displayName: 'Player' });
    await flush();

    assert.deepEqual(store.snapshot.housing.placements, serverPlacements,
      'invalid local outbox must not override the server layout');
    assert.equal(saved.length, 0, 'invalid local outbox must not be replayed to the Worker');
    assert.deepEqual(JSON.parse(values.get('degen.prototype.player.v2')!).__housingOutbox, {},
      'discarding a malformed outbox must persist the cleaned queue');
  }
});

test('failed housing outbox survives reload and retries after server bootstrap', async () => {
  const values = new Map<string, string>();
  const warnings: string[] = [];
  const calls: Array<{ playerId: string; housing: any }> = [];
  let rejectFirst!: (error: Error) => void;
  const first = makeStore((playerId, housing) => new Promise<void>((resolve, reject) => {
    calls.push({ playerId, housing: structuredClone(housing) });
    rejectFirst = reject;
  }), warnings, values);
  const playerId = first.snapshot.id;

  first.placeFurniture('starter-chair', 2, 2);
  await flush();
  assert.equal(calls.length, 1);
  const inFlightStorage = JSON.parse(values.get('degen.prototype.player.v2')!);
  assert.ok(inFlightStorage.__housingOutbox[playerId].placements.some((placement: any) =>
    placement.furnitureId === 'starter-chair' && placement.x === 2 && placement.y === 2),
  'outbox must remain durable while the network request is in flight');

  rejectFirst(new Error('page lost connection'));
  await flush();
  const failedStorage = JSON.parse(values.get('degen.prototype.player.v2')!);
  assert.ok(failedStorage.__housingOutbox[playerId],
    'failed layout must remain in local storage for reload recovery');

  const serverPlayer = {
    id: playerId,
    displayName: 'Player',
    level: 1,
    xp: 0,
    currency: 0,
    degenId: 'test-degen',
    inventory: [],
    unlockedLocations: ['home', 'downtown', 'underpass'],
    housing: {
      inventory: ['starter-bed', 'starter-chair', 'starter-lamp', 'starter-rug'],
      placements: [],
    },
    defeatedBosses: [],
  };
  const restored = makeStore(async (id, housing) => {
    calls.push({ playerId: id, housing: structuredClone(housing) });
  }, warnings, values, async (id) => ({ ...serverPlayer, id }));
  await restored.initialize({ displayName: 'Player' });
  await flush();

  assert.ok(restored.snapshot.housing.placements.some((placement: any) =>
    placement.furnitureId === 'starter-chair' && placement.x === 2 && placement.y === 2),
  'bootstrap must preserve the locally queued layout rather than overwrite it with the older server snapshot');
  assert.equal(calls.length, 2, 'the queued layout should be retried after bootstrap');
  assert.equal(calls[1]!.playerId, playerId);
  assert.ok(calls[1]!.housing.placements.some((placement: any) =>
    placement.furnitureId === 'starter-chair' && placement.x === 2 && placement.y === 2));
  const settledStorage = JSON.parse(values.get('degen.prototype.player.v2')!);
  assert.deepEqual(settledStorage.__housingOutbox, {},
    'outbox entry should clear only after the server confirms the save');
});


test('corrupt active housing state cannot override a valid queued snapshot during bootstrap', async () => {
  const playerId = 'corrupt-active-housing-with-valid-outbox';
  const inventory = ['starter-bed', 'starter-chair', 'starter-lamp', 'starter-rug'];
  const corruptedPlacements = [
    { instanceId: 'duplicate-id', furnitureId: 'starter-bed', x: 1, y: 1 },
    { instanceId: 'duplicate-id', furnitureId: 'starter-chair', x: 2, y: 2 },
  ];
  const queuedHousing = {
    inventory,
    placements: [
      { instanceId: 'queued-bed', furnitureId: 'starter-bed', x: 1, y: 1 },
      { instanceId: 'queued-chair', furnitureId: 'starter-chair', x: 2, y: 2 },
    ],
  };
  const values = new Map<string, string>();
  const saved: Array<{ playerId: string; housing: any }> = [];
  const localPlayer = {
    id: playerId,
    displayName: 'Player',
    level: 1,
    xp: 0,
    currency: 0,
    degenId: 'test-degen',
    inventory: [],
    unlockedLocations: ['home', 'downtown', 'underpass'],
    housing: { inventory, placements: corruptedPlacements },
    defeatedBosses: [],
  };
  values.set('degen.prototype.player.v2', JSON.stringify({
    ...localPlayer,
    __housingOutbox: { [playerId]: queuedHousing },
  }));
  const serverPlayer = {
    ...localPlayer,
    housing: { inventory, placements: [
      { instanceId: 'server-bed', furnitureId: 'starter-bed', x: 4, y: 4 },
    ] },
  };
  const store = makeStore(async (id, housing) => {
    saved.push({ playerId: id, housing: structuredClone(housing) });
  }, [], values, async (id) => ({ ...serverPlayer, id }));

  await store.initialize({ displayName: 'Player' });
  await flush();

  assert.deepEqual(store.snapshot.housing.placements, queuedHousing.placements,
    'only the structurally valid queued snapshot may preserve unsaved edits');
  assert.equal(saved.length, 1, 'the valid queued snapshot should be retried once');
  assert.equal(saved[0]!.playerId, playerId);
  assert.deepEqual(saved[0]!.housing.placements, queuedHousing.placements);
});

test('corrupt active housing state cannot be edited or saved before bootstrap', async () => {
  const playerId = 'corrupt-active-housing-no-outbox';
  const inventory = ['starter-bed', 'starter-chair', 'starter-lamp', 'starter-rug'];
  const corruptedPlacements = [
    { instanceId: 'duplicate-cell-a', furnitureId: 'starter-bed', x: 1, y: 1 },
    { instanceId: 'duplicate-cell-b', furnitureId: 'starter-chair', x: 1, y: 1 },
  ];
  const values = new Map<string, string>();
  const saved: unknown[] = [];
  const localPlayer = {
    id: playerId,
    displayName: 'Player',
    level: 1,
    xp: 0,
    currency: 0,
    degenId: 'test-degen',
    inventory: [],
    unlockedLocations: ['home', 'downtown', 'underpass'],
    housing: { inventory, placements: corruptedPlacements },
    defeatedBosses: [],
  };
  values.set('degen.prototype.player.v2', JSON.stringify(localPlayer));
  const serverPlacements = [
    { instanceId: 'server-chair', furnitureId: 'starter-chair', x: 3, y: 3 },
  ];
  const store = makeStore(async (_id, housing) => {
    saved.push(structuredClone(housing));
  }, [], values);

  store.placeFurniture('starter-lamp', 2, 2);
  store.removeFurnitureAt(1, 1);
  await flush();
  assert.equal(saved.length, 0, 'malformed local state must never be submitted to the Worker');
  assert.deepEqual(store.snapshot.housing.placements, [
    { instanceId: 'starter-bed-placed', furnitureId: 'starter-bed', x: 1, y: 1 },
  ], 'corrupt persisted placements are replaced with a safe placeholder');
  assert.notDeepEqual(store.snapshot.housing.placements, corruptedPlacements,
    'housing edits remain blocked until an authoritative bootstrap repairs the layout');

  await store.initialize({ displayName: 'Player' });
  // The default bootstrap mock returns undefined, so install server state through
  // the same public reconciliation method used by the real API response.
  store.replaceFromServer({
    ...localPlayer,
    housing: { inventory, placements: serverPlacements },
  } as any);
  assert.deepEqual(store.snapshot.housing.placements, serverPlacements,
    'the server layout replaces corrupt local state when no valid outbox exists');
  assert.equal(saved.length, 0);
});


test('null persisted housing cannot crash the home view or save before bootstrap', async () => {
  const playerId = 'corrupt-null-housing';
  const values = new Map<string, string>();
  const saved: unknown[] = [];
  values.set('degen.prototype.player.v2', JSON.stringify({
    id: playerId,
    displayName: 'Player',
    level: 1,
    xp: 0,
    currency: 0,
    degenId: 'test-degen',
    inventory: [],
    unlockedLocations: ['home', 'downtown', 'underpass'],
    housing: null,
    defeatedBosses: [],
  }));
  const store = makeStore(async (_id, housing) => {
    saved.push(structuredClone(housing));
  }, [], values);

  assert.doesNotThrow(() => structuredClone(store.snapshot.housing),
    'the store must expose a structurally safe room even before bootstrap');
  assert.ok(Array.isArray(store.snapshot.housing.inventory));
  assert.ok(Array.isArray(store.snapshot.housing.placements));
  store.placeFurniture('starter-chair', 2, 2);
  store.removeFurnitureAt(1, 1);
  await flush();
  assert.equal(saved.length, 0, 'the placeholder must not overwrite server-owned housing');

  const serverPlacements = [
    { instanceId: 'server-chair', furnitureId: 'starter-chair', x: 3, y: 3 },
  ];
  store.replaceFromServer({
    ...store.snapshot,
    housing: { inventory: ['starter-bed', 'starter-chair'], placements: serverPlacements },
  });
  assert.deepEqual(store.snapshot.housing.placements, serverPlacements);
  store.placeFurniture('starter-chair', 4, 4);
  await flush();
  assert.equal(saved.length, 1, 'housing edits resume after authoritative bootstrap');
  assert.ok((saved[0] as any).placements.some((p: any) => p.x === 4 && p.y === 4));
});


test('offline preview remains editable after corrupt housing is normalized', async () => {
  const values = new Map<string, string>();
  values.set('degen.prototype.player.v2', JSON.stringify({
    id: 'offline-corrupt-housing',
    displayName: 'Player',
    level: 1,
    xp: 0,
    currency: 0,
    degenId: 'test-degen',
    inventory: [],
    unlockedLocations: ['home', 'downtown', 'underpass'],
    housing: null,
    defeatedBosses: [],
  }));
  const store = makeStore(async () => {
    throw new Error('disabled API should not submit housing');
  }, [], values, async () => undefined, undefined, false);

  assert.ok(Array.isArray(store.snapshot.housing.placements),
    'corrupt local state is normalized before the view renders');
  store.placeFurniture('starter-chair', 2, 2);
  await flush();
  assert.ok(store.snapshot.housing.placements.some((p: any) =>
    p.furnitureId === 'starter-chair' && p.x === 2 && p.y === 2),
  'local preview housing should remain usable without an authoritative backend');
  assert.deepEqual(JSON.parse(values.get('degen.prototype.player.v2')!).__housingOutbox, {},
    'disabled preview saves should not leave a retry queue');
});


test('server-backed housing bootstrap requirement survives reload', async () => {
  const playerId = 'corrupt-room-bootstrap-marker';
  const values = new Map<string, string>();
  values.set('degen.prototype.player.v2', JSON.stringify({
    id: playerId,
    displayName: 'Player',
    level: 1,
    xp: 0,
    currency: 0,
    degenId: 'test-degen',
    inventory: [],
    unlockedLocations: ['home', 'downtown', 'underpass'],
    housing: null,
    defeatedBosses: [],
  }));
  const first = makeStore(async () => undefined, [], values, async () => undefined, undefined, true);
  await first.initialize({ displayName: 'Miles' });
  assert.equal(JSON.parse(values.get('degen.prototype.player.v2')!).__housingNeedsBootstrap, true,
    'normalizing local state must persist the fact that the room still needs server authority');

  const saved: unknown[] = [];
  const restored = makeStore(async (_id, housing) => { saved.push(structuredClone(housing)); },
    [], values, async () => undefined, undefined, true);
  restored.placeFurniture('starter-chair', 2, 2);
  await flush();
  assert.equal(saved.length, 0, 'a reload must not turn the safe placeholder into a server save');

  restored.replaceFromServer({
    ...restored.snapshot,
    housing: { inventory: ['starter-bed', 'starter-chair'], placements: [] },
  });
  restored.placeFurniture('starter-chair', 2, 2);
  await flush();
  assert.equal(saved.length, 1, 'server bootstrap should clear the guard and allow housing edits');
  assert.equal(JSON.parse(values.get('degen.prototype.player.v2')!).__housingNeedsBootstrap, undefined);
});
