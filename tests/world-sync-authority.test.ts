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
