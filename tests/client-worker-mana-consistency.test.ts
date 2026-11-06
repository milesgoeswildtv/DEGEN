import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';
import { assertNoMonsterActionResource, canUseAbility, isValidManaState, isValidShield, maxAbilityDamage, resolveCombatTurn } from '../src/game/combat/rules.ts';
const apiSource = readFileSync(new URL('../src/app/api.ts', import.meta.url), 'utf8');
const validatorStart = apiSource.indexOf('const isAuthoritativeBattleStartState =');
const validatorEnd = apiSource.indexOf('\nconst isRecord', validatorStart);
if (validatorStart < 0 || validatorEnd < 0) throw new Error('Authoritative battle validators were not found.');
const validatorSource = apiSource.slice(validatorStart, validatorEnd).replace('export const ', 'const ');
type BattleValidators = {
  isAuthoritativeBattleStartState(value: unknown, permitId: string): boolean;
  isAuthoritativeBattleActionState(value: unknown, permitId: string): boolean;
};
const createBattleValidators = (enemy: typeof TUNNEL_MAW): BattleValidators => runInNewContext(
  stripTypeScriptTypes(`
    const isBoundedSafeInteger = (value, minimum, maximum) =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
    ${validatorSource}
    ({ isAuthoritativeBattleStartState, isAuthoritativeBattleActionState });
  `, { mode: 'transform' }),
  { TEST_DEGEN, TUNNEL_MAW: enemy, maxAbilityDamage },
) as BattleValidators;
const { isAuthoritativeBattleActionState } = createBattleValidators(TUNNEL_MAW);

