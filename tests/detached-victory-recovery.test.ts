import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../src/app/AppController.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/\bexport class /g, 'class ');

class TestGameApiError extends Error {
  constructor(status, payload, message) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

const validBattleState = (value, permitId) => Boolean(value && typeof value === 'object'
  && value.permitId === permitId
  && ['active', 'victory', 'defeat'].includes(value.status)
  && Number.isSafeInteger(value.playerHp) && value.playerHp >= 0 && value.playerHp <= 120
  && Number.isSafeInteger(value.playerMana) && value.playerMana >= 0 && value.playerMana <= 12
  && Number.isSafeInteger(value.enemyHp) && value.enemyHp >= 0 && value.enemyHp <= 120
  && Number.isSafeInteger(value.turnCount) && value.turnCount >= 0
  && (value.status !== 'victory' || (value.playerHp > 0 && value.enemyHp === 0))
  && (value.status !== 'defeat' || (value.playerHp === 0 && value.enemyHp > 0))
  && (value.status !== 'active' || (value.playerHp > 0 && value.enemyHp > 0)));

test('detached Worker victory is queued under the issuing player only', async () => {
  const values = new Map();
  const localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  let currentPlayer = 'player-A';
  const api = {
    enabled: true,
    authenticatedPlayerId: 'player-A',
    completeCalls: 0,
    async actUnderpass() {
      currentPlayer = 'player-B';
      this.authenticatedPlayerId = 'player-B';
      throw new TestGameApiError(401, {
        error: 'Authenticated player changed while request was in flight.',
        detachedBattleAction: {
          permitId: 'permit-A', status: 'victory',
          playerHp: 100, playerMana: 0, enemyHp: 0, turnCount: 1,
        },
      }, 'DEGEN API 401: authenticated player changed while the request was in flight.');
    },
    async completeUnderpass() {
      this.completeCalls += 1;
      throw new Error('must not complete Player A permit under Player B session');
    },
  };
  const root = {
    innerHTML: '',
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const store = { get snapshot() { return { id: currentPlayer, displayName: currentPlayer }; } };
  const globals = {
    GameApiError: TestGameApiError,
    isAuthoritativeBattleActionState: validBattleState,
    TEST_DEGEN: { maxHp: 120, maxMana: 12 },
    TUNNEL_MAW: { maxHp: 120, id: 'tunnel-maw' },
    createBattleGame: () => undefined,
    BattleEngine: class {},
    underpassRewardForClear: () => ({ xp: 0, currency: 0, items: [] }),
    battleView: () => '',
    homeView: () => '',
    mapView: () => '<main>Map</main>',
    underpassView: () => '',
    updateBattleDom: () => undefined,
    createPreviewPermit: () => undefined,
    getPreviewUnderpass: () => undefined,
    recordPreviewClear: () => 0,
    localStorage,
    structuredClone,
    console: { warn: () => undefined },
    window: { setTimeout: () => 1, clearTimeout: () => undefined },
  };
  const { AppController } = runInNewContext(
    stripTypeScriptTypes(source, { mode: 'transform' }) + '\n({ AppController });',
    globals,
  );
  const controller = new AppController(root, store, api);
  let applied = false;
  const engine = {
    snapshot: { status: 'active', turnCount: 0, playerHp: 100, playerMana: 8, enemyHp: 40 },
    applyAuthoritativeAction: () => { applied = true; },
    synchronizeAuthoritativeState: () => undefined,
  };
  controller.battleEngine = engine;
  controller.battlePermit = { permitId: 'permit-A' };
  controller.battlePlayerId = 'player-A';
  controller.route = 'battle';

  await controller.useBattleAbility('crack');

  assert.equal(applied, false, 'Player A victory state must not mutate the current account battle');
  assert.deepEqual(JSON.parse(values.get('degen.pending.reward-permits.v1:player-A') ?? '[]'), ['permit-A']);
  assert.equal(values.has('degen.pending.reward-permits.v1:player-B'), false);
  assert.equal(api.completeCalls, 0, 'the Worker completion must not be attempted with Player B session');
  assert.equal(controller.battlePermit, undefined, 'the old account battle is detached from the current screen');
  assert.equal(controller.route, 'map');
});
