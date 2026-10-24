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

function makeStore(saveHousing: (id: string, housing: unknown) => Promise<void>, warnings: string[] = []) {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  const Store = runInNewContext(compiled + '\nPlayerStore;', {
    localStorage: storage, structuredClone, crypto: webcrypto,
    console: { warn: (...args: unknown[]) => warnings.push(args.join(' ')) },
    advanceLevel: () => ({ level: 1, xp: 0 }),
  }) as new (api: unknown) => {
    placeFurniture(item: string, x: number, y: number): void;
    removeFurnitureAt(x: number, y: number): void;
    readonly snapshot: any;
    replaceFromServer(player: any): void;
  };
  return new Store({ enabled: true, saveHousing });
}

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
  store.placeFurniture('starter-rug', 6, 6);

  calls[0]!.resolve();
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.playerId, firstPlayerId,
    'the queue must not send the second account snapshot with the first account active');
  assert.deepEqual(calls[1]!.housing.placements.map((placement: any) =>
    [placement.furnitureId, placement.x, placement.y]).sort(),
  [['starter-bed', 1, 1], ['starter-chair', 2, 2], ['starter-lamp', 3, 3], ['starter-rug', 6, 6]]);
  calls[1]!.resolve();
  await flush();
  assert.equal(calls.length, 2, 'the second account snapshot stays queued while the first account is active');

  store.replaceFromServer({ ...store.snapshot, id: secondPlayerId,
    housing: { inventory: furniture, placements: [] } });
  assert.deepEqual(store.snapshot.housing.placements.map((placement: any) =>
    [placement.furnitureId, placement.x, placement.y]).sort(),
  [['starter-chair', 4, 4], ['starter-lamp', 5, 5]],
  'the second account must retain its own queued layout');
  store.placeFurniture('starter-rug', 6, 6);
  await flush();
  assert.equal(calls.length, 3);
  assert.equal(calls[2]!.playerId, secondPlayerId);
  assert.deepEqual(calls[2]!.housing.placements.map((placement: any) =>
    [placement.furnitureId, placement.x, placement.y]).sort(),
  [['starter-chair', 4, 4], ['starter-lamp', 5, 5], ['starter-rug', 6, 6]]);
  calls[2]!.resolve();
  await flush();
  assert.equal(calls.length, 3);
});
