import type { BattleActionResult, BattleCompletionResult, BattlePermit, HousingState, PlatformIdentity, PlayerState, WorldEventSnapshot } from '../domain/types';
import { TEST_DEGEN, TUNNEL_MAW } from '../data/combatPrototype';

const isBoundedSafeInteger = (value: unknown, minimum: number, maximum: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;

const isAuthoritativeBattleStartState = (value: unknown, permitId: string): value is BattleActionResult => {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  return state.permitId === permitId
    && state.status === 'active'
    // An idempotent start retry may recover a battle that has already advanced
    // while its original response was delayed. Accept only a valid active turn.
    && isBoundedSafeInteger(state.turnCount, 0, Number.MAX_SAFE_INTEGER - 1)
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const isFurniturePlacementArray = (
  value: unknown,
): value is BattleCompletionResult['player']['housing']['placements'] =>
  Array.isArray(value) && value.every((entry) =>
    isRecord(entry)
    && typeof entry.instanceId === 'string'
    && entry.instanceId.length > 0
    && typeof entry.furnitureId === 'string'
    && entry.furnitureId.length > 0
    && isBoundedSafeInteger(entry.x, 0, Number.MAX_SAFE_INTEGER)
    && isBoundedSafeInteger(entry.y, 0, Number.MAX_SAFE_INTEGER));

// Completion responses are authoritative account/economy snapshots. Validate the
// response envelope before AppController can replace a PlayerStore or clear a
// pending receipt; never synthesize or repair reward values on the client.
const isAuthoritativeBattleCompletionResult = (
  value: unknown,
  playerId: string,
): value is BattleCompletionResult => {
  if (!isRecord(value)) return false;
  const player = value.player;
  const reward = value.reward;
  const worldEvent = value.worldEvent;
  if (!isRecord(player) || !isRecord(reward) || !isRecord(worldEvent)) return false;
  const housing = player.housing;
  if (!isRecord(housing)) return false;

  return player.id === playerId
    && typeof player.displayName === 'string'
    && isBoundedSafeInteger(player.level, 1, Number.MAX_SAFE_INTEGER)
    && isBoundedSafeInteger(player.xp, 0, Number.MAX_SAFE_INTEGER)
    && isBoundedSafeInteger(player.currency, 0, Number.MAX_SAFE_INTEGER)
    && typeof player.degenId === 'string'
    && isStringArray(player.inventory)
    && isStringArray(player.unlockedLocations)
    && isStringArray(player.defeatedBosses)
    && isStringArray(housing.inventory)
    && isFurniturePlacementArray(housing.placements)
    && isBoundedSafeInteger(reward.xp, 0, Number.MAX_SAFE_INTEGER)
    && isBoundedSafeInteger(reward.currency, 0, Number.MAX_SAFE_INTEGER)
    && isStringArray(reward.items)
    && isStringArray(reward.furniture)
    && (reward.tier === 'full' || reward.tier === 'reduced')
    && worldEvent.eventKey === 'underpass'
    && typeof worldEvent.cycleId === 'string'
    && worldEvent.cycleId.trim().length > 0
    && (worldEvent.phase === 'sealed' || worldEvent.phase === 'warning' || worldEvent.phase === 'open')
    && typeof worldEvent.opensAt === 'string'
    && Number.isFinite(Date.parse(worldEvent.opensAt))
    && typeof worldEvent.closesAt === 'string'
    && Number.isFinite(Date.parse(worldEvent.closesAt))
    && isBoundedSafeInteger(worldEvent.fullRewardClears, 0, Number.MAX_SAFE_INTEGER)
    && isBoundedSafeInteger(worldEvent.fullRewardLimit, 1, Number.MAX_SAFE_INTEGER)
    && worldEvent.source === 'server';
};

export class GameApiError extends Error {
  constructor(readonly status: number, readonly payload: unknown, message: string) {
    super(message);
    this.name = 'GameApiError';
  }
}

const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');
const BATTLE_START_TIMEOUT_MS = 12_000;
const BATTLE_ACTION_TIMEOUT_MS = 12_000;
const BATTLE_COMPLETION_TIMEOUT_MS = 20_000;

const BATTLE_START_REQUEST_STORAGE_PREFIX = 'degen:pending-battle-start:';
const isBattleStartRequestId = (value: unknown): value is string =>
  typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const battleStartRequestStorageKey = (playerId: string, cycleId: string): string =>
  `${BATTLE_START_REQUEST_STORAGE_PREFIX}${encodeURIComponent(playerId)}:${encodeURIComponent(cycleId)}`;

// Keep an uncertain start's idempotency key across retries, app reloads, and
// new GameApi instances. The key is scoped to one player and Underpass cycle;
// it contains no combat or reward authority.
const getPendingBattleStartRequestId = (playerId: string, cycleId: string): string => {
  const key = battleStartRequestStorageKey(playerId, cycleId);
  try {
    const saved = globalThis.localStorage.getItem(key);
    if (isBattleStartRequestId(saved)) return saved;
    if (saved !== null) globalThis.localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable in restricted browser contexts. Starting still
    // works there, but durable recovery is limited to the current request pair.
  }
  const requestId = crypto.randomUUID();
  try {
    globalThis.localStorage.setItem(key, requestId);
  } catch {
    // Do not turn a storage-policy failure into a battle-start failure.
  }
  return requestId;
};

const clearPendingBattleStartRequestId = (playerId: string, cycleId: string): void => {
  try {
    globalThis.localStorage.removeItem(battleStartRequestStorageKey(playerId, cycleId));
  } catch {
    // Best-effort cleanup only; no game authority is stored in this key.
  }
};

const ACTIVE_BATTLE_START_STORAGE_PREFIX = 'degen:active-battle-start:';
type ActiveBattleStartKey = { cycleId: string; requestId: string };
const activeBattleStartStorageKey = (playerId: string): string =>
  `${ACTIVE_BATTLE_START_STORAGE_PREFIX}${encodeURIComponent(playerId)}`;

const getActiveBattleStartKey = (playerId: string): ActiveBattleStartKey | undefined => {
  try {
    const raw = globalThis.localStorage.getItem(activeBattleStartStorageKey(playerId));
    if (raw === null) return undefined;
    const value = JSON.parse(raw) as Partial<ActiveBattleStartKey>;
    if (typeof value.cycleId === 'string' && value.cycleId.trim()
      && isBattleStartRequestId(value.requestId)) {
      return { cycleId: value.cycleId, requestId: value.requestId };
    }
    globalThis.localStorage.removeItem(activeBattleStartStorageKey(playerId));
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
  return undefined;
};

const saveActiveBattleStartKey = (playerId: string, cycleId: string, requestId: string): void => {
  try {
    globalThis.localStorage.setItem(activeBattleStartStorageKey(playerId), JSON.stringify({ cycleId, requestId }));
  } catch {
    // The permit remains Worker-owned; local storage only improves reload recovery.
  }
};

const clearActiveBattleStartKey = (playerId: string, requestId: string): void => {
  try {
    const key = activeBattleStartStorageKey(playerId);
    const current = globalThis.localStorage.getItem(key);
    if (current === null) return;
    const value = JSON.parse(current) as Partial<ActiveBattleStartKey>;
    if (value.requestId === requestId) globalThis.localStorage.removeItem(key);
  } catch {
    // Best-effort cleanup only.
  }
};




export class GameApi {
  readonly enabled: boolean;
  private readonly apiBase: string;
  private readonly fetcher: typeof fetch;

  constructor(
    apiBase: string = API_BASE,
    fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
    private readonly actionTimeoutMs = BATTLE_ACTION_TIMEOUT_MS,
    private readonly completionTimeoutMs = BATTLE_COMPLETION_TIMEOUT_MS,
    private readonly startTimeoutMs = BATTLE_START_TIMEOUT_MS,
  ) {
    this.apiBase = apiBase.endsWith('/') ? apiBase.slice(0, -1) : apiBase;
    this.fetcher = fetcher;
    this.enabled = this.apiBase.length > 0;
  }

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
    // Once a permit is accepted, retain only its ID and original cycle across
    // reloads/Underpass rollover. The Worker replays that exact owner-scoped row.
    const activeStart = getActiveBattleStartKey(playerId);
    const requestCycleId = activeStart?.cycleId ?? cycleId;
    const requestId = activeStart?.requestId ?? getPendingBattleStartRequestId(playerId, requestCycleId);
    const startRequest: RequestInit = {
      method: 'POST',
      body: JSON.stringify({
        playerId, eventKey: 'underpass', cycleId: requestCycleId, encounterKey: 'tunnel-maw',
        requestId,
      }),
    };
    const sendStart = () => this.requestWithTimeout<BattlePermit>(
      '/api/battle/start', startRequest, this.startTimeoutMs,
    );
    let permit: BattlePermit;
    try {
      permit = await sendStart();
    } catch (error) {
      if (error instanceof GameApiError && error.status < 500) {
        clearPendingBattleStartRequestId(playerId, requestCycleId);
        if (activeStart) clearActiveBattleStartKey(playerId, requestId);
        throw error;
      }
      try {
        permit = await sendStart();
      } catch (retryError) {
        // A definitive Worker rejection proves this key cannot recover a live
        // start. Keep it only for uncertain timeout/transport/5xx outcomes.
        if (retryError instanceof GameApiError && retryError.status < 500) {
          clearPendingBattleStartRequestId(playerId, requestCycleId);
          if (activeStart) clearActiveBattleStartKey(playerId, requestId);
        }
        throw retryError;
      }
    }
    if (!permit || permit.permitId !== requestId
      || typeof permit.permitId !== 'string' || !permit.permitId.trim()
      || permit.eventKey !== 'underpass' || permit.cycleId !== requestCycleId
      || permit.encounterKey !== TUNNEL_MAW.id
      || typeof permit.expiresAt !== 'string' || !Number.isFinite(Date.parse(permit.expiresAt))
      || Date.parse(permit.expiresAt) <= Date.now()
      || !isAuthoritativeBattleStartState(permit.initialState, permit.permitId)) {
      // Do not discard the key on a malformed 2xx response: the Worker may
      // have committed the permit, so a later retry must remain idempotent.
      throw new Error('Missing or malformed authoritative battle start state.');
    }
    // Keep a pending key until the controller accepts the permit. The active
    // key is retained until authoritative reward completion or expiry.
    return permit;
  }

  acknowledgeUnderpassStart(playerId: string, cycleId: string, permitId: string): void {
    const key = battleStartRequestStorageKey(playerId, cycleId);
    try {
      const active = getActiveBattleStartKey(playerId);
      if (active?.requestId === permitId && active.cycleId === cycleId) return;
      if (globalThis.localStorage.getItem(key) === permitId) {
        saveActiveBattleStartKey(playerId, cycleId, permitId);
        clearPendingBattleStartRequestId(playerId, cycleId);
      }
    } catch {
      // Best-effort acknowledgement only.
    }
  }

  acknowledgeUnderpassCompletion(playerId: string, permitId: string): void {
    clearActiveBattleStartKey(playerId, permitId);
  }

  async actUnderpass(playerId: string, permitId: string, abilityId: string, expectedTurnCount: number): Promise<BattleActionResult | undefined> {
    if (!this.enabled) return undefined;
    if (!Number.isSafeInteger(expectedTurnCount) || expectedTurnCount < 0 || expectedTurnCount >= Number.MAX_SAFE_INTEGER) {
      throw new Error('Invalid expected turn count.');
    }
    // The Worker action is compare-and-swap guarded by expectedTurnCount. Retrying
    // once after a transport/5xx failure can recover a lost response without applying
    // damage or Mana twice: an already-committed first attempt returns the latest 409 snapshot.
    const actionRequest: RequestInit = {
      method: 'POST',
      body: JSON.stringify({ playerId, permitId, abilityId, expectedTurnCount }),
    };
    const sendAction = () => this.requestWithTimeout<BattleActionResult>(
      '/api/battle/action', actionRequest, this.actionTimeoutMs,
    );
    let result: BattleActionResult;
    try {
      result = await sendAction();
    } catch (error) {
      if (error instanceof GameApiError && error.status < 500) throw error;
      // Includes timeout/transport failures. Reuse the same turn precondition once;
      // the Worker compare-and-swap makes a committed-but-unanswered action safe.
      result = await sendAction();
    }
    if (!isAuthoritativeBattleActionState(result, permitId) || result.turnCount !== expectedTurnCount + 1) {
      throw new Error('Malformed authoritative battle action response.');
    }
    return result;
  }

  async completeUnderpass(playerId: string, permitId: string): Promise<BattleCompletionResult | undefined> {
    if (!this.enabled) return undefined;
    // Completion is idempotent: the Worker returns the existing audited receipt if
    // the first response was lost after settlement. Bound hangs, then retry once with
    // the exact same permit request; the client never calculates or grants rewards.
    const completionRequest: RequestInit = {
      method: 'POST',
      body: JSON.stringify({ playerId, permitId }),
    };
    const sendCompletion = () => this.requestWithTimeout<BattleCompletionResult>(
      '/api/battle/complete', completionRequest, this.completionTimeoutMs,
    );
    let result: BattleCompletionResult;
    try {
      result = await sendCompletion();
    } catch (error) {
      if (error instanceof GameApiError && error.status < 500) throw error;
      result = await sendCompletion();
    }
    if (!isAuthoritativeBattleCompletionResult(result, playerId)) {
      throw new Error('Malformed authoritative battle completion response.');
    }
    return result;
  }

  private async requestWithTimeout<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.request<T>(path, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async request<T = void>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.fetcher(`${this.apiBase}${path}`, {
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
