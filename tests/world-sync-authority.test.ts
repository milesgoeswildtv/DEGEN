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
const AppController = runInNewContext(stripped + '\nAppController;', {
  getPreviewUnderpass: () => { previewCalls += 1; return preview; },
  console: { warn() {} },
  localStorage: { getItem: () => null, setItem: () => {} },
});
const serverOpen = { ...preview, cycleId: 'server-cycle', source: 'server' };
const make = (api) => new AppController({}, { snapshot: { id: 'p1' } }, api);

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
