import type { BattleActionResult, BattleCompletionResult, BattlePermit, HousingState, PlatformIdentity, PlayerState, WorldEventSnapshot } from '../domain/types';
import { withBattleActionRetry } from './battleActionRetry';

const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');

const isNonnegativeSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isAuthoritativeBattleStartState = (value: unknown, permitId: string): value is BattleActionResult => {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  return state.permitId === permitId
    && state.status === 'active'
    && state.turnCount === 0
    && isNonnegativeSafeInteger(state.playerHp) && state.playerHp > 0
    && isNonnegativeSafeInteger(state.playerMana)
    && isNonnegativeSafeInteger(state.enemyHp) && state.enemyHp > 0;
};

const isAuthoritativeBattleActionResult = (
  value: unknown,
  permitId: string,
  expectedTurnCount: number,
): value is BattleActionResult => {
  if (!isNonnegativeSafeInteger(expectedTurnCount) || expectedTurnCount >= Number.MAX_SAFE_INTEGER
    || !value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  if (state.permitId !== permitId
    || typeof state.status !== 'string' || !['active', 'victory', 'defeat'].includes(state.status)
    || state.turnCount !== expectedTurnCount + 1
    || !isNonnegativeSafeInteger(state.playerHp)
    || !isNonnegativeSafeInteger(state.playerMana)
    || !isNonnegativeSafeInteger(state.enemyHp)) return false;

  if (state.status === 'active') return state.playerHp > 0 && state.enemyHp > 0;
  if (state.status === 'victory') return state.playerHp > 0 && state.enemyHp === 0;
  return state.playerHp === 0 && state.enemyHp > 0;
};

export class BattleTurnConflictError extends Error {
  constructor(readonly battleState: BattleActionResult) {
    super('Battle turn changed; synchronized from the Worker.');
    this.name = 'BattleTurnConflictError';
  }
}

export class GameApi {
  readonly enabled = API_BASE.length > 0;

  async bootstrap(playerId: string, identity: PlatformIdentity): Promise<PlayerState | undefined> {
    if (!this.enabled) return undefined;
    // Bootstrap must not leave the app blank indefinitely on a stalled connection.
    // PlayerStore.initialize already handles failures by retaining local preview state.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      return await this.request<PlayerState>('/api/player/bootstrap', {
        method: 'POST',
        body: JSON.stringify({ playerId, displayName: identity.displayName, platform: identity.platform, platformUserId: identity.platformUserId }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async saveHousing(playerId: string, housing: HousingState): Promise<void> {
    if (!this.enabled) return;
    await this.request('/api/player/housing', {
      method: 'PUT',
      body: JSON.stringify({ playerId, housing }),
    });
  }

  async getUnderpass(playerId: string): Promise<WorldEventSnapshot | undefined> {
    if (!this.enabled) return undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      return await this.request<WorldEventSnapshot>(`/api/world/underpass?playerId=${encodeURIComponent(playerId)}`, {
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async startUnderpass(playerId: string, cycleId: string): Promise<BattlePermit | undefined> {
    if (!this.enabled) return undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const permit = await this.request<BattlePermit>('/api/battle/start', {
        method: 'POST',
        body: JSON.stringify({ playerId, eventKey: 'underpass', cycleId, encounterKey: 'tunnel-maw' }),
        signal: controller.signal,
      });
      if (!permit || typeof permit.permitId !== 'string' || !permit.permitId.trim()
        || permit.eventKey !== 'underpass' || permit.cycleId !== cycleId
        || permit.encounterKey !== 'tunnel-maw'
        || typeof permit.expiresAt !== 'string' || !Number.isFinite(Date.parse(permit.expiresAt))
        || !isAuthoritativeBattleStartState(permit.initialState, permit.permitId)) {
        throw new Error('Missing or malformed authoritative battle start state.');
      }
      return permit;
    } finally {
      clearTimeout(timeout);
    }
  }

  async actUnderpass(playerId: string, permitId: string, abilityId: string, expectedTurnCount: number): Promise<BattleActionResult | undefined> {
    if (!this.enabled) return undefined;
    if (!isNonnegativeSafeInteger(expectedTurnCount) || expectedTurnCount >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Invalid expected battle turn count.');
    }
    return withBattleActionRetry(expectedTurnCount, async (turnCount, signal) => {
      const result = await this.request<unknown>('/api/battle/action', {
        method: 'POST',
        signal,
        body: JSON.stringify({ playerId, permitId, abilityId, expectedTurnCount: turnCount }),
      });
      if (!isAuthoritativeBattleActionResult(result, permitId, turnCount)) {
        throw new Error('Malformed authoritative battle action response.');
      }
      return result;
    });
  }

  async completeUnderpass(playerId: string, permitId: string): Promise<BattleCompletionResult | undefined> {
    if (!this.enabled) return undefined;
    // A stalled completion fetch must not indefinitely block serialized reward recovery.
    // The Worker owns reward settlement and replays authoritative receipts on retry.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      return await this.request<BattleCompletionResult>('/api/battle/complete', {
        method: 'POST',
        body: JSON.stringify({ playerId, permitId }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async request<T = void>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    if (!response.ok) {
      if (response.status === 409 && path === '/api/battle/action') {
        const conflict = await response.clone().json().catch(() => null) as { battleState?: BattleActionResult } | null;
        const state = conflict?.battleState;
        if (state && typeof state.permitId === 'string' && Number.isInteger(state.turnCount)
          && state.turnCount >= 0 && Number.isFinite(state.playerHp) && Number.isFinite(state.playerMana)
          && Number.isFinite(state.enemyHp) && ['active', 'victory', 'defeat'].includes(state.status)) {
          throw new BattleTurnConflictError(state);
        }
      }
      const detail = await response.text().catch(() => '');
      throw new Error(`DEGEN API ${response.status}: ${detail || response.statusText}`);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
}
