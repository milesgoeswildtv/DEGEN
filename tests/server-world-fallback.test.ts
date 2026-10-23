import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../src/app/AppController.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/\bexport class /g, 'class ');

type EventSnapshot = {
  eventKey: string;
  cycleId: string;
  phase: 'sealed' | 'warning' | 'open';
  opensAt: string;
  closesAt: string;
  fullRewardClears: number;
  fullRewardLimit: number;
  source: 'server' | 'preview';
};

function loadController(preview: EventSnapshot) {
  let previewCalls = 0;
  const loaded = runInNewContext(
    stripTypeScriptTypes(source, { mode: 'transform' }) + '\n({ AppController });',
    {
      getPreviewUnderpass: () => {
        previewCalls += 1;
        return preview;
      },
      console: { warn: () => undefined },
    },
  ) as {
    AppController: new (
      root: unknown,
      store: { snapshot: { id: string } },
      api: { enabled: boolean; getUnderpass: (id: string) => Promise<EventSnapshot> },
    ) => { refreshWorld: () => Promise<void>; underpassEvent?: EventSnapshot };
  };
  return { AppController: loaded.AppController, previewCalls: () => previewCalls };
}

const previewEvent: EventSnapshot = {
  eventKey: 'underpass',
  cycleId: 'local-preview-cycle',
  phase: 'open',
  opensAt: '2026-10-23T00:00:00.000Z',
  closesAt: '2026-10-23T01:00:00.000Z',
  fullRewardClears: 0,
  fullRewardLimit: 3,
  source: 'preview',
};

test('server-backed world refresh failure never fabricates a local Underpass cycle', async () => {
  const loaded = loadController(previewEvent);
  const controller = new loaded.AppController(
    {},
    { snapshot: { id: 'player-1' } },
    { enabled: true, getUnderpass: async () => { throw new Error('session expired'); } },
  );

  await controller.refreshWorld();

  assert.equal(controller.underpassEvent, undefined);
  assert.equal(loaded.previewCalls(), 0, 'server-backed mode must not call the local preview generator');
});

test('offline preview still uses its local Underpass cycle when no Worker is configured', async () => {
  const loaded = loadController(previewEvent);
  const controller = new loaded.AppController(
    {},
    { snapshot: { id: 'player-1' } },
    { enabled: false, getUnderpass: async () => { throw new Error('must not be called'); } },
  );

  await controller.refreshWorld();

  assert.equal(controller.underpassEvent, previewEvent);
  assert.equal(loaded.previewCalls(), 1);
});
