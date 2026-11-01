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

// A 200 response is not authority unless it matches the Worker-owned world
// snapshot contract. In particular, a malformed "open" payload must not enable
// a client-side start attempt or be mistaken for an offline preview cycle.
const isAuthoritativeWorldEventSnapshot = (value: unknown): value is WorldEventSnapshot => {
  if (!isRecord(value)) return false;
  const opensAt = typeof value.opensAt === 'string' ? Date.parse(value.opensAt) : Number.NaN;
  const closesAt = typeof value.closesAt === 'string' ? Date.parse(value.closesAt) : Number.NaN;

  return value.eventKey === 'underpass'
    && typeof value.cycleId === 'string'
    && value.cycleId.trim().length > 0
    && (value.phase === 'sealed' || value.phase === 'warning' || value.phase === 'open')
    && Number.isFinite(opensAt)
    && Number.isFinite(closesAt)
    && opensAt < closesAt
    && isBoundedSafeInteger(value.fullRewardClears, 0, Number.MAX_SAFE_INTEGER)
    && isBoundedSafeInteger(value.fullRewardLimit, 1, Number.MAX_SAFE_INTEGER)
    && value.source === 'server';
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');

const isFurniturePlacementArray = (
  value: unknown,
): value is BattleCompletionResult['player']['housing']['placements'] => {
  // A saved room is an 8×6 grid. Treat a malformed Worker snapshot as a
  // protocol failure instead of letting impossible layouts enter client state.
  if (!Array.isArray(value) || value.length > 48) return false;

  const instanceIds = new Set<string>();
  const cells = new Set<string>();
  return value.every((entry) => {
    if (!isRecord(entry)
      || typeof entry.instanceId !== 'string'
      || entry.instanceId.length === 0
      || typeof entry.furnitureId !== 'string'
      || entry.furnitureId.length === 0
      || !isBoundedSafeInteger(entry.x, 0, 7)
      || !isBoundedSafeInteger(entry.y, 0, 5)) return false;

    const cell = `${entry.x},${entry.y}`;
    if (instanceIds.has(entry.instanceId) || cells.has(cell)) return false;
    instanceIds.add(entry.instanceId);
    cells.add(cell);
    return true;
  });
};

// Player snapshots from the Worker are account and persistence authority. Validate
// them before bootstrap or completion can replace client state; never repair malformed
// server data or synthesize progression locally.
const isAuthoritativePlayerState = (value: unknown, playerId: string): value is PlayerState => {
  if (!isRecord(value)) return false;
  const housing = value.housing;
  if (!isRecord(housing)) return false;

  return value.id === playerId
    && typeof value.displayName === 'string'
    && isBoundedSafeInteger(value.level, 1, Number.MAX_SAFE_INTEGER)
    && isBoundedSafeInteger(value.xp, 0, Number.MAX_SAFE_INTEGER)
    && isBoundedSafeInteger(value.currency, 0, Number.MAX_SAFE_INTEGER)
    && typeof value.degenId === 'string'
    && isStringArray(value.inventory)
    && isStringArray(value.unlockedLocations)
    && isStringArray(value.defeatedBosses)
    && isStringArray(housing.inventory)
    && isFurniturePlacementArray(housing.placements);
};

const isAuthoritativeBattleCompletionResult = (
  value: unknown,
  playerId: string,
): value is BattleCompletionResult => {
  if (!isRecord(value)) return false;
  const player = value.player;
  const reward = value.reward;
  const levelTransition = value.levelTransition;
  const worldEvent = value.worldEvent;
  if (!isAuthoritativePlayerState(player, playerId)
    || !isRecord(reward) || !isRecord(levelTransition) || !isRecord(worldEvent)) return false;

  const previousLevel = levelTransition.previousLevel;
  if (!isBoundedSafeInteger(previousLevel, 1, Number.MAX_SAFE_INTEGER)
    || !isBoundedSafeInteger(levelTransition.currentLevel, previousLevel, player.level)) return false;

  return isBoundedSafeInteger(reward.xp, 0, Number.MAX_SAFE_INTEGER)
    && isBoundedSafeInteger(reward.currency, 0, Number.MAX_SAFE_INTEGER)
    && isStringArray(reward.items)
    && isStringArray(reward.furniture)
    && (reward.tier === 'full' || reward.tier === 'reduced')
    && isAuthoritativeWorldEventSnapshot(worldEvent);
};

export class GameApiProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GameApiProtocolError';
  }
}

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

const BATTLE_START_STORAGE_PREFIX = 'degen:battle-start:';
const LEGACY_PENDING_BATTLE_START_STORAGE_PREFIX = 'degen:pending-battle-start:';
const isBattleStartRequestId = (value: unknown): value is string =>
  typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

type BattleStartRequestKey = {
  cycleId: string;
  requestId: string;
  state: 'pending' | 'active';
};

