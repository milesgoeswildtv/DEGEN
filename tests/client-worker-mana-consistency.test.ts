import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';
import { canUseAbility, resolveCombatTurn } from '../src/game/combat/rules.ts';

// Execute the real client engine with the same deterministic resolver imported by
// the Worker. This deliberately compares behavior, not duplicated expected math.
const engineSource = readFileSync(new URL('../src/game/combat/engine.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/\bexport class /g, 'class ');
const { BattleEngine } = runInNewContext(
  stripTypeScriptTypes(engineSource, { mode: 'transform' }) + '\n({ BattleEngine });',
  { canUseAbility, resolveCombatTurn },
) as {
  BattleEngine: new (
    degen: typeof TEST_DEGEN,
    enemy: typeof TUNNEL_MAW,
    onComplete: (...args: unknown[]) => void,
    initialState: {
      permitId: string;
      status: 'active';
      playerHp: number;
      playerMana: number;
      enemyHp: number;
      turnCount: number;
    },
  ) => {
    snapshot: {
      status: string;
      playerHp: number;
      playerMana: number;
      enemyHp: number;
      turnCount: number;
    };
    useAbility(abilityId: string): void;
  };
};

test('client battle engine and shared Worker resolver agree on one paid turn', () => {
  const ability = TEST_DEGEN.abilities.find((candidate) => candidate.id === 'crack');
  assert.ok(ability);

  const input = {
    playerHp: 80,
    playerMana: TEST_DEGEN.maxMana,
    enemyHp: 100,
    ability,
    degen: TEST_DEGEN,
    enemy: TUNNEL_MAW,
  };
  const expected = resolveCombatTurn(input);
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => undefined, {
    permitId: 'local-consistency-check',
    status: 'active',
    playerHp: input.playerHp,
    playerMana: input.playerMana,
    enemyHp: input.enemyHp,
    turnCount: 0,
  });

  engine.useAbility(ability.id);

  assert.deepEqual(
    {
      status: engine.snapshot.status,
      playerHp: engine.snapshot.playerHp,
      playerMana: engine.snapshot.playerMana,
      enemyHp: engine.snapshot.enemyHp,
      turnCount: engine.snapshot.turnCount,
    },
    {
      status: expected.status,
      playerHp: expected.playerHp,
      playerMana: expected.playerMana,
      enemyHp: expected.enemyHp,
      turnCount: 1,
    },
  );
});

test('Mana validation rejects negative, fractional, non-finite, and unsafe values', () => {
  const ability = TEST_DEGEN.abilities.find((candidate) => candidate.id === 'slash');
  assert.ok(ability);

  for (const manaCost of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    const invalidAbility = { ...ability, manaCost };
    assert.equal(canUseAbility(TEST_DEGEN.maxMana, invalidAbility), false);
    assert.throws(() => resolveCombatTurn({
      playerHp: TEST_DEGEN.maxHp,
      playerMana: TEST_DEGEN.maxMana,
      enemyHp: TUNNEL_MAW.maxHp,
      ability: invalidAbility,
      degen: TEST_DEGEN,
      enemy: TUNNEL_MAW,
    }), /Invalid Mana cost/);
  }

  for (const playerMana of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(canUseAbility(playerMana, ability), false);
    assert.throws(() => resolveCombatTurn({
      playerHp: TEST_DEGEN.maxHp,
      playerMana,
      enemyHp: TUNNEL_MAW.maxHp,
      ability,
      degen: TEST_DEGEN,
      enemy: TUNNEL_MAW,
    }), /Invalid player Mana/);
  }
});
