import type { BattleCompletionResult, BattlePermit, HousingState, PlatformIdentity, PlayerState, WorldEventSnapshot } from '../domain/types';

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
    return this.request<BattlePermit>('/api/battle/start', {
      method: 'POST',
      body: JSON.stringify({ playerId, eventKey: 'underpass', cycleId, encounterKey: 'tunnel-maw' }),
    });
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
      throw new Error(`DEGEN API ${response.status}: ${detail || response.statusText}`);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
}
