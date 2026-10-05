import assert from 'node:assert/strict';
import test from 'node:test';

import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';
import { canUseAbility, resolveCombatTurn } from '../src/game/combat/rules.ts';
import {
  UNDERPASS_FULL_REWARD_LIMIT,
  advanceLevel,
  underpassRewardForClear,
  xpNeededForLevel,
} from '../src/game/progression.ts';

test('prototype combat resolves the same deterministic turn every time', () => {
  const ability = TEST_DEGEN.abilities.find((candidate) => candidate.id === 'slash');
  assert.ok(ability);

  const a = resolveCombatTurn({
    playerHp: TEST_DEGEN.maxHp,
    playerMana: TEST_DEGEN.maxMana,
    enemyHp: TUNNEL_MAW.maxHp,
    ability,
    degen: TEST_DEGEN,
    enemy: TUNNEL_MAW,
  });
  const b = resolveCombatTurn({
    playerHp: TEST_DEGEN.maxHp,
    playerMana: TEST_DEGEN.maxMana,
    enemyHp: TUNNEL_MAW.maxHp,
    ability,
    degen: TEST_DEGEN,
    enemy: TUNNEL_MAW,
  });

  assert.deepEqual(a, b);
  assert.equal(a.playerDamage, 29);
  assert.equal(a.playerMana, TEST_DEGEN.maxMana);
  assert.equal(a.retaliationDamage, 10);
  assert.equal(a.status, 'active');
});

test('a killing blow never receives retaliation', () => {
  const ability = TEST_DEGEN.abilities.find((candidate) => candidate.id === 'crack');
  assert.ok(ability);

  const result = resolveCombatTurn({
    playerHp: 5,
    playerMana: TEST_DEGEN.maxMana,
    enemyHp: 20,
    ability,
    degen: TEST_DEGEN,
    enemy: TUNNEL_MAW,
  });

  assert.equal(result.status, 'victory');
  assert.equal(result.enemyHp, 0);
  assert.equal(result.playerHp, 5);
  assert.equal(result.playerMana, TEST_DEGEN.maxMana - ability.manaCost);
  assert.equal(result.retaliationDamage, 0);
});

test('enemy retaliation cannot be reduced below one damage', () => {
  const tank = { ...TEST_DEGEN, guard: 999 };
  const ability = tank.abilities[0];
  assert.ok(ability);

  const result = resolveCombatTurn({
    playerHp: tank.maxHp,
    playerMana: tank.maxMana,
    enemyHp: TUNNEL_MAW.maxHp,
    ability,
    degen: tank,
    enemy: TUNNEL_MAW,
  });

  assert.equal(result.retaliationDamage, 1);
  assert.equal(result.playerHp, tank.maxHp - 1);
});

test('defeat is resolved when retaliation reduces player HP to zero', () => {
  const ability = TEST_DEGEN.abilities[0];
  assert.ok(ability);

  const result = resolveCombatTurn({
    playerHp: 1,
    playerMana: TEST_DEGEN.maxMana,
    enemyHp: TUNNEL_MAW.maxHp,
    ability,
    degen: TEST_DEGEN,
    enemy: TUNNEL_MAW,
  });

  assert.equal(result.status, 'defeat');
  assert.equal(result.playerHp, 0);
});


test('Degen Mana is spent by paid abilities and zero-cost abilities remain available at zero Mana', () => {
  const free = TEST_DEGEN.abilities.find((candidate) => candidate.id === 'slash');
  const paid = TEST_DEGEN.abilities.find((candidate) => candidate.id === 'crack');
  assert.ok(free);
  assert.ok(paid);

  assert.equal(canUseAbility(0, free), true);
  assert.equal(canUseAbility(0, paid), false);
  assert.equal(canUseAbility(paid.manaCost, paid), true);

  const result = resolveCombatTurn({
    playerHp: TEST_DEGEN.maxHp,
    playerMana: TEST_DEGEN.maxMana,
    enemyHp: TUNNEL_MAW.maxHp,
    ability: paid,
    degen: TEST_DEGEN,
    enemy: TUNNEL_MAW,
  });

  assert.equal(result.playerMana, TEST_DEGEN.maxMana - paid.manaCost);
});

test('turn resolution rejects a paid ability when the Degen lacks Mana', () => {
  const paid = TEST_DEGEN.abilities.find((candidate) => candidate.id === 'crack');
  assert.ok(paid);

  assert.throws(() => resolveCombatTurn({
    playerHp: TEST_DEGEN.maxHp,
    playerMana: paid.manaCost - 1,
    enemyHp: TUNNEL_MAW.maxHp,
    ability: paid,
    degen: TEST_DEGEN,
    enemy: TUNNEL_MAW,
  }), /Insufficient Mana/);
});

test('Underpass rewards are full for the first three clears and reduced after', () => {
  for (let clear = 1; clear <= UNDERPASS_FULL_REWARD_LIMIT; clear += 1) {
    const reward = underpassRewardForClear(clear);
    assert.equal(reward.tier, 'full');
    assert.equal(reward.xp, 75);
    assert.equal(reward.currency, 30);
  }

  const reduced = underpassRewardForClear(UNDERPASS_FULL_REWARD_LIMIT + 1);
  assert.equal(reduced.tier, 'reduced');
  assert.equal(reduced.xp, 10);
  assert.equal(reduced.currency, 3);
  assert.deepEqual(reduced.items, []);
});

test('level progression preserves overflow XP across one or more levels', () => {
  assert.equal(xpNeededForLevel(1), 100);
  assert.equal(xpNeededForLevel(2), 175);

  assert.deepEqual(advanceLevel(1, 90, 75), { level: 2, xp: 65 });
  assert.deepEqual(advanceLevel(1, 90, 400), { level: 3, xp: 215 });
});
