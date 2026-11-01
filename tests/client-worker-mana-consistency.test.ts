import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';
import { canUseAbility, isValidManaState, resolveCombatTurn } from '../src/game/combat/rules.ts';

// Execute the real client engine with the same deterministic resolver imported by
// the Worker. This deliberately compares behavior, not duplicated expected math.
const engineSource = readFileSync(new URL('../src/game/combat/engine.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/\bexport class /g, 'class ');
const { BattleEngine } = runInNewContext(
  stripTypeScriptTypes(engineSource, { mode: 'transform' }) + '\n({ BattleEngine });',
  { canUseAbility, isValidManaState, resolveCombatTurn },
) as {
  BattleEngine: new (
    degen: typeof TEST_DEGEN,
    enemy: typeof TUNNEL_MAW,
    onComplete: (...args: unknown[]) => void,
    initialState: {
      permitId: string;
      status: 'active' | 'victory' | 'defeat';
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
      log: string[];
    };
    useAbility(abilityId: string): void;
    synchronizeAuthoritativeState(result: {
      permitId: string;
      status: 'active' | 'victory' | 'defeat';
      playerHp: number;
      playerMana: number;
      enemyHp: number;
      turnCount: number;
    }): void;
    applyAuthoritativeAction(abilityId: string, result: {
      permitId: string;
      status: 'active' | 'victory' | 'defeat';
      playerHp: number;
      playerMana: number;
      enemyHp: number;
      turnCount: number;
    }): void;
  };
};

test('client battle engine and shared Worker resolver agree on one paid turn', () => {
  const ability = TEST_DEGEN.abilities.find((candidate) => candidate.id === 'crack');
  assert.ok(ability);

  const input = {
    playerHp: 80,
    playerMana: TEST_DEGEN.maxMana,
    enemyHp: TUNNEL_MAW.maxHp,
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



test('BattleEngine rejects invalid Worker-owned initial snapshots before exposing battle state', () => {
  const valid = {
    permitId: 'permit-invalid-start-snapshot',
    status: 'active' as const,
    playerHp: 80,
    playerMana: 8,
    enemyHp: TUNNEL_MAW.maxHp,
    turnCount: 0,
  };
  const invalidInitialStates = [
    { ...valid, status: 'victory' as const, enemyHp: 0, turnCount: 1 },
    { ...valid, status: 'defeat' as const, playerHp: 0, turnCount: 1 },
    { ...valid, playerHp: 0 },
    { ...valid, playerMana: -1 },
    { ...valid, playerMana: TEST_DEGEN.maxMana + 1 },
    { ...valid, playerMana: 0.5 },
    { ...valid, enemyHp: 0 },
    { ...valid, turnCount: Number.MAX_SAFE_INTEGER },
    { ...valid, permitId: '' },
  ];

  for (const initialState of invalidInitialStates) {
    assert.throws(
      () => new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => undefined, initialState),
      /Invalid authoritative battle start state/,
    );
  }
});


test('malformed authoritative snapshots cannot overwrite combat state or forge terminal outcomes', () => {
  let completions = 0;
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => { completions += 1; }, {
    permitId: 'permit-malformed-snapshot',
    status: 'active',
    playerHp: 80,
    playerMana: 8,
    enemyHp: TUNNEL_MAW.maxHp,
    turnCount: 0,
  });
  const before = {
    status: engine.snapshot.status,
    playerHp: engine.snapshot.playerHp,
    playerMana: engine.snapshot.playerMana,
    enemyHp: engine.snapshot.enemyHp,
    turnCount: engine.snapshot.turnCount,
    log: Array.from(engine.snapshot.log),
  };
  const invalidSnapshots = [
    { permitId: 'permit-malformed-snapshot', status: 'active' as const, playerHp: 70, playerMana: -1, enemyHp: 63, turnCount: 1 },
    { permitId: 'permit-malformed-snapshot', status: 'active' as const, playerHp: 70, playerMana: TEST_DEGEN.maxMana + 1, enemyHp: 63, turnCount: 1 },
    { permitId: 'permit-malformed-snapshot', status: 'active' as const, playerHp: 70, playerMana: 0.5, enemyHp: 63, turnCount: 1 },
    { permitId: 'permit-malformed-snapshot', status: 'victory' as const, playerHp: 0, playerMana: 4, enemyHp: 0, turnCount: 1 },
    { permitId: 'permit-malformed-snapshot', status: 'defeat' as const, playerHp: 0, playerMana: 4, enemyHp: 0, turnCount: 1 },
  ];

  for (const invalid of invalidSnapshots) engine.synchronizeAuthoritativeState(invalid);

  assert.deepEqual({
    status: engine.snapshot.status,
    playerHp: engine.snapshot.playerHp,
    playerMana: engine.snapshot.playerMana,
    enemyHp: engine.snapshot.enemyHp,
    turnCount: engine.snapshot.turnCount,
    log: Array.from(engine.snapshot.log),
  }, before, 'invalid Mana and impossible terminal HP combinations must be ignored');
  assert.equal(completions, 0, 'malformed terminal snapshots cannot emit completion');
});

test('an authoritative action with over-cap Mana is ignored before the client presents a killing blow', () => {
  let completions = 0;
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => { completions += 1; }, {
    permitId: 'permit-invalid-action-result',
    status: 'active',
    playerHp: 80,
    playerMana: 8,
    enemyHp: TUNNEL_MAW.maxHp,
    turnCount: 0,
  });
  const before = {
    status: engine.snapshot.status,
    playerHp: engine.snapshot.playerHp,
    playerMana: engine.snapshot.playerMana,
    enemyHp: engine.snapshot.enemyHp,
    turnCount: engine.snapshot.turnCount,
  };

  engine.applyAuthoritativeAction('crack', {
    permitId: 'permit-invalid-action-result',
    status: 'victory',
    playerHp: 80,
    playerMana: TEST_DEGEN.maxMana + 1,
    enemyHp: 0,
    turnCount: 1,
  });

  assert.deepEqual({
    status: engine.snapshot.status,
    playerHp: engine.snapshot.playerHp,
    playerMana: engine.snapshot.playerMana,
    enemyHp: engine.snapshot.enemyHp,
    turnCount: engine.snapshot.turnCount,
  }, before);
  assert.equal(completions, 0, 'invalid authoritative results cannot trigger reward completion');
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
