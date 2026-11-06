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


test('monster guard rejects resource aliases, separator variants, and compatibility characters', () => {
  const forbiddenFields = [
    'mana', 'maxMana', 'currentMana', 'manaCost', 'manaPool', 'monsterMana',
    'monster_mana', 'max_mana', 'current_mana', 'mana_cost',
    'm-a-n-a', 'm a n a', 'm.a.n.a', 'm_a_n_a', 'm/a/n/a', 'ＭＡＮＡＣＯＳＴ', 'ｍａｎａ',
    'resource', 'RESOURCE', 'resourcePool', 'ResourcePool', 'resource_pool',
    'resource.amount', 'resource amount', 'resource/amount', 'resource:amount',
    'resourceCost', 'resourceRegeneration', 'resourceSteal', 'resourceDrain',
    'resourceRecovery', 'resourceRestore', 'resourceGain', 'resourceAmount',
    'actionResource', 'actionPoints', 'actionPoint', 'maxActionPoints',
    'actionPointCost', 'actionPointRegeneration',
    'energy', 'maxEnergy', 'energyCost', 'energyRegeneration', 'energySteal',
    'energyDrain', 'energyRecovery', 'energyRestore', 'energyGain',
    'energyPoint', 'energyPoints', 'maxEnergyPoints',
    'stamina', 'maxStamina', 'staminaCost', 'staminaRegeneration', 'staminaSteal',
    'staminaDrain', 'staminaRecovery', 'staminaRestore', 'staminaGain',
    'staminaPoint', 'staminaPoints', 'focus', 'maxFocus', 'focusCost',
    'focusRegeneration', 'focusSteal', 'focusDrain', 'focusRecovery',
    'focusRestore', 'focusGain', 'focusPoint', 'focusPoints',
    'mp', 'maxMp', 'currentMp', 'mpCost', 'mpPool', 'mpRegeneration', 'mpRegen',
    'mpSteal', 'mpDrain', 'mpRecovery', 'mpRestore', 'mpGain', 'magicPoint',
    'magicPoints', 'magicPointCost', 'magicPointRegeneration', 'mpMax',
    'mpCurrent', 'mpBase', 'mpStarting', 'mpInitial', 'm-p', 'm_p', 'm.p.',
    'm p', 'ｍｐ', 'ＭＰＣＯＳＴ',
  ] as const;

  for (const field of forbiddenFields) {
    const enemy = { ...TUNNEL_MAW, [field]: 1 } as typeof TUNNEL_MAW;
    assert.throws(
      () => assertNoMonsterActionResource(enemy),
      (error: unknown) => error instanceof TypeError
        && error.message.includes('universal action resource (' + field + ')'),
      'root monster field ' + field + ' must be rejected',
    );
  }
});

test('nested monster resource aliases fail closed in signatures and loadouts, including cyclic data', () => {
  const nestedCases = [
    { path: 'signature.m-a-n-a', enemy: { ...TUNNEL_MAW, signature: { 'm-a-n-a': 1 } } },
    { path: 'signature.currentMana', enemy: { ...TUNNEL_MAW, signature: { currentMana: 1 } } },
    { path: 'signature.ｍａｎａ', enemy: { ...TUNNEL_MAW, signature: { 'ｍａｎａ': 1 } } },
    { path: 'signature.resource_pool', enemy: { ...TUNNEL_MAW, signature: { resource_pool: 1 } } },
    { path: 'signature.resource.amount', enemy: { ...TUNNEL_MAW, signature: { 'resource.amount': 1 } } },
    { path: 'signature.resource amount', enemy: { ...TUNNEL_MAW, signature: { 'resource amount': 1 } } },
    { path: 'loadout.0.energy', enemy: { ...TUNNEL_MAW, loadout: [{ energy: 1 }] } },
    { path: 'signature.maxEnergy', enemy: { ...TUNNEL_MAW, signature: { maxEnergy: 1 } } },
    { path: 'signature.focus', enemy: { ...TUNNEL_MAW, signature: { focus: 1 } } },
    { path: 'signature.resourceAmount', enemy: { ...TUNNEL_MAW, signature: { resourceAmount: 1 } } },
    { path: 'signature.actionPointCost', enemy: { ...TUNNEL_MAW, signature: { actionPointCost: 1 } } },
    { path: 'loadout.0.staminaSteal', enemy: { ...TUNNEL_MAW, loadout: [{ staminaSteal: 1 }] } },
    { path: 'signature.focusRecovery', enemy: { ...TUNNEL_MAW, signature: { focusRecovery: 1 } } },
    { path: 'loadout.0.resource_steal', enemy: { ...TUNNEL_MAW, loadout: [{ resource_steal: 1 }] } },
    { path: 'signature.resource-drain', enemy: { ...TUNNEL_MAW, signature: { 'resource-drain': 1 } } },
    { path: 'signature.mpPool', enemy: { ...TUNNEL_MAW, signature: { mpPool: 1 } } },
    { path: 'loadout.0.magicPointCost', enemy: { ...TUNNEL_MAW, loadout: [{ magicPointCost: 1 }] } },
    { path: 'signature.resource_max', enemy: { ...TUNNEL_MAW, signature: { resource_max: 1 } } },
  ] as const;

  for (const { path, enemy } of nestedCases) {
    assert.throws(
      () => resolveCombatTurn({
        playerHp: TEST_DEGEN.maxHp, playerMana: TEST_DEGEN.maxMana, playerShield: 0,
        enemyHp: TUNNEL_MAW.maxHp, ability: freeAbility, degen: TEST_DEGEN,
        enemy: enemy as typeof TUNNEL_MAW,
      }),
      (error: unknown) => error instanceof TypeError
        && error.message.includes('universal action resource (' + path + ')'),
      'nested monster field ' + path + ' must be rejected before combat resolves',
    );
  }

  const cyclicSignature: Record<string, unknown> = {};
  cyclicSignature.self = cyclicSignature;
  cyclicSignature.mana = 1;
  const cyclic = { ...TUNNEL_MAW, signature: cyclicSignature } as typeof TUNNEL_MAW;
  assert.throws(
    () => resolveCombatTurn({
      playerHp: TEST_DEGEN.maxHp, playerMana: TEST_DEGEN.maxMana, playerShield: 0,
      enemyHp: TUNNEL_MAW.maxHp, ability: freeAbility, degen: TEST_DEGEN, enemy: cyclic,
    }),
    ((error: unknown) => error instanceof TypeError && error.message.includes('universal action resource (signature.mana)')),
  );
});

