import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';
import { canUseAbility, isValidManaState, isValidShield, resolveCombatTurn } from '../src/game/combat/rules.ts';
const apiSource = readFileSync(new URL('../src/app/api.ts', import.meta.url), 'utf8');
const validatorStart = apiSource.indexOf('export const isAuthoritativeBattleActionState =');
const validatorEnd = apiSource.indexOf('\nconst isRecord', validatorStart);
if (validatorStart < 0 || validatorEnd < 0) throw new Error('Authoritative battle validator source was not found.');
const validatorSource = apiSource.slice(validatorStart, validatorEnd).replace('export const ', 'const ');
const { isAuthoritativeBattleActionState } = runInNewContext(
  stripTypeScriptTypes(`
    const isBoundedSafeInteger = (value, minimum, maximum) =>
      typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
    ${validatorSource}
    ({ isAuthoritativeBattleActionState });
  `, { mode: 'transform' }),
  { TEST_DEGEN, TUNNEL_MAW },
) as {
  isAuthoritativeBattleActionState(value: unknown, permitId: string): boolean;
};

// Execute the real client engine with the same deterministic resolver imported by
// the Worker. This deliberately compares behavior, not duplicated expected math.
const engineSource = readFileSync(new URL('../src/game/combat/engine.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/\bexport class /g, 'class ');
const { BattleEngine } = runInNewContext(
  stripTypeScriptTypes(engineSource, { mode: 'transform' }) + '\n({ BattleEngine });',
  { canUseAbility, isValidManaState, isValidShield, resolveCombatTurn },
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
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => undefined, {
    permitId: 'permit-replay',
    status: 'active',
    playerHp: 100,
    playerMana: 8,
    enemyHp: TUNNEL_MAW.maxHp,
    turnCount: 0,
  });
  const result = {
    permitId: 'permit-replay',
    status: 'active' as const,
    playerHp: 85,
    playerMana: 5,
    enemyHp: 60,
    turnCount: 1,
  };

  engine.applyAuthoritativeAction('crack', result);
  const firstLog = [...engine.snapshot.log];
  engine.applyAuthoritativeAction('crack', result);

  assert.equal(engine.snapshot.playerMana, 5);
  assert.equal(engine.snapshot.turnCount, 1);
  assert.equal(engine.snapshot.enemyHp, 60);
  assert.equal(engine.snapshot.log.filter((entry) => entry.includes('uses')).length, 1);
  assert.equal(engine.snapshot.log.filter((entry) => entry.startsWith('Mana -')).length, 1);
  assert.deepEqual(Array.from(engine.snapshot.log), firstLog);
});


test('a terminal authoritative result cannot be reopened by a later active snapshot', () => {
  let completions = 0;
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, (status) => {
    assert.equal(status, 'victory');
    completions += 1;
  }, {
    permitId: 'permit-terminal',
    status: 'active',
    playerHp: 80,
    playerMana: 8,
    enemyHp: TUNNEL_MAW.maxHp,
    turnCount: 0,
  });

  engine.applyAuthoritativeAction('crack', {
    permitId: 'permit-terminal',
    status: 'victory',
    playerHp: 80,
    playerMana: 5,
    enemyHp: 0,
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


test('client rejects impossible active Shield audits and preserves the legacy zero/zero sentinel', () => {
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
  }, permitId), true,
  'the zero-Shield, zero/zero audit is the compatibility projection for migrated legacy permits');
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
    { ...valid, playerShield: 1, turnCount: 1, retaliationDamage: 0 },
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
  assert.deepEqual(engine.snapshot, before);
});
