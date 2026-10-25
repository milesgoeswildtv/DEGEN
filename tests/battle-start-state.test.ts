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

test('a zero-Mana battle remains active and zero-cost abilities remain usable', () => {
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => undefined, startState({ playerMana: 0 }));
  engine.useAbility('slash');

  assert.equal(engine.snapshot.status, 'active');
  assert.equal(engine.snapshot.playerMana, 0);
  assert.equal(engine.snapshot.enemyHp, 22);
  assert.equal(engine.snapshot.turnCount, 1);
});

test('the client snapshot follows authoritative action HP, Mana, and enemy HP', () => {
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => undefined, startState());
  engine.applyAuthoritativeAction('crack', {
    permitId: 'permit-1', status: 'active', playerHp: 62, playerMana: 0, enemyHp: 25, turnCount: 1,
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
