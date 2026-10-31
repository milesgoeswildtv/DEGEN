import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';
import { canUseAbility, isValidManaCost, isValidManaState, resolveCombatTurn } from '../src/game/combat/rules.ts';

class TestGameApiProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GameApiProtocolError';
  }
}

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
  GameApiProtocolError: TestGameApiProtocolError,
  isValidManaCost,
  isValidManaState,
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
    hasRecoverableUnderpassStart?(playerId: string): boolean;
    recoverableUnderpassCycleId?(playerId: string): string | undefined;
    recoverableUnderpassPermitId?(playerId: string): string | undefined;
    discardUnrecoverableUnderpassStart?(playerId: string, permitId: string): void;
    startUnderpass?(playerId: string, cycleId: string, requestIdOverride?: string): Promise<{
      permitId: string; cycleId: string; initialState: unknown;
    } | undefined>;
    acknowledgeUnderpassStart?(playerId: string, cycleId: string, permitId: string): void;
    actUnderpass(...args: unknown[]): Promise<unknown>;
    completeUnderpass(playerId: string, permitId: string): Promise<{ player: unknown; worldEvent: unknown }>;
  },
) => {
  route: string;
  battlePermit?: { permitId: string; cycleId?: string; initialState?: unknown };
  battlePermitOwnerId?: string;
  battleEngine?: BattleEngineInstance;
  rewardNotices: Map<string, { playerId: string; permitId: string; reward: unknown; previousLevel: number; currentLevel: number }>;
  underpassEvent?: { phase: string; cycleId: string };
  useBattleAbility(abilityId: string): Promise<void>;
  resumeUnderpass(): Promise<void>;
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

test('a malformed battle response explains safe resync without applying client combat state', async () => {
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
    async actUnderpass() {
      throw new TestGameApiProtocolError('Malformed JSON response from DEGEN API.');
    },
    async completeUnderpass() {
      assert.fail('a malformed action response cannot authorize completion');
    },
  };
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => {
    assert.fail('a malformed response must not resolve a local turn');
  }, {
    permitId: 'permit-protocol-error',
    status: 'active',
    playerHp: 100,
    playerMana: 8,
    enemyHp: TUNNEL_MAW.maxHp,
    turnCount: 0,
  });
  const controller = new AppController(root, store, api);
  controller.route = 'battle';
  controller.battlePermit = { permitId: 'permit-protocol-error' };
  controller.battlePermitOwnerId = 'player-1';
  controller.battleEngine = engine;

  await controller.useBattleAbility('crack');

  assert.equal(actionStatus.hidden, false);
  assert.match(actionStatus.textContent, /unreadable battle response/i);
  assert.match(actionStatus.textContent, /same move again to safely resync/i);
  assert.doesNotMatch(actionStatus.textContent, /connection interrupted/i);
  assert.equal(engine.snapshot.turnCount, 0, 'the client must wait for authoritative turn state');
  assert.equal(engine.snapshot.playerMana, 8, 'the client must not deduct Mana on a malformed response');
  assert.equal(engine.snapshot.enemyHp, TUNNEL_MAW.maxHp, 'the client must not assume damage landed');
  assert.equal(controller.battlePermit?.permitId, 'permit-protocol-error', 'keep the permit for safe recovery');
  assert.equal(store.localRewards, 0, 'the client never fabricates rewards');
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
  assert.equal(controller.rewardNotices.get('player-1')?.permitId, 'permit-player-1',
    'a verified receipt must remain available to the issuing player after an account switch');
  assert.equal(controller.rewardNotices.get('player-1')?.currentLevel, 2);
  assert.equal(controller.rewardNotices.get('player-1')?.previousLevel, 2,
    'the active second account must never supply the first account’s prior level');
  assert.equal(controller.rewardNotices.has('player-2'), false,
    'a receipt must never be rebound to the currently active account');
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
  assert.equal(controller.battleEngine, newEngine);
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


test('an unrecoverable 409 without an authoritative snapshot exits stale battle without rewards', async () => {
  for (const { errorMessage, payload } of [
    {
      errorMessage: 'Battle permit is invalid, expired, or already completed.',
      payload: { error: 'Battle permit is invalid, expired, or already completed.' },
    },
    {
      errorMessage: 'Battle state is unavailable.',
      payload: { error: 'Battle state is unavailable.' },
    },
  ]) {
    timers.length = 0;
    storage.clear();
    actionStatus.textContent = '';
    actionStatus.hidden = true;
    root.innerHTML = '';

    const permitId = errorMessage.includes('expired') ? 'permit-expired' : 'permit-corrupt';
    const store = {
      snapshot: { id: 'player-1' },
      replaced: 0,
      localRewards: 0,
      replaceFromServer(_player: unknown) { this.replaced += 1; },
      applyReward(_reward: unknown) { this.localRewards += 1; },
      markBossDefeated(_bossId: string) {},
    };
    let completionCalls = 0;
    const api = {
      enabled: true,
      async actUnderpass() {
        throw new TestGameApiError(409, payload, 'DEGEN API 409');
      },
      async getUnderpass() { return undefined; },
      async completeUnderpass() {
        completionCalls += 1;
        throw new Error('an unrecoverable 409 must not request rewards');
      },
    };
    const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => {
      assert.fail('a conflict without a valid snapshot must not resolve a local turn');
    }, {
      permitId,
      status: 'active',
      playerHp: 80,
      playerMana: 0,
      enemyHp: 60,
      turnCount: 2,
    });
    const controller = new AppController(root, store, api);
    controller.route = 'battle';
    controller.battlePermit = { permitId };
    controller.battlePermitOwnerId = 'player-1';
    controller.battleEngine = engine;

    await controller.useBattleAbility('crack');

    assert.equal(controller.route, 'underpass', errorMessage);
    assert.equal(controller.battlePermit, undefined, errorMessage);
    assert.equal(controller.battlePermitOwnerId, undefined, errorMessage);
    assert.equal(controller.battleEngine, undefined, errorMessage);
    assert.equal(engine.snapshot.status, 'active', 'the client must not invent a defeat or victory');
    assert.equal(engine.snapshot.playerMana, 0, 'zero Mana itself is not the reason for leaving combat');
    assert.equal(engine.snapshot.turnCount, 2, 'the rejected request must not advance local combat');
    assert.equal(completionCalls, 0, 'permit possession alone never grants or requests a reward');
    assert.equal(store.replaced, 0);
    assert.equal(store.localRewards, 0);
  }
});