// Execute the real client engine with the same deterministic resolver imported by
// the Worker. This deliberately compares behavior, not duplicated expected math.
const engineSource = readFileSync(new URL('../src/game/combat/engine.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/\bexport class /g, 'class ');
const { BattleEngine } = runInNewContext(
  stripTypeScriptTypes(engineSource, { mode: 'transform' }) + '\n({ BattleEngine });',
  { assertNoMonsterActionResource, canUseAbility, isValidManaState, isValidShield, maxAbilityDamage, resolveCombatTurn },
) as {
  BattleEngine: new (
    degen: typeof TEST_DEGEN,
    enemy: typeof TUNNEL_MAW,
    onComplete: (...args: unknown[]) => void,
    initialState?: {
      permitId: string;
      status: 'active';
      playerHp: number;
      playerMana: number;
      playerShield?: number;
      shieldAbsorbed?: number;
      retaliationDamage?: number;
      enemyShield?: number;
      enemyShieldAbsorbed?: number;
      enemyHp: number;
      turnCount: number;
    },
  ) => {
    snapshot: {
      status: string;
      playerHp: number;
      playerMana: number;
      playerShield: number;
      enemyHp: number;
      enemyShield?: number;
      turnCount: number;
      log: string[];
    };
    useAbility(abilityId: string): void;
    synchronizeAuthoritativeState(result: {
      permitId: string;
      status: 'active' | 'victory' | 'defeat';
      playerHp: number;
      playerMana: number;
      playerShield?: number;
      shieldAbsorbed?: number;
      retaliationDamage?: number;
      enemyShield?: number;
      enemyShieldAbsorbed?: number;
      enemyHp: number;
      turnCount: number;
    }): void;
    applyAuthoritativeAction(abilityId: string, result: {
      permitId: string;
      status: 'active' | 'victory' | 'defeat';
      playerHp: number;
      playerMana: number;
      playerShield?: number;
      shieldAbsorbed?: number;
      retaliationDamage?: number;
      enemyShield?: number;
      enemyShieldAbsorbed?: number;
      enemyHp: number;
      turnCount: number;
    }): void;
  };
};

test('client battle engine and shared Worker resolver agree on one paid turn', () => {
  const ability = TEST_DEGEN.abilities.find((candidate) => candidate.id === 'crack');
  assert.ok(ability);

  const degen = { ...TEST_DEGEN, maxHp: 80 };
  const enemy = { ...TUNNEL_MAW, maxHp: 100 };
  const input = {
    playerHp: degen.maxHp,
    playerMana: degen.maxMana,
    enemyHp: enemy.maxHp,
    ability,
    degen,
    enemy,
  };
  const expected = resolveCombatTurn(input);
  // No permit means this is the explicitly local/offline preview path.
  const engine = new BattleEngine(degen, enemy, () => undefined);

  engine.useAbility(ability.id);

  assert.deepEqual(
    {
      status: engine.snapshot.status,
      playerHp: engine.snapshot.playerHp,
      playerMana: engine.snapshot.playerMana,
      playerShield: engine.snapshot.playerShield,
      enemyHp: engine.snapshot.enemyHp,
      turnCount: engine.snapshot.turnCount,
    },
    {
      status: expected.status,
      playerHp: expected.playerHp,
      playerMana: expected.playerMana,
      playerShield: expected.playerShield,
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


test('an out-of-order stale Worker snapshot cannot roll back newer HP, Mana, enemy HP, or turn count', () => {
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => undefined, {
    permitId: 'permit-stale-snapshot',
    status: 'active',
    playerHp: 72,
    playerMana: 4,
    enemyHp: 51,
    turnCount: 2,
  });

  engine.synchronizeAuthoritativeState({
    permitId: 'permit-stale-snapshot',
    status: 'active',
    playerHp: 94,
    playerMana: 8,
    enemyHp: 28,
    turnCount: 1,
  });

  assert.deepEqual(
    {
      status: engine.snapshot.status,
      playerHp: engine.snapshot.playerHp,
      playerMana: engine.snapshot.playerMana,
      enemyHp: engine.snapshot.enemyHp,
      turnCount: engine.snapshot.turnCount,
    },
    {
      status: 'active',
      playerHp: 72,
      playerMana: 4,
      enemyHp: 51,
      turnCount: 2,
    },
  );
});

test('a conflicting snapshot at the same turn count cannot rewrite authoritative combat state', () => {
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => undefined, {
    permitId: 'permit-same-turn-conflict',
    status: 'active',
    playerHp: 72,
    playerMana: 4,
    enemyHp: 51,
    turnCount: 2,
  });
  const before = {
    status: engine.snapshot.status,
    playerHp: engine.snapshot.playerHp,
    playerMana: engine.snapshot.playerMana,
    enemyHp: engine.snapshot.enemyHp,
    turnCount: engine.snapshot.turnCount,
    log: Array.from(engine.snapshot.log),
  };

  engine.synchronizeAuthoritativeState({
    permitId: 'permit-same-turn-conflict',
    status: 'active',
    playerHp: 94,
    playerMana: 8,
    enemyHp: 28,
    turnCount: 2,
  });

  assert.deepEqual({
    status: engine.snapshot.status,
    playerHp: engine.snapshot.playerHp,
    playerMana: engine.snapshot.playerMana,
    enemyHp: engine.snapshot.enemyHp,
    turnCount: engine.snapshot.turnCount,
    log: Array.from(engine.snapshot.log),
  }, before, 'same-turn snapshots must be identical; conflicting state is ignored');
});

test('a same-turn status-only conflict cannot forge a terminal outcome', () => {
  let completions = 0;
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => { completions += 1; }, {
    permitId: 'permit-same-turn-status-conflict',
    status: 'active',
    playerHp: 72,
    playerMana: 4,
    enemyHp: 51,
    turnCount: 2,
  });
  const before = {
    status: engine.snapshot.status,
    playerHp: engine.snapshot.playerHp,
    playerMana: engine.snapshot.playerMana,
    enemyHp: engine.snapshot.enemyHp,
    turnCount: engine.snapshot.turnCount,
    log: Array.from(engine.snapshot.log),
  };

  engine.synchronizeAuthoritativeState({
    permitId: 'permit-same-turn-status-conflict',
    status: 'victory',
    playerHp: 72,
    playerMana: 4,
    enemyHp: 51,
    turnCount: 2,
  });

  assert.deepEqual({
    status: engine.snapshot.status,
    playerHp: engine.snapshot.playerHp,
    playerMana: engine.snapshot.playerMana,
    enemyHp: engine.snapshot.enemyHp,
    turnCount: engine.snapshot.turnCount,
    log: Array.from(engine.snapshot.log),
  }, before, 'status alone cannot change an immutable same-turn snapshot');
  assert.equal(completions, 0, 'a conflicting same-turn status cannot emit reward completion');
});

test('replaying the same authoritative action result does not deduct Mana or append action logs twice', () => {
  const ability = TEST_DEGEN.abilities.find((candidate) => candidate.id === 'crack');
  assert.ok(ability);
  const initial = {
    permitId: 'permit-replay',
    status: 'active' as const,
    playerHp: 100,
    playerMana: 8,
    playerShield: 0,
    shieldAbsorbed: 0,
    retaliationDamage: 0,
    enemyHp: TUNNEL_MAW.maxHp,
    enemyShield: 0,
    turnCount: 0,
  };
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => undefined, initial);
  const turn = resolveCombatTurn({
    playerHp: initial.playerHp,
    playerMana: initial.playerMana,
    playerShield: initial.playerShield,
    enemyHp: initial.enemyHp,
    enemyShield: initial.enemyShield,
    ability,
    degen: TEST_DEGEN,
    enemy: TUNNEL_MAW,
  });
  const result = {
    permitId: 'permit-replay',
    status: turn.status,
    playerHp: turn.playerHp,
    playerMana: turn.playerMana,
    playerShield: turn.playerShield,
    shieldAbsorbed: turn.shieldAbsorbed,
    retaliationDamage: turn.retaliationDamage,
    enemyHp: turn.enemyHp,
    enemyShield: turn.enemyShield,
    enemyShieldAbsorbed: turn.enemyShieldAbsorbed,
    turnCount: 1,
  };

  engine.applyAuthoritativeAction('crack', result);
  const firstLog = [...engine.snapshot.log];
  engine.applyAuthoritativeAction('crack', result);

  assert.equal(engine.snapshot.playerMana, 4);
  assert.equal(engine.snapshot.turnCount, 1);
  assert.equal(engine.snapshot.enemyHp, turn.enemyHp);
  assert.equal(engine.snapshot.playerHp, turn.playerHp);
  assert.equal(engine.snapshot.log.filter((entry) => entry.includes('uses')).length, 1);
  assert.equal(engine.snapshot.log.filter((entry) => entry.startsWith('Mana -')).length, 1);
  assert.deepEqual(Array.from(engine.snapshot.log), firstLog);
});


test('client applies a Worker action only when Mana falls by the selected ability cost exactly', () => {
  const ability = TEST_DEGEN.abilities.find((candidate) => candidate.id === 'crack');
  assert.ok(ability);
  const permitId = 'permit-exact-mana-delta';
  const initial = {
    permitId,
    status: 'active' as const,
    playerHp: TEST_DEGEN.maxHp,
    playerMana: TEST_DEGEN.maxMana,
    playerShield: 0,
    shieldAbsorbed: 0,
    retaliationDamage: 0,
    enemyHp: TUNNEL_MAW.maxHp,
    enemyShield: 0,
    turnCount: 0,
  };
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => undefined, initial);
  const expected = resolveCombatTurn({
    playerHp: initial.playerHp,
    playerMana: initial.playerMana,
    enemyHp: initial.enemyHp,
    enemyShield: initial.enemyShield,
    ability,
    degen: TEST_DEGEN,
    enemy: TUNNEL_MAW,
  });
  const validResult = { ...expected, permitId, turnCount: 1 };
  const before = engine.snapshot;

  for (const incorrectMana of [initial.playerMana, expected.playerMana - 1, 0]) {
    engine.applyAuthoritativeAction(ability.id, { ...validResult, playerMana: incorrectMana });
    assert.deepEqual(engine.snapshot, before,
      `a Worker response with player Mana ${incorrectMana} must not be presented for a ${ability.manaCost}-Mana ability`);
  }

  engine.applyAuthoritativeAction(ability.id, validResult);
  assert.equal(engine.snapshot.playerMana, expected.playerMana);
  assert.equal(engine.snapshot.turnCount, 1);
  assert.equal(engine.snapshot.enemyHp, expected.enemyHp);
});

test('client accepts a zero-cost Worker action at zero Mana without inventing a deduction', () => {
  const ability = TEST_DEGEN.abilities.find((candidate) => candidate.id === 'slash');
  assert.ok(ability);
  assert.equal(ability.manaCost, 0);
  const permitId = 'permit-zero-mana-free-action';
  const initial = {
    permitId,
    status: 'active' as const,
    playerHp: TEST_DEGEN.maxHp,
    playerMana: 0,
    playerShield: 0,
    shieldAbsorbed: 0,
    retaliationDamage: 0,
    enemyHp: TUNNEL_MAW.maxHp,
    enemyShield: 0,
    turnCount: 0,
  };
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => undefined, initial);
  const expected = resolveCombatTurn({
    playerHp: initial.playerHp,
    playerMana: initial.playerMana,
    enemyHp: initial.enemyHp,
    enemyShield: initial.enemyShield,
    ability,
    degen: TEST_DEGEN,
    enemy: TUNNEL_MAW,
  });

  engine.applyAuthoritativeAction(ability.id, { ...expected, permitId, turnCount: 1 });

  assert.equal(engine.snapshot.playerMana, 0);
  assert.equal(engine.snapshot.turnCount, 1);
  assert.equal(engine.snapshot.enemyHp, expected.enemyHp);
});

