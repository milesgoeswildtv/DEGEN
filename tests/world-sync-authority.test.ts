import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

// Exercise the real controller without starting Phaser or a browser.
const source = readFileSync(new URL('../src/app/AppController.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace('export class AppController', 'class AppController');
const stripped = stripTypeScriptTypes(source, { mode: 'transform' });
let previewCalls = 0;
const preview = { eventKey: 'underpass', cycleId: 'local-preview', phase: 'open',
  source: 'preview', opensAt: '', closesAt: '', fullRewardClears: 0, fullRewardLimit: 3 };
const pendingStorage = new Map();
class BattleTurnConflictError extends Error {
  constructor(battleState) { super('stale turn'); this.battleState = battleState; }
}
const AppController = runInNewContext(stripped + '\nAppController;', {
  getPreviewUnderpass: () => { previewCalls += 1; return preview; },
  console: { warn() {} },
  window: { setTimeout: () => 1, clearTimeout: () => {} },
  BattleTurnConflictError,
  localStorage: { getItem: key => pendingStorage.get(key) ?? null, setItem: (key, value) => pendingStorage.set(key, value) },
});
const serverOpen = { ...preview, cycleId: 'server-cycle', source: 'server' };
const make = (api) => {
  const app = new AppController({}, { snapshot: { id: 'p1' } }, api);
  app.route = 'underpass';
  return app;
};

test('server-backed sync failure never substitutes a local open event', async () => {
  previewCalls = 0;
  const app = make({ enabled: true, getUnderpass: async () => { throw Error('offline'); } });
  await app.refreshWorld();
  assert.equal(app.underpassEvent, undefined);
  assert.equal(previewCalls, 0);
});

test('failed refresh invalidates previously open server snapshot', async () => {
  previewCalls = 0;
  let fail = false;
  const app = make({ enabled: true, getUnderpass: async () => {
    if (fail) throw Error('offline');
    return serverOpen;
  } });
  await app.refreshWorld();
  assert.equal(app.underpassEvent?.phase, 'open');
  fail = true;
  await app.refreshWorld();
  assert.equal(app.underpassEvent, undefined);
  assert.equal(previewCalls, 0);
});

test('offline preview remains available when Worker integration is disabled', async () => {
  previewCalls = 0;
  const app = make({ enabled: false, getUnderpass: async () => { throw Error('should not call'); } });
  await app.refreshWorld();
  assert.equal(app.underpassEvent, preview);
  assert.equal(previewCalls, 1);
});

test('successful Worker sync uses authoritative event', async () => {
  previewCalls = 0;
  const app = make({ enabled: true, getUnderpass: async () => serverOpen });
  await app.refreshWorld();
  assert.equal(app.underpassEvent, serverOpen);
  assert.equal(previewCalls, 0);
});

test('late older server success cannot overwrite newer sealed state', async () => {
  const requests = [];
  const app = make({ enabled: true, getUnderpass: () => new Promise((resolve, reject) => requests.push({ resolve, reject })) });
  const old = app.refreshWorld();
  const current = app.refreshWorld();
  const sealed = { ...serverOpen, phase: 'sealed', cycleId: 'new-cycle' };
  requests[1].resolve(sealed);
  await current;
  requests[0].resolve(serverOpen);
  await old;
  assert.equal(app.underpassEvent, sealed);
});

test('late older request failure cannot erase newer server state', async () => {
  const requests = [];
  const app = make({ enabled: true, getUnderpass: () => new Promise((resolve, reject) => requests.push({ resolve, reject })) });
  const old = app.refreshWorld();
  const current = app.refreshWorld();
  requests[1].resolve(serverOpen);
  await current;
  requests[0].reject(Error('late failure'));
  await old;
  assert.equal(app.underpassEvent, serverOpen);
});

test('an older world refresh cannot overwrite a newer authoritative reward receipt', async () => {
  let resolveWorld;
  const receiptEvent = { ...serverOpen, fullRewardClears: 2, cycleId: 'reward-cycle' };
  const api = {
    enabled: true,
    getUnderpass: () => new Promise(resolve => { resolveWorld = resolve; }),
    completeUnderpass: async () => ({ player: { id: 'p1' }, worldEvent: receiptEvent }),
  };
  const store = { snapshot: { id: 'p1' }, replaceFromServer() {} };
  const app = new AppController({}, store, api);
  app.route = 'battle'; // Avoid unrelated DOM render during this state-only regression.
  const staleRefresh = app.refreshWorld();
  await app.queueRewardCompletion('permit');
  assert.equal(app.underpassEvent, receiptEvent);
  resolveWorld({ ...serverOpen, fullRewardClears: 0 });
  await staleRefresh;
  assert.equal(app.underpassEvent, receiptEvent);
});


test('double-tapping Underpass cannot create two concurrent battle permits', async () => {
  let resolveStart;
  let starts = 0;
  const app = make({ enabled: true, startUnderpass: async () => {
    starts += 1;
    return new Promise(resolve => { resolveStart = resolve; });
  } });
  app.underpassEvent = serverOpen;
  const routes = [];
  app.navigate = route => routes.push(route);
  const first = app.enterUnderpass();
  const second = app.enterUnderpass();
  assert.equal(starts, 1);
  resolveStart({ permitId: 'issued', cycleId: serverOpen.cycleId });
  await Promise.all([first, second]);
  assert.deepEqual(routes, ['battle']);
});

test('rejected Underpass start releases the entry lock for a later retry', async () => {
  let attempts = 0;
  const app = make({ enabled: true, getUnderpass: async () => serverOpen,
    startUnderpass: async () => {
      attempts += 1;
      if (attempts === 1) throw Error('temporary failure');
      return { permitId: 'retry', cycleId: serverOpen.cycleId };
    },
  });
  app.underpassEvent = serverOpen;
  app.render = () => {};
  const routes = [];
  app.navigate = route => routes.push(route);
  await app.enterUnderpass();
  assert.equal(app.underpassEntryPending, false);
  assert.equal(app.underpassEvent, undefined);
  // A rejected entry fails closed until the Worker confirms the event is open.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.underpassEvent?.phase, 'open');
  await app.enterUnderpass();
  assert.equal(attempts, 2);
  assert.deepEqual(routes, ['battle']);
});

test('an issued battle permit remains enterable when event closes during start', async () => {
  let resolveStart;
  const app = make({ enabled: true, startUnderpass: () => new Promise(resolve => { resolveStart = resolve; }) });
  app.underpassEvent = serverOpen;
  const routes = [];
  app.navigate = route => routes.push(route);
  const starting = app.enterUnderpass();
  app.underpassEvent = { ...serverOpen, phase: 'sealed' };
  resolveStart({ permitId: 'legal-entry', cycleId: serverOpen.cycleId });
  await starting;
  assert.equal(app.battlePermit.permitId, 'legal-entry');
  assert.deepEqual(routes, ['battle']);
});

test('1000 rapid Underpass taps issue only one pending permit', async () => {
  let resolveStart;
  let starts = 0;
  const app = make({ enabled: true, startUnderpass: () => {
    starts += 1;
    return new Promise(resolve => { resolveStart = resolve; });
  } });
  app.underpassEvent = serverOpen;
  const routes = [];
  app.navigate = route => routes.push(route);
  const pending = Array.from({ length: 1000 }, () => app.enterUnderpass());
  assert.equal(starts, 1);
  resolveStart({ permitId: 'single', cycleId: serverOpen.cycleId });
  await Promise.all(pending);
  assert.deepEqual(routes, ['battle']);
  assert.equal(app.underpassEntryPending, false);
});

test('missing server permit releases Underpass entry lock for retry', async () => {
  let attempts = 0;
  const app = make({ enabled: true, getUnderpass: async () => serverOpen,
    startUnderpass: async () => {
      attempts += 1;
      return attempts === 1 ? undefined : { permitId: 'recovered', cycleId: serverOpen.cycleId };
    },
  });
  app.underpassEvent = serverOpen;
  app.render = () => {};
  const routes = [];
  app.navigate = route => routes.push(route);
  await app.enterUnderpass();
  assert.equal(app.underpassEntryPending, false);
  assert.equal(app.underpassEvent, undefined);
  // A rejected entry fails closed until the Worker confirms the event is open.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.underpassEvent?.phase, 'open');
  await app.enterUnderpass();
  assert.equal(attempts, 2);
  assert.deepEqual(routes, ['battle']);
});

test('stale Underpass click after battle navigation cannot issue another permit', async () => {
  let starts = 0;
  const app = make({ enabled: true, startUnderpass: async () => ({
    permitId: `permit-${++starts}`, cycleId: serverOpen.cycleId,
  }) });
  app.route = 'underpass';
  app.underpassEvent = serverOpen;
  app.navigate = route => { app.route = route; };
  await app.enterUnderpass();
  assert.equal(app.route, 'battle');
  await app.enterUnderpass();
  assert.equal(starts, 1);
});

test('malformed Worker permit cannot enter battle; valid retry recovers', async () => {
  let attempts = 0;
  const app = make({ enabled: true, getUnderpass: async () => serverOpen,
    startUnderpass: async () => {
      attempts += 1;
      return attempts === 1 ? {} : { permitId: 'valid-retry', cycleId: serverOpen.cycleId };
    },
  });
  app.underpassEvent = serverOpen;
  app.route = 'underpass';
  app.render = () => {};
  app.navigate = route => { app.route = route; };
  await app.enterUnderpass();
  assert.equal(app.route, 'underpass');
  assert.equal(app.battlePermit, undefined);
  assert.equal(app.underpassEntryPending, false);
  assert.equal(app.underpassEvent, undefined);
  // A rejected entry fails closed until the Worker confirms the event is open.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.underpassEvent?.phase, 'open');
  await app.enterUnderpass();
  assert.equal(attempts, 2);
  assert.equal(app.route, 'battle');
  assert.equal(app.battlePermit.permitId, 'valid-retry');
});


test('stale Home or Map entry callbacks never request a battle permit', async () => {
  let starts = 0;
  const app = make({ enabled: true, startUnderpass: async () => {
    starts += 1;
    return { permitId: 'unexpected' };
  } });
  app.underpassEvent = serverOpen;
  app.route = 'home';
  await app.enterUnderpass();
  app.route = 'map';
  await app.enterUnderpass();
  assert.equal(starts, 0);
  assert.equal(app.battlePermit, undefined);
});

test('navigating Home while permit is pending cannot redirect to battle', async () => {
  let resolveStart;
  const app = make({ enabled: true, startUnderpass: () => new Promise(resolve => { resolveStart = resolve; }) });
  app.underpassEvent = serverOpen;
  app.render = () => {};
  app.destroyBattle = () => {};
  const pending = app.enterUnderpass();
  app.navigate('home');
  resolveStart({ permitId: 'valid-but-abandoned', cycleId: serverOpen.cycleId });
  await pending;
  assert.equal(app.route, 'home');
  assert.equal(app.battlePermit, undefined);
  assert.equal(app.underpassEntryPending, false);
});

test('returning to Underpass during pending request does not revive old navigation intent', async () => {
  let resolveStart;
  const app = make({ enabled: true, startUnderpass: () => new Promise(resolve => { resolveStart = resolve; }) });
  app.underpassEvent = serverOpen;
  app.render = () => {};
  app.destroyBattle = () => {};
  const pending = app.enterUnderpass();
  app.navigate('home');
  app.navigate('underpass');
  resolveStart({ permitId: 'valid-but-stale', cycleId: serverOpen.cycleId });
  await pending;
  assert.equal(app.route, 'underpass');
  assert.equal(app.battlePermit, undefined);
  assert.equal(app.underpassEntryPending, false);
});

test('account switch during permit issuance cannot enter another account battle', async () => {
  let resolveStart;
  const store = { snapshot: { id: 'account-a' } };
  const app = new AppController({}, store, {
    enabled: true,
    startUnderpass: () => new Promise(resolve => { resolveStart = resolve; }),
  });
  app.route = 'underpass';
  app.underpassEvent = serverOpen;
  app.render = () => {};
  const pending = app.enterUnderpass();
  store.snapshot.id = 'account-b';
  resolveStart({ permitId: 'issued-to-a', cycleId: serverOpen.cycleId });
  await pending;
  assert.equal(app.route, 'underpass');
  assert.equal(app.battlePermit, undefined);
  assert.equal(app.underpassEntryPending, false);
});

test('late reward for A cannot overwrite B and retains A retry permit', async () => {
  pendingStorage.clear();
  const state = { id: 'A' };
  let resolveReceipt;
  const receiptEvent = { ...serverOpen, cycleId: 'receipt-A' };
  const applied = [];
  const app = new AppController({}, { snapshot: state, replaceFromServer: player => applied.push(player) }, {
    enabled: true, completeUnderpass: () => new Promise(resolve => { resolveReceipt = resolve; }),
  });
  app.route = 'home';
  app.render = () => {};
  app.rememberPendingReward('permit-A', 'A');
  const pending = app.queueRewardCompletion('permit-A', 'A');
  await Promise.resolve();
  state.id = 'B';
  resolveReceipt({ player: { id: 'A' }, worldEvent: receiptEvent });
  await pending;
  assert.equal(applied.length, 0);
  assert.equal(app.underpassEvent, undefined);
  assert.deepEqual(JSON.parse(pendingStorage.get('degen.pending.reward-permits.v1:A')), ['permit-A']);
});

test('late A world-event response cannot replace B event after account change', async () => {
  let resolveEvent;
  const state = { id: 'A' };
  const app = new AppController({}, { snapshot: state }, {
    enabled: true, getUnderpass: () => new Promise(resolve => { resolveEvent = resolve; }),
  });
  app.route = 'battle';
  const pending = app.refreshWorld();
  state.id = 'B';
  resolveEvent(serverOpen);
  await pending;
  assert.equal(app.underpassEvent, undefined);
});

test('server-confirmed reward refreshes Home after successful completion', async () => {
  pendingStorage.clear();
  let renders = 0;
  const state = { id: 'A' };
  const receiptEvent = { ...serverOpen, cycleId: 'receipt-A' };
  const app = new AppController({}, {
    snapshot: state, replaceFromServer: player => { state.id = player.id; },
  }, { enabled: true, completeUnderpass: async () => ({ player: { id: 'A' }, worldEvent: receiptEvent }) });
  app.route = 'home';
  app.render = () => { renders += 1; };
  app.rememberPendingReward('permit-A', 'A');
  await app.queueRewardCompletion('permit-A', 'A');
  assert.equal(renders, 1);
  assert.equal(app.underpassEvent, receiptEvent);
  assert.deepEqual(JSON.parse(pendingStorage.get('degen.pending.reward-permits.v1:A')), []);
});

test('victory pending for A never submits A permit while B is active', async () => {
  pendingStorage.clear();
  const state = { id: 'B' };
  let completions = 0;
  const app = new AppController({}, { snapshot: state }, {
    enabled: true, completeUnderpass: async () => { completions += 1; },
  });
  app.route = 'battle';
  app.battlePermit = { permitId: 'permit-A' };
  app.battlePlayerId = 'A';
  await app.finishBattle('victory');
  assert.equal(completions, 0);
  assert.deepEqual(JSON.parse(pendingStorage.get('degen.pending.reward-permits.v1:A')), ['permit-A']);
  assert.equal(pendingStorage.has('degen.pending.reward-permits.v1:B'), false);
});


test('late Worker-confirmed victory after Home navigation uses only server completion', async () => {
  pendingStorage.clear();
  let resolveAction, completed = 0, localActions = 0;
  const state = { id: 'A' };
  const app = new AppController({}, { snapshot: state, replaceFromServer() {} }, {
    enabled: true,
    actUnderpass: () => new Promise(resolve => { resolveAction = resolve; }),
    completeUnderpass: async (playerId, permitId) => {
      assert.equal(playerId, 'A');
      assert.equal(permitId, 'permit-A');
      completed += 1;
      return { player: { id: 'A' }, worldEvent: serverOpen };
    },
  });
  app.route = 'battle';
  app.render = () => {};
  app.setAbilityButtonsDisabled = () => {};
  app.battlePermit = { permitId: 'permit-A' };
  app.battlePlayerId = 'A';
  app.battleEngine = { snapshot: { turnCount: 0, status: 'active' },
    applyAuthoritativeAction: () => { localActions += 1; } };
  const pending = app.useBattleAbility('ability');
  app.navigate('home');
  resolveAction({ permitId: 'permit-A', status: 'victory', turnCount: 1,
    playerHp: 10, playerMana: 0, enemyHp: 0 });
  await pending;
  assert.equal(localActions, 0);
  assert.equal(completed, 1);
  assert.equal(app.route, 'home');
  assert.deepEqual(JSON.parse(pendingStorage.get('degen.pending.reward-permits.v1:A')), []);
});

test('detached terminal turn conflict can recover a server-confirmed victory', async () => {
  pendingStorage.clear();
  let rejectAction, completed = 0;
  const app = new AppController({}, { snapshot: { id: 'A' }, replaceFromServer() {} }, {
    enabled: true,
    actUnderpass: () => new Promise((resolve, reject) => { rejectAction = reject; }),
    completeUnderpass: async () => {
      completed += 1;
      return { player: { id: 'A' }, worldEvent: serverOpen };
    },
  });
  app.route = 'battle';
  app.render = () => {};
  app.setAbilityButtonsDisabled = () => {};
  app.battlePermit = { permitId: 'permit-A' };
  app.battlePlayerId = 'A';
  app.battleEngine = { snapshot: { turnCount: 0, status: 'active' },
    syncAuthoritativeState: () => { throw Error('detached engine cannot sync'); } };
  const pending = app.useBattleAbility('ability');
  app.navigate('home');
  rejectAction(new BattleTurnConflictError({ permitId: 'permit-A', status: 'victory',
    turnCount: 1, playerHp: 10, playerMana: 0, enemyHp: 0 }));
  await pending;
  assert.equal(completed, 1);
});

test('late account-A victory cannot claim a reward while account B is active', async () => {
  pendingStorage.clear();
  let resolveAction, completed = 0;
  const state = { id: 'A' };
  const app = new AppController({}, { snapshot: state }, {
    enabled: true,
    actUnderpass: () => new Promise(resolve => { resolveAction = resolve; }),
    completeUnderpass: async () => { completed += 1; },
  });
  app.route = 'battle';
  app.setAbilityButtonsDisabled = () => {};
  app.battlePermit = { permitId: 'permit-A' };
  app.battlePlayerId = 'A';
  app.battleEngine = { snapshot: { turnCount: 0, status: 'active' },
    applyAuthoritativeAction: () => { throw Error('wrong account'); } };
  const pending = app.useBattleAbility('ability');
  state.id = 'B';
  resolveAction({ permitId: 'permit-A', status: 'victory', turnCount: 1,
    playerHp: 10, playerMana: 0, enemyHp: 0 });
  await pending;
  assert.equal(completed, 0);
  assert.deepEqual(JSON.parse(pendingStorage.get('degen.pending.reward-permits.v1:A')), ['permit-A']);
  assert.equal(pendingStorage.has('degen.pending.reward-permits.v1:B'), false);
});

test('failed fresh Underpass entry clears a detached old battle permit', async () => {
  const app = make({ enabled: true,
    getUnderpass: async () => serverOpen,
    startUnderpass: async () => { throw Error('temporary'); },
  });
  app.underpassEvent = serverOpen;
  app.battlePermit = { permitId: 'old-battle' };
  app.battlePlayerId = 'p1';
  app.render = () => {};
  await app.enterUnderpass();
  assert.equal(app.battlePermit, undefined);
  assert.equal(app.battlePlayerId, undefined);
});

test('detached non-victory response cannot trigger reward completion', async () => {
  pendingStorage.clear();
  let resolveAction, completed = 0;
  const app = new AppController({}, { snapshot: { id: 'A' } }, {
    enabled: true,
    actUnderpass: () => new Promise(resolve => { resolveAction = resolve; }),
    completeUnderpass: async () => { completed += 1; },
  });
  app.route = 'battle';
  app.render = () => {};
  app.setAbilityButtonsDisabled = () => {};
  app.battlePermit = { permitId: 'permit-A' };
  app.battlePlayerId = 'A';
  app.battleEngine = { snapshot: { turnCount: 0, status: 'active' } };
  const pending = app.useBattleAbility('ability');
  app.navigate('home');
  resolveAction({ permitId: 'permit-A', status: 'active', turnCount: 1,
    playerHp: 10, playerMana: 0, enemyHp: 10 });
  await pending;
  assert.equal(completed, 0);
  assert.equal(pendingStorage.has('degen.pending.reward-permits.v1:A'), false);
});

test('mismatched Worker permit response never queues a reward', async () => {
  pendingStorage.clear();
  let completed = 0;
  const app = new AppController({}, { snapshot: { id: 'A' } }, {
    enabled: true,
    actUnderpass: async () => ({ permitId: 'another-permit', status: 'victory' }),
    completeUnderpass: async () => { completed += 1; },
  });
  app.route = 'battle';
  app.setAbilityButtonsDisabled = () => {};
  app.battlePermit = { permitId: 'permit-A' };
  app.battlePlayerId = 'A';
  app.battleEngine = { snapshot: { turnCount: 0, status: 'active' } };
  await app.useBattleAbility('ability');
  assert.equal(completed, 0);
  assert.equal(pendingStorage.has('degen.pending.reward-permits.v1:A'), false);
});

test('late old victory cannot overwrite a newer same-account battle', async () => {
  pendingStorage.clear();
  let resolveAction, completed = 0, newEngineApplied = 0;
  const app = new AppController({}, { snapshot: { id: 'A' }, replaceFromServer() {} }, {
    enabled: true,
    actUnderpass: () => new Promise(resolve => { resolveAction = resolve; }),
    completeUnderpass: async (playerId, permitId) => {
      assert.equal(playerId, 'A');
      assert.equal(permitId, 'old-permit');
      completed += 1;
      return { player: { id: 'A' }, worldEvent: serverOpen };
    },
  });
  app.route = 'battle';
  app.setAbilityButtonsDisabled = () => {};
  app.battlePermit = { permitId: 'old-permit' };
  app.battlePlayerId = 'A';
  const oldEngine = { snapshot: { turnCount: 0, status: 'active' },
    applyAuthoritativeAction: () => { throw Error('old engine must not apply'); } };
  app.battleEngine = oldEngine;
  const pending = app.useBattleAbility('ability');
  app.battlePermit = { permitId: 'new-permit' };
  app.battleEngine = { snapshot: { turnCount: 0, status: 'active' },
    applyAuthoritativeAction: () => { newEngineApplied += 1; } };
  resolveAction({ permitId: 'old-permit', status: 'victory', turnCount: 1,
    playerHp: 10, playerMana: 0, enemyHp: 0 });
  await pending;
  assert.equal(completed, 1);
  assert.equal(newEngineApplied, 0);
  assert.equal(app.battlePermit.permitId, 'new-permit');
  assert.deepEqual(JSON.parse(pendingStorage.get('degen.pending.reward-permits.v1:A')), []);
});



test('timed-out Underpass entry unlocks before a stalled world resync finishes', async () => {
  let resolveWorld;
  let polls = 0;
  const app = make({
    enabled: true,
    startUnderpass: async () => { throw Error('permit timeout'); },
    getUnderpass: () => { polls += 1; return new Promise(resolve => { resolveWorld = resolve; }); },
  });
  app.underpassEvent = serverOpen;
  let renders = 0;
  app.render = () => { renders += 1; };
  await app.enterUnderpass();
  assert.equal(app.underpassEntryPending, false);
  assert.equal(app.underpassEvent, undefined);
  assert.equal(app.battlePermit, undefined);
  assert.equal(polls, 1);
  assert.equal(renders, 1);
  resolveWorld(serverOpen);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.underpassEvent, serverOpen);
  assert.equal(renders, 2);
});

test('late failed entry from a previous account cannot erase the current world event', async () => {
  let rejectEntry;
  let polls = 0;
  const app = make({
    enabled: true,
    startUnderpass: () => new Promise((_resolve, reject) => { rejectEntry = reject; }),
    getUnderpass: async () => { polls += 1; return serverOpen; },
  });
  app.underpassEvent = serverOpen;
  let renders = 0;
  app.render = () => { renders += 1; };
  const pending = app.enterUnderpass();
  app.store.snapshot.id = 'different-player';
  app.route = 'home';
  app.navigationGeneration += 1;
  const otherAccountEvent = { ...serverOpen, cycleId: 'other-account-cycle' };
  app.underpassEvent = otherAccountEvent;
  rejectEntry(Error('late permit timeout'));
  await pending;
  assert.equal(app.underpassEvent, otherAccountEvent);
  assert.equal(app.underpassEntryPending, false);
  assert.equal(polls, 0);
  assert.equal(renders, 0);
});
