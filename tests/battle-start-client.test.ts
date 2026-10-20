import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';

const source = readFileSync(new URL('../src/app/api.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace('import.meta.env.VITE_API_BASE', 'globalThis.__API_BASE')
  .replace('export class GameApi', 'class GameApi');
const GameApi = runInNewContext(stripTypeScriptTypes(source, { mode: 'transform' }) + '\nGameApi;', {
  __API_BASE: 'https://degen-api.example', TEST_DEGEN, TUNNEL_MAW,
  fetch: (...args: any[]) => globalThis.fetch(...args), Response, URL, AbortController, setTimeout, clearTimeout,
  Date, Number, JSON, Error, encodeURIComponent, console,
}) as new () => { startUnderpass(playerId: string, cycleId: string): Promise<unknown> };

const validPermit = () => {
  const permitId = 'permit-1';
  return {
    permitId, eventKey: 'underpass', cycleId: 'cycle-1', encounterKey: TUNNEL_MAW.id,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    initialState: {
      permitId, status: 'active', playerHp: TEST_DEGEN.maxHp,
      playerMana: 0, enemyHp: TUNNEL_MAW.maxHp, turnCount: 0,
    },
  };
};

async function apiReturning(value: unknown) {
  const api = new GameApi();
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(value), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  try { return await api.startUnderpass('player-1', 'cycle-1'); }
  finally { globalThis.fetch = oldFetch; }
}

test('server-backed battle start accepts a valid authoritative zero-Mana snapshot', async () => {
  const permit = validPermit();
  const result = await apiReturning(permit) as typeof permit;
  assert.deepEqual(result.initialState, permit.initialState);
});

test('server-backed battle start rejects an expired permit before entering combat', async () => {
  const permit = validPermit();
  permit.expiresAt = new Date(Date.now() - 60_000).toISOString();
  await assert.rejects(apiReturning(permit), /Missing or malformed authoritative battle start state/);
});

test('server-backed battle start rejects a snapshot for another permit or an out-of-range Mana value', async () => {
  const wrongPermit = validPermit();
  wrongPermit.initialState.permitId = 'other-permit';
  await assert.rejects(apiReturning(wrongPermit), /Missing or malformed authoritative battle start state/);

  const excessiveMana = validPermit();
  excessiveMana.initialState.playerMana = TEST_DEGEN.maxMana + 1;
  await assert.rejects(apiReturning(excessiveMana), /Missing or malformed authoritative battle start state/);
});

test('server-backed battle start rejects a non-initial turn count', async () => {
  const permit = validPermit();
  permit.initialState.turnCount = 1;
  await assert.rejects(apiReturning(permit), /Missing or malformed authoritative battle start state/);
});