test('a terminal authoritative result cannot be reopened by a later active snapshot', () => {
  let completions = 0;
  const enemy = { ...TUNNEL_MAW, maxHp: 1 };
  const ability = TEST_DEGEN.abilities.find((candidate) => candidate.id === 'crack');
  assert.ok(ability);
  const initial = {
    permitId: 'permit-terminal',
    status: 'active' as const,
    playerHp: 80,
    playerMana: 8,
    playerShield: 0,
    shieldAbsorbed: 0,
    retaliationDamage: 0,
    enemyHp: enemy.maxHp,
    enemyShield: 0,
    turnCount: 0,
  };
  const engine = new BattleEngine(TEST_DEGEN, enemy, (status) => {
    assert.equal(status, 'victory');
    completions += 1;
  }, initial);
  const turn = resolveCombatTurn({
    playerHp: initial.playerHp,
    playerMana: initial.playerMana,
    playerShield: initial.playerShield,
    enemyHp: initial.enemyHp,
    enemyShield: initial.enemyShield,
    ability,
    degen: TEST_DEGEN,
    enemy,
  });
  assert.equal(turn.status, 'victory');
  engine.applyAuthoritativeAction('crack', {
    permitId: 'permit-terminal',
    status: turn.status,
    playerHp: turn.playerHp,
    playerMana: turn.playerMana,
    playerShield: turn.playerShield,
    shieldAbsorbed: turn.shieldAbsorbed,
    retaliationDamage: turn.retaliationDamage,
    enemyHp: turn.enemyHp,
    enemyShield: turn.enemyShield,
    enemyShieldAbsorbed: turn.enemyShieldAbsorbed,
    turnCount: 1,
  });
  const terminal = {
    status: engine.snapshot.status,
    playerHp: engine.snapshot.playerHp,
    playerMana: engine.snapshot.playerMana,
    enemyHp: engine.snapshot.enemyHp,
    turnCount: engine.snapshot.turnCount,
  };

  engine.synchronizeAuthoritativeState({
    permitId: 'permit-terminal',
    status: 'active',
    playerHp: 99,
    playerMana: 8,
    enemyHp: 30,
    turnCount: 2,
  });

  assert.deepEqual({
    status: engine.snapshot.status,
    playerHp: engine.snapshot.playerHp,
    playerMana: engine.snapshot.playerMana,
    enemyHp: engine.snapshot.enemyHp,
    turnCount: engine.snapshot.turnCount,
  }, terminal);
  assert.equal(completions, 1, 'terminal completion must be emitted exactly once');
});


