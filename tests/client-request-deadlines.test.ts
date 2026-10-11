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

test('bootstrap, housing and completion deadlines independently abort and clear timers', async () => {
  const cases = [
    { method: 'bootstrap', timeout: 15_000, path: '/api/player/bootstrap' },
    { method: 'saveHousing', timeout: 20_000, path: '/api/player/housing' },
    { method: 'completeUnderpass', timeout: 20_000, path: '/api/battle/complete' },
  ] as const;
  for (const item of cases) {
    let observed = '';
    let cleared = false;
    let aborted = false;
    const Api = runInNewContext(compiled + '\nGameApi;', {
      fetch: (url: string, init: RequestInit) => {
        observed = new URL(url).pathname;
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('Aborted', 'AbortError'));
          }, { once: true });
        });
      },
      setTimeout: (fn: () => void, ms: number) => {
        assert.equal(ms, item.timeout);
        queueMicrotask(fn);
        return 1;
      },
      clearTimeout: () => { cleared = true; },
      AbortController,
      console,
    });
    const api = new Api();
    const operation = item.method === 'bootstrap'
      ? api.bootstrap('p', { displayName: 'P', platform: 'browser', platformUserId: 'p' })
      : item.method === 'saveHousing'
        ? api.saveHousing('p', { inventory: [], placements: [] })
        : api.completeUnderpass('p', 'permit');
    await assert.rejects(operation, { name: 'AbortError' });
    assert.equal(observed, item.path);
    assert.ok(aborted && cleared);
  }
});

test('successful housing save clears its deadline without aborting', async () => {
  let cleared = 0;
  let signal: AbortSignal | undefined;
  const Api = runInNewContext(compiled + '\nGameApi;', {
    fetch: async (_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Response(null, { status: 204 });
    },
    setTimeout: (_fn: () => void, ms: number) => {
      assert.equal(ms, 20_000);
      return 7;
    },
    clearTimeout: (timer: number) => {
      assert.equal(timer, 7);
      cleared += 1;
    },
    AbortController, Response, console,
  });
  const api = new Api();
  await api.saveHousing('p', { inventory: [], placements: [] });
  assert.equal(cleared, 1);
  assert.equal(signal?.aborted, false);
});
