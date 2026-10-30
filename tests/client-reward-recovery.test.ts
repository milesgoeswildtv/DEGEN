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
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, payload: unknown, message: string) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

class TestGameApiProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GameApiProtocolError';
  }
}

const setup = (
  enabled: boolean,
  completeUnderpass?: (playerId: string, permitId: string) => Promise<unknown>,
  getPendingBattleRewards?: (playerId: string) => Promise<string[]>,
  storageUnavailable = false,
) => {
  const storage = new Map<string, string>();
  const timers: Array<{ callback: () => void; delay: number; id: number; cancelled: boolean }> = [];
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
      setTimeout: (callback: () => void, delay: number) => {
        const id = timers.length + 1;
        timers.push({ callback, delay, id, cancelled: false });
        return id;
      },
      clearTimeout: (id: number) => {
        const timer = timers.find((candidate) => candidate.id === id);
        if (timer) timer.cancelled = true;
      },
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
    GameApiProtocolError: TestGameApiProtocolError,
    mapView: () => '', districtView: () => '', locationView: () => '', homeView: () => '', underpassView: () => '', battleView: () => '',
    bindCityViewport: () => undefined,
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

test('definitive reward rejection retains the permit without an endless retry timer', async () => {
  const fixture = setup(true, async () => {
    throw new TestGameApiError(
      409,
      { error: 'Battle terminal history marker conflicts with reward settlement.' },
      'Battle terminal history marker conflicts with reward settlement.',
    );
  });
  const controller = new fixture.Controller(fixture.root, fixture.store, fixture.api);
  controller.battlePermit = { permitId: 'permit-poisoned' };
  controller.battlePermitOwnerId = 'test-player';

  await controller.finishBattle('victory');

  assert.equal(controller.battlePermit?.permitId, 'permit-poisoned',
    'do not discard the permit when a definitive conflict needs data repair');
  assert.equal(fixture.storage.get('degen.pending.reward-permits.v1:test-player'), '["permit-poisoned"]',
    'retain the identifier for a future reload or server-discovery pass');
  assert.equal(fixture.timers.filter((timer) => timer.delay === 15_000).length, 0,
    'a permanent terminal-history conflict must not schedule a retry loop');
  assert.equal(fixture.store.localRewards, 0, 'the client never fabricates a reward');
});

test('retryable reward claim conflicts still schedule recovery', async () => {
  const fixture = setup(true, async () => {
    throw new TestGameApiError(409, { error: 'Reward claim changed; retry.' }, 'Reward claim changed; retry.');
  });
  const controller = new fixture.Controller(fixture.root, fixture.store, fixture.api);
  controller.battlePermit = { permitId: 'permit-retryable-claim' };
  controller.battlePermitOwnerId = 'test-player';

  await controller.finishBattle('victory');

  assert.ok(fixture.timers.some((timer) => timer.delay === 15_000),
    'a Worker conflict explicitly marked retryable must continue bounded recovery');
  assert.equal(fixture.store.localRewards, 0);
});

test('duplicate victory notifications share one in-flight Worker completion', async () => {
  let resolveCompletion!: (value: unknown) => void;
  let attempts = 0;
  const completionResponse = new Promise<unknown>((resolve) => { resolveCompletion = resolve; });
  const fixture = setup(true, async () => {
    attempts += 1;
    return completionResponse;
  });
  const controller = new fixture.Controller(fixture.root, fixture.store, fixture.api);
  controller.battlePermit = { permitId: 'permit-duplicate-notification' };
  controller.battlePermitOwnerId = 'test-player';
  controller.route = 'battle';

  const first = controller.finishBattle('victory');
  const second = controller.finishBattle('victory');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1, 'duplicate finish/recovery notifications must coalesce before reaching the Worker');

  resolveCompletion({ player: { id: 'test-player', level: 2 }, worldEvent: { cycleId: 'cycle-1' } });
  await Promise.all([first, second]);

  assert.equal(attempts, 1);
  assert.equal(fixture.store.replaced, 1, 'only one authoritative player snapshot is applied');
  assert.equal(fixture.store.localRewards, 0, 'deduplication never moves reward authority to the client');
  assert.equal(fixture.timers.filter((timer) => timer.delay === 15_000 && !timer.cancelled).length, 0);
  assert.equal(controller.battlePermit, undefined);
});

