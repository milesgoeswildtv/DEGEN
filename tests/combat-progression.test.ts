import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';
import { assertNoMonsterActionResource, canUseAbility, isValidManaState, isValidShield, resolveCombatTurn } from '../src/game/combat/rules.ts';

import {
  UNDERPASS_FULL_REWARD_LIMIT,
  advanceLevel,
  underpassRewardForClear,
  xpNeededForLevel,
} from '../src/game/progression.ts';

const engineSource = readFileSync(new URL('../src/game/combat/engine.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/\bexport class /g, 'class ');
const { BattleEngine } = runInNewContext(
  stripTypeScriptTypes(engineSource, { mode: 'transform' }) + '\n({ BattleEngine });',
  { assertNoMonsterActionResource, canUseAbility, isValidManaState, isValidShield, resolveCombatTurn },
) as {
  BattleEngine: new (
    degen: typeof TEST_DEGEN,
    enemy: typeof TUNNEL_MAW,
    onComplete: () => void,
    initialState?: {
      permitId: string;
      status: 'active' | 'victory' | 'defeat';
      playerHp: number;
      playerMana: number;
      enemyHp: number;
      turnCount: number;
    },
  ) => {
    useAbility(abilityId: string): void;
    snapshot: {
      playerHp: number;
      playerMana: number;
      enemyHp: number;
      turnCount: number;
      status: string;
      playerName: string;
      log: string[];
    };
  };
};

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


test('turn resolution rejects Mana above the Degen maximum', () => {
  const free = TEST_DEGEN.abilities.find((candidate) => candidate.manaCost === 0);
  assert.ok(free);

  assert.equal(isValidManaState(TEST_DEGEN.maxMana + 1, TEST_DEGEN.maxMana), false);
  assert.throws(() => resolveCombatTurn({
    playerHp: TEST_DEGEN.maxHp,
    playerMana: TEST_DEGEN.maxMana + 1,
    enemyHp: TUNNEL_MAW.maxHp,
    ability: free,
    degen: TEST_DEGEN,
    enemy: TUNNEL_MAW,
  }), /Invalid player Mana/);
});

test('BattleEngine rejects an over-cap authoritative Mana start snapshot', () => {
  let completionCalls = 0;
  assert.throws(() => new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => {
    completionCalls += 1;
  }, {
    permitId: 'permit-invalid-mana',
    status: 'active',
    playerHp: TEST_DEGEN.maxHp,
    playerMana: TEST_DEGEN.maxMana + 1,
    enemyHp: TUNNEL_MAW.maxHp,
    turnCount: 0,
  }), /Invalid authoritative battle start state/);
  assert.equal(completionCalls, 0, 'invalid start snapshots never expose a battle or emit completion');
});

test('BattleEngine deducts paid Mana once and an unaffordable retry changes no combat state', () => {
  const paid = TEST_DEGEN.abilities.find((candidate) => candidate.id === 'crack');
  assert.ok(paid);
  assert.ok(paid.manaCost > 0);

  // This test-only pool lets one paid action reach exactly zero without defining
  // any production Degen balance.
  const limitedDegen = { ...TEST_DEGEN, maxMana: paid.manaCost, abilities: [paid] };
  let completionCalls = 0;
  const engine = new BattleEngine(limitedDegen, TUNNEL_MAW, () => {
    completionCalls += 1;
  });

  engine.useAbility(paid.id);
  const afterPaidAction = engine.snapshot;
  assert.equal(afterPaidAction.playerMana, 0, 'the paid action deducts its cost exactly once');
  assert.equal(afterPaidAction.turnCount, 1);
  assert.equal(afterPaidAction.enemyHp, TUNNEL_MAW.maxHp - paid.damage - Math.floor(limitedDegen.power * 0.5));
  assert.equal(afterPaidAction.status, 'active');
  assert.equal(afterPaidAction.playerName, limitedDegen.name, 'zero Mana does not revert the Degen');
  assert.equal(completionCalls, 0);

  engine.useAbility(paid.id);
  const afterRejectedAction = engine.snapshot;
  assert.equal(afterRejectedAction.playerHp, afterPaidAction.playerHp);
  assert.equal(afterRejectedAction.playerMana, afterPaidAction.playerMana);
  assert.equal(afterRejectedAction.enemyHp, afterPaidAction.enemyHp);
  assert.equal(afterRejectedAction.turnCount, afterPaidAction.turnCount);
  assert.equal(afterRejectedAction.status, afterPaidAction.status);
  assert.equal(completionCalls, 0, 'an unaffordable retry cannot complete or end combat');
  assert.match(afterRejectedAction.log.at(-1) ?? '', /Not enough Mana/);
});

test('Degen Shield gain absorbs retaliation before HP, including at zero Mana', () => {
  const free = TEST_DEGEN.abilities.find((candidate) => candidate.manaCost === 0);
  assert.ok(free);
  // Test-only Shield gain exercises the shared rule without inventing a production Degen kit.
  const shieldAbility = { ...free, shieldGain: 8 };
  const shieldDegen = { ...TEST_DEGEN, maxMana: 0, abilities: [shieldAbility] };

  const result = resolveCombatTurn({
    playerHp: 10,
    playerMana: 0,
    playerShield: 3,
    enemyHp: TUNNEL_MAW.maxHp,
    enemyShield: 0,
    ability: shieldAbility,
    degen: shieldDegen,
    enemy: TUNNEL_MAW,
  });

  assert.equal(result.playerMana, 0);
  assert.equal(result.status, 'active');
  assert.equal(result.playerHp, 10, 'the gained and existing Shield absorb the full retaliation');
  assert.equal(result.playerShield, 1, 'Shield is consumed only by the absorbed retaliation');
  assert.equal(result.retaliationDamage, 10);
  assert.equal(result.shieldAbsorbed, 10);
  assert.equal(result.enemyHp, TUNNEL_MAW.maxHp - result.playerDamage);
});

test('enemy Shield absorbs incoming damage before HP and a killing blow skips retaliation', () => {
  const free = TEST_DEGEN.abilities.find((candidate) => candidate.manaCost === 0);
  assert.ok(free);
  const shieldDegen = { ...TEST_DEGEN, maxMana: 0, abilities: [free] };

  const result = resolveCombatTurn({
    playerHp: 1,
    playerMana: 0,
    playerShield: 4,
    enemyHp: 24,
    enemyShield: 5,
    ability: free,
    degen: shieldDegen,
    enemy: TUNNEL_MAW,
  });

  assert.equal(result.status, 'victory');
  assert.equal(result.playerMana, 0);
  assert.equal(result.enemyShieldAbsorbed, 5);
  assert.equal(result.enemyShield, 0);
  assert.equal(result.enemyHp, 0);
  assert.equal(result.playerHp, 1);
  assert.equal(result.playerShield, 4, 'a killing blow does not consume player Shield');
  assert.equal(result.retaliationDamage, 0);
  assert.equal(result.shieldAbsorbed, 0);
});

test('Shield values and accumulated gains reject invalid or unsafe integers', () => {
  assert.equal(isValidShield(0), true);
  assert.equal(isValidShield(Number.MAX_SAFE_INTEGER), true);
  assert.equal(isValidShield(-1), false);
  assert.equal(isValidShield(0.5), false);
  assert.equal(isValidShield(Number.MAX_SAFE_INTEGER + 1), false);

  const free = TEST_DEGEN.abilities.find((candidate) => candidate.manaCost === 0);
  assert.ok(free);
  const shieldAbility = { ...free, shieldGain: 1 };
  const shieldDegen = { ...TEST_DEGEN, abilities: [shieldAbility] };
  const input = {
    playerHp: TEST_DEGEN.maxHp,
    playerMana: TEST_DEGEN.maxMana,
    playerShield: Number.MAX_SAFE_INTEGER,
    enemyHp: TUNNEL_MAW.maxHp,
    enemyShield: 0,
    ability: shieldAbility,
    degen: shieldDegen,
    enemy: TUNNEL_MAW,
  };

  assert.throws(() => resolveCombatTurn(input), /safe integer/);
  assert.throws(() => resolveCombatTurn({ ...input, playerShield: 0, enemyShield: -1 }), /Invalid enemy Shield/);
  assert.throws(() => resolveCombatTurn({
    ...input,
    playerShield: 0,
    ability: { ...free, shieldGain: -1 },
    degen: { ...shieldDegen, abilities: [{ ...free, shieldGain: -1 }] },
  }), /Invalid Shield gain/);
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


test('zero Mana does not force reversion or end an active Degen encounter', () => {
  const free = TEST_DEGEN.abilities.find((candidate) => candidate.manaCost === 0);
  assert.ok(free);

  const zeroManaDegen = { ...TEST_DEGEN, maxMana: 0, abilities: [free] };
  let completionCalls = 0;
  const engine = new BattleEngine(zeroManaDegen, TUNNEL_MAW, () => {
    completionCalls += 1;
  });

  engine.useAbility(free.id);

  assert.equal(engine.snapshot.playerMana, 0);
  assert.equal(engine.snapshot.status, 'active');
  assert.equal(engine.snapshot.playerName, zeroManaDegen.name);
  assert.equal(completionCalls, 0, 'Mana depletion alone must not finish or revert combat');
});

test('monster definitions do not expose a Mana resource', () => {
  assert.deepEqual(
    Object.keys(TUNNEL_MAW).filter((key) => /mana/i.test(key)),
    [],
    'monster combat state must not acquire a Mana-equivalent field',
  );
});
