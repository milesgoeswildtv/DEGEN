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
    ) => { refreshWorld: () => Promise<void>; underpassEvent?: EventSnapshot; worldSyncFailed?: boolean; render: () => void };
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


test('a world refresh from a previous player cannot overwrite the active player snapshot', async () => {
  const loaded = loadController(previewEvent);
  const requests: string[] = [];
  let resolvePrevious!: (event: EventSnapshot) => void;
  const previousEvent: EventSnapshot = {
    ...previewEvent, cycleId: 'player-1-cycle', source: 'server',
  };
  const currentEvent: EventSnapshot = {
    ...previewEvent, cycleId: 'player-2-cycle', source: 'server',
  };
  const store = { snapshot: { id: 'player-1' } };
  const controller = new loaded.AppController({}, store, {
    enabled: true,
    getUnderpass: (playerId: string) => {
      requests.push(playerId);
      if (playerId === 'player-1') {
        return new Promise<EventSnapshot>((resolve) => { resolvePrevious = resolve; });
      }
      return Promise.resolve(currentEvent);
    },
  });

  let renderCount = 0;
  controller.render = () => { renderCount += 1; };
  const previousRefresh = controller.refreshWorld();
  store.snapshot.id = 'player-2';
  resolvePrevious(previousEvent);
  await previousRefresh;

  assert.deepEqual(requests, ['player-1', 'player-2']);
  assert.equal(controller.underpassEvent?.cycleId, 'player-2-cycle');
  assert.equal(controller.worldSyncFailed, false);
  assert.equal(renderCount, 1, 'the replacement account refresh must rerender even when the original refresh was non-rendering');
});

test('a stale previous-player world failure cannot mark the active player offline', async () => {
  const loaded = loadController(previewEvent);
  const requests: string[] = [];
  let rejectPrevious!: (error: Error) => void;
  const currentEvent: EventSnapshot = {
    ...previewEvent, cycleId: 'player-2-cycle', source: 'server',
  };
  const store = { snapshot: { id: 'player-1' } };
  const controller = new loaded.AppController({}, store, {
    enabled: true,
    getUnderpass: (playerId: string) => {
      requests.push(playerId);
      if (playerId === 'player-1') {
        return new Promise<EventSnapshot>((_resolve, reject) => { rejectPrevious = reject; });
      }
      return Promise.resolve(currentEvent);
    },
  });

  controller.render = () => {};
  const previousRefresh = controller.refreshWorld();
  store.snapshot.id = 'player-2';
  rejectPrevious(new Error('stale player session expired'));
  await previousRefresh;

  assert.deepEqual(requests, ['player-1', 'player-2']);
  assert.equal(controller.underpassEvent?.cycleId, 'player-2-cycle');
  assert.equal(controller.worldSyncFailed, false);
  assert.equal(loaded.previewCalls(), 0);
});



test('a stale previous-player response awaits a fail-closed refresh for the active player', async () => {
  const loaded = loadController(previewEvent);
  const requests: string[] = [];
  const previousEvent: EventSnapshot = {
    ...previewEvent, cycleId: 'player-1-cycle', source: 'server',
  };
  const store = { snapshot: { id: 'player-1' } };
  const controller = new loaded.AppController({}, store, {
    enabled: true,
    getUnderpass: async (playerId: string) => {
      requests.push(playerId);
      if (playerId === 'player-1') return previousEvent;
      throw new Error('active player session unavailable');
    },
  });

  const previousRefresh = controller.refreshWorld();
  store.snapshot.id = 'player-2';
  await previousRefresh;

  assert.deepEqual(requests, ['player-1', 'player-2']);
  assert.equal(controller.underpassEvent, undefined);
  assert.equal(controller.worldSyncFailed, true);
  assert.equal(loaded.previewCalls(), 0, 'an active-player failure must never fall back to preview state');
});

test('an older player refresh cannot overwrite or restart while the active player refresh is pending', async () => {
  const loaded = loadController(previewEvent);
  const requests: string[] = [];
  let playerOneReads = 0;
  let resolveOlder!: (event: EventSnapshot) => void;
  let resolveCurrent!: (event: EventSnapshot) => void;
  const initialEvent: EventSnapshot = {
    ...previewEvent, cycleId: 'player-1-initial-cycle', source: 'server',
  };
  const staleEvent: EventSnapshot = {
    ...previewEvent, cycleId: 'player-1-stale-cycle', source: 'server',
  };
  const currentEvent: EventSnapshot = {
    ...previewEvent, cycleId: 'player-2-current-cycle', source: 'server',
  };
  const store = { snapshot: { id: 'player-1' } };
  const controller = new loaded.AppController({}, store, {
    enabled: true,
    getUnderpass: (playerId: string) => {
      requests.push(playerId);
      if (playerId === 'player-1') {
        playerOneReads += 1;
        return playerOneReads === 1
          ? Promise.resolve(initialEvent)
          : new Promise<EventSnapshot>((resolve) => { resolveOlder = resolve; });
      }
      return new Promise<EventSnapshot>((resolve) => { resolveCurrent = resolve; });
    },
  });
  let renderCount = 0;
  controller.render = () => { renderCount += 1; };

  await controller.refreshWorld();
  assert.equal(controller.underpassEvent?.cycleId, 'player-1-initial-cycle');

  const olderRefresh = controller.refreshWorld();
  store.snapshot.id = 'player-2';
  const activeRefresh = controller.refreshWorld(true);

  assert.equal(renderCount, 1, 'the previous account snapshot is cleared and rerendered immediately');
  assert.deepEqual(requests, ['player-1', 'player-1', 'player-2']);
  assert.equal(controller.underpassEvent, undefined,
    'the previous account event must be cleared while the active account is syncing');

  resolveOlder(staleEvent);
  await olderRefresh;

  assert.deepEqual(requests, ['player-1', 'player-1', 'player-2'],
    'a superseded stale request must not start a duplicate active-player read');
  assert.equal(controller.underpassEvent, undefined,
    'a stale response must not repopulate the previous account event while the active read is pending');

  resolveCurrent(currentEvent);
  await activeRefresh;

  assert.equal(controller.underpassEvent?.cycleId, 'player-2-current-cycle');
  assert.equal(controller.worldSyncFailed, false);
  assert.equal(loaded.previewCalls(), 0);
  assert.equal(renderCount, 2, 'the active player snapshot is rendered after its refresh settles');
});

test('an older overlapping world read cannot replace a newer snapshot for the same player', async () => {
  const loaded = loadController(previewEvent);
  let resolveOlder!: (event: EventSnapshot) => void;
  let requestCount = 0;
  const olderEvent: EventSnapshot = {
    ...previewEvent, cycleId: 'older-cycle', source: 'server',
  };
  const newerEvent: EventSnapshot = {
    ...previewEvent, cycleId: 'newer-cycle', source: 'server',
  };
  const controller = new loaded.AppController(
    {},
    { snapshot: { id: 'player-1' } },
    {
      enabled: true,
      getUnderpass: () => {
        requestCount += 1;
        return requestCount === 1
          ? new Promise<EventSnapshot>((resolve) => { resolveOlder = resolve; })
          : Promise.resolve(newerEvent);
      },
    },
  );

  const olderRefresh = controller.refreshWorld();
  await controller.refreshWorld();
  resolveOlder(olderEvent);
  await olderRefresh;

  assert.equal(requestCount, 2);
  assert.equal(controller.underpassEvent?.cycleId, 'newer-cycle');
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
