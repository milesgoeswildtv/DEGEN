import assert from 'node:assert/strict';
import test from 'node:test';

import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';
import type { BattleActionResult, BattleReward } from '../src/domain/types.ts';
import { BattleEngine } from '../src/game/combat/engine.ts';
import { resolveCombatTurn } from '../src/game/combat/rules.ts';

const resolve = (abilityId: string, state: { playerHp: number; playerMana: number; enemyHp: number }) => {
  const ability = TEST_DEGEN.abilities.find((candidate) => candidate.id === abilityId);
  assert.ok(ability);
  return resolveCombatTurn({ ...state, ability, degen: TEST_DEGEN, enemy: TUNNEL_MAW });
};

const serverResult = (
  turnCount: number,
  result: ReturnType<typeof resolveCombatTurn>,
): BattleActionResult => ({
  permitId: 'permit-test',
  status: result.status,
  playerHp: result.playerHp,
  playerMana: result.playerMana,
  enemyHp: result.enemyHp,
  turnCount,
});

test('server-backed presentation applies the Worker Mana and combat result once without local reward calculation', () => {
  const completed: Array<{ status: string; reward?: BattleReward }> = [];
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, (status, reward) => completed.push({ status, reward }));
  const turn = resolve('crack', { playerHp: 120, playerMana: 12, enemyHp: 92 });
  const authoritative = serverResult(1, turn);

  engine.applyAuthoritativeAction('crack', authoritative);
  const afterAcceptedAction = engine.snapshot;
  assert.deepEqual(
    [afterAcceptedAction.status, afterAcceptedAction.playerHp, afterAcceptedAction.playerMana,
      afterAcceptedAction.enemyHp, afterAcceptedAction.turnCount],
    [authoritative.status, authoritative.playerHp, authoritative.playerMana, authoritative.enemyHp, 1],
  );
  assert.ok(afterAcceptedAction.log.some((entry) => entry.includes('uses Crack: 35 damage')));
  assert.ok(afterAcceptedAction.log.some((entry) => entry.includes('Mana -4')));
  assert.equal(completed.length, 0, 'an active authoritative result cannot complete the encounter');

  engine.applyAuthoritativeAction('crack', authoritative);
  assert.deepEqual(engine.snapshot, afterAcceptedAction, 'duplicate Worker response must not apply the action twice');
  assert.equal(completed.length, 0);
});

test('out-of-order Worker responses synchronize to authoritative state and ignore stale turns', () => {
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => undefined);
  const first = serverResult(1, resolve('crack', { playerHp: 120, playerMana: 12, enemyHp: 92 }));
  const second = serverResult(2, resolve('slash', {
    playerHp: first.playerHp,
    playerMana: first.playerMana,
    enemyHp: first.enemyHp,
  }));

  engine.applyAuthoritativeAction('slash', second);
  const synchronized = engine.snapshot;
  assert.deepEqual(
    [synchronized.status, synchronized.playerHp, synchronized.playerMana, synchronized.enemyHp, synchronized.turnCount],
    [second.status, second.playerHp, second.playerMana, second.enemyHp, 2],
  );
  assert.ok(synchronized.log.includes('Battle state synchronized with server.'));
  assert.equal(synchronized.log.some((entry) => entry.includes('uses Slash:')), false,
    'a skipped turn must not be falsely attributed to the clicked ability');

  engine.applyAuthoritativeAction('crack', first);
  assert.deepEqual(engine.snapshot, synchronized, 'a stale response cannot roll back HP, Mana, enemy HP, or turn count');
});

test('server-issued battle-start state initializes the client without assuming local Mana', () => {
  const initialState: BattleActionResult = {
    permitId: 'permit-test',
    status: 'active',
    playerHp: 87,
    playerMana: 5,
    enemyHp: 61,
    turnCount: 0,
  };
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => undefined, initialState);

  assert.deepEqual(
    [engine.snapshot.status, engine.snapshot.playerHp, engine.snapshot.playerMana,
      engine.snapshot.enemyHp, engine.snapshot.turnCount],
    ['active', 87, 5, 61, 0],
  );
  assert.equal(engine.snapshot.playerMaxMana, TEST_DEGEN.maxMana);
});

test('zero-Mana free action keeps the Degen manifested and the encounter active', () => {
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, () => undefined);
  const result = serverResult(1, resolve('slash', { playerHp: 120, playerMana: 0, enemyHp: 60 }));

  engine.applyAuthoritativeAction('slash', result);

  assert.equal(engine.snapshot.status, 'active');
  assert.equal(engine.snapshot.playerMana, 0);
  assert.equal(engine.snapshot.playerName, TEST_DEGEN.name);
  assert.equal(engine.snapshot.log.some((entry) => /revert/i.test(entry)), false);
});

test('authoritative killing blow completes once and never supplies client-computed rewards', () => {
  const completed: Array<{ status: string; reward?: BattleReward }> = [];
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, (status, reward) => completed.push({ status, reward }));
  const result = serverResult(1, resolve('crack', { playerHp: 120, playerMana: 4, enemyHp: 30 }));

  engine.applyAuthoritativeAction('crack', result);
  engine.applyAuthoritativeAction('crack', result);

  assert.equal(engine.snapshot.status, 'victory');
  assert.equal(engine.snapshot.playerMana, 0);
  assert.equal(engine.snapshot.enemyHp, 0);
  assert.equal(engine.snapshot.turnCount, 1);
  assert.deepEqual(completed, [{ status: 'victory', reward: undefined }]);
});

test('authoritative defeat preserves Worker Mana and never supplies a client reward', () => {
  const completed: Array<{ status: string; reward?: BattleReward }> = [];
  const engine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, (status, reward) => completed.push({ status, reward }));
  const result = serverResult(1, resolve('slash', { playerHp: 1, playerMana: 0, enemyHp: 60 }));

  engine.applyAuthoritativeAction('slash', result);

  assert.equal(engine.snapshot.status, 'defeat');
  assert.equal(engine.snapshot.playerHp, 0);
  assert.equal(engine.snapshot.playerMana, 0);
  assert.equal(engine.snapshot.turnCount, 1);
  assert.deepEqual(completed, [{ status: 'defeat', reward: undefined }]);
});
