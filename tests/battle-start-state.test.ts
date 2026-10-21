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
  .replace(/^import .*;\\r?\\n/gm, '')
  .replace('export class BattleEngine', 'class BattleEngine');
const BattleEngine = runInNewContext(
  stripTypeScriptTypes(engineSource, { mode: 'transform' }) + '\\nBattleEngine;',
  { canUseAbility, resolveCombatTurn },
) as new (
  degen: typeof TEST_DEGEN,
  enemy: typeof TUNNEL_MAW,
  onComplete: (status: 'victory' | 'defeat') => void,
  initialState?: BattleActionResult,
) => {
  snapshot: { playerHp: number; playerMana: number; enemyHp: number; status: string };
  useAbility: (abilityId: string) => void;
  applyAuthoritativeAction: (abilityId: string, result: BattleActionResult) => void;
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
