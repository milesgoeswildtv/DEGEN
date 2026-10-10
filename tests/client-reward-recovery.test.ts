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

const setup = (enabled: boolean, completeUnderpass?: () => Promise<unknown>) => {
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
    completeUnderpass: completeUnderpass ?? (async () => ({ player: { id: 'test-player' }, worldEvent: {} })),
    getUnderpass: async () => ({}),
  };
  const root = { innerHTML: '', querySelectorAll: () => [] };
  const scope = {
    window: {
      setTimeout: (callback: () => void, delay: number) => { timers.push({ callback, delay }); return timers.length; },
      clearTimeout: () => {},
      setInterval: () => 1,
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
    },
    console: { warn: () => {} },
    mapView: () => '', homeView: () => '', underpassView: () => '', battleView: () => '',
    getPreviewUnderpass: () => ({}),
    recordPreviewClear: () => 0,
    underpassRewardForClear: () => ({ xp: 75, currency: 30, items: [] }),
    TUNNEL_MAW: { id: 'tunnel-maw' },
  };
  const Controller = runInNewContext(compiled + '\nAppController;', scope) as new (
    root: unknown, store: unknown, api: unknown
  ) => { route: string; battlePermit?: { permitId: string }; finishBattle(status: string): Promise<void>; start(): Promise<void> };
  return { Controller, root, store, api, storage, timers };
};

test('failed Worker completion retains the permit and persists retry across controller restart', async () => {
  let attempts = 0;
  const fixture = setup(true, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('transient D1 failure');
    return { player: { id: 'test-player' }, worldEvent: {} };
  });
  const first = new fixture.Controller(fixture.root, fixture.store, fixture.api);
  first.battlePermit = { permitId: 'permit-1' };
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

test('successful Worker completion returns from victory only after authoritative reward', async () => {
  const fixture = setup(true);
  const controller = new fixture.Controller(fixture.root, fixture.store, fixture.api);
  controller.battlePermit = { permitId: 'permit-2' };
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
  await controller.finishBattle('victory');
  assert.equal(fixture.store.localRewards, 1);
  assert.equal(fixture.store.replaced, 0);
});
