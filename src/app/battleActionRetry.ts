/**
 * Retry an uncertain battle-action transport result using the *same* observed turn.
 * The Worker compare-and-swap is the authority: never increment the turn locally
 * and never retry an HTTP/authorization/gameplay rejection.
 */
export async function withBattleActionRetry<T>(
  expectedTurnCount: number,
  send: (turnCount: number, signal: AbortSignal) => Promise<T>,
  timeoutMs = 20_000,
): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await send(expectedTurnCount, controller.signal);
    } catch (error) {
      const transportFailure = error instanceof TypeError
        || (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError'));
      if (!transportFailure || attempt === 1) throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error('Battle action retry exhausted.');
}