test('client rejects fabricated zero/zero Shield audits and preserves omitted legacy snapshots', () => {
  const permitId = 'shield-audit-validation';
  const base = {
    permitId,
    status: 'active' as const,
    playerHp: TEST_DEGEN.maxHp,
    playerMana: TEST_DEGEN.maxMana,
    playerShield: 5,
    shieldAbsorbed: 0,
    retaliationDamage: 0,
    enemyHp: TUNNEL_MAW.maxHp,
    turnCount: 1,
  };

  assert.equal(isAuthoritativeBattleActionState(base, permitId), false,
    'a new-format active turn cannot retain Shield without a retaliation audit');
  assert.equal(isAuthoritativeBattleActionState({
    ...base, retaliationDamage: 10,
  }, permitId), false, 'remaining Shield requires the audit to show full retaliation absorption');
  assert.equal(isAuthoritativeBattleActionState({
    ...base, shieldAbsorbed: 10, retaliationDamage: 10,
  }, permitId), true, 'remaining Shield is valid when it fully absorbed retaliation');
  assert.equal(isAuthoritativeBattleActionState({
    ...base, playerShield: 0, retaliationDamage: 10,
  }, permitId), true);
  assert.equal(isAuthoritativeBattleActionState({
    ...base, playerShield: 0,
  }, permitId), false,
  'an advanced current-format turn cannot use explicit zero/zero fields to impersonate legacy history');
  const validators = createBattleValidators(TUNNEL_MAW);
  assert.equal(validators.isAuthoritativeBattleStartState({ ...base, playerShield: 0 }, permitId), false,
    'start recovery must reject the same fabricated zero/zero audit');
  assert.equal(isAuthoritativeBattleActionState({
    ...base, playerShield: 0, turnCount: 0,
  }, permitId), true, 'a fresh permit begins with zero Shield and zero retaliation audit');

  for (const invalidRetaliation of [null, "10", -1, TUNNEL_MAW.damage + 1]) {
    assert.equal(isAuthoritativeBattleActionState({
      ...base,
      playerShield: 0,
      retaliationDamage: invalidRetaliation,
    }, permitId), false, `invalid retaliation audit ${String(invalidRetaliation)} must fail closed`);
  }

  const legacy = { ...base } as Record<string, unknown>;
  delete legacy.playerShield;
  delete legacy.shieldAbsorbed;
  delete legacy.retaliationDamage;
  assert.equal(isAuthoritativeBattleActionState(legacy, permitId), true,
    'pre-Shield snapshots remain readable when all Shield audit fields are absent');
  assert.equal(validators.isAuthoritativeBattleStartState(legacy, permitId), true,
    'idempotent start recovery preserves the omitted legacy audit shape');

  const explicitZeroDefeat = {
    ...base, status: 'defeat' as const, playerHp: 0, playerShield: 0,
    shieldAbsorbed: 0, retaliationDamage: 0,
  };
  assert.equal(isAuthoritativeBattleActionState(explicitZeroDefeat, permitId), false,
    'a current-format defeat must prove residual retaliation damage');
  const legacyDefeat = { ...explicitZeroDefeat } as Record<string, unknown>;
  delete legacyDefeat.playerShield;
  delete legacyDefeat.shieldAbsorbed;
  delete legacyDefeat.retaliationDamage;
  assert.equal(isAuthoritativeBattleActionState(legacyDefeat, permitId), true,
    'only the omitted legacy shape may recover a pre-Shield defeat without audit deltas');
});

