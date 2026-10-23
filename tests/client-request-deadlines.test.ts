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

test('bootstrap and completion deadlines independently abort and clear timers', async () => {
  const cases = [
    { method: 'bootstrap', timeout: 15_000, path: '/api/player/bootstrap' },
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
      : api.completeUnderpass('p', 'permit');
    await assert.rejects(operation, { name: 'AbortError' });
    assert.equal(observed, item.path);
    assert.ok(aborted && cleared);
  }
});
