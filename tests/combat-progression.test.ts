import assert from 'node:assert/strict';
import test from 'node:test';

import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';
import { canAffordManaCost, canUseAbility, resolveCombatTurn } from '../src/game/combat/rules.ts';
import { BattleEngine } from '../src/game/combat/engine.ts';
import { updateBattleDom } from '../src/ui/views.ts';
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

test('monster definitions do not expose Degen Mana fields', () => {
  assert.deepEqual(Object.keys(TUNNEL_MAW).filter((key) => /mana/i.test(key)), []);
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


test('depleting Degen Mana never reverts combat and zero-cost actions still resolve', () => {
  const enemy = { ...TUNNEL_MAW, maxHp: 200 };
  const completed: string[] = [];
  const battle = new BattleEngine(TEST_DEGEN, enemy, (status) => completed.push(status));

  battle.useAbility('crack');
  battle.useAbility('crack');
  battle.useAbility('crack');

  assert.equal(battle.snapshot.playerMana, 0);
  assert.equal(battle.snapshot.status, 'active');
  assert.equal(battle.snapshot.enemyHp, 95);
  assert.equal(battle.snapshot.playerHp, 90);
  assert.equal(completed.length, 0);

  battle.useAbility('slash');

  assert.equal(battle.snapshot.playerMana, 0);
  assert.equal(battle.snapshot.status, 'active');
  assert.equal(battle.snapshot.enemyHp, 66);
  assert.equal(battle.snapshot.playerHp, 80);
  assert.equal(battle.snapshot.turnCount, 4);
  // The battle log is intentionally bounded, so the opening manifestation line may be trimmed.
  // The active snapshot still identifies the manifested Degen after Mana reaches zero.
  assert.equal(battle.snapshot.playerName, TEST_DEGEN.name);
  assert.equal(battle.snapshot.playerMaxMana, TEST_DEGEN.maxMana);
  assert.equal(completed.length, 0);
});


test('invalid Mana states and negative or fractional costs cannot mint Mana', () => {
  const free = TEST_DEGEN.abilities.find((candidate) => candidate.id === 'slash');
  assert.ok(free);

  assert.equal(canUseAbility(-1, free), false);
  assert.equal(canUseAbility(Number.NaN, free), false);
  assert.equal(canUseAbility(0, { ...free, manaCost: -1 }), false);
  assert.equal(canUseAbility(0, { ...free, manaCost: 0.5 }), false);
  assert.equal(canUseAbility(0, { ...free, manaCost: Number.NaN }), false);

  assert.throws(() => resolveCombatTurn({
    playerHp: TEST_DEGEN.maxHp,
    playerMana: 0,
    enemyHp: TUNNEL_MAW.maxHp,
    ability: { ...free, manaCost: -1 },
    degen: TEST_DEGEN,
    enemy: TUNNEL_MAW,
  }), /Invalid Mana cost/);

  assert.throws(() => resolveCombatTurn({
    playerHp: TEST_DEGEN.maxHp,
    playerMana: -1,
    enemyHp: TUNNEL_MAW.maxHp,
    ability: free,
    degen: TEST_DEGEN,
    enemy: TUNNEL_MAW,
  }), /Invalid player Mana state/);
});


test('shared Mana affordability rejects malformed costs and player Mana consistently', () => {
  const free = TEST_DEGEN.abilities.find((candidate) => candidate.id === 'slash');
  const paid = TEST_DEGEN.abilities.find((candidate) => candidate.id === 'crack');
  assert.ok(free);
  assert.ok(paid);

  assert.equal(canAffordManaCost(0, 0), true);
  assert.equal(canAffordManaCost(paid.manaCost, paid.manaCost), true);
  assert.equal(canAffordManaCost(paid.manaCost, paid.manaCost - 1), false);
  assert.equal(canUseAbility(0, free), canAffordManaCost(free.manaCost, 0));
  assert.equal(canUseAbility(paid.manaCost, paid), canAffordManaCost(paid.manaCost, paid.manaCost));

  for (const cost of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(canAffordManaCost(cost, 10), false, `invalid cost ${cost}`);
  }
  for (const mana of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(canAffordManaCost(0, mana), false, `invalid player Mana ${mana}`);
  }
});

test('battle DOM keeps zero-cost actions usable at zero Mana and fails closed for invalid costs', () => {
  const paid = TEST_DEGEN.abilities.find((candidate) => candidate.id === 'crack');
  assert.ok(paid);
  const buttons = [
    { dataset: { manaCost: '0' }, disabled: true },
    { dataset: { manaCost: String(paid.manaCost) }, disabled: false },
    { dataset: { manaCost: 'NaN' }, disabled: false },
    { dataset: { manaCost: '' }, disabled: false },
    { dataset: {}, disabled: false },
    { dataset: { manaCost: '-1' }, disabled: false },
    { dataset: { manaCost: '0.5' }, disabled: false },
  ];
  const log = { innerHTML: '', append: (_node: unknown) => undefined };
  const fakeDocument = {
    querySelector: (selector: string) => selector === '#battle-log' ? log : null,
    querySelectorAll: (selector: string) => selector === '[data-ability]' ? buttons : [],
  };
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });

  try {
    const snapshot = {
      ...new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => undefined).snapshot,
      playerMana: 0,
    };
    updateBattleDom(snapshot);
    assert.equal(buttons[0].disabled, false, 'zero-cost ability remains available');
    for (const index of [1, 2, 3, 4, 5, 6]) {
      assert.equal(buttons[index].disabled, true, `button ${index} must be disabled at zero Mana`);
    }
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
