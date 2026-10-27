import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';
import { canUseAbility, resolveCombatTurn } from '../src/game/combat/rules.ts';

class TestGameApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, payload: unknown, message: string) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

const engineSource = readFileSync(new URL('../src/game/combat/engine.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/\bexport class BattleEngine\b/g, 'class BattleEngine');
const { BattleEngine } = runInNewContext(
  stripTypeScriptTypes(engineSource, { mode: 'transform' }) + '\n({ BattleEngine });',
  { canUseAbility, resolveCombatTurn },
) as {
  BattleEngine: new (
    degen: typeof TEST_DEGEN,
    enemy: typeof TUNNEL_MAW,
    onComplete: (status: 'victory' | 'defeat') => void,
    initialState: {
      permitId: string; status: 'active'; playerHp: number; playerMana: number; enemyHp: number; turnCount: number;
    },
  ) => {
    snapshot: { status: string; playerMana: number; enemyHp: number; turnCount: number };
    synchronizeAuthoritativeState(result: {
      permitId: string; status: 'active' | 'victory' | 'defeat';
      playerHp: number; playerMana: number; enemyHp: number; turnCount: number;
    }): void;
  };
};

type BattleEngineInstance = InstanceType<typeof BattleEngine>;

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
const actionStatus = { textContent: '', hidden: true };
const root = {
  innerHTML: '',
  querySelector: (selector: string) => selector === '#battle-action-status' ? actionStatus : null,
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
    completeUnderpass(playerId: string, permitId: string): Promise<{ player: unknown; worldEvent: unknown }>;
  },
) => {
  route: string;
  battlePermit?: { permitId: string };
  battlePermitOwnerId?: string;
  battleEngine?: BattleEngineInstance;
  useBattleAbility(abilityId: string): Promise<void>;
  finishBattle(status: 'victory' | 'defeat'): Promise<void>;
  destroyBattle(): void;
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
    async completeUnderpass(_playerId: string, permitId: string) {
      completionCalls += 1;
      assert.equal(permitId, 'permit-1');
      return { player: { id: 'player-1', level: 2 }, worldEvent: { cycleId: 'cycle-1' } };
    },
  };

  let terminalCallbacks = 0;
  let controller!: InstanceType<typeof AppController>;
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, (status) => {
    terminalCallbacks += 1;
    void controller.finishBattle(status);
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
  controller.battlePermitOwnerId = 'player-1';
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


test('an unconfirmed action failure is visible and tells the player to safely retry the same move', async () => {
  timers.length = 0;
  storage.clear();
  actionStatus.textContent = '';
  actionStatus.hidden = true;

  const store = {
    snapshot: { id: 'player-1' },
    replaced: 0,
    localRewards: 0,
    replaceFromServer(_player: unknown) { this.replaced += 1; },
    applyReward(_reward: unknown) { this.localRewards += 1; },
    markBossDefeated(_bossId: string) {},
  };
  const api = {
    enabled: true,
    async actUnderpass() { throw new TypeError('simulated final transport failure'); },
    async completeUnderpass() { throw new Error('completion must not run for an unconfirmed action'); },
  };
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => {
    assert.fail('an unconfirmed response must not resolve a local turn');
  }, {
    permitId: 'permit-uncertain',
    status: 'active',
    playerHp: 100,
    playerMana: 8,
    enemyHp: TUNNEL_MAW.maxHp,
    turnCount: 0,
  });
  const controller = new AppController(root, store, api);
  controller.route = 'battle';
  controller.battlePermit = { permitId: 'permit-uncertain' };
  controller.battlePermitOwnerId = 'player-1';
  controller.battleEngine = engine;

  await controller.useBattleAbility('crack');

  assert.equal(actionStatus.hidden, false);
  assert.match(actionStatus.textContent, /move may have reached the server/i);
  assert.match(actionStatus.textContent, /same move again/i);
  assert.equal(engine.snapshot.turnCount, 0, 'the client must not apply a turn without an authoritative result');
  assert.equal(engine.snapshot.playerMana, 8, 'the client must not spend Mana locally on an uncertain response');
  assert.equal(store.localRewards, 0, 'an uncertain action must never grant local rewards');
});

test('an insufficient-Mana conflict shows the server error and synchronizes the latest state', async () => {
  timers.length = 0;
  storage.clear();
  actionStatus.textContent = '';
  actionStatus.hidden = true;

  const store = {
    snapshot: { id: 'player-1' },
    replaced: 0,
    localRewards: 0,
    replaceFromServer(_player: unknown) { this.replaced += 1; },
    applyReward(_reward: unknown) { this.localRewards += 1; },
    markBossDefeated(_bossId: string) {},
  };
  const latest = {
    permitId: 'permit-1',
    status: 'active' as const,
    playerHp: 70,
    playerMana: 0,
    enemyHp: 63,
    turnCount: 1,
  };
  const api = {
    enabled: true,
    async actUnderpass() {
      throw new TestGameApiError(409, {
        error: 'Not enough Mana for that ability.',
        battleState: latest,
      }, 'DEGEN API 409');
    },
    async completeUnderpass() { throw new Error('completion must not run for an active battle'); },
  };
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => {
    assert.fail('an active authoritative snapshot must not resolve the encounter');
  }, {
    permitId: 'permit-1',
    status: 'active',
    playerHp: 100,
    playerMana: 8,
    enemyHp: TUNNEL_MAW.maxHp,
    turnCount: 0,
  });
  const controller = new AppController(root, store, api);
  controller.route = 'battle';
  controller.battlePermit = { permitId: 'permit-1' };
  controller.battlePermitOwnerId = 'player-1';
  controller.battleEngine = engine;

  await controller.useBattleAbility('crack');

  assert.equal(actionStatus.hidden, false);
  assert.equal(actionStatus.textContent, 'Not enough Mana for that ability.');
  assert.equal(engine.snapshot.playerMana, 0);
  assert.equal(engine.snapshot.enemyHp, 63);
  assert.equal(engine.snapshot.turnCount, 1);
  assert.equal(store.localRewards, 0);
});