test('a malformed 409 payload preserves the permit for safe server retry without local combat', async () => {
  timers.length = 0;
  storage.clear();
  actionStatus.textContent = '';
  actionStatus.hidden = true;
  root.innerHTML = '';

  const store = {
    snapshot: { id: 'player-1' },
    replaced: 0,
    localRewards: 0,
    replaceFromServer(_player: unknown) { this.replaced += 1; },
    applyReward(_reward: unknown) { this.localRewards += 1; },
    markBossDefeated(_bossId: string) {},
  };
  let completionCalls = 0;
  const api = {
    enabled: true,
    async actUnderpass() {
      throw new TestGameApiError(409, undefined, 'DEGEN API 409');
    },
    async getUnderpass() { return undefined; },
    async completeUnderpass() {
      completionCalls += 1;
      throw new Error('an unverified conflict must not request rewards');
    },
  };
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => {
    assert.fail('a malformed conflict must not resolve local combat');
  }, {
    permitId: 'permit-retryable-conflict',
    status: 'active',
    playerHp: 80,
    playerMana: 0,
    enemyHp: 60,
    turnCount: 2,
  });
  const controller = new AppController(root, store, api);
  controller.route = 'battle';
  controller.battlePermit = { permitId: 'permit-retryable-conflict' };
  controller.battlePermitOwnerId = 'player-1';
  controller.battleEngine = engine;

  await controller.useBattleAbility('crack');

  assert.equal(controller.route, 'battle');
  assert.equal(controller.battlePermit?.permitId, 'permit-retryable-conflict',
    'unknown conflict responses must retain the permit for a later authoritative retry');
  assert.equal(controller.battleEngine, engine);
  assert.equal(engine.snapshot.status, 'active');
  assert.equal(engine.snapshot.playerMana, 0);
  assert.equal(engine.snapshot.turnCount, 2);
  assert.equal(completionCalls, 0);
  assert.equal(store.replaced, 0);
  assert.equal(store.localRewards, 0);
  assert.equal(actionStatus.textContent, 'The server rejected that move.');
});


