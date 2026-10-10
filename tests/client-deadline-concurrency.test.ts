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

test('concurrent bootstrap/completion deadlines remain isolated and release every timer', async () => {
  const scheduled = new Map<number, () => void>();
  const cleared = new Set<number>();
  const signals = new Set<AbortSignal>();
  const pending = new Set<number>();
  let nextId = 1;
  let requests = 0;
  const Api = runInNewContext(compiled + '\nGameApi;', {
    fetch: async (_url: string, init: RequestInit) => {
      requests += 1;
      const requestId = requests;
      const signal = init.signal as AbortSignal;
      assert.ok(signal && !signals.has(signal));
      signals.add(signal);
      if (requestId % 2 === 0) {
        return new Response(JSON.stringify({ player: { id: `p${requestId}` } }), { status: 200 });
      }
      pending.add(requestId);
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          pending.delete(requestId);
          reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
      });
    },
    setTimeout: (fn: () => void, ms: number) => {
      assert.ok(ms === 15_000 || ms === 20_000);
      const id = nextId++;
      scheduled.set(id, fn);
      return id;
    },
    clearTimeout: (id: number) => { cleared.add(id); },
    AbortController,
    Response,
    console,
  }) as new () => {
    bootstrap(id: string, identity: { displayName: string; platform: string; platformUserId: string }): Promise<unknown>;
    completeUnderpass(id: string, permit: string): Promise<unknown>;
  };
  const api = new Api();
  const work: Promise<unknown>[] = [];
  for (let i = 0; i < 500; i++) {
    work.push(i % 2 === 0
      ? api.bootstrap(`p${i}`, { displayName: 'P', platform: 'browser', platformUserId: `${i}` })
      : api.completeUnderpass(`p${i}`, `permit-${i}`));
  }
  await new Promise(resolve => setImmediate(resolve));
  for (const [id, fn] of scheduled) if (!cleared.has(id)) fn();
  const results = await Promise.allSettled(work);
  assert.equal(requests, 500);
  assert.equal(signals.size, 500);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 250);
  assert.equal(results.filter(r => r.status === 'rejected' && r.reason.name === 'AbortError').length, 250);
  assert.equal(cleared.size, 500);
  assert.equal(pending.size, 0);
});
