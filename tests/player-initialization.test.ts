import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const storage = new Map<string, string>();
const localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
};

const source = readFileSync(new URL('../src/app/state.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/\bexport class /g, 'class ');
const { PlayerStore } = runInNewContext(
  stripTypeScriptTypes(source, { mode: 'transform' }) + '\n({ PlayerStore });',
  {
    advanceLevel: (level: number, xp: number, rewardXp: number) => ({ level, xp: xp + rewardXp }),
    localStorage,
    crypto: globalThis.crypto,
    structuredClone: globalThis.structuredClone,
    console: { warn: () => {} },
  },
) as {
  PlayerStore: new (api: unknown) => {
    initialize(identity: { platform: 'browser'; platformUserId: string; displayName: string }): Promise<boolean>;
    snapshot: { id: string; level: number; currency: number };
    replaceFromServer(player: any): void;
  };
};

const identity = { platform: 'browser' as const, platformUserId: 'local-dev', displayName: 'Player' };

const playerSnapshot = (id: string, level: number, currency: number) => ({
  id,
  displayName: 'Server Player',
  level,
  xp: 0,
  currency,
  degenId: 'test-degen',
  inventory: [],
  unlockedLocations: ['home'],
  housing: { inventory: ['starter-bed'], placements: [] },
  defeatedBosses: [],
});

test('late bootstrap cannot replace a newer active account snapshot', async () => {
  storage.clear();
  let resolveBootstrap!: (player: any) => void;
  let requestedPlayerId = '';
  const store = new PlayerStore({
    enabled: true,
    bootstrap(playerId: string) {
      requestedPlayerId = playerId;
      return new Promise((resolve) => { resolveBootstrap = resolve; });
    },
  });
  const originalPlayerId = store.snapshot.id;
  const pendingInitialization = store.initialize(identity);
  assert.equal(requestedPlayerId, originalPlayerId);

  store.replaceFromServer(playerSnapshot('second-account', 9, 90));
  resolveBootstrap(playerSnapshot(originalPlayerId, 2, 20));

  assert.equal(await pendingInitialization, true, 'the Worker was reachable even though its stale snapshot was ignored');
  assert.deepEqual(
    [store.snapshot.id, store.snapshot.level, store.snapshot.currency],
    ['second-account', 9, 90],
    'a late bootstrap must not replace the account that became active while it was pending',
  );
});

test('late bootstrap cannot overwrite the latest snapshot after an A-to-B-to-A account switch', async () => {
  storage.clear();
  let resolveBootstrap!: (player: any) => void;
  const store = new PlayerStore({
    enabled: true,
    bootstrap(playerId: string) {
      return new Promise((resolve) => { resolveBootstrap = resolve; });
    },
  });
  const originalPlayerId = store.snapshot.id;
  const pendingInitialization = store.initialize(identity);

  store.replaceFromServer(playerSnapshot('second-account', 4, 40));
  store.replaceFromServer(playerSnapshot(originalPlayerId, 8, 80));
  resolveBootstrap(playerSnapshot(originalPlayerId, 2, 20));

  assert.equal(await pendingInitialization, true);
  assert.deepEqual(
    [store.snapshot.id, store.snapshot.level, store.snapshot.currency],
    [originalPlayerId, 8, 80],
    'an older response for the same player ID must not win after the account switched away and back',
  );
});


test('server-backed initialization reports success only after an authoritative player snapshot', async () => {
  storage.clear();
  let requestedPlayerId = '';
  const api = {
    enabled: true,
    async bootstrap(playerId: string) {
      requestedPlayerId = playerId;
      return {
        id: playerId,
        displayName: 'Server Player',
        level: 4,
        xp: 12,
        currency: 30,
        degenId: 'test-degen',
        inventory: [],
        unlockedLocations: ['home'],
        housing: { inventory: ['starter-bed'], placements: [] },
        defeatedBosses: [],
      };
    },
  };
  const store = new PlayerStore(api);
  assert.equal(await store.initialize(identity), true);
  assert.equal(requestedPlayerId, store.snapshot.id);
  assert.equal(store.snapshot.level, 4);
  assert.equal(store.snapshot.currency, 30);
});

test('server-backed initialization reports failure when bootstrap rejects', async () => {
  storage.clear();
  const store = new PlayerStore({
    enabled: true,
    async bootstrap() { throw new Error('Worker unavailable'); },
  });
  assert.equal(await store.initialize(identity), false);
});

test('offline preview initialization succeeds without calling the Worker', async () => {
  storage.clear();
  let calls = 0;
  const store = new PlayerStore({
    enabled: false,
    async bootstrap() { calls += 1; return undefined; },
  });
  assert.equal(await store.initialize(identity), true);
  assert.equal(calls, 0);
});