test('a late expired-permit rejection cannot clear a newer encounter', async () => {
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
  let rejectAction!: (error: unknown) => void;
  const actionResponse = new Promise<unknown>((_resolve, reject) => { rejectAction = reject; });
  let completionCalls = 0;
  const api = {
    enabled: true,
    actUnderpass() { return actionResponse; },
    async getUnderpass() { return undefined; },
    async completeUnderpass() {
      completionCalls += 1;
      throw new Error('a rejected expired permit must not request reward completion');
    },
  };
  const oldEngine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => {
    assert.fail('the old engine must not resolve an expired action');
  }, {
    permitId: 'permit-old-expired',
    status: 'active',
    playerHp: 80,
    playerMana: 0,
    enemyHp: 60,
    turnCount: 2,
  });
  const controller = new AppController(root, store, api);
  controller.route = 'battle';
  controller.battlePermit = { permitId: 'permit-old-expired' };
  controller.battlePermitOwnerId = 'player-1';
  controller.battleEngine = oldEngine;

  const pendingAction = controller.useBattleAbility('crack');
  controller.destroyBattle();
  const newEngine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => {
    assert.fail('the newer encounter must remain untouched');
  }, {
    permitId: 'permit-new',
    status: 'active',
    playerHp: 100,
    playerMana: 8,
    enemyHp: TUNNEL_MAW.maxHp,
    turnCount: 0,
  });
  controller.route = 'battle';
  controller.battlePermit = { permitId: 'permit-new' };
  controller.battlePermitOwnerId = 'player-1';
  controller.battleEngine = newEngine;

  rejectAction(new TestGameApiError(409, {
    error: 'Battle permit is invalid, expired, or already completed.',
  }, 'DEGEN API 409'));
  await pendingAction;

  assert.equal(controller.route, 'battle');
  assert.equal(controller.battlePermit?.permitId, 'permit-new');
  assert.equal(controller.battleEngine, newEngine);
  assert.equal(newEngine.snapshot.status, 'active');
  assert.equal(newEngine.snapshot.turnCount, 0);
  assert.equal(newEngine.snapshot.playerMana, 8);
  assert.equal(completionCalls, 0);
  assert.equal(store.localRewards, 0);
});



test('a delayed expired-permit refresh cannot navigate away from a newer encounter', async () => {
  timers.length = 0;
  storage.clear();
  actionStatus.textContent = '';
  actionStatus.hidden = true;
  root.innerHTML = '';

  const store = {
    snapshot: { id: 'player-1' },
    replaced: 0,
    localRewards: 0,
    replaceFromServer(_player: unknown) { this.replaced += 1; },
    applyReward(_reward: unknown) { this.localRewards += 1; },
    markBossDefeated(_bossId: string) {},
  };
  let resolveWorld!: (value: undefined) => void;
  const worldRefresh = new Promise<undefined>((resolve) => { resolveWorld = resolve; });
  let completionCalls = 0;
  const api = {
    enabled: true,
    async actUnderpass() {
      throw new TestGameApiError(409, {
        error: 'Battle permit is invalid, expired, or already completed.',
      }, 'DEGEN API 409');
    },
    getUnderpass() { return worldRefresh; },
    async completeUnderpass() {
      completionCalls += 1;
      throw new Error('expired-permit recovery must not request rewards');
    },
  };
  const oldEngine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => {
    assert.fail('an expired action must not resolve locally');
  }, {
    permitId: 'permit-old-expired',
    status: 'active',
    playerHp: 80,
    playerMana: 0,
    enemyHp: 60,
    turnCount: 2,
  });
  const controller = new AppController(root, store, api);
  controller.route = 'battle';
  controller.battlePermit = { permitId: 'permit-old-expired' };
  controller.battlePermitOwnerId = 'player-1';
  controller.battleEngine = oldEngine;

  const pendingAction = controller.useBattleAbility('crack');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.battlePermit, undefined, 'the expired permit is cleared before the refresh resolves');

  const newEngine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => {
    assert.fail('the new encounter must not be completed by old cleanup');
  }, {
    permitId: 'permit-new-after-refresh',
    status: 'active',
    playerHp: 100,
    playerMana: 8,
    enemyHp: TUNNEL_MAW.maxHp,
    turnCount: 0,
  });
  controller.route = 'battle';
  controller.battlePermit = { permitId: 'permit-new-after-refresh' };
  controller.battlePermitOwnerId = 'player-1';
  controller.battleEngine = newEngine;

  resolveWorld(undefined);
  await pendingAction;

  assert.equal(controller.route, 'battle', 'late cleanup must not navigate away from a newer encounter');
  assert.equal(controller.battlePermit?.permitId, 'permit-new-after-refresh');
  assert.equal(controller.battleEngine, newEngine);
  assert.equal(newEngine.snapshot.status, 'active');
  assert.equal(newEngine.snapshot.turnCount, 0);
  assert.equal(newEngine.snapshot.playerMana, 8);
  assert.equal(completionCalls, 0);
  assert.equal(store.localRewards, 0);
});