test('resource-looking prose and ordinary monster move names remain descriptive metadata', () => {
  const enemy = {
    ...TUNNEL_MAW,
    signature: { jump: true, stomp: true },
    energyColor: 'cold blue',
    focusDescription: 'tracks the loudest movement',
    staminaAnimation: 'heavy',
    resourceDrops: ['underpass-scrap'],
    magicPointColor: 'dim white',
    abilities: [{ name: 'Focus', description: 'The monster watches its target.' }],
  } as typeof TUNNEL_MAW;
  assert.doesNotThrow(() => assertNoMonsterActionResource(enemy));
  assert.doesNotThrow(() => resolveCombatTurn({
    playerHp: TEST_DEGEN.maxHp, playerMana: TEST_DEGEN.maxMana, playerShield: 0,
    enemyHp: TUNNEL_MAW.maxHp, ability: freeAbility, degen: TEST_DEGEN, enemy,
  }));
});

test('monster mechanic namespaces reject GLITCHRAT-owned LEAK across composite fields', () => {
  const forbiddenCases = [
    { path: 'status', enemy: { ...TUNNEL_MAW, status: 'LEAK' } },
    { path: 'signature.name', enemy: { ...TUNNEL_MAW, signature: { name: 'LEAK' } } },
    { path: 'signature.effects.LEAK', enemy: { ...TUNNEL_MAW, signature: { effects: { LEAK: { enabled: true } } } } },
    { path: 'statusName.LEAK', enemy: { ...TUNNEL_MAW, statusName: { LEAK: { enabled: true } } } },
    { path: 'loadout.0.statuses.leak', enemy: { ...TUNNEL_MAW, loadout: [{ statuses: { leak: { enabled: true } } }] } },
    { path: 'loadout.0.appliedEffect', enemy: { ...TUNNEL_MAW, loadout: [{ appliedEffect: 'leak' }] } },
    { path: 'appliedStatus', enemy: { ...TUNNEL_MAW, appliedStatus: 'LEAK' } },
    { path: 'appliedStatuses.0', enemy: { ...TUNNEL_MAW, appliedStatuses: ['LEAK'] } },
    { path: 'abilities.0.appliedStatus', enemy: { ...TUNNEL_MAW, abilities: [{ appliedStatus: 'LEAK' }] } },
    { path: 'loadout.0.appliedStatuses.0', enemy: { ...TUNNEL_MAW, loadout: [{ appliedStatuses: ['LEAK'] }] } },
    { path: 'abilities.0.effect', enemy: { ...TUNNEL_MAW, abilities: [{ effect: 'ＬＥＡＫ' }] } },
    { path: 'status.0', enemy: { ...TUNNEL_MAW, status: ['LEAK'] } },
    { path: 'statusEffects.0', enemy: { ...TUNNEL_MAW, statusEffects: ['LEAK'] } },
    { path: 'signatureEffects.0.name', enemy: { ...TUNNEL_MAW, signatureEffects: [{ name: 'LEAK' }] } },
    { path: 'degenEffects.0', enemy: { ...TUNNEL_MAW, degenEffects: ['LEAK'] } },
    { path: 'degenStatuses.0', enemy: { ...TUNNEL_MAW, degenStatuses: ['LEAK'] } },
    { path: 'abilityEffects.0', enemy: { ...TUNNEL_MAW, abilityEffects: ['LEAK'] } },
    { path: 'moveEffects.0', enemy: { ...TUNNEL_MAW, moveEffects: ['LEAK'] } },
    { path: 'effects.0', enemy: { ...TUNNEL_MAW, effects: ['LEAK'] } },
    { path: 'loadout.0.effects.0', enemy: { ...TUNNEL_MAW, loadout: [{ effects: ['LEAK'] }] } },
  ] as const;

  for (const { path, enemy } of forbiddenCases) {
    assert.throws(
      () => resolveCombatTurn({
        playerHp: TEST_DEGEN.maxHp, playerMana: TEST_DEGEN.maxMana, playerShield: 0,
        enemyHp: TUNNEL_MAW.maxHp, ability: freeAbility, degen: TEST_DEGEN,
        enemy: enemy as typeof TUNNEL_MAW,
      }),
      (error: unknown) => error instanceof TypeError
        && error.message.includes('Degen-owned effect LEAK (' + path + ')'),
      'monster mechanic ' + path + ' must not claim GLITCHRAT-owned LEAK',
    );
  }

  const sharedMechanic = { name: 'LEAK' };
  const shared = {
    ...TUNNEL_MAW,
    metadata: sharedMechanic,
    signature: sharedMechanic,
  } as typeof TUNNEL_MAW;
  assert.throws(
    () => assertNoMonsterActionResource(shared),
    /Degen-owned effect LEAK/,
    'a shared object first visited as metadata must still be checked in a mechanic context',
  );
});

