import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';
import { assertNoMonsterActionResource, canUseAbility, isValidManaState, isValidShield, resolveCombatTurn } from '../src/game/combat/rules.ts';
import type { BattleActionResult } from '../src/domain/types.ts';

// Load the real engine source without asking Node's native ESM resolver to
// follow the production bundler's extensionless internal import.
const engineSource = readFileSync(new URL('../src/game/combat/engine.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace('export class BattleEngine', 'class BattleEngine');
const BattleEngine = runInNewContext(
  stripTypeScriptTypes(engineSource, { mode: 'transform' }) + '\nBattleEngine;',
  { assertNoMonsterActionResource, canUseAbility, isValidManaState, isValidShield, resolveCombatTurn },
) as new (
  degen: typeof TEST_DEGEN,
  enemy: typeof TUNNEL_MAW,
  onComplete: (status: 'victory' | 'defeat') => void,
  initialState?: BattleActionResult,
) => {
  snapshot: { playerHp: number; playerMana: number; enemyHp: number; status: string; turnCount: number };
  useAbility: (abilityId: string) => void;
  applyAuthoritativeAction: (abilityId: string, result: BattleActionResult) => void;
  synchronizeAuthoritativeState: (result: BattleActionResult) => void;
};

const startState = (overrides: Partial<BattleActionResult> = {}): BattleActionResult => ({
  permitId: 'permit-1',
  status: 'active',
  playerHp: 73,
  playerMana: 4,
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

test('an offline zero-Mana preview remains active and zero-cost abilities remain usable', () => {
  const zeroManaDegen = { ...TEST_DEGEN, maxMana: 0 };
  const previewEnemy = { ...TUNNEL_MAW, maxHp: 51 };
  const engine = new BattleEngine(zeroManaDegen, previewEnemy, () => undefined);
  engine.useAbility('slash');

  assert.equal(engine.snapshot.status, 'active');
  assert.equal(engine.snapshot.playerMana, 0);
  assert.equal(engine.snapshot.enemyHp, 22);
  assert.equal(engine.snapshot.turnCount, 1);
});

test('the client snapshot follows an exact legacy Worker action result', () => {
  const initial = startState();
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => undefined, initial);
  const ability = TEST_DEGEN.abilities.find((candidate) => candidate.id === 'crack');
  assert.ok(ability);
  const turn = resolveCombatTurn({
    playerHp: initial.playerHp,
    playerMana: initial.playerMana,
    playerShield: 0,
    enemyHp: initial.enemyHp,
    enemyShield: 0,
    ability,
    degen: TEST_DEGEN,
    enemy: TUNNEL_MAW,
  });
  // Pre-Shield Worker snapshots omit all Shield audit fields. The engine infers
  // retaliation from the returned HP delta, then validates the complete shared turn.
  engine.applyAuthoritativeAction('crack', {
    permitId: 'permit-1',
    status: turn.status,
    playerHp: turn.playerHp,
    playerMana: turn.playerMana,
    enemyHp: turn.enemyHp,
    turnCount: 1,
  });

  assert.equal(engine.snapshot.playerHp, turn.playerHp);
  assert.equal(engine.snapshot.playerMana, turn.playerMana);
  assert.equal(engine.snapshot.enemyHp, turn.enemyHp);
  assert.equal(engine.snapshot.status, turn.status);
  assert.equal(engine.snapshot.turnCount, 1);
});

test('an unaffordable offline preview action changes neither state nor turn count', () => {
  const zeroManaDegen = { ...TEST_DEGEN, maxMana: 0 };
  const previewEnemy = { ...TUNNEL_MAW, maxHp: 51 };
  const engine = new BattleEngine(zeroManaDegen, previewEnemy, () => undefined);
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
    permitId: 'permit-1', status: 'active', playerHp: 54, playerMana: 0, enemyHp: 13, turnCount: 2,
  });
  assert.deepEqual(
    [engine.snapshot.playerHp, engine.snapshot.playerMana, engine.snapshot.enemyHp, engine.snapshot.turnCount],
    [54, 0, 13, 2],
  );
  engine.synchronizeAuthoritativeState({
    permitId: 'another-permit', status: 'active', playerHp: 1, playerMana: 12, enemyHp: 1, turnCount: 99,
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
  const initial = { ...startState(), playerHp: 10, playerMana: 4 };
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, status => completions.push(status), initial);
  const ability = TEST_DEGEN.abilities.find((candidate) => candidate.id === 'crack');
  assert.ok(ability);
  const turn = resolveCombatTurn({
    playerHp: initial.playerHp,
    playerMana: initial.playerMana,
    enemyHp: initial.enemyHp,
    ability,
    degen: TEST_DEGEN,
    enemy: TUNNEL_MAW,
  });
  assert.equal(turn.status, 'defeat');

  // Pre-Shield recovery snapshots omit Shield audit fields. Use the shared resolver
  // to prove this is a real one-turn defeat rather than a fabricated terminal state.
  const completedDefeat: BattleActionResult = {
    permitId: 'permit-1',
    status: turn.status,
    playerHp: turn.playerHp,
    playerMana: turn.playerMana,
    enemyHp: turn.enemyHp,
    turnCount: 1,
  };
  engine.synchronizeAuthoritativeState(completedDefeat);

  assert.equal(engine.snapshot.status, 'defeat');
  assert.equal(engine.snapshot.playerHp, turn.playerHp);
  assert.equal(engine.snapshot.playerMana, turn.playerMana);
  assert.equal(engine.snapshot.enemyHp, turn.enemyHp);
  assert.equal(engine.snapshot.turnCount, 1);
  assert.deepEqual(completions, ['defeat']);

  engine.synchronizeAuthoritativeState(completedDefeat);
  assert.deepEqual(completions, ['defeat'], 'replaying the recovered defeat snapshot must not finish twice');
});
