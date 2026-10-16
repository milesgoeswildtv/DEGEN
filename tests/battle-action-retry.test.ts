import assert from 'node:assert/strict';
import test from 'node:test';
import { withBattleActionRetry } from '../src/app/battleActionRetry.ts';

test('a successful action sends one request with the observed turn', async () => {
  const turns: number[] = [];
  const value = await withBattleActionRetry(3, async (turn, signal) => {
    assert.equal(signal.aborted, false);
    turns.push(turn);
    return { turnCount: 4 };
  });
  assert.deepEqual(value, { turnCount: 4 });
  assert.deepEqual(turns, [3]);
});

test('a network failure retries once with the identical expected turn', async () => {
  const turns: number[] = [];
  const signals: AbortSignal[] = [];
  const value = await withBattleActionRetry(8, async (turn, signal) => {
    turns.push(turn);
    signals.push(signal);
    if (turns.length === 1) throw new TypeError('Failed to fetch');
    return { turnCount: 9 };
  });
  assert.deepEqual(value, { turnCount: 9 });
  assert.deepEqual(turns, [8, 8]);
  assert.notEqual(signals[0], signals[1]);
});

test('a timed-out action retries the same turn, never guessing a second action', async () => {
  const turns: number[] = [];
  const value = await withBattleActionRetry(0, async (turn, signal) => {
    turns.push(turn);
    if (turns.length === 1) {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('timeout', 'AbortError')), { once: true });
      });
    }
    return { turnCount: 1 };
  }, 5);
  assert.deepEqual(value, { turnCount: 1 });
  assert.deepEqual(turns, [0, 0]);
});

test('an authoritative 409 conflict is not retried or converted into another turn', async () => {
  let calls = 0;
  const conflict = new Error('Battle turn changed; synchronized from the Worker.');
  await assert.rejects(withBattleActionRetry(2, async () => {
    calls += 1;
    throw conflict;
  }), error => error === conflict);
  assert.equal(calls, 1);
});

test('a gameplay rejection is not retried', async () => {
  let calls = 0;
  await assert.rejects(withBattleActionRetry(4, async () => {
    calls += 1;
    throw new RangeError('Not enough Mana');
  }), /Not enough Mana/);
  assert.equal(calls, 1);
});

test('two consecutive transport failures stop after the bounded retry', async () => {
  const turns: number[] = [];
  await assert.rejects(withBattleActionRetry(5, async turn => {
    turns.push(turn);
    throw new TypeError('offline');
  }), /offline/);
  assert.deepEqual(turns, [5, 5]);
});