test('server-backed BattleEngine cannot simulate local actions or emit client rewards', () => {
  const ability = TEST_DEGEN.abilities.find((candidate) => candidate.id === 'crack');
  assert.ok(ability);
  let completions = 0;
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => { completions += 1; }, {
    permitId: 'permit-server-authority',
    status: 'active',
    playerHp: TEST_DEGEN.maxHp,
    playerMana: TEST_DEGEN.maxMana,
    playerShield: 0,
    shieldAbsorbed: 0,
    retaliationDamage: 0,
    enemyHp: 1,
    turnCount: 0,
  });
  const before = engine.snapshot;
  engine.useAbility(ability.id);
  assert.deepEqual(engine.snapshot, before);
  assert.equal(completions, 0);
});

test('BattleEngine rejects malformed initial Worker Shield snapshots', () => {
  const valid = {
    permitId: 'permit-shield-start-validation',
    status: 'active' as const,
    playerHp: TEST_DEGEN.maxHp,
    playerMana: TEST_DEGEN.maxMana,
    playerShield: 0,
    shieldAbsorbed: 0,
    retaliationDamage: 0,
    enemyHp: TUNNEL_MAW.maxHp,
    turnCount: 0,
  };
  const invalid = [
    { ...valid, playerShield: null as never },
    { ...valid, shieldAbsorbed: undefined },
    { ...valid, retaliationDamage: TUNNEL_MAW.damage + 1 },
    { ...valid, playerShield: 1, turnCount: 1 },
    { ...valid, playerShield: 0, shieldAbsorbed: 0, retaliationDamage: 0, turnCount: 1 },
    { ...valid, status: 'defeat' as const, playerHp: 0, playerShield: 0, shieldAbsorbed: 0, retaliationDamage: 0, turnCount: 1 },
    { ...valid, playerShield: 1, turnCount: 1, retaliationDamage: 0 },
    { ...valid, playerShield: 5, turnCount: 1, shieldAbsorbed: 0, retaliationDamage: 10 },
    { ...valid, status: 'victory' as const, enemyHp: 0, turnCount: 1, retaliationDamage: 1 },
    { ...valid, status: 'defeat' as const, playerHp: 0, turnCount: 1, playerShield: 0, shieldAbsorbed: 10, retaliationDamage: 10 },
  ];
  for (const state of invalid) {
    assert.throws(
      () => new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => undefined, state),
      /Invalid authoritative battle start state/,
    );
  }
});

