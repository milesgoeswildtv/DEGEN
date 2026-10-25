import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';
import { canUseAbility, resolveCombatTurn } from '../src/game/combat/rules.ts';
import type { BattleActionResult } from '../src/domain/types.ts';

// Load the real engine source without asking Node's native ESM resolver to
// follow the production bundler's extensionless internal import.
const engineSource = readFileSync(new URL('../src/game/combat/engine.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace('export class BattleEngine', 'class BattleEngine');
const BattleEngine = runInNewContext(
  stripTypeScriptTypes(engineSource, { mode: 'transform' }) + '\nBattleEngine;',
  { canUseAbility, resolveCombatTurn },
) as new (
  degen: typeof TEST_DEGEN,
  enemy: typeof TUNNEL_MAW,
  onComplete: (status: 'victory' | 'defeat') => void,
  initialState?: BattleActionResult,
) => {
  snapshot: { playerHp: number; playerMana: number; playerShield: number; enemyHp: number; status: string; turnCount: number; log: string[] };
  useAbility: (abilityId: string) => void;
  applyAuthoritativeAction: (abilityId: string, result: BattleActionResult) => void;
  synchronizeAuthoritativeState: (result: BattleActionResult) => void;
};

const startState = (overrides: Partial<BattleActionResult> = {}): BattleActionResult => ({
  permitId: 'permit-1',
  status: 'active',
  playerHp: 73,
  playerMana: 4,
  playerShield: 0,
  shieldAbsorbed: 0,
  retaliationDamage: 0,
  enemyHp: 51,
  turnCount: 0,
  ...overrides,
});

test('BattleEngine initializes from the Worker snapshot instead of prototype defaults', () => {
  const initialState = startState();
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => undefined, initialState);

  assert.equal(engine.snapshot.playerHp, initialState.playerHp);
  assert.equal(engine.snapshot.playerMana, initialState.playerMana);
  assert.equal(engine.snapshot.enemyHp, initialState.enemyHp);
  assert.equal(engine.snapshot.status, 'active');
  assert.equal(engine.snapshot.turnCount, 0);
});

test('a zero-Mana battle remains active and zero-cost abilities remain usable', () => {
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => undefined, startState({ playerMana: 0 }));
  engine.useAbility('slash');

  assert.equal(engine.snapshot.status, 'active');
  assert.equal(engine.snapshot.playerMana, 0);
  assert.equal(engine.snapshot.enemyHp, 22);
  assert.equal(engine.snapshot.turnCount, 1);
});

test('authoritative battle log reports full retaliation when Shield absorbs part of the hit', () => {
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => undefined, startState({
    playerHp: 50, playerMana: 0, playerShield: 7, enemyHp: TUNNEL_MAW.maxHp,
  }));
  engine.applyAuthoritativeAction('slash', {
    permitId: 'permit-1', status: 'active', playerHp: 47, playerMana: 0,
    playerShield: 0, shieldAbsorbed: 7, retaliationDamage: 10, enemyHp: 63, turnCount: 1,
  });

  assert.ok(engine.snapshot.log.includes('Tunnel Maw hits back for 10.'));
  assert.ok(engine.snapshot.log.includes('Shield absorbs 7.'));
  assert.equal(engine.snapshot.log.includes('Tunnel Maw hits back for 3.'), false);
});