test('a delayed expired-permit refresh cannot navigate after the active account changes', async () => {
  timers.length = 0;
  storage.clear();
  actionStatus.textContent = '';
  actionStatus.hidden = true;
  root.innerHTML = '';

  const store = {
    snapshot: { id: 'player-1' },
    replaced: 0,
    localRewards: 0,
    replaceFromServer(_player: unknown) { this.replaced += 1; },
    applyReward(_reward: unknown) { this.localRewards += 1; },
    markBossDefeated(_bossId: string) {},
  };
  let resolveWorld!: (value: undefined) => void;
  const worldRefresh = new Promise<undefined>((resolve) => { resolveWorld = resolve; });
  let completionCalls = 0;
  const api = {
    enabled: true,
    async actUnderpass() {
      throw new TestGameApiError(409, {
        error: 'Battle permit is invalid, expired, or already completed.',
      }, 'DEGEN API 409');
    },
    getUnderpass() { return worldRefresh; },
    async completeUnderpass() {
      completionCalls += 1;
      throw new Error('expired-permit cleanup must not request rewards');
    },
  };
  const oldEngine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => {
    assert.fail('an expired action must not resolve locally');
  }, {
    permitId: 'permit-account-switch-expired',
    status: 'active',
    playerHp: 80,
    playerMana: 0,
    enemyHp: 60,
    turnCount: 2,
  });
  const controller = new AppController(root, store, api);
  controller.route = 'battle';
  controller.battlePermit = { permitId: 'permit-account-switch-expired' };
  controller.battlePermitOwnerId = 'player-1';
  controller.battleEngine = oldEngine;

  const pendingAction = controller.useBattleAbility('crack');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.battlePermit, undefined, 'the unusable permit is cleared before refresh finishes');

  // Simulate the active account changing while the old encounter's world refresh is pending.
  store.snapshot.id = 'player-2';
  resolveWorld(undefined);
  await pendingAction;

  assert.equal(controller.route, 'battle', 'old cleanup must not navigate the newly active account');
  assert.equal(controller.battlePermit, undefined);
  assert.equal(controller.battleEngine, oldEngine, 'the stale request must not mutate another account’s encounter');
  assert.equal(completionCalls, 0);
  assert.equal(store.localRewards, 0);
});


test('an active encounter can be resumed from a sealed Underpass with fresh Worker state', async () => {
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
  const existingPermit = {
    permitId: 'permit-resume-closed',
    cycleId: 'cycle-that-closed',
    eventKey: 'underpass',
    encounterKey: 'tunnel-maw',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    initialState: {
      permitId: 'permit-resume-closed', status: 'active' as const,
      playerHp: 120, playerMana: 12, enemyHp: 92, turnCount: 0,
    },
  };
  const resumedPermit = {
    ...existingPermit,
    initialState: {
      permitId: 'permit-resume-closed', status: 'active' as const,
      playerHp: 110, playerMana: 8, enemyHp: 57, turnCount: 1,
    },
  };
  const startCalls: unknown[][] = [];
  const acknowledgements: unknown[][] = [];
  let completionCalls = 0;
  const api = {
    enabled: true,
    hasRecoverableUnderpassStart: () => true,
    recoverableUnderpassCycleId: () => 'cycle-that-closed',
    async startUnderpass(...args: [string, string, string?]) {
      startCalls.push(args);
      return resumedPermit;
    },
    acknowledgeUnderpassStart(...args: [string, string, string]) { acknowledgements.push(args); },
    async actUnderpass() { assert.fail('resume must not apply a combat action'); },
    async completeUnderpass() {
      completionCalls += 1;
      throw new Error('resume must not request rewards');
    },
  };
  const controller = new AppController(root, store, api);
  controller.route = 'underpass';
  controller.underpassEvent = { phase: 'sealed', cycleId: 'new-cycle' };
  controller.battlePermit = existingPermit;
  controller.battlePermitOwnerId = 'player-1';

  await controller.resumeUnderpass();

  assert.equal(controller.route, 'battle');
  assert.equal(controller.battlePermit?.permitId, 'permit-resume-closed');
  assert.deepEqual(controller.battlePermit?.initialState, {
    permitId: 'permit-resume-closed', status: 'active',
    playerHp: 110, playerMana: 8, enemyHp: 57, turnCount: 1,
  });
  assert.deepEqual(startCalls, [['player-1', 'cycle-that-closed', 'permit-resume-closed']],
    'resume must reuse the issued permit ID and original cycle rather than minting a new encounter');
  assert.deepEqual(acknowledgements, [['player-1', 'cycle-that-closed', 'permit-resume-closed']]);
  assert.equal(completionCalls, 0);
  assert.equal(store.localRewards, 0);
});