const battleStartRequestStorageKey = (playerId: string): string =>
  `${BATTLE_START_STORAGE_PREFIX}${encodeURIComponent(playerId)}`;

const parseBattleStartRequestKey = (raw: string | null): BattleStartRequestKey | undefined => {
  if (raw === null) return undefined;
  try {
    const value = JSON.parse(raw) as Partial<BattleStartRequestKey>;
    if (typeof value.cycleId === 'string' && value.cycleId.trim()
      && isBattleStartRequestId(value.requestId)
      && (value.state === 'pending' || value.state === 'active')) {
      return { cycleId: value.cycleId, requestId: value.requestId, state: value.state };
    }
  } catch {
    // Malformed local metadata never becomes game authority.
  }
  return undefined;
};

const readBattleStartRequestKey = (playerId: string): BattleStartRequestKey | undefined => {
  try {
    return parseBattleStartRequestKey(globalThis.localStorage.getItem(battleStartRequestStorageKey(playerId)));
  } catch {
    return undefined;
  }
};

const saveBattleStartRequestKey = (playerId: string, value: BattleStartRequestKey): void => {
  try {
    globalThis.localStorage.setItem(battleStartRequestStorageKey(playerId), JSON.stringify(value));
  } catch {
    // The permit remains Worker-owned; local storage only improves retry recovery.
  }
};

const getBattleStartRequestKey = (playerId: string, requestedCycleId: string): BattleStartRequestKey => {
  const storageKey = battleStartRequestStorageKey(playerId);
  try {
    const raw = globalThis.localStorage.getItem(storageKey);
    const saved = parseBattleStartRequestKey(raw);
    if (saved) return saved;
    if (raw !== null) globalThis.localStorage.removeItem(storageKey);
  } catch {
    // Continue with best-effort legacy recovery or a fresh request key.
  }

  // One-time migration from the previously released player+cycle key format.
  // Prefer the current cycle, but recover any still-pending prior-cycle key too.
  const legacyPrefix = `${LEGACY_PENDING_BATTLE_START_STORAGE_PREFIX}${encodeURIComponent(playerId)}:`;
  try {
    const legacyKeys: string[] = [];
    for (let index = 0; index < globalThis.localStorage.length; index += 1) {
      const key = globalThis.localStorage.key(index);
      if (key?.startsWith(legacyPrefix)) legacyKeys.push(key);
    }
    legacyKeys.sort((left, right) => {
      const currentKey = `${legacyPrefix}${encodeURIComponent(requestedCycleId)}`;
      return Number(right === currentKey) - Number(left === currentKey);
    });
    for (const legacyKey of legacyKeys) {
      const encodedCycleId = legacyKey.slice(legacyPrefix.length);
      let legacyCycleId: string;
      try { legacyCycleId = decodeURIComponent(encodedCycleId); } catch { continue; }
      const legacyRequestId = globalThis.localStorage.getItem(legacyKey);
      if (!isBattleStartRequestId(legacyRequestId)) continue;
      const migrated: BattleStartRequestKey = {
        cycleId: legacyCycleId,
        requestId: legacyRequestId,
        state: 'pending',
      };
      saveBattleStartRequestKey(playerId, migrated);
      globalThis.localStorage.removeItem(legacyKey);
      return migrated;
    }
  } catch {
    // Storage enumeration can be restricted; continue with a new key.
  }

  const created: BattleStartRequestKey = {
    cycleId: requestedCycleId,
    requestId: crypto.randomUUID(),
    state: 'pending',
  };
  saveBattleStartRequestKey(playerId, created);
  return created;
};

const markBattleStartActive = (playerId: string, cycleId: string, permitId: string): void => {
  try {
    const key = battleStartRequestStorageKey(playerId);
    const current = parseBattleStartRequestKey(globalThis.localStorage.getItem(key));
    if (current?.requestId === permitId && current.cycleId === cycleId) {
      saveBattleStartRequestKey(playerId, { ...current, state: 'active' });
    }
  } catch {
    // Best-effort acknowledgement only.
  }
};

