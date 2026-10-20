import assert from 'node:assert/strict';
import test from 'node:test';
import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';
import { BattleEngine } from '../src/game/combat/engine.ts';
import type { BattleActionResult } from '../src/domain/types.ts';

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
});

test('a zero-Mana battle remains active and zero-cost abilities remain usable', () => {
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => undefined, startState({ playerMana: 0 }));
  engine.useAbility('slash');

  assert.equal(engine.snapshot.status, 'active');
  assert.equal(engine.snapshot.playerMana, 0);
  assert.equal(engine.snapshot.enemyHp, 22);
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
});
