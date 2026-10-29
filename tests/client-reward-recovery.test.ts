import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

// Execute the real controller source with mocked browser/API dependencies.
// No Worker or browser rendering is implied by this deterministic unit test.
const controllerSource = readFileSync(new URL('../src/app/AppController.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '')
  .replace('export class AppController', 'class AppController');
const compiled = stripTypeScriptTypes(controllerSource, { mode: 'transform' });

class TestGameApiError extends Error {
  constructor(readonly status: number, readonly payload: unknown, message: string) {
    super(message);
  }
}

const setup = (
  enabled: boolean,
  completeUnderpass?: (playerId: string, permitId: string) => Promise<unknown>,
  getPendingBattleRewards?: (playerId: string) => Promise<string[]>,
  storageUnavailable = false,
) => {
  const storage = new Map<string, string>();
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const store = {
    snapshot: { id: 'test-player' },
    replaced: 0,
    localRewards: 0,
    replaceFromServer() { this.replaced += 1; },
    applyReward() { this.localRewards += 1; },
    markBossDefeated() {},
  };
  const api = {
    enabled,
    completeUnderpass: completeUnderpass ?? (async () => ({ player: {}, worldEvent: {} })),
    getUnderpass: async () => ({}),
    getPendingBattleRewards: getPendingBattleRewards ?? (async () => []),
  };
  const root = { innerHTML: '', querySelectorAll: () => [] };
  const scope = {
    window: {
      setTimeout: (callback: () => void, delay: number) => { timers.push({ callback, delay }); return timers.length; },
      clearTimeout: () => {},
      setInterval: () => 1,
    },
    localStorage: {
      getItem: (key: string) => {
        if (storageUnavailable) throw new Error('localStorage unavailable');
        return storage.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (storageUnavailable) throw new Error('localStorage unavailable');
        storage.set(key, value);
      },
    },
    console: { warn: () => {} },
    GameApiError: TestGameApiError,
    mapView: () => '', homeView: () => '', underpassView: () => '', battleView: () => '',
    getPreviewUnderpass: () => ({}),
    recordPreviewClear: () => 0,
    underpassRewardForClear: () => ({ xp: 75, currency: 30, items: [] }),
    TUNNEL_MAW: { id: 'tunnel-maw' },
  };
  const Controller = runInNewContext(compiled + '\nAppController;', scope) as new (
    root: unknown, store: unknown, api: unknown
  ) => { route: string; battlePermit?: { permitId: string }; battlePermitOwnerId?: string; finishBattle(status: string): Promise<void>; start(): Promise<void> };
  return { Controller, root, store, api, storage, timers };
};

test('failed Worker completion retains the permit and persists retry across controller restart', async () => {
  let attempts = 0;
  const fixture = setup(true, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('transient D1 failure');
    return { player: {}, worldEvent: {} };
  });
  const first = new fixture.Controller(fixture.root, fixture.store, fixture.api);
  first.battlePermit = { permitId: 'permit-1' };
  first.battlePermitOwnerId = 'test-player';
  await first.finishBattle('victory');
  assert.equal(first.battlePermit?.permitId, 'permit-1');
  assert.equal(fixture.storage.get('degen.pending.reward-permits.v1:test-player'), '["permit-1"]');
  assert.ok(fixture.timers.some((timer) => timer.delay === 15_000));
  assert.equal(fixture.store.localRewards, 0);

  const restored = new fixture.Controller(fixture.root, fixture.store, fixture.api);
  await restored.start();
  // start() schedules recovery without awaiting it.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 2);
  assert.equal(fixture.store.replaced, 1);
  assert.equal(fixture.storage.get('degen.pending.reward-permits.v1:test-player'), '[]');
  assert.equal(fixture.store.localRewards, 0);
});

test('server-discovered victory recovery retries a transient lookup failure without localStorage', async () => {
  let attempts = 0;
  let discoveries = 0;
  let discoveredFor = '';
  const fixture = setup(
    true,
    async (playerId, permitId) => {
      attempts += 1;
      assert.equal(playerId, 'test-player');
      assert.equal(permitId, 'server-only-permit');
      return { player: { id: playerId }, worldEvent: {} };
    },
    async (playerId) => {
      discoveries += 1;
      discoveredFor = playerId;
      if (discoveries === 1) throw new Error('transient D1 failure');
      return ['server-only-permit'];
    },
    true,
  );
  const controller = new fixture.Controller(fixture.root, fixture.store, fixture.api);
  await controller.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(discoveries, 1);
  const retry = fixture.timers.find((timer) => timer.delay === 15_000);
  assert.ok(retry, 'transient discovery failure must schedule a bounded-delay retry');
  retry.callback();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(discoveredFor, 'test-player');
  assert.equal(discoveries, 2, 'the server discovery query must retry after a transient failure');
  assert.equal(attempts, 1, 'the server-discovered permit must be completed exactly once');
  assert.equal(fixture.store.replaced, 1, 'only the authoritative completion snapshot is applied');
  assert.equal(fixture.store.localRewards, 0, 'recovery never computes or grants client rewards');
});

test('successful Worker completion returns from victory only after authoritative reward', async () => {
  const fixture = setup(true);
  const controller = new fixture.Controller(fixture.root, fixture.store, fixture.api);
  controller.battlePermit = { permitId: 'permit-2' };
  controller.battlePermitOwnerId = 'test-player';
  controller.route = 'battle';
  await controller.finishBattle('victory');
  assert.equal(controller.battlePermit, undefined);
  assert.equal(fixture.store.replaced, 1);
  assert.equal(fixture.store.localRewards, 0);
  assert.ok(fixture.timers.some((timer) => timer.delay === 1400));
});

test('offline preview still applies its local non-economic reward', async () => {
  const fixture = setup(false);
  const controller = new fixture.Controller(fixture.root, fixture.store, fixture.api);
  controller.battlePermit = { permitId: 'preview' };
  controller.battlePermitOwnerId = 'test-player';
  await controller.finishBattle('victory');
  assert.equal(fixture.store.localRewards, 1);
  assert.equal(fixture.store.replaced, 0);
});


test('a completion already in flight cannot replace a switched account', async () => {
  let resolveCompletion!: (value: unknown) => void;
  const completionResponse = new Promise<unknown>((resolve) => { resolveCompletion = resolve; });
  let requestedPlayerId = '';
  let requestedPermitId = '';
  const fixture = setup(true, async (playerId, permitId) => {
    requestedPlayerId = playerId;
    requestedPermitId = permitId;
    return completionResponse;
  });
  const controller = new fixture.Controller(fixture.root, fixture.store, fixture.api);
  controller.battlePermit = { permitId: 'permit-in-flight' };
  controller.battlePermitOwnerId = 'test-player';
  controller.route = 'battle';

  const finishing = controller.finishBattle('victory');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requestedPlayerId, 'test-player');
  assert.equal(requestedPermitId, 'permit-in-flight');

  fixture.store.snapshot.id = 'new-player';
  resolveCompletion({ player: { id: 'test-player', level: 2 }, worldEvent: { cycleId: 'cycle-1' } });
  await finishing;

  assert.equal(fixture.store.snapshot.id, 'new-player');
  assert.equal(fixture.store.replaced, 0, 'a late completion must not overwrite the new account with the old player snapshot');
  assert.equal(fixture.store.localRewards, 0, 'completion remains Worker-owned');
  assert.equal(fixture.storage.get('degen.pending.reward-permits.v1:test-player'), '[]',
    'the original account’s retry record is cleared after authoritative completion');
  assert.equal(fixture.storage.get('degen.pending.reward-permits.v1:new-player'), undefined,
    'the original permit never enters the new account’s retry queue');
  assert.equal(controller.battlePermit, undefined, 'the completed old permit is cleared without changing the active account');
});
