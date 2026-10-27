import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';
import { BattleEngine } from '../src/game/combat/engine.ts';

class TestGameApiError extends Error {
  constructor(readonly status: number, readonly payload: unknown, message: string) {
    super(message);
  }
}

const source = readFileSync(new URL('../src/app/AppController.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/\bexport class AppController\b/g, 'class AppController');

const isAuthoritativeBattleActionState = (value: unknown, permitId: string): value is {
  permitId: string;
  status: 'active' | 'victory' | 'defeat';
  playerHp: number;
  playerMana: number;
  enemyHp: number;
  turnCount: number;
} => {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  return state.permitId === permitId
    && (state.status === 'active' || state.status === 'victory' || state.status === 'defeat')
    && Number.isSafeInteger(state.playerHp)
    && Number.isSafeInteger(state.playerMana)
    && Number.isSafeInteger(state.enemyHp)
    && Number.isSafeInteger(state.turnCount);
};

const timers: Array<{ callback: () => void; delay: number }> = [];
const storage = new Map<string, string>();
const root = {
  innerHTML: '',
  querySelectorAll: (_selector: string) => [] as Array<{ dataset: Record<string, string>; disabled: boolean }>,
};
const scope = {
  TEST_DEGEN,
  TUNNEL_MAW,
  BattleEngine,
  GameApiError: TestGameApiError,
  isAuthoritativeBattleActionState,
  createBattleGame: () => ({ destroy: () => {} }),
  underpassRewardForClear: () => ({ xp: 0, currency: 0, items: [] }),
  battleView: () => '',
  homeView: () => '',
  mapView: () => '',
  underpassView: () => '',
  updateBattleDom: () => {},
  createPreviewPermit: () => ({}),
  getPreviewUnderpass: () => ({}),
  recordPreviewClear: () => 0,
  window: {
    setTimeout: (callback: () => void, delay: number) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeout: () => {},
    setInterval: () => 1,
  },
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  },
  console: { warn: () => {} },
};

const AppController = runInNewContext(
  stripTypeScriptTypes(source, { mode: 'transform' }) + '\nAppController;',
  scope,
) as new (
  root: typeof root,
  store: {
    snapshot: { id: string };
    replaced: number;
    localRewards: number;
    replaceFromServer(player: unknown): void;
    applyReward(reward: unknown): void;
    markBossDefeated(bossId: string): void;
  },
  api: {
    enabled: boolean;
    actUnderpass(...args: unknown[]): Promise<unknown>;
    completeUnderpass(permitId: string): Promise<{ player: unknown; worldEvent: unknown }>;
  },
) => {
  route: string;
  battlePermit?: { permitId: string };
  battleEngine?: BattleEngine;
  useBattleAbility(abilityId: string): Promise<void>;
};

test('lost action response followed by authoritative victory snapshot completes rewards once', async () => {
  timers.length = 0;
  storage.clear();

  const store = {
    snapshot: { id: 'player-1' },
    replaced: 0,
    localRewards: 0,
    replaceFromServer(_player: unknown) { this.replaced += 1; },
    applyReward(_reward: unknown) { this.localRewards += 1; },
    markBossDefeated(_bossId: string) {},
  };
  const authoritativeVictory = {
    permitId: 'permit-1',
    status: 'victory' as const,
    playerHp: 80,
    playerMana: 4,
    enemyHp: 0,
    turnCount: 1,
  };
  let actionCalls = 0;
  let completionCalls = 0;
  const api = {
    enabled: true,
    async actUnderpass() {
      actionCalls += 1;
      throw new TestGameApiError(409, {
        error: 'Stale battle turn.',
        battleState: authoritativeVictory,
      }, 'DEGEN API 409');
    },
    async completeUnderpass(permitId: string) {
      completionCalls += 1;
      assert.equal(permitId, 'permit-1');
      return { player: { id: 'player-1', level: 2 }, worldEvent: { cycleId: 'cycle-1' } };
    },
  };

  let terminalCallbacks = 0;
  let controller!: InstanceType<typeof AppController>;
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, (status) => {
    terminalCallbacks += 1;
    void controller['finishBattle'](status);
  }, {
    permitId: 'permit-1',
    status: 'active',
    playerHp: 100,
    playerMana: 8,
    enemyHp: TUNNEL_MAW.maxHp,
    turnCount: 0,
  });

  controller = new AppController(root, store, api);
  controller.route = 'battle';
  controller.battlePermit = { permitId: 'permit-1' };
  controller.battleEngine = engine;

  await controller.useBattleAbility('crack');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(actionCalls, 1);
  assert.equal(engine.snapshot.status, 'victory');
  assert.equal(engine.snapshot.playerMana, authoritativeVictory.playerMana);
  assert.equal(engine.snapshot.enemyHp, 0);
  assert.equal(engine.snapshot.turnCount, authoritativeVictory.turnCount);
  assert.equal(terminalCallbacks, 1);
  assert.equal(completionCalls, 1);
  assert.equal(store.replaced, 1, 'the server player snapshot replaces local state');
  assert.equal(store.localRewards, 0, 'the client never awards local rewards in server-backed play');
  assert.equal(controller.battlePermit, undefined);
  assert.equal(storage.get('degen.pending.reward-permits.v1:player-1'), '[]');
});
