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
