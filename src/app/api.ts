import type { BattleActionResult, BattleCompletionResult, BattlePermit, HousingState, PlatformIdentity, PlayerState, WorldEventSnapshot } from '../domain/types';
import { TEST_DEGEN, TUNNEL_MAW } from '../data/combatPrototype';

const isBoundedSafeInteger = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;

const isAuthoritativeBattleStartState = (value: unknown, permitId: string): value is BattleActionResult => {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  return state.permitId === permitId
    && state.status === 'active'
    && state.turnCount === 0
    && isBoundedSafeInteger(state.playerHp, 1, TEST_DEGEN.maxHp)
    && isBoundedSafeInteger(state.playerMana, 0, TEST_DEGEN.maxMana)
    && isBoundedSafeInteger(state.enemyHp, 1, TUNNEL_MAW.maxHp);
};

export const isAuthoritativeBattleActionState = (value: unknown, permitId: string): value is BattleActionResult => {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  const playerHp = state.playerHp;
  const playerMana = state.playerMana;
  const enemyHp = state.enemyHp;
  const turnCount = state.turnCount;
  if (state.permitId !== permitId
    || (state.status !== 'active' && state.status !== 'victory' && state.status !== 'defeat')
    || !isBoundedSafeInteger(playerHp, 0, TEST_DEGEN.maxHp)
    || !isBoundedSafeInteger(playerMana, 0, TEST_DEGEN.maxMana)
    || !isBoundedSafeInteger(enemyHp, 0, TUNNEL_MAW.maxHp)
    || !isBoundedSafeInteger(turnCount, 0, Number.MAX_SAFE_INTEGER)) return false;

  if (state.status === 'active') return playerHp > 0 && enemyHp > 0;
  if (state.status === 'victory') return playerHp > 0 && enemyHp === 0;
  return playerHp === 0 && enemyHp > 0;
};

export class GameApiError extends Error {
  constructor(readonly status: number, readonly payload: unknown, message: string) {
    super(message);
    this.name = 'GameApiError';
  }
}

const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');

export class GameApi {
  readonly enabled = API_BASE.length > 0;

  async bootstrap(playerId: string, identity: PlatformIdentity): Promise<PlayerState | undefined> {
    if (!this.enabled) return undefined;
    return this.request<PlayerState>('/api/player/bootstrap', {
      method: 'POST',
      body: JSON.stringify({ playerId, displayName: identity.displayName, platform: identity.platform, platformUserId: identity.platformUserId }),
    });
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
    return this.request<WorldEventSnapshot>(`/api/world/underpass?playerId=${encodeURIComponent(playerId)}`);
  }

  async startUnderpass(playerId: string, cycleId: string): Promise<BattlePermit | undefined> {
    if (!this.enabled) return undefined;
    const permit = await this.request<BattlePermit>('/api/battle/start', {
      method: 'POST',
      body: JSON.stringify({ playerId, eventKey: 'underpass', cycleId, encounterKey: 'tunnel-maw' }),
    });
    if (!permit || typeof permit.permitId !== 'string' || !permit.permitId.trim()
      || permit.eventKey !== 'underpass' || permit.cycleId !== cycleId
      || permit.encounterKey !== TUNNEL_MAW.id
      || typeof permit.expiresAt !== 'string' || !Number.isFinite(Date.parse(permit.expiresAt))
      || Date.parse(permit.expiresAt) <= Date.now()
      || !isAuthoritativeBattleStartState(permit.initialState, permit.permitId)) {
      throw new Error('Missing or malformed authoritative battle start state.');
    }
    return permit;
  }

  async actUnderpass(playerId: string, permitId: string, abilityId: string, expectedTurnCount: number): Promise<BattleActionResult | undefined> {
    if (!this.enabled) return undefined;
    if (!Number.isSafeInteger(expectedTurnCount) || expectedTurnCount < 0 || expectedTurnCount >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Invalid expected turn count.');
    }
    const result = await this.request<BattleActionResult>('/api/battle/action', {
      method: 'POST',
      body: JSON.stringify({ playerId, permitId, abilityId, expectedTurnCount }),
    });
    if (!isAuthoritativeBattleActionState(result, permitId) || result.turnCount !== expectedTurnCount + 1) {
      throw new Error('Malformed authoritative battle action response.');
    }
    return result;
  }

  async completeUnderpass(playerId: string, permitId: string): Promise<BattleCompletionResult | undefined> {
    if (!this.enabled) return undefined;
    return this.request<BattleCompletionResult>('/api/battle/complete', {
      method: 'POST',
      body: JSON.stringify({ playerId, permitId }),
    });
  }

  private async request<T = void>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      let payload: unknown;
      try { payload = detail ? JSON.parse(detail) as unknown : undefined; } catch { /* non-JSON API error */ }
      throw new GameApiError(response.status, payload, `DEGEN API ${response.status}: ${detail || response.statusText}`);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
}
