import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';
import { canUseAbility, resolveCombatTurn } from '../src/game/combat/rules.ts';
import { UNDERPASS_FULL_REWARD_LIMIT, advanceLevel, underpassRewardForClear } from '../src/game/progression.ts';

const source = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\\r?\\n/gm, '')
  .replace(/^export default\\s*\\{/m, 'const worker = {');
const worker = runInNewContext(stripTypeScriptTypes(source, { mode: 'transform' }) + '\\nworker;', {
  TEST_DEGEN, TUNNEL_MAW, canUseAbility, resolveCombatTurn,
  UNDERPASS_FULL_REWARD_LIMIT, advanceLevel, underpassRewardForClear,
  crypto: globalThis.crypto, Request, Response, URL, Uint32Array,
  console: { error() {} },
}) as {
  fetch(request: Request, env: { DB: unknown }): Promise<Response>;
};

test('malformed and non-object JSON request bodies return 400 before touching D1', async () => {
  const cases = [
    { body: '{', error: 'Request body must be valid JSON.' },
    { body: 'null', error: 'Request body must be a JSON object.' },
    { body: '[]', error: 'Request body must be a JSON object.' },
    { body: '"not-an-object"', error: 'Request body must be a JSON object.' },
  ];
  for (const scenario of cases) {
    const response = await worker.fetch(new Request('https://degen-api.example/api/battle/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: scenario.body,
    }), {
      DB: { prepare() { throw new Error('D1 must not be touched for invalid input'); } },
    });
    assert.equal(response.status, 400, scenario.body);
    assert.deepEqual(await response.json(), { error: scenario.error });
  }
});

test('unexpected Worker exceptions return a generic 500 without exposing internal details', async () => {
  const response = await worker.fetch(
    new Request('https://degen-api.example/api/world/underpass?playerId=player-1'),
    { DB: { prepare() { throw new Error('private SQL text and internal binding details'); } } },
  );
  assert.equal(response.status, 500);
  const payload = await response.json() as { error: string };
  assert.deepEqual(payload, { error: 'Internal server error' });
  assert.doesNotMatch(JSON.stringify(payload), /private SQL text|internal binding details/i);
});