test('a confirmed victory still settles if the player abandons before the action response arrives', async () => {
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
    permitId: 'permit-abandoned',
    status: 'victory' as const,
    playerHp: 80,
    playerMana: 4,
    enemyHp: 0,
    turnCount: 1,
  };
  let resolveAction!: (value: unknown) => void;
  const actionResponse = new Promise<unknown>((resolve) => { resolveAction = resolve; });
  let actionCalls = 0;
  let completionCalls = 0;
  const api = {
    enabled: true,
    actUnderpass() {
      actionCalls += 1;
      return actionResponse;
    },
    async completeUnderpass(_playerId: string, permitId: string) {
      completionCalls += 1;
      assert.equal(permitId, 'permit-abandoned');
      return { player: { id: 'player-1', level: 2 }, worldEvent: { cycleId: 'cycle-1' } };
    },
  };

  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => {
    assert.fail('the torn-down engine should not resolve the action locally');
  }, {
    permitId: 'permit-abandoned',
    status: 'active',
    playerHp: 100,
    playerMana: 8,
    enemyHp: TUNNEL_MAW.maxHp,
    turnCount: 0,
  });
  const controller = new AppController(root, store, api);
  controller.route = 'battle';
  controller.battlePermit = { permitId: 'permit-abandoned' };
  controller.battlePermitOwnerId = 'player-1';
  controller.battleEngine = engine;

  const pendingAction = controller.useBattleAbility('crack');
  controller.route = 'underpass';
  controller.battleEngine = undefined;
  resolveAction(authoritativeVictory);
  await pendingAction;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(actionCalls, 1);
  assert.equal(completionCalls, 1, 'the confirmed victory is submitted to Worker completion exactly once');
  assert.equal(store.replaced, 1, 'only the authoritative player snapshot is applied');
  assert.equal(store.localRewards, 0, 'the client never grants a local reward');
  assert.equal(controller.battlePermit, undefined);
  assert.equal(storage.get('degen.pending.reward-permits.v1:player-1'), '[]');
});


test('a stale victory snapshot settles its original permit, not a newer encounter', async () => {
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
  const oldVictory = {
    permitId: 'permit-old',
    status: 'victory' as const,
    playerHp: 80,
    playerMana: 4,
    enemyHp: 0,
    turnCount: 1,
  };
  let completionPermit = '';
  let completionCalls = 0;
  const api = {
    enabled: true,
    async actUnderpass() {
      throw new TestGameApiError(409, {
        error: 'Stale battle turn.',
        battleState: oldVictory,
      }, 'DEGEN API 409');
    },
    async completeUnderpass(_playerId: string, permitId: string) {
      completionCalls += 1;
      completionPermit = permitId;
      return { player: { id: 'player-1', level: 2 }, worldEvent: { cycleId: 'cycle-1' } };
    },
  };
  const oldEngine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => {
    assert.fail('a stale engine must not settle whichever permit is currently mounted');
  }, {
    permitId: 'permit-old',
    status: 'active',
    playerHp: 100,
    playerMana: 8,
    enemyHp: TUNNEL_MAW.maxHp,
    turnCount: 0,
  });
  const controller = new AppController(root, store, api);
  controller.route = 'battle';
  controller.battlePermit = { permitId: 'permit-old' };
  controller.battlePermitOwnerId = 'player-1';
  controller.battleEngine = oldEngine;

  const pendingAction = controller.useBattleAbility('crack');
  controller.route = 'underpass';
  controller.battlePermit = { permitId: 'permit-new' };
  controller.battlePermitOwnerId = 'player-1';
  controller.battleEngine = undefined;
  await pendingAction;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(completionCalls, 1);
  assert.equal(completionPermit, 'permit-old', 'the original server-resolved victory is the only completion requested');
  assert.equal(controller.battlePermit?.permitId, 'permit-new', 'recovery must not clear or complete the newer permit');
  assert.equal(store.replaced, 1);
  assert.equal(store.localRewards, 0);
  assert.equal(storage.get('degen.pending.reward-permits.v1:player-1'), '[]');
});


