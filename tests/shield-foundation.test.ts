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

test('server-backed engine cannot simulate local actions or accept impossible Shield snapshots', () => {
  let completions = 0;
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => { completions += 1; }, {
    permitId: 'server-only-permit', status: 'active', playerHp: 50, playerMana: 0, playerShield: 4,
    shieldAbsorbed: 10, retaliationDamage: 10, enemyHp: TUNNEL_MAW.maxHp, turnCount: 1,
  });
  const before = engine.snapshot;

  // A server permit makes local simulation and its prototype reward callback unavailable.
  engine.useAbility('slash');
  assert.deepEqual(engine.snapshot, before);
  assert.equal(completions, 0);

  // A partial absorption cannot leave Shield remaining. Neither action nor recovery
  // presentation may mutate the last accepted snapshot when that invariant is broken.
  const impossible = {
    permitId: 'server-only-permit',
    status: 'active' as const,
    playerHp: 40,
    playerMana: 0,
    playerShield: 4,
    shieldAbsorbed: 5,
    retaliationDamage: 10,
    enemyHp: TUNNEL_MAW.maxHp - 20,
    turnCount: 2,
  };
  engine.applyAuthoritativeAction('slash', impossible);
  engine.synchronizeAuthoritativeState(impossible);
  assert.deepEqual(engine.snapshot, before);
  assert.equal(completions, 0);
});


test('authoritative actions reject impossible enemy Shield absorption and gains', () => {
  const enemy = { ...TUNNEL_MAW, startingShield: 5 };
  const engine = new BattleEngine(TEST_DEGEN, enemy, () => undefined, {
    permitId: 'enemy-shield-audit', status: 'active',
    playerHp: TEST_DEGEN.maxHp, playerMana: TEST_DEGEN.maxMana,
    playerShield: 0, shieldAbsorbed: 0, retaliationDamage: 0,
    enemyHp: enemy.maxHp, enemyShield: 5, turnCount: 0,
  });
  const before = engine.snapshot;
  const common = {
    permitId: 'enemy-shield-audit', status: 'active' as const,
    playerHp: TEST_DEGEN.maxHp - 10, playerMana: TEST_DEGEN.maxMana,
    playerShield: 0, shieldAbsorbed: 0, retaliationDamage: 10,
    enemyHp: enemy.maxHp - 24, turnCount: 1,
  };

  for (const impossible of [
    { ...common, enemyShield: 4, enemyShieldAbsorbed: 6 },
    { ...common, enemyShield: 4, enemyShieldAbsorbed: 2 },
    { ...common, enemyShield: 6, enemyShieldAbsorbed: 0 },
  ]) {
    engine.applyAuthoritativeAction('slash', impossible);
    assert.deepEqual(engine.snapshot, before);
  }

  const validTurn = resolveCombatTurn({
    playerHp: TEST_DEGEN.maxHp, playerMana: TEST_DEGEN.maxMana, playerShield: 0,
    enemyHp: enemy.maxHp, enemyShield: 5, ability: ability('slash'),
    degen: TEST_DEGEN, enemy,
  });
  engine.applyAuthoritativeAction('slash', {
    permitId: 'enemy-shield-audit', status: validTurn.status,
    playerHp: validTurn.playerHp, playerMana: validTurn.playerMana,
    playerShield: validTurn.playerShield, shieldAbsorbed: validTurn.shieldAbsorbed,
    retaliationDamage: validTurn.retaliationDamage, enemyHp: validTurn.enemyHp,
    enemyShield: validTurn.enemyShield, enemyShieldAbsorbed: validTurn.enemyShieldAbsorbed,
    turnCount: 1,
  });
  assert.equal(engine.snapshot.enemyShield, undefined);
  assert.ok(engine.snapshot.log.some((line) => line.includes('Shield absorbs 5')));
});

test('conflict recovery rejects enemy Shield gains but accepts a consumed Shield snapshot', () => {
  const enemy = { ...TUNNEL_MAW, startingShield: 5 };
  const engine = new BattleEngine(TEST_DEGEN, enemy, () => undefined, {
    permitId: 'enemy-shield-resync', status: 'active',
    playerHp: TEST_DEGEN.maxHp - 10, playerMana: TEST_DEGEN.maxMana,
    playerShield: 0, shieldAbsorbed: 0, retaliationDamage: 10,
    enemyHp: enemy.maxHp - 24, enemyShield: 5, turnCount: 1,
  });
  const before = engine.snapshot;
  const impossible = {
    permitId: 'enemy-shield-resync', status: 'active' as const,
    playerHp: TEST_DEGEN.maxHp - 20, playerMana: TEST_DEGEN.maxMana,
    playerShield: 0, shieldAbsorbed: 0, retaliationDamage: 10,
    enemyHp: enemy.maxHp - 24, enemyShield: 6, turnCount: 2,
  };

  engine.synchronizeAuthoritativeState(impossible);
  assert.deepEqual(engine.snapshot, before, 'conflict recovery cannot increase enemy Shield');

  engine.synchronizeAuthoritativeState({
    ...impossible,
    enemyShield: 0,
    enemyShieldAbsorbed: 5,
  });
  assert.equal(engine.snapshot.turnCount, 2);
  assert.equal(engine.snapshot.enemyHp, before.enemyHp, 'fully absorbed damage does not reduce enemy HP');
  assert.equal(engine.snapshot.enemyShield, undefined, 'consumed enemy Shield is removed from the HUD snapshot');
});