test('authoritative Shield gain is applied once when the same action response is replayed', () => {
  const shieldDegen = {
    ...TEST_DEGEN,
    abilities: TEST_DEGEN.abilities.map((ability) => ability.id === 'slash'
      ? { ...ability, shieldGain: 3 }
      : ability),
  };
  const engine = new BattleEngine(shieldDegen, TUNNEL_MAW, () => undefined, startState({
    playerHp: 50, playerMana: 0, playerShield: 4, enemyHp: TUNNEL_MAW.maxHp,
  }));
  const authoritative: BattleActionResult = {
    permitId: 'permit-1', status: 'active', playerHp: 47, playerMana: 0,
    playerShield: 0, shieldAbsorbed: 7, retaliationDamage: 10, enemyHp: 63, turnCount: 1,
  };

  engine.applyAuthoritativeAction('slash', authoritative);
  assert.equal(engine.snapshot.playerHp, 47);
  assert.equal(engine.snapshot.playerShield, 0);
  assert.equal(engine.snapshot.turnCount, 1);
  assert.equal(engine.snapshot.log.filter((entry) => entry === 'Shield +3.').length, 1);
  assert.equal(engine.snapshot.log.filter((entry) => entry === 'Shield absorbs 7.').length, 1);

  engine.applyAuthoritativeAction('slash', authoritative);
  assert.equal(engine.snapshot.playerHp, 47, 'a replay cannot apply retaliation twice');
  assert.equal(engine.snapshot.playerShield, 0, 'a replay cannot grant or consume Shield twice');
  assert.equal(engine.snapshot.enemyHp, 63);
  assert.equal(engine.snapshot.turnCount, 1);
  assert.equal(engine.snapshot.log.filter((entry) => entry === 'Shield +3.').length, 1);
  assert.equal(engine.snapshot.log.filter((entry) => entry === 'Shield absorbs 7.').length, 1);
});

test('authoritative battle log keeps full retaliation on defeat even when Shield absorbs damage', () => {
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => undefined, startState({
    playerHp: 1, playerMana: 0, playerShield: 2, enemyHp: TUNNEL_MAW.maxHp,
  }));
  engine.applyAuthoritativeAction('slash', {
    permitId: 'permit-1', status: 'defeat', playerHp: 0, playerMana: 0,
    playerShield: 0, shieldAbsorbed: 2, retaliationDamage: 10, enemyHp: 63, turnCount: 1,
  });

  assert.ok(engine.snapshot.log.includes('Tunnel Maw hits back for 10.'));
  assert.ok(engine.snapshot.log.includes('Shield absorbs 2.'));
  assert.ok(engine.snapshot.log.includes('TEST_DEGEN goes down.'));
  assert.equal(engine.snapshot.log.includes('Tunnel Maw hits back for 1.'), false);
});

test('the client snapshot follows authoritative action HP, Mana, and enemy HP', () => {
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => undefined, startState());
  engine.applyAuthoritativeAction('crack', {
    permitId: 'permit-1', status: 'active', playerHp: 62, playerMana: 0, playerShield: 0, shieldAbsorbed: 0, retaliationDamage: 10, enemyHp: 25, turnCount: 1,
  });

  assert.equal(engine.snapshot.playerHp, 62);
  assert.equal(engine.snapshot.playerMana, 0);
  assert.equal(engine.snapshot.enemyHp, 25);
  assert.equal(engine.snapshot.status, 'active');
  assert.equal(engine.snapshot.turnCount, 1);
});

test('an unaffordable local preview action changes neither state nor turn count', () => {
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => undefined, startState({ playerMana: 0 }));
  const before = engine.snapshot;
  engine.useAbility('crack');

  assert.equal(engine.snapshot.playerHp, before.playerHp);
  assert.equal(engine.snapshot.playerMana, before.playerMana);
  assert.equal(engine.snapshot.enemyHp, before.enemyHp);
  assert.equal(engine.snapshot.turnCount, 0);
});

test('a stale action response synchronizes only from the same permit authoritative state', () => {
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => undefined, startState());
  engine.synchronizeAuthoritativeState({
    permitId: 'permit-1', status: 'active', playerHp: 54, playerMana: 0, playerShield: 0, shieldAbsorbed: 0, retaliationDamage: 0, enemyHp: 13, turnCount: 2,
  });
  assert.deepEqual(
    [engine.snapshot.playerHp, engine.snapshot.playerMana, engine.snapshot.enemyHp, engine.snapshot.turnCount],
    [54, 0, 13, 2],
  );
  engine.synchronizeAuthoritativeState({
    permitId: 'another-permit', status: 'active', playerHp: 1, playerMana: 12, playerShield: 0, shieldAbsorbed: 0, retaliationDamage: 0, enemyHp: 1, turnCount: 99,
  });
  assert.deepEqual(
    [engine.snapshot.playerHp, engine.snapshot.playerMana, engine.snapshot.enemyHp, engine.snapshot.turnCount],
    [54, 0, 13, 2],
  );
});

