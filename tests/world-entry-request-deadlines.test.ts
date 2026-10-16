import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../src/app/api.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '')
  .replace(/^const API_BASE = .*;$/m, "const API_BASE = 'https://example.invalid';")
  .replace(/export class /g, 'class ');
const compiled = stripTypeScriptTypes(source, { mode: 'transform' });

type Api = {
  getUnderpass(playerId: string): Promise<unknown>;
  startUnderpass(playerId: string, cycleId: string): Promise<unknown>;
};

function fixture(complete = false) {
  const timers = new Map<number, { fire: () => void; ms: number }>();
  const cleared = new Set<number>();
  const calls: Array<{ path: string; signal: AbortSignal; method: string; body?: unknown }> = [];
  let nextId = 0;
  const ApiClass = runInNewContext(compiled + '\nGameApi;', {
    AbortController, Response, console,
    setTimeout: (fire: () => void, ms: number) => {
      const id = ++nextId;
      timers.set(id, { fire, ms });
      return id;
    },
    clearTimeout: (id: number) => { cleared.add(id); },
    fetch: async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const signal = init.signal as AbortSignal;
      calls.push({ path, signal, method: init.method ?? 'GET',
        body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (complete) return Response.json(path === '/api/battle/start'
        ? { permitId: 'worker-permit', cycleId: 'cycle' }
        : { source: 'server', phase: 'open', cycleId: 'cycle' });
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
      });
    },
  }) as new () => Api;
  return { api: new ApiClass(), timers, cleared, calls };
}

test('world request aborts at 15 seconds and never creates a preview event', async () => {
  const f = fixture();
  const pending = f.api.getUnderpass('owner');
  assert.equal(f.calls[0]?.path, '/api/world/underpass');
  assert.equal(f.calls[0]?.method, 'GET');
  assert.equal(f.timers.get(1)?.ms, 15_000);
  f.timers.get(1)?.fire();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.calls[0]?.signal.aborted, true);
  assert.deepEqual([...f.cleared], [1]);
});

test('permit request aborts at 20 seconds without fabricating a permit', async () => {
  const f = fixture();
  const pending = f.api.startUnderpass('owner', 'cycle');
  assert.equal(f.calls[0]?.path, '/api/battle/start');
  assert.equal(f.calls[0]?.method, 'POST');
  assert.deepEqual(f.calls[0]?.body, { playerId: 'owner', eventKey: 'underpass',
    cycleId: 'cycle', encounterKey: 'tunnel-maw' });
  assert.equal(f.timers.get(1)?.ms, 20_000);
  f.timers.get(1)?.fire();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual([...f.cleared], [1]);
});

test('successful world and permit responses retain Worker data and clear timers', async () => {
  const f = fixture(true);
  assert.deepEqual(await f.api.getUnderpass('owner'), { source: 'server', phase: 'open', cycleId: 'cycle' });
  assert.deepEqual(await f.api.startUnderpass('owner', 'cycle'), { permitId: 'worker-permit', cycleId: 'cycle' });
  assert.deepEqual([...f.cleared], [1, 2]);
  assert.ok(f.calls.every(call => !call.signal.aborted));
});

test('simultaneous world and entry deadlines never share abort signals', async () => {
  const f = fixture();
  const world = f.api.getUnderpass('owner');
  const entry = f.api.startUnderpass('owner', 'cycle');
  assert.notEqual(f.calls[0]?.signal, f.calls[1]?.signal);
  f.timers.get(1)?.fire();
  await assert.rejects(world, { name: 'AbortError' });
  assert.equal(f.calls[1]?.signal.aborted, false);
  f.timers.get(2)?.fire();
  await assert.rejects(entry, { name: 'AbortError' });
  assert.deepEqual([...f.cleared], [1, 2]);
});