test('LEAK in monster flavor text and move-description arrays remains descriptive', () => {
  const prose = {
    ...TUNNEL_MAW,
    description: 'A cracked service pipe leaks water into the tunnel.',
    metadata: { LEAK: 'A descriptive key about water leaking from a pipe.' },
    abilities: [{ description: ['LEAK is only a word in this move description.'] }],
  } as typeof TUNNEL_MAW;
  assert.doesNotThrow(() => assertNoMonsterActionResource(prose));
  assert.doesNotThrow(() => resolveCombatTurn({
    playerHp: TEST_DEGEN.maxHp, playerMana: TEST_DEGEN.maxMana, playerShield: 0,
    enemyHp: TUNNEL_MAW.maxHp, ability: freeAbility, degen: TEST_DEGEN, enemy: prose,
  }));
});


test('LEAK keys inside descriptive metadata nested under monster mechanics remain prose', () => {
  const prose = {
    ...TUNNEL_MAW,
    signature: { metadata: { LEAK: 'A descriptive reference to a leaking pipe.' } },
    abilities: [{ name: 'Crush', metadata: { LEAK: 'A descriptive move note.' }, description: { LEAK: 'Flavor only.' } }],
    loadout: [{ metadata: { LEAK: 'A descriptive loadout note.' } }],
  } as typeof TUNNEL_MAW;
  assert.doesNotThrow(() => assertNoMonsterActionResource(prose));
  assert.doesNotThrow(() => resolveCombatTurn({
    playerHp: TEST_DEGEN.maxHp, playerMana: TEST_DEGEN.maxMana, playerShield: 0,
    enemyHp: TUNNEL_MAW.maxHp, ability: freeAbility, degen: TEST_DEGEN, enemy: prose,
  }));
});

test('descriptive metadata remains subject to the monster resource boundary', () => {
  const forbiddenCases = [
    {
      path: 'signature.metadata.manaCost',
      enemy: { ...TUNNEL_MAW, signature: { metadata: { manaCost: 1 } } },
    },
    {
      path: 'abilities.0.description.resourcePool',
      enemy: { ...TUNNEL_MAW, abilities: [{ description: { resourcePool: 1 } }] },
    },
  ] as const;

  for (const { path, enemy } of forbiddenCases) {
    assert.throws(
      () => assertNoMonsterActionResource(enemy as typeof TUNNEL_MAW),
      (error: unknown) => error instanceof TypeError
        && error.message.includes('universal action resource (' + path + ')'),
      'descriptive text may mention LEAK but cannot smuggle a monster action-resource field',
    );
  }
});