test('late victory after an account switch settles under the issuing player without replacing the active account', async () => {
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
    permitId: 'permit-player-1',
    status: 'victory' as const,
    playerHp: 80,
    playerMana: 4,
    enemyHp: 0,
    turnCount: 1,
  };
  let resolveAction!: (value: unknown) => void;
  const actionResponse = new Promise<unknown>((resolve) => { resolveAction = resolve; });
  let actionPlayerId = '';
  let completionPlayerId = '';
  let completionPermitId = '';
  const api = {
    enabled: true,
    actUnderpass(playerId: string) {
      actionPlayerId = playerId;
      return actionResponse;
    },
    async completeUnderpass(playerId: string, permitId: string) {
      completionPlayerId = playerId;
      completionPermitId = permitId;
      return { player: { id: 'player-1', level: 2 }, worldEvent: { cycleId: 'cycle-1' } };
    },
  };
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => {
    assert.fail('the detached engine must not apply or settle the action locally');
  }, {
    permitId: 'permit-player-1',
    status: 'active',
    playerHp: 100,
    playerMana: 8,
    enemyHp: TUNNEL_MAW.maxHp,
    turnCount: 0,
  });
  const controller = new AppController(root, store, api);
  controller.route = 'battle';
  controller.battlePermit = { permitId: 'permit-player-1' };
  controller.battlePermitOwnerId = 'player-1';
  controller.battleEngine = engine;

  const pendingAction = controller.useBattleAbility('crack');
  controller.route = 'underpass';
  controller.battleEngine = undefined;
  store.snapshot.id = 'player-2';
  resolveAction(authoritativeVictory);
  await pendingAction;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(actionPlayerId, 'player-1', 'the in-flight action remains bound to the original player');
  assert.equal(completionPlayerId, 'player-1', 'reward completion must use the permit owner, not the current account');
  assert.equal(completionPermitId, 'permit-player-1');
  assert.equal(store.snapshot.id, 'player-2');
  assert.equal(store.replaced, 0, 'an old account completion must not overwrite the active player snapshot');
  assert.equal(store.localRewards, 0, 'the client must never grant local rewards for a server-backed battle');
  assert.equal(storage.get('degen.pending.reward-permits.v1:player-1'), '[]',
    'the original player’s pending permit is cleared only after authoritative completion');
  assert.equal(storage.get('degen.pending.reward-permits.v1:player-2'), undefined,
    'the old permit must never be written into the new player’s retry queue');
  assert.equal(controller.battlePermit, undefined);
});


test('a stale active snapshot cannot synchronize a newer permit after battle teardown', async () => {
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
  const staleActive = {
    permitId: 'permit-old',
    status: 'active' as const,
    playerHp: 72,
    playerMana: 3,
    enemyHp: 60,
    turnCount: 2,
  };
  let rejectAction!: (error: unknown) => void;
  const actionResponse = new Promise<unknown>((_resolve, reject) => { rejectAction = reject; });
  let completionCalls = 0;
  const api = {
    enabled: true,
    actUnderpass() { return actionResponse; },
    async completeUnderpass() {
      completionCalls += 1;
      throw new Error('an active stale snapshot must not request reward completion');
    },
  };
  const oldEngine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => {
    assert.fail('the old engine must not resolve a stale active snapshot');
  }, {
    permitId: 'permit-old',
    status: 'active',
    playerHp: 100,
    playerMana: 8,
    enemyHp: TUNNEL_MAW.maxHp,
    turnCount: 0,
  });
  const controller = new AppController(root, store, api);
  controller.route = 'battle';
  controller.battlePermit = { permitId: 'permit-old' };
  controller.battlePermitOwnerId = 'player-1';
  controller.battleEngine = oldEngine;

  const pendingAction = controller.useBattleAbility('crack');
  controller.destroyBattle();
  controller.route = 'battle';
  const newEngine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => {
    assert.fail('the new engine must not resolve the old permit response');
  }, {
    permitId: 'permit-new',
    status: 'active',
    playerHp: 100,
    playerMana: 8,
    enemyHp: TUNNEL_MAW.maxHp,
    turnCount: 0,
  });
  controller.battlePermit = { permitId: 'permit-new' };
  controller.battlePermitOwnerId = 'player-1';
  controller.battleEngine = newEngine;

  rejectAction(new TestGameApiError(409, {
    error: 'Stale battle turn.',
    battleState: staleActive,
  }, 'DEGEN API 409'));
  await pendingAction;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(oldEngine.snapshot.turnCount, 0);
  assert.equal(newEngine.snapshot.permitId, 'permit-new');
  assert.equal(newEngine.snapshot.status, 'active');
  assert.equal(newEngine.snapshot.turnCount, 0);
  assert.equal(newEngine.snapshot.playerHp, 100);
  assert.equal(newEngine.snapshot.playerMana, 8);
  assert.equal(newEngine.snapshot.enemyHp, TUNNEL_MAW.maxHp);
  assert.equal(controller.battlePermit?.permitId, 'permit-new');
  assert.equal(completionCalls, 0);
  assert.equal(store.localRewards, 0);
  assert.equal(storage.get('degen.pending.reward-permits.v1:player-1'), undefined);
});