test('a reload can recover an active encounter from the player-scoped saved start key', async () => {
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
  const resumedPermit = {
    permitId: 'permit-reload-resume',
    cycleId: 'cycle-persisted',
    eventKey: 'underpass',
    encounterKey: 'tunnel-maw',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    initialState: {
      permitId: 'permit-reload-resume', status: 'active' as const,
      playerHp: 95, playerMana: 4, enemyHp: 22, turnCount: 2,
    },
  };
  const startCalls: unknown[][] = [];
  const api = {
    enabled: true,
    hasRecoverableUnderpassStart: () => true,
    recoverableUnderpassCycleId: () => 'cycle-persisted',
    recoverableUnderpassPermitId: () => 'permit-reload-resume',
    async startUnderpass(...args: [string, string, string?]) {
      startCalls.push(args);
      return resumedPermit;
    },
    acknowledgeUnderpassStart() {},
    async actUnderpass() { assert.fail('reload recovery must not apply an action'); },
    async completeUnderpass() { assert.fail('reload recovery must not claim a reward'); },
  };
  const controller = new AppController(root, store, api);
  controller.route = 'underpass';

  await controller.resumeUnderpass();

  assert.equal(controller.route, 'battle');
  assert.equal(controller.battlePermit?.permitId, 'permit-reload-resume');
  assert.deepEqual(controller.battlePermit?.initialState, resumedPermit.initialState);
  assert.deepEqual(startCalls, [['player-1', 'cycle-persisted', 'permit-reload-resume']],
    'a fresh controller must retry the saved request key and recover the persisted permit');
  assert.equal(store.localRewards, 0);
});


test('an unrecoverable resumed permit clears only its matching persisted start key', async () => {
  timers.length = 0;
  storage.clear();
  actionStatus.textContent = '';
  actionStatus.hidden = true;
  root.innerHTML = '';

  let recoverable = true;
  const discarded: string[] = [];
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
    hasRecoverableUnderpassStart: () => recoverable,
    recoverableUnderpassCycleId: () => recoverable ? 'cycle-persisted' : undefined,
    recoverableUnderpassPermitId: () => recoverable ? 'permit-expired' : undefined,
    async startUnderpass(playerId: string, cycleId: string, requestIdOverride?: string) {
      assert.deepEqual([playerId, cycleId, requestIdOverride], ['player-1', 'cycle-persisted', 'permit-expired']);
      throw new TestGameApiError(409, {
        error: 'Battle start request is already used or invalid.',
      }, 'DEGEN API 409');
    },
    discardUnrecoverableUnderpassStart(playerId: string, permitId: string) {
      assert.equal(playerId, 'player-1');
      discarded.push(permitId);
      if (permitId === 'permit-expired') recoverable = false;
    },
    async getUnderpass() { return undefined; },
    async completeUnderpass() { assert.fail('an invalid permit cannot request rewards'); },
  };
  const controller = new AppController(root, store, api);
  controller.route = 'underpass';
  controller.underpassEvent = { phase: 'sealed', cycleId: 'new-cycle' };

  await controller.resumeUnderpass();

  assert.deepEqual(discarded, ['permit-expired']);
  assert.equal(recoverable, false, 'a definitive rejection removes the stale player-scoped key');
  assert.equal(controller.route, 'underpass');
  assert.equal(controller.battlePermit, undefined);
  assert.equal(store.localRewards, 0);
});