test('monster resource descriptor values cannot name a universal action resource', () => {
  const descriptorCases = [
    { path: 'resourceType', enemy: { ...TUNNEL_MAW, resourceType: 'Mana' } },
    { path: 'actionResourceName', enemy: { ...TUNNEL_MAW, actionResourceName: 'Energy' } },
    { path: 'resourceKind', enemy: { ...TUNNEL_MAW, resourceKind: 'MP' } },
    { path: 'magicPointType', enemy: { ...TUNNEL_MAW, magicPointType: 'Action Points' } },
  ] as { path: string; enemy: typeof TUNNEL_MAW }[];

  for (const { path, enemy } of descriptorCases) {
    assert.throws(
      () => assertNoMonsterActionResource(enemy),
      (error: unknown) => error instanceof TypeError
        && error.message.includes('universal action resource (' + path + ')'),
      'monster resource descriptor ' + path + ' must reject a universal action resource value',
    );
  }

  assert.doesNotThrow(() => assertNoMonsterActionResource({
    ...TUNNEL_MAW,
    metadata: { resourceType: 'loot' },
  } as typeof TUNNEL_MAW), 'descriptive loot metadata remains valid');
});

test('scalar monster effect descriptors cannot carry GLITCHRAT-owned LEAK', () => {
  const descriptorCases = [
    { path: 'statusEffect', enemy: { ...TUNNEL_MAW, statusEffect: 'LEAK' } },
    { path: 'signatureEffect', enemy: { ...TUNNEL_MAW, signatureEffect: 'LEAK' } },
    { path: 'abilityEffect', enemy: { ...TUNNEL_MAW, abilityEffect: 'LEAK' } },
    { path: 'moveEffect', enemy: { ...TUNNEL_MAW, moveEffect: 'LEAK' } },
    { path: 'statusEffects', enemy: { ...TUNNEL_MAW, statusEffects: 'LEAK' } },
    { path: 'signatureEffects', enemy: { ...TUNNEL_MAW, signatureEffects: 'LEAK' } },
    { path: 'abilityEffects', enemy: { ...TUNNEL_MAW, abilityEffects: 'LEAK' } },
    { path: 'moveEffects', enemy: { ...TUNNEL_MAW, moveEffects: 'LEAK' } },
  ] as { path: string; enemy: typeof TUNNEL_MAW }[];

  for (const { path, enemy } of descriptorCases) {
    assert.throws(
      () => assertNoMonsterActionResource(enemy),
      (error: unknown) => error instanceof TypeError
        && error.message.includes('Degen-owned effect LEAK (' + path + ')'),
      'monster effect descriptor ' + path + ' must reject GLITCHRAT-owned LEAK',
    );
  }
});

test('LEAK aliases with separators and invisible formatting remain forbidden mechanic IDs', () => {
  const disguisedIdentifiers = [
    'ＬＥＡＫ', 'L.E.A.K', 'L_E_A_K', 'L E A K',
    'L\u200bEAK', 'L\u2060EAK', 'L\u0307EAK', 'L\u202eEAK',
  ];

  for (const identifier of disguisedIdentifiers) {
    const byKey = {
      ...TUNNEL_MAW,
      signature: { effects: { [identifier]: { enabled: true } } },
    } as typeof TUNNEL_MAW;
    const byValue = {
      ...TUNNEL_MAW,
      abilities: [{ effect: identifier }],
    } as typeof TUNNEL_MAW;

    assert.throws(() => assertNoMonsterActionResource(byKey), /Degen-owned effect LEAK/);
    assert.throws(() => assertNoMonsterActionResource(byValue), /Degen-owned effect LEAK/);
  }

  const prose = {
    ...TUNNEL_MAW,
    description: 'A cracked pipe leaks water into the tunnel.',
    metadata: { LEAK: 'A descriptive reference to leaking water.' },
    abilities: [{ description: ['LEAK is only a word in move flavor text.'] }],
  } as typeof TUNNEL_MAW;
  assert.doesNotThrow(() => assertNoMonsterActionResource(prose));
});

test('shared monster objects are checked in both descriptive and mechanic contexts', () => {
  const sharedMechanic = { name: 'LEAK' };
  const enemy = {
    ...TUNNEL_MAW,
    metadata: sharedMechanic,
    signature: sharedMechanic,
  } as typeof TUNNEL_MAW;

  assert.throws(
    () => assertNoMonsterActionResource(enemy),
    /Degen-owned effect LEAK/,
    'a descriptive traversal must not hide the same object when reached as a mechanic',
  );

  const descriptiveNested = {
    ...TUNNEL_MAW,
    signature: { metadata: { LEAK: 'Descriptive flavor only.' } },
    abilities: [{ metadata: { LEAK: 'Move note only.' }, description: { LEAK: 'Flavor only.' } }],
  } as typeof TUNNEL_MAW;
  assert.doesNotThrow(() => assertNoMonsterActionResource(descriptiveNested));
});
