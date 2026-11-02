import assert from 'node:assert/strict';
import test from 'node:test';

import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';
import { BattleEngine } from '../src/game/combat/engine.ts';
import { assertNoMonsterActionResource, resolveCombatTurn } from '../src/game/combat/rules.ts';

const freeAbility = TEST_DEGEN.abilities.find((ability) => ability.manaCost === 0);
assert.ok(freeAbility, 'prototype Degen must retain a zero-cost bespoke action');

test('monster definitions reject Mana and universal action-resource aliases at the root', () => {
  const forbiddenFields = [
    'mana', 'maxMana', 'currentMana', 'manaCost', 'monster_mana',
    'm-a-n-a', 'ｍａｎａ', 'resource', 'resourcePool', 'actionResource',
    'actionPointCost', 'energy', 'maxEnergy', 'energyRegeneration',
    'staminaSteal', 'focusRecovery', 'mpCost',
  ];
  for (const field of forbiddenFields) {
    const enemy = { ...TUNNEL_MAW, [field]: 1 } as typeof TUNNEL_MAW;
    assert.throws(
      () => assertNoMonsterActionResource(enemy),
      /universal action resource/,
      `monster field ${field} must be rejected`,
    );
  }
});

test('monster resource guards inspect nested and cyclic signature data safely', () => {
  const nested = { ...TUNNEL_MAW, signature: { 'resource.amount': 1 } } as typeof TUNNEL_MAW;
  assert.throws(() => assertNoMonsterActionResource(nested), /signature\.resource\.amount/);

  const cyclicSignature: Record<string, unknown> = {};
  cyclicSignature.self = cyclicSignature;
  cyclicSignature.energy = 1;
  const cyclic = { ...TUNNEL_MAW, signature: cyclicSignature } as typeof TUNNEL_MAW;
  assert.throws(() => assertNoMonsterActionResource(cyclic), /signature\.energy/);
});

test('descriptive monster metadata is not mistaken for an action-resource pool', () => {
  const enemy = {
    ...TUNNEL_MAW,
    energyColor: 'cold blue',
    focusDescription: 'tracks the loudest movement',
    staminaAnimation: 'heavy',
    resourceDrops: ['underpass-scrap'],
    magicPointColor: 'dim white',
    abilities: [{ name: 'Focus', description: 'The monster watches its target.' }],
  } as typeof TUNNEL_MAW;
  assert.doesNotThrow(() => assertNoMonsterActionResource(enemy));
});

test('monster mechanics cannot use the Degen-owned LEAK effect', () => {
  const invalid = { ...TUNNEL_MAW, signature: { name: 'LEAK' } } as typeof TUNNEL_MAW;
  assert.throws(() => assertNoMonsterActionResource(invalid), /Degen-owned effect LEAK/);
});

test('combat rules reject monster resources before resolving damage', () => {
  const invalid = { ...TUNNEL_MAW, signature: { resourceRegeneration: 1 } } as typeof TUNNEL_MAW;
  assert.throws(
    () => resolveCombatTurn({
      playerHp: TEST_DEGEN.maxHp, playerMana: TEST_DEGEN.maxMana, playerShield: 0,
      enemyHp: TUNNEL_MAW.maxHp, ability: freeAbility, degen: TEST_DEGEN, enemy: invalid,
    }),
    /universal action resource/,
  );
});

test('BattleEngine rejects monster resources before exposing a battle snapshot', () => {
  const invalid = { ...TUNNEL_MAW, signature: { resourceSteal: 1 } } as typeof TUNNEL_MAW;
  assert.throws(() => new BattleEngine(TEST_DEGEN, invalid, () => {}), /universal action resource/);
});