test('a recovered authoritative victory snapshot completes the client battle exactly once', () => {
  const completions: Array<'victory' | 'defeat'> = [];
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, status => completions.push(status), startState());

  const completedVictory: BattleActionResult = {
    permitId: 'permit-1',
    status: 'victory',
    playerHp: 70,
    playerMana: 0,
    playerShield: 5,
    shieldAbsorbed: 0,
    retaliationDamage: 0,
    enemyHp: 0,
    turnCount: 3,
  };
  engine.synchronizeAuthoritativeState(completedVictory);

  assert.equal(engine.snapshot.status, 'victory');
  assert.equal(engine.snapshot.playerHp, 70);
  assert.equal(engine.snapshot.playerMana, 0);
  assert.equal(engine.snapshot.playerShield, 5, 'unused Shield survives the recovered killing blow');
  assert.equal(engine.snapshot.enemyHp, 0);
  assert.equal(engine.snapshot.turnCount, 3);
  assert.deepEqual(completions, ['victory']);

  engine.synchronizeAuthoritativeState(completedVictory);
  assert.deepEqual(completions, ['victory'], 'replaying the recovered terminal snapshot must not complete twice');
});


test('a recovered authoritative defeat snapshot ends the client battle exactly once', () => {
  const completions: Array<'victory' | 'defeat'> = [];
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, status => completions.push(status), startState());

  const completedDefeat: BattleActionResult = {
    permitId: 'permit-1',
    status: 'defeat',
    playerHp: 0,
    playerMana: 0,
    playerShield: 0,
    shieldAbsorbed: 2,
    retaliationDamage: 10,
    enemyHp: 63,
    turnCount: 1,
  };
  engine.synchronizeAuthoritativeState(completedDefeat);

  assert.equal(engine.snapshot.status, 'defeat');
  assert.equal(engine.snapshot.playerHp, 0);
  assert.equal(engine.snapshot.playerMana, 0);
  assert.equal(engine.snapshot.playerShield, 0);
  assert.equal(engine.snapshot.enemyHp, 63);
  assert.equal(engine.snapshot.turnCount, 1);
  assert.deepEqual(completions, ['defeat']);

  engine.synchronizeAuthoritativeState(completedDefeat);
  assert.deepEqual(completions, ['defeat'], 'replaying the recovered defeat snapshot must not finish twice');
});


test('a recovered authoritative victory snapshot completes the client battle exactly once', () => {
  const completions: Array<'victory' | 'defeat'> = [];
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, status => completions.push(status), startState());

  const completedVictory: BattleActionResult = {
    permitId: 'permit-1',
    status: 'victory',
    playerHp: 70,
    playerMana: 0,
    enemyHp: 0,
    turnCount: 3,
  };
  engine.synchronizeAuthoritativeState(completedVictory);

  assert.equal(engine.snapshot.status, 'victory');
  assert.equal(engine.snapshot.playerHp, 70);
  assert.equal(engine.snapshot.playerMana, 0);
  assert.equal(engine.snapshot.enemyHp, 0);
  assert.equal(engine.snapshot.turnCount, 3);
  assert.deepEqual(completions, ['victory']);

  engine.synchronizeAuthoritativeState(completedVictory);
  assert.deepEqual(completions, ['victory'], 'replaying the recovered terminal snapshot must not complete twice');
});


test('a recovered authoritative defeat snapshot ends the client battle exactly once', () => {
  const completions: Array<'victory' | 'defeat'> = [];
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, status => completions.push(status), startState());

  const completedDefeat: BattleActionResult = {
    permitId: 'permit-1',
    status: 'defeat',
    playerHp: 0,
    playerMana: 0,
    enemyHp: 63,
    turnCount: 1,
  };
  engine.synchronizeAuthoritativeState(completedDefeat);

  assert.equal(engine.snapshot.status, 'defeat');
  assert.equal(engine.snapshot.playerHp, 0);
  assert.equal(engine.snapshot.playerMana, 0);
  assert.equal(engine.snapshot.enemyHp, 63);
  assert.equal(engine.snapshot.turnCount, 1);
  assert.deepEqual(completions, ['defeat']);

  engine.synchronizeAuthoritativeState(completedDefeat);
  assert.deepEqual(completions, ['defeat'], 'replaying the recovered defeat snapshot must not finish twice');
});