test('malformed Worker action snapshots cannot mutate engine state or emit completion', () => {
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => undefined, {
    permitId: 'permit-shield-action-validation',
    status: 'active',
    playerHp: TEST_DEGEN.maxHp,
    playerMana: TEST_DEGEN.maxMana,
    playerShield: 0,
    shieldAbsorbed: 0,
    retaliationDamage: 0,
    enemyHp: TUNNEL_MAW.maxHp,
    turnCount: 0,
  });
  const before = engine.snapshot;
  engine.applyAuthoritativeAction('crack', {
    permitId: 'permit-shield-action-validation',
    status: 'active',
    playerHp: -1,
    playerMana: TEST_DEGEN.maxMana,
    playerShield: 0,
    shieldAbsorbed: 0,
    retaliationDamage: 0,
    enemyHp: 1,
    turnCount: 1,
  });
  engine.synchronizeAuthoritativeState({
    permitId: 'permit-shield-action-validation',
    status: 'active',
    playerHp: TEST_DEGEN.maxHp,
    playerMana: TEST_DEGEN.maxMana + 1,
    playerShield: 0,
    shieldAbsorbed: 0,
    retaliationDamage: 0,
    enemyHp: TUNNEL_MAW.maxHp,
    turnCount: 0,
  });
  engine.applyAuthoritativeAction('crack', {
    permitId: 'permit-shield-action-validation',
    status: 'active',
    playerHp: TEST_DEGEN.maxHp,
    playerMana: TEST_DEGEN.maxMana,
    playerShield: 5,
    shieldAbsorbed: 0,
    retaliationDamage: 10,
    enemyHp: TUNNEL_MAW.maxHp - 29,
    turnCount: 1,
  });
  assert.deepEqual(engine.snapshot, before);
});


test('shielded-enemy start and recovery snapshots require the explicit current enemy Shield', () => {
  const shieldedEnemy = { ...TUNNEL_MAW, startingShield: 5 };
  const validators = createBattleValidators(shieldedEnemy);
  const permitId = 'permit-explicit-enemy-shield';
  const initial = {
    permitId,
    status: 'active' as const,
    playerHp: TEST_DEGEN.maxHp,
    playerMana: TEST_DEGEN.maxMana,
    playerShield: 0,
    shieldAbsorbed: 0,
    retaliationDamage: 0,
    enemyHp: shieldedEnemy.maxHp,
    enemyShield: 5,
    turnCount: 0,
  };
  assert.equal(validators.isAuthoritativeBattleStartState(initial, permitId), true);
  const missingStartShield = { ...initial } as Record<string, unknown>;
  delete missingStartShield.enemyShield;
  assert.equal(validators.isAuthoritativeBattleStartState(missingStartShield, permitId), false,
    'the client must not invent a starting Shield when a shielded enemy snapshot omits it');

  const advanced = {
    ...initial,
    playerHp: TEST_DEGEN.maxHp - 10,
    enemyHp: shieldedEnemy.maxHp - 24,
    enemyShield: 0,
    enemyShieldAbsorbed: 5,
    retaliationDamage: 10,
    turnCount: 1,
  };
  assert.equal(validators.isAuthoritativeBattleActionState(advanced, permitId), true);
  const missingActionShield = { ...advanced } as Record<string, unknown>;
  delete missingActionShield.enemyShield;
  assert.equal(validators.isAuthoritativeBattleActionState(missingActionShield, permitId), false,
    'the action validator must not project a depleted enemy Shield back to its starting value');

  const engine = new BattleEngine(TEST_DEGEN, shieldedEnemy, () => undefined, initial);
  engine.synchronizeAuthoritativeState(missingActionShield as never);
  assert.deepEqual(
    [engine.snapshot.turnCount, engine.snapshot.enemyHp, engine.snapshot.enemyShield],
    [0, shieldedEnemy.maxHp, 5],
    'a recovery snapshot without current enemy Shield must not advance or restore the starting Shield',
  );
});

