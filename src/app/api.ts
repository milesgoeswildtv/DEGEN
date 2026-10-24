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

  if (state.status === 'active') return playerHp > 0 && enemyHp > 0 && turnCount < Number.MAX_SAFE_INTEGER;
  if (state.status === 'victory') return turnCount > 0 && playerHp > 0 && enemyHp === 0;
  return turnCount > 0 && playerHp === 0 && enemyHp > 0;
};

export class GameApiError extends Error {
  constructor(readonly status: number, readonly payload: unknown, message: string) {
    super(message);
    this.name = 'GameApiError';
  }
}

const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');
const SESSION_STORAGE_KEY = 'degen.player.session.v1';
const SESSION_PLAYER_ID_KEY = 'degen.player.session-owner.v1';
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class GameApi {
  readonly enabled = API_BASE.length > 0;
  private sessionToken: string | undefined;
  private sessionPlayerId: string | undefined;
  private identityProvider: (() => Promise<PlatformIdentity>) | undefined;
  private refreshInFlight: Promise<void> | undefined;

  setIdentityProvider(provider: () => Promise<PlatformIdentity>): void {
    this.identityProvider = provider;
  }

  get authenticatedPlayerId(): string | undefined {
    return this.sessionPlayerId;
  }

  private assertSessionOwner(playerId: string): void {
    if (this.enabled && this.sessionToken && this.sessionPlayerId !== playerId) {
      throw new GameApiError(
        401,
        { error: 'Authenticated player mismatch.' },
        'DEGEN API 401: authenticated player mismatch.',
      );
    }
  }

  constructor() {
    try {
      const stored = sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (stored && SESSION_TOKEN_PATTERN.test(stored)) {
        this.sessionToken = stored;
        const storedPlayerId = sessionStorage.getItem(SESSION_PLAYER_ID_KEY);
        if (storedPlayerId && storedPlayerId.trim()) this.sessionPlayerId = storedPlayerId;
      }
    } catch { /* Storage can be unavailable in embedded/private contexts. */ }
  }

  async createDiscordChallenge(): Promise<string> {
    if (!this.enabled) throw new Error('Discord authentication requires the DEGEN Worker API.');
    const challenge = await this.request<{ state: string; expiresAtMs: number }>('/api/auth/discord/challenge', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (!challenge || !SESSION_TOKEN_PATTERN.test(challenge.state)
      || !Number.isSafeInteger(challenge.expiresAtMs) || challenge.expiresAtMs <= Date.now()) {
      throw new Error('Discord authentication challenge was malformed.');
    }
    return challenge.state;
  }

  async bootstrap(identity: PlatformIdentity): Promise<PlayerState | undefined> {
    if (!this.enabled) return undefined;
    const result = await this.request<{ player: PlayerState; session: { token: string; expiresAtMs: number } }>('/api/player/bootstrap', {
      method: 'POST',
      body: JSON.stringify({
        platform: identity.platform,
        telegramInitData: identity.telegramInitData,
        discordAuthorizationCode: identity.discordAuthorizationCode,
        discordState: identity.discordState,
      }),
    });
    if (!result?.player || typeof result.player.id !== 'string' || !result.player.id.trim()
      || !result.session || !SESSION_TOKEN_PATTERN.test(result.session.token)
      || !Number.isSafeInteger(result.session.expiresAtMs) || result.session.expiresAtMs <= Date.now()) {
      throw new Error('The Worker returned an invalid player session.');
    }
    this.sessionToken = result.session.token;
    this.sessionPlayerId = result.player.id;
    try {
      sessionStorage.setItem(SESSION_PLAYER_ID_KEY, result.player.id);
      sessionStorage.setItem(SESSION_STORAGE_KEY, this.sessionToken);
    } catch { /* In-memory session remains valid. */ }
    return result.player;
  }

  async saveHousing(playerId: string, housing: HousingState): Promise<void> {
    if (!this.enabled) return;
    // The Worker authorizes writes from the bearer session, never from a body ID.
    // Refuse a stale queued layout locally instead of saving it to whichever account
    // happens to be active after a platform/account switch.
    this.assertSessionOwner(playerId);
    await this.request('/api/player/housing', {
      method: 'PUT',
      body: JSON.stringify({ housing }),
    });
  }

  async getUnderpass(playerId: string): Promise<WorldEventSnapshot | undefined> {
    if (!this.enabled) return undefined;
    this.assertSessionOwner(playerId);
    return this.request<WorldEventSnapshot>('/api/world/underpass');
  }

  async startUnderpass(playerId: string, cycleId: string): Promise<BattlePermit | undefined> {
    if (!this.enabled) return undefined;
    this.assertSessionOwner(playerId);
    const permit = await this.request<BattlePermit>('/api/battle/start', {
      method: 'POST',
      body: JSON.stringify({ eventKey: 'underpass', cycleId, encounterKey: 'tunnel-maw' }),
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
    this.assertSessionOwner(playerId);
    if (!Number.isSafeInteger(expectedTurnCount) || expectedTurnCount < 0 || expectedTurnCount >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Invalid expected turn count.');
    }
    const result = await this.request<BattleActionResult>('/api/battle/action', {
      method: 'POST',
      body: JSON.stringify({ permitId, abilityId, expectedTurnCount }),
    });
    if (!isAuthoritativeBattleActionState(result, permitId) || result.turnCount !== expectedTurnCount + 1) {
      throw new Error('Malformed authoritative battle action response.');
    }
    return result;
  }

  async completeUnderpass(playerId: string, permitId: string): Promise<BattleCompletionResult | undefined> {
    if (!this.enabled) return undefined;
    this.assertSessionOwner(playerId);
    return this.request<BattleCompletionResult>('/api/battle/complete', {
      method: 'POST',
      body: JSON.stringify({ permitId }),
    });
  }

  private async request<T = void>(path: string, init?: RequestInit, allowRefresh = true): Promise<T> {
    const tokenUsed = this.sessionToken;
    const playerIdUsed = this.sessionPlayerId;
    const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
    if (init?.body && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
      headers['content-type'] = 'application/json';
    }
    if (tokenUsed) headers.authorization = `Bearer ${tokenUsed}`;
    const publicAuthRoute = path === '/api/player/bootstrap' || path === '/api/auth/discord/challenge'
      || path === '/api/auth/logout';
    const response = await fetch(`${API_BASE}${path}`, { ...init, headers });
    const sessionOwnerChanged = () => !publicAuthRoute && this.sessionPlayerId !== playerIdUsed;
    const staleResponseError = (detachedBattleAction?: unknown) => new GameApiError(
      401,
      detachedBattleAction === undefined
        ? { error: 'Authenticated player changed while request was in flight.' }
        : { error: 'Authenticated player changed while request was in flight.', detachedBattleAction },
      'DEGEN API 401: authenticated player changed while the request was in flight.',
    );
    // A battle action is the one response we may need to inspect for a Worker-confirmed
    // victory so its permit can be recovered under the issuing account. Never apply it
    // to the currently active account.
    if (sessionOwnerChanged() && path !== '/api/battle/action') {
      void response.body?.cancel().catch(() => undefined);
      throw staleResponseError();
    }
    if (response.status === 401) {
      if (sessionOwnerChanged()) throw staleResponseError();
      if (this.sessionToken && this.sessionToken !== tokenUsed) {
        if (this.sessionPlayerId !== playerIdUsed) {
          throw new GameApiError(401, { error: 'Authenticated player changed while request was in flight.' }, 'DEGEN API 401: authenticated player changed while the request was in flight.');
        }
        return this.request<T>(path, init, false);
      }
      this.sessionToken = undefined;
      this.sessionPlayerId = undefined;
      try {
        sessionStorage.removeItem(SESSION_STORAGE_KEY);
        sessionStorage.removeItem(SESSION_PLAYER_ID_KEY);
      } catch { /* Ignore unavailable storage. */ }
      if (!publicAuthRoute && allowRefresh && this.identityProvider) {
        if (!this.refreshInFlight) {
          const refresh = (async () => {
            const identity = await this.identityProvider!();
            const player = await this.bootstrap(identity);
            if (!player) throw new Error('Platform reauthentication did not return a player.');
          })();
          this.refreshInFlight = refresh.finally(() => { this.refreshInFlight = undefined; });
        }
        await this.refreshInFlight;
        if (this.sessionPlayerId !== playerIdUsed) {
          throw new GameApiError(401, { error: 'Authenticated player changed while request was in flight.' }, 'DEGEN API 401: authenticated player changed while the request was in flight.');
        }
        return this.request<T>(path, init, false);
      }
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      let payload: unknown;
      try { payload = detail ? JSON.parse(detail) as unknown : undefined; } catch { /* non-JSON API error */ }
      if (sessionOwnerChanged()) {
        const detached = path === '/api/battle/action' && payload && typeof payload === 'object'
          ? (payload as { battleState?: unknown }).battleState
          : undefined;
        throw staleResponseError(detached);
      }
      throw new GameApiError(response.status, payload, `DEGEN API ${response.status}: ${detail || response.statusText}`);
    }
    if (response.status === 204) {
      if (sessionOwnerChanged()) throw staleResponseError();
      return undefined as T;
    }
    const payload = await response.json() as T;
    // The account can change while a streamed response body is being read. Preserve
    // only the Worker response for action-victory recovery; callers never apply it to B.
    if (sessionOwnerChanged()) {
      throw staleResponseError(path === '/api/battle/action' ? payload : undefined);
    }
    return payload;
  }
}