const clearBattleStartRequestKey = (playerId: string, requestId: string): void => {
  try {
    const key = battleStartRequestStorageKey(playerId);
    const current = parseBattleStartRequestKey(globalThis.localStorage.getItem(key));
    if (current?.requestId === requestId) globalThis.localStorage.removeItem(key);
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
    const player = await this.request<unknown>('/api/player/bootstrap', {
      method: 'POST',
      body: JSON.stringify({ playerId, displayName: identity.displayName, platform: identity.platform, platformUserId: identity.platformUserId }),
    });
    if (!isAuthoritativePlayerState(player, playerId)) {
      throw new GameApiProtocolError('Malformed authoritative player bootstrap snapshot.');
    }
    return player;
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
    const snapshot = await this.request<unknown>(
      `/api/world/underpass?playerId=${encodeURIComponent(playerId)}`,
    );
    if (!isAuthoritativeWorldEventSnapshot(snapshot)) {
      throw new GameApiProtocolError('Malformed authoritative Underpass snapshot.');
    }
    return snapshot;
  }

  async getPendingBattleRewards(playerId: string): Promise<string[]> {
    if (!this.enabled) return [];
    const response = await this.requestWithTimeout<unknown>(
      `/api/battle/pending-rewards?playerId=${encodeURIComponent(playerId)}`,
      {},
      this.completionTimeoutMs,
    );
    if (!isRecord(response)
      || !Array.isArray(response.permitIds)
      || response.permitIds.length > 10_000
      || !response.permitIds.every((permitId) =>
        typeof permitId === 'string' && permitId.trim().length > 0 && permitId === permitId.trim() && permitId.length <= 256)) {
      throw new GameApiProtocolError('Malformed pending battle reward response.');
    }
    return [...new Set(response.permitIds as string[])];
  }

  async startUnderpass(playerId: string, cycleId: string, requestIdOverride?: string): Promise<BattlePermit | undefined> {
    if (!this.enabled) return undefined;
    // Keep one player-scoped correlation record through pending and active
    // states. It stores only the request ID and original cycle, never combat data.
    // Resume passes the already-issued permit ID so it can recover even if
    // browser storage was unavailable after the original start response.
    let startKey: BattleStartRequestKey;
    if (requestIdOverride !== undefined) {
      if (!isBattleStartRequestId(requestIdOverride)) throw new Error('Invalid battle permit ID for resume.');
      const saved = readBattleStartRequestKey(playerId);
      if (saved && saved.requestId !== requestIdOverride) {
        throw new Error('A different battle start is already recorded for this player.');
      }
      startKey = {
        cycleId: saved?.requestId === requestIdOverride ? saved.cycleId : cycleId,
        requestId: requestIdOverride,
        state: 'active',
      };
      saveBattleStartRequestKey(playerId, startKey);
    } else {
      startKey = getBattleStartRequestKey(playerId, cycleId);
    }
    const requestCycleId = startKey.cycleId;
    const requestId = startKey.requestId;
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
      if (error instanceof GameApiProtocolError) throw error;
      if (error instanceof GameApiError && error.status < 500) {
        clearBattleStartRequestKey(playerId, requestId);
        throw error;
      }
      try {
        permit = await sendStart();
      } catch (retryError) {
        // A definitive Worker rejection proves this key cannot recover a live
        // start. Keep it only for uncertain timeout/transport/5xx outcomes.
        if (retryError instanceof GameApiError && retryError.status < 500) {
          clearBattleStartRequestKey(playerId, requestId);
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
      throw new GameApiProtocolError('Missing or malformed authoritative battle start state.');
    }
    // Keep the one correlation record through the encounter; the controller
    // marks it active and clears it only after authoritative reward completion.
    return permit;
  }

  hasRecoverableUnderpassStart(playerId: string): boolean {
    return readBattleStartRequestKey(playerId) !== undefined;
  }

  recoverableUnderpassCycleId(playerId: string): string | undefined {
    return readBattleStartRequestKey(playerId)?.cycleId;
  }

  recoverableUnderpassPermitId(playerId: string): string | undefined {
    return readBattleStartRequestKey(playerId)?.requestId;
  }

  discardUnrecoverableUnderpassStart(playerId: string, permitId: string): void {
    clearBattleStartRequestKey(playerId, permitId);
  }

  acknowledgeUnderpassStart(playerId: string, cycleId: string, permitId: string): void {
    markBattleStartActive(playerId, cycleId, permitId);
  }

  acknowledgeUnderpassCompletion(playerId: string, permitId: string): void {
    clearBattleStartRequestKey(playerId, permitId);
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
      if (error instanceof GameApiProtocolError) throw error;
      if (error instanceof GameApiError && error.status < 500) throw error;
      // Includes timeout/transport failures. Reuse the same turn precondition once;
      // the Worker compare-and-swap makes a committed-but-unanswered action safe.
      result = await sendAction();
    }
    if (!isAuthoritativeBattleActionState(result, permitId) || result.turnCount !== expectedTurnCount + 1) {
      throw new GameApiProtocolError('Malformed authoritative battle action response.');
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
      if (error instanceof GameApiProtocolError) throw error;
      if (error instanceof GameApiError && error.status < 500) throw error;
      result = await sendCompletion();
    }
    if (!isAuthoritativeBattleCompletionResult(result, playerId)) {
      throw new GameApiProtocolError('Malformed authoritative battle completion response.');
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
    try {
      return await response.json() as T;
    } catch (error) {
      // Invalid JSON is a protocol/integrity failure. Transport/stream failures
      // retain their original error so callers can still retry transient faults.
      if (error instanceof SyntaxError) {
        throw new GameApiProtocolError('Malformed JSON response from DEGEN API.');
      }
      throw error;
    }
  }
}
