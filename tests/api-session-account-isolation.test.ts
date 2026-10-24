import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';

const source = readFileSync(new URL('../src/app/api.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace('import.meta.env.VITE_API_BASE', 'globalThis.__API_BASE')
  .replace(/\bexport class /g, 'class ')
  .replace(/\bexport const /g, 'const ');

const sessionValues = new Map<string, string>();

const { GameApi } = runInNewContext(
  stripTypeScriptTypes(source, { mode: 'transform' }) + '\n({ GameApi });',
  {
    __API_BASE: 'https://degen-api.example',
    TEST_DEGEN,
    TUNNEL_MAW,
    fetch: (...args: unknown[]) => globalThis.fetch(...args as [RequestInfo | URL, RequestInit?]),
    Response,
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
    Date,
    Number,
    JSON,
    Error,
    encodeURIComponent,
    console,
    sessionStorage: {
      getItem: (key: string) => sessionValues.get(key) ?? null,
      setItem: (key: string, value: string) => { sessionValues.set(key, value); },
      removeItem: (key: string) => { sessionValues.delete(key); },
    },
  },
) as {
  GameApi: new () => {
    bootstrap(identity: { platform: 'telegram'; displayName: string; telegramInitData: string }): Promise<unknown>;
    setIdentityProvider(provider: () => Promise<{ platform: 'telegram'; displayName: string; telegramInitData: string }>): void;
    actUnderpass(playerId: string, permitId: string, abilityId: string, expectedTurnCount: number): Promise<{ turnCount: number } | undefined>;
    getUnderpass(playerId: string): Promise<unknown>;
    saveHousing(playerId: string, housing: { inventory: string[]; placements: unknown[] }): Promise<void>;
  };
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('housing saves reject a stale queued owner instead of writing under the current session', async () => {
  const api = new GameApi();
  const oldFetch = globalThis.fetch;
  const housingRequests: Array<{ authorization: string; body: unknown }> = [];
  let bootstraps = 0;
  globalThis.fetch = async (input, init) => {
    const path = String(input).replace('https://degen-api.example', '');
    if (path === '/api/player/bootstrap') {
      bootstraps += 1;
      const playerId = bootstraps === 1 ? 'player-A' : 'player-B';
      const token = bootstraps === 1 ? 'A'.repeat(43) : 'B'.repeat(43);
      return jsonResponse({
        player: { id: playerId, displayName: playerId },
        session: { token, expiresAtMs: Date.now() + 60_000 },
      });
    }
    if (path === '/api/player/housing') {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      housingRequests.push({
        authorization: headers.authorization ?? '',
        body: JSON.parse(String(init?.body ?? '{}')),
      });
      return new Response(null, { status: 204 });
    }
    throw new Error('Unexpected API request: ' + path);
  };

  try {
    await api.bootstrap({ platform: 'telegram', displayName: 'Player A', telegramInitData: 'proof-A' });
    await api.bootstrap({ platform: 'telegram', displayName: 'Player B', telegramInitData: 'proof-B' });

    await assert.rejects(
      api.saveHousing('player-A', { inventory: [], placements: [] }),
      /authenticated player mismatch/,
    );
    assert.equal(housingRequests.length, 0,
      'a stale queued layout must not be sent with the new account bearer token');

    await api.saveHousing('player-B', { inventory: [], placements: [] });
    assert.equal(housingRequests.length, 1);
    assert.equal(housingRequests[0]!.authorization, 'Bearer ' + 'B'.repeat(43));
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('an expired account session never replays an in-flight action under a different player', async () => {
  const api = new GameApi();
  const identityA = { platform: 'telegram' as const, displayName: 'Player A', telegramInitData: 'proof-A' };
  const identityB = { platform: 'telegram' as const, displayName: 'Player B', telegramInitData: 'proof-B' };
  const tokenA = 'A'.repeat(43);
  const tokenB = 'B'.repeat(43);
  const oldFetch = globalThis.fetch;
  let bootstrapCount = 0;
  let accountAActions = 0;
  const actionTokens: string[] = [];
  let worldSnapshotToken = '';
  let releaseStale401!: (response: Response) => void;
  const stale401 = new Promise<Response>((resolve) => { releaseStale401 = resolve; });

  globalThis.fetch = async (input, init) => {
    const path = String(input).replace('https://degen-api.example', '');
    if (path === '/api/player/bootstrap') {
      bootstrapCount += 1;
      const playerId = bootstrapCount === 1 ? 'player-A' : 'player-B';
      const token = bootstrapCount === 1 ? tokenA : tokenB;
      return jsonResponse({
        player: { id: playerId, displayName: playerId },
        session: { token, expiresAtMs: Date.now() + 60_000 },
      });
    }

    if (path === '/api/world/underpass') {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      worldSnapshotToken = headers.authorization ?? '';
      return jsonResponse({
        eventKey: 'underpass', cycleId: 'cycle-B', phase: 'open',
        opensAt: new Date(Date.now() - 1_000).toISOString(),
        closesAt: new Date(Date.now() + 60_000).toISOString(),
        fullRewardClears: 0, fullRewardLimit: 3, source: 'server',
      });
    }

    if (path === '/api/battle/action') {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const token = headers.authorization ?? '';
      actionTokens.push(token);

      if (token === 'Bearer ' + tokenA) {
        accountAActions += 1;
        if (accountAActions === 1) return jsonResponse({ error: 'expired' }, 401);
        if (accountAActions === 2) return stale401;
      }

      if (token === 'Bearer ' + tokenB) {
        return jsonResponse({
          permitId: 'permit-1',
          status: 'active',
          playerHp: 70,
          playerMana: 0,
          enemyHp: 20,
          turnCount: 1,
        });
      }
    }

    throw new Error('Unexpected API request: ' + path);
  };

  try {
    await api.bootstrap(identityA);
    // Simulate a page reload: the token and its owner must be restored together.
    const reloadedApi = new GameApi();
    reloadedApi.setIdentityProvider(async () => identityB);

    const expiredRequest = reloadedApi.actUnderpass('player-A', 'permit-1', 'slash', 0);
    const delayedOldAccountRequest = reloadedApi.actUnderpass('player-A', 'permit-1', 'slash', 0);

    await assert.rejects(expiredRequest, /authenticated player changed/);
    releaseStale401(jsonResponse({ error: 'expired' }, 401));
    await assert.rejects(delayedOldAccountRequest, /authenticated player changed/);

    // The rejected old-account requests must not clear or reuse Player B's new session.
    const currentAccountSnapshot = await reloadedApi.getUnderpass('player-B');
    assert.equal((currentAccountSnapshot as { cycleId: string }).cycleId, 'cycle-B');
    assert.equal(worldSnapshotToken, 'Bearer ' + tokenB);
    assert.equal(bootstrapCount, 2, 'only one rebootstrap should occur');
    assert.deepEqual(actionTokens, ['Bearer ' + tokenA, 'Bearer ' + tokenA]);
  } finally {
    globalThis.fetch = oldFetch;
  }
});