test('client rejects enemy Shield absorption above one Degen hit on multi-turn recovery', () => {
  const shieldedEnemy = { ...TUNNEL_MAW, startingShield: 5 };
  const validators = createBattleValidators(shieldedEnemy);
  const permitId = 'permit-enemy-shield-absorption-bound';
  const maximumAbsorption = maxAbilityDamage(TEST_DEGEN);
  assert.notEqual(maximumAbsorption, undefined);

  const impossibleRecovery = {
    permitId,
    status: 'active' as const,
    playerHp: TEST_DEGEN.maxHp - 20,
    playerMana: TEST_DEGEN.maxMana,
    playerShield: 0,
    shieldAbsorbed: 0,
    retaliationDamage: 10,
    enemyHp: shieldedEnemy.maxHp - 24,
    enemyShield: 0,
    enemyShieldAbsorbed: maximumAbsorption! + 1,
    turnCount: 2,
  };
  assert.equal(validators.isAuthoritativeBattleActionState(impossibleRecovery, permitId), false,
    'the API boundary must reject an absorption delta larger than any one defined Degen hit');

  const initial = {
    permitId,
    status: 'active' as const,
    playerHp: TEST_DEGEN.maxHp,
    playerMana: TEST_DEGEN.maxMana,
    playerShield: 0,
    shieldAbsorbed: 0,
    retaliationDamage: 0,
    enemyHp: shieldedEnemy.maxHp,
    enemyShield: 5,
    turnCount: 0,
  };
  const engine = new BattleEngine(TEST_DEGEN, shieldedEnemy, () => undefined, initial);
  const before = engine.snapshot;
  assert.equal(engine.synchronizeAuthoritativeState(impossibleRecovery as never), false,
    'the engine boundary must reject the same impossible multi-turn recovery');
  assert.deepEqual(engine.snapshot, before, 'invalid audit data must not change the displayed battle');
});


test('API battle validators reject non-deterministic retaliation audits outside legacy snapshots', () => {
  const permitId = 'retaliation-audit-api';
  const validators = createBattleValidators(TUNNEL_MAW);
  const active = {
    permitId,
    status: 'active' as const,
    playerHp: 110,
    playerMana: 0,
    playerShield: 0,
    shieldAbsorbed: 0,
    retaliationDamage: 10,
    enemyHp: 63,
    turnCount: 1,
  };

  assert.equal(isAuthoritativeBattleActionState(active, permitId), true);
  assert.equal(isAuthoritativeBattleActionState({ ...active, retaliationDamage: 9 }, permitId), false);
  assert.equal(validators.isAuthoritativeBattleStartState(active, permitId), true);
  assert.equal(validators.isAuthoritativeBattleStartState({ ...active, retaliationDamage: 9 }, permitId), false);

  const defeat = { ...active, status: 'defeat' as const, playerHp: 0, shieldAbsorbed: 2, turnCount: 2 };
  assert.equal(isAuthoritativeBattleActionState(defeat, permitId), true);
  assert.equal(isAuthoritativeBattleActionState({ ...defeat, retaliationDamage: 9 }, permitId), false);
});