test('an expired in-memory permit rerenders the sealed Underpass after cleanup', async () => {
  timers.length = 0;
  storage.clear();
  actionStatus.textContent = '';
  actionStatus.hidden = true;
  root.innerHTML = '';

  let recoverable = true;
  const discarded: string[] = [];
  const rendered: unknown[][] = [];
  const originalUnderpassView = scope.underpassView;
  scope.underpassView = (...args: any[]) => {
    rendered.push(args);
    return '';
  };
  const store = {
    snapshot: { id: 'player-1' },
    replaced: 0,
    localRewards: 0,
    replaceFromServer(_player: unknown) { this.replaced += 1; },
    applyReward(_reward: unknown) { this.localRewards += 1; },
    markBossDefeated(_bossId: string) {},
  };
  const expiredPermit = {
    permitId: 'permit-expired-memory',
    cycleId: 'cycle-old',
    eventKey: 'underpass',
    encounterKey: 'tunnel-maw',
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  };
  const api = {
    enabled: true,
    hasRecoverableUnderpassStart: () => recoverable,
    recoverableUnderpassCycleId: () => recoverable ? 'cycle-old' : undefined,
    recoverableUnderpassPermitId: () => recoverable ? expiredPermit.permitId : undefined,
    async startUnderpass(_playerId: string, _cycleId: string, requestIdOverride?: string) {
      assert.equal(requestIdOverride, expiredPermit.permitId);
      throw new TestGameApiError(409, {
        error: 'Battle start request is already used or invalid.',
      }, 'DEGEN API 409');
    },
    discardUnrecoverableUnderpassStart(_playerId: string, permitId: string) {
      discarded.push(permitId);
      if (permitId === expiredPermit.permitId) recoverable = false;
    },
    async getUnderpass() { return undefined; },
    async completeUnderpass() { assert.fail('an expired permit cannot request rewards'); },
  };
  const controller = new AppController(root, store, api);
  controller.route = 'underpass';
  controller.underpassEvent = { phase: 'sealed', cycleId: 'new-cycle' };
  controller.battlePermit = expiredPermit;
  controller.battlePermitOwnerId = 'player-1';

  try {
    await controller.resumeUnderpass();
    assert.deepEqual(discarded, [expiredPermit.permitId]);
    assert.equal(recoverable, false);
    assert.equal(controller.battlePermit, undefined);
    assert.equal(controller.battlePermitOwnerId, undefined);
    assert.equal(controller.route, 'underpass');
    assert.equal(rendered.length, 1, 'cleanup must render after clearing the old permit');
    assert.equal(rendered[0]?.[2], false, 'the sealed view must stop advertising a stale resume key');
    assert.equal(store.localRewards, 0);
  } finally {
    scope.underpassView = originalUnderpassView;
  }
});


test('unknown or authentication resume errors retain the permit and saved key', async () => {
  for (const error of [
    new TestGameApiError(409, { error: 'Unexpected conflict response.' }, 'DEGEN API 409'),
    new TestGameApiError(401, { error: 'Unauthorized.' }, 'DEGEN API 401'),
  ]) {
    timers.length = 0;
    storage.clear();
    actionStatus.textContent = '';
    actionStatus.hidden = true;
    root.innerHTML = '';

    const existingPermit = {
      permitId: 'permit-retryable',
      cycleId: 'cycle-original',
      eventKey: 'underpass',
      encounterKey: 'tunnel-maw',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const discarded: string[] = [];
    let refreshCalls = 0;
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
      async startUnderpass() { throw error; },
      discardUnrecoverableUnderpassStart(_playerId: string, permitId: string) { discarded.push(permitId); },
      async getUnderpass() { refreshCalls += 1; return undefined; },
      async completeUnderpass() { assert.fail('an unverified conflict cannot request rewards'); },
    };
    const controller = new AppController(root, store, api);
    controller.route = 'underpass';
    controller.underpassEvent = { phase: 'sealed', cycleId: 'cycle-current' };
    controller.battlePermit = existingPermit;
    controller.battlePermitOwnerId = 'player-1';

    await controller.resumeUnderpass();

    assert.equal(controller.battlePermit, existingPermit, 'unknown/auth errors must retain the in-memory permit');
    assert.equal(controller.battlePermitOwnerId, 'player-1');
    assert.deepEqual(discarded, [], 'unknown/auth errors must not discard the saved request key');
    assert.equal(refreshCalls, 0, 'only known unrecoverable Worker responses trigger a refresh');
    assert.equal(controller.route, 'underpass');
    assert.equal(store.localRewards, 0);
  }
});
