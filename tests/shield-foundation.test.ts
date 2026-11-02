import assert from 'node:assert/strict';
import test from 'node:test';
import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';
import { BattleEngine } from '../src/game/combat/engine.ts';
import { resolveCombatTurn } from '../src/game/combat/rules.ts';

const ability = (id: string, shieldGain?: number) => {
  const found = TEST_DEGEN.abilities.find((entry) => entry.id === id);
  assert.ok(found);
  return { ...found, ...(shieldGain === undefined ? {} : { shieldGain }) };
};

test('Degen Shield absorbs retaliation before HP and consumes only the absorbed amount', () => {
  const result = resolveCombatTurn({
    playerHp: 50, playerMana: 0, playerShield: 4, enemyHp: TUNNEL_MAW.maxHp,
    ability: ability('slash', 3), degen: TEST_DEGEN, enemy: TUNNEL_MAW,
  });
  assert.equal(result.retaliationDamage, 10);
  assert.equal(result.shieldAbsorbed, 7);
  assert.equal(result.playerShield, 0);
  assert.equal(result.playerHp, 47);
  assert.equal(result.playerMana, 0);
  assert.equal(result.status, 'active');
});

test('unused Shield carries into the next turn and absorbs only incoming retaliation', () => {
  const result = resolveCombatTurn({
    playerHp: 50, playerMana: 0, playerShield: 12, enemyHp: TUNNEL_MAW.maxHp,
    ability: ability('slash'), degen: TEST_DEGEN, enemy: TUNNEL_MAW,
  });
  assert.equal(result.shieldAbsorbed, 10);
  assert.equal(result.playerShield, 2);
  assert.equal(result.playerHp, 50);
});

test('a killing blow preserves remaining Shield and causes no retaliation', () => {
  const result = resolveCombatTurn({
    playerHp: 5, playerMana: TEST_DEGEN.maxMana, playerShield: 2, enemyHp: 1,
    ability: ability('crack', 6), degen: TEST_DEGEN, enemy: TUNNEL_MAW,
  });
  assert.equal(result.status, 'victory');
  assert.equal(result.playerHp, 5);
  assert.equal(result.playerShield, 8);
  assert.equal(result.shieldAbsorbed, 0);
  assert.equal(result.retaliationDamage, 0);
});

test('invalid Shield gain and safe-integer overflow fail before combat state can change', () => {
  assert.throws(() => resolveCombatTurn({
    playerHp: 50, playerMana: 0, playerShield: 0, enemyHp: TUNNEL_MAW.maxHp,
    ability: { ...ability('slash'), shieldGain: -1 }, degen: TEST_DEGEN, enemy: TUNNEL_MAW,
  }), /Invalid Shield gain/);
  assert.throws(() => resolveCombatTurn({
    playerHp: 50, playerMana: 0, playerShield: Number.MAX_SAFE_INTEGER, enemyHp: TUNNEL_MAW.maxHp,
    ability: ability('slash', 1), degen: TEST_DEGEN, enemy: TUNNEL_MAW,
  }), /safe integer/);
});

test('authoritative Shield result is presented once and replay does not duplicate the turn log', () => {
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => undefined, {
    permitId: 'shield-permit', status: 'active', playerHp: 50, playerMana: 0, playerShield: 4,
    shieldAbsorbed: 10, retaliationDamage: 10, enemyHp: TUNNEL_MAW.maxHp, turnCount: 1,
  });
  const turn = resolveCombatTurn({
    playerHp: 50, playerMana: 0, playerShield: 4, enemyHp: TUNNEL_MAW.maxHp,
    ability: ability('slash', 3), degen: TEST_DEGEN, enemy: TUNNEL_MAW,
  });
  const result = {
    permitId: 'shield-permit', status: turn.status, playerHp: turn.playerHp, playerMana: turn.playerMana,
    playerShield: turn.playerShield, shieldAbsorbed: turn.shieldAbsorbed,
    retaliationDamage: turn.retaliationDamage, enemyHp: turn.enemyHp, turnCount: 2,
  } as const;
  engine.applyAuthoritativeAction('slash', result);
  assert.equal(engine.snapshot.playerShield, 0);
  assert.equal(engine.snapshot.playerHp, 47);
  const logLength = engine.snapshot.log.length;
  engine.applyAuthoritativeAction('slash', result);
  assert.equal(engine.snapshot.turnCount, 2);
  assert.equal(engine.snapshot.log.length, logLength);
});