test('successful manual reward retry cancels the existing automatic retry timer', async () => {
  let attempts = 0;
  const fixture = setup(true, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('temporary network failure');
    return { player: { id: 'test-player', level: 2 }, worldEvent: {} };
  });
  const controller = new fixture.Controller(fixture.root, fixture.store, fixture.api);
  controller.battlePermit = { permitId: 'permit-manual-retry' };
  controller.battlePermitOwnerId = 'test-player';

  await controller.finishBattle('victory');
  const retry = fixture.timers.find((timer) => timer.delay === 15_000);
  assert.ok(retry);
  assert.equal(retry.cancelled, false);

  await controller.finishBattle('victory');
  assert.equal(attempts, 2);
  assert.equal(retry.cancelled, true, 'successful completion must cancel its stale scheduled retry');
  assert.equal(fixture.timers.filter((timer) => timer.delay === 15_000 && !timer.cancelled).length, 0);
  assert.equal(fixture.store.replaced, 1);
  assert.equal(fixture.store.localRewards, 0);
});

test('duplicate failed reward notifications create only one automatic retry timer', async () => {
  let attempts = 0;
  const fixture = setup(true, async () => {
    attempts += 1;
    throw new Error('temporary network failure');
  });
  const controller = new fixture.Controller(fixture.root, fixture.store, fixture.api);
  controller.battlePermit = { permitId: 'permit-duplicate-retry' };
  controller.battlePermitOwnerId = 'test-player';

  await Promise.all([
    controller.finishBattle('victory'),
    controller.finishBattle('victory'),
  ]);

  assert.equal(attempts, 1, 'same-permit failures are coalesced while in flight');
  assert.equal(fixture.timers.filter((timer) => timer.delay === 15_000 && !timer.cancelled).length, 1,
    'one permit must have at most one scheduled retry');
  assert.equal(controller.battlePermit?.permitId, 'permit-duplicate-retry');
  assert.equal(fixture.store.localRewards, 0);
});

test('server-discovered victory recovery retries a not-yet-deployed endpoint without localStorage', async () => {
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
      if (discoveries === 1) {
        throw new TestGameApiError(404, { error: 'Not found' }, 'pending-reward route is not deployed yet');
      }
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


test('malformed server reward discovery response is not retried as a transient failure', async () => {
  let discoveries = 0;
  const fixture = setup(true, undefined, async () => {
    discoveries += 1;
    throw new TestGameApiProtocolError('Malformed pending battle reward response.');
  });
  const controller = new fixture.Controller(fixture.root, fixture.store, fixture.api);
  await (controller as any).discoverPendingBattleRewards('test-player');

  assert.equal(discoveries, 1);
  assert.equal(fixture.timers.filter((timer) => timer.delay === 15_000 && !timer.cancelled).length, 0,
    'a malformed authoritative response must not create an endless discovery loop');
});

test('malformed reward completion response retains the permit without a retry loop', async () => {
  const fixture = setup(true, async () => {
    throw new TestGameApiProtocolError('Malformed authoritative battle completion response.');
  });
  const controller = new fixture.Controller(fixture.root, fixture.store, fixture.api);
  controller.battlePermit = { permitId: 'permit-malformed-completion' };
  controller.battlePermitOwnerId = 'test-player';

  await controller.finishBattle('victory');

  assert.equal(controller.battlePermit?.permitId, 'permit-malformed-completion',
    'keep the permit for later repair/recovery rather than discard the identifier');
  assert.equal(fixture.timers.filter((timer) => timer.delay === 15_000 && !timer.cancelled).length, 0,
    'a malformed authoritative receipt must not retry forever');
  assert.equal(fixture.store.localRewards, 0, 'the client never fabricates rewards');
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
