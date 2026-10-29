import type { BattleReward, FurniturePlacement, PlatformIdentity, PlayerState } from '../domain/types';
import { advanceLevel } from '../game/progression';
import { GameApi } from './api';

const STORAGE_KEY = 'degen.prototype.player.v2';

const newPlayerId = (): string => `browser-${crypto.randomUUID()}`;

const createDefaultPlayer = (id = newPlayerId()): PlayerState => ({
  id,
  displayName: 'Player',
  level: 1,
  xp: 0,
  currency: 0,
  degenId: 'test-degen',
  inventory: [],
  unlockedLocations: ['home', 'downtown', 'underpass'],
  housing: {
    inventory: ['starter-bed', 'starter-chair', 'starter-lamp', 'starter-rug'],
    placements: [
      { instanceId: 'starter-bed-placed', furnitureId: 'starter-bed', x: 1, y: 1 },
    ],
  },
  defeatedBosses: [],
});

export class PlayerStore {
  private state: PlayerState;
  private listeners = new Set<(state: PlayerState) => void>();
  private housingSaveInFlight = false;
  private housingSavePlayerId?: string;
  private housingSaveSnapshot?: PlayerState['housing'];
  // Coalesce per player, not globally: a pending save for one account must not
  // be discarded when another account edits housing before the first resolves.
  private pendingHousingSaves = new Map<string, PlayerState['housing']>();
  // Accounts reactivated during an in-flight save get one retry if that save fails.
  private reactivatedHousingPlayers = new Set<string>();
  // A malformed saved room is replaced with a safe placeholder until server bootstrap.
  // Never let that placeholder become an outbound save or override a valid outbox snapshot.
  private housingNeedsAuthoritativeBootstrap = false;

  constructor(private readonly api: GameApi) {
    this.state = this.load();
    this.pendingHousingSaves = this.loadHousingOutbox();
  }

  get snapshot(): PlayerState {
    return structuredClone(this.state);
  }

  get serverBacked(): boolean {
    return this.api.enabled;
  }

  async initialize(identity: PlatformIdentity): Promise<void> {
    if (this.state.displayName === 'Player' && identity.displayName !== 'Player') {
      this.state.displayName = identity.displayName.slice(0, 32);
      this.commitLocal();
    }

    if (!this.api.enabled) return;

    try {
      const remote = await this.api.bootstrap(this.state.id, identity);
      if (remote) this.replaceFromServer(remote);
    } catch (error) {
      console.warn('DEGEN backend unavailable; retaining local preview state.', error);
    }
  }

  subscribe(listener: (state: PlayerState) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  setDisplayName(displayName: string): void {
    const trimmed = displayName.trim();
    if (!trimmed) return;
    this.state.displayName = trimmed.slice(0, 32);
    this.commitLocal();
  }

  replaceFromServer(player: PlayerState): void {
    // Preserve unsaved placement edits for this account even if another account
    // was active while the save was queued or in flight. Inventory and progression
    // always come from the server response.
    const wasActive = this.state.id === player.id;
    const pending = this.pendingHousingSaves.get(player.id);
    const inFlight = this.housingSavePlayerId === player.id ? this.housingSaveSnapshot : undefined;
    const localHousing = !this.housingNeedsAuthoritativeBootstrap && this.isValidHousingSnapshot(this.state.housing)
      ? this.state.housing
      : undefined;
    const unsavedHousing = pending && this.isValidHousingSnapshot(pending)
      ? pending
      : inFlight && this.isValidHousingSnapshot(inFlight)
        ? inFlight
        : undefined;
    const placements = unsavedHousing
      ? structuredClone(wasActive && localHousing
        ? localHousing.placements
        : unsavedHousing.placements)
      : undefined;
    this.state = placements ? { ...player, housing: { ...player.housing, placements } } : player;
    this.housingNeedsAuthoritativeBootstrap = false;
    this.commitLocal();

    // Retry a queued layout on reactivation. If only an in-flight snapshot exists,
    // remember the reactivation so a later failure can get one bounded retry.
    if (pending) void this.drainHousingSaves();
    if (inFlight && !wasActive) this.reactivatedHousingPlayers.add(player.id);
  }

  applyReward(reward: BattleReward): void {
    const progression = advanceLevel(this.state.level, this.state.xp, reward.xp);
    this.state.level = progression.level;
    this.state.xp = progression.xp;
    this.state.currency += reward.currency;
    this.state.inventory.push(...reward.items);

    for (const furnitureId of reward.furniture ?? []) {
      if (!this.state.housing.inventory.includes(furnitureId)) {
        this.state.housing.inventory.push(furnitureId);
      }
    }

    this.commitLocal();
  }

  markBossDefeated(bossId: string): void {
    if (!this.state.defeatedBosses.includes(bossId)) {
      this.state.defeatedBosses.push(bossId);
      this.commitLocal();
    }
  }

  placeFurniture(furnitureId: string, x: number, y: number): void {
    // Corrupt persisted layouts must not be mutated into a new invalid save before
    // the authoritative bootstrap has a chance to replace them.
    if (this.housingNeedsAuthoritativeBootstrap || !this.isValidHousingSnapshot(this.state.housing)) return;
    if (!this.state.housing.inventory.includes(furnitureId)) return;
    if (x < 0 || x > 7 || y < 0 || y > 5) return;

    const occupied = this.state.housing.placements.findIndex((item) => item.x === x && item.y === y);
    if (occupied >= 0) this.state.housing.placements.splice(occupied, 1);

    const existing = this.state.housing.placements.findIndex((item) => item.furnitureId === furnitureId);
    if (existing >= 0) this.state.housing.placements.splice(existing, 1);

    const placement: FurniturePlacement = {
      instanceId: `${furnitureId}-${crypto.randomUUID()}`,
      furnitureId,
      x,
      y,
    };

    this.state.housing.placements.push(placement);
    this.queueHousingSave();
  }

  removeFurnitureAt(x: number, y: number): void {
    if (this.housingNeedsAuthoritativeBootstrap || !this.isValidHousingSnapshot(this.state.housing)) return;
    this.state.housing.placements = this.state.housing.placements.filter(
      (item) => item.x !== x || item.y !== y,
    );
    this.queueHousingSave();
  }

  private queueHousingSave(): void {
    this.pendingHousingSaves.set(this.state.id, structuredClone(this.state.housing));
    // Persist the outbox before starting network I/O so a failed/in-flight save
    // can be recovered after reload without replacing the server-owned player data.
    this.commitLocal();
    void this.drainHousingSaves();
  }

  private async drainHousingSaves(): Promise<void> {
    if (this.housingSaveInFlight) return;
    this.housingSaveInFlight = true;
    const failedSnapshots = new Map<string, PlayerState['housing']>();
    try {
      while (this.pendingHousingSaves.size > 0) {
        const activePlayerId = this.state.id;
        const next = [...this.pendingHousingSaves.entries()]
          .find(([playerId, housing]) =>
            playerId === activePlayerId && failedSnapshots.get(playerId) !== housing);
        if (!next) break;
        const [playerId, housing] = next;
        // Keep the immutable snapshot in the durable outbox until the server
        // confirms it. Removing it before await would lose recovery on page exit.
        this.housingSavePlayerId = playerId;
        this.housingSaveSnapshot = structuredClone(housing);
        try {
          await this.api.saveHousing(playerId, housing);
          if (this.pendingHousingSaves.get(playerId) === housing) {
            this.pendingHousingSaves.delete(playerId);
            this.commitLocal();
          }
          this.reactivatedHousingPlayers.delete(playerId);
        } catch (error) {
          const retryAfterReactivation = this.reactivatedHousingPlayers.delete(playerId)
            && this.state.id === playerId;
          if (this.pendingHousingSaves.get(playerId) === housing) {
            failedSnapshots.set(playerId, housing);
          }
          // Permit one retry when the same account was reactivated mid-flight;
          // otherwise leave the latest snapshot queued for the next edit/reload.
          if (retryAfterReactivation) failedSnapshots.delete(playerId);
          console.warn('Housing save failed; latest layout remains queued for retry.', error);
        } finally {
          this.housingSavePlayerId = undefined;
          this.housingSaveSnapshot = undefined;
        }
      }
    } finally {
      this.housingSaveInFlight = false;
    }
  }

  private loadHousingOutbox(): Map<string, PlayerState['housing']> {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return new Map();
      const parsed = JSON.parse(raw) as { __housingOutbox?: unknown };
      const value = parsed.__housingOutbox;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return new Map();
      const outbox = new Map<string, PlayerState['housing']>();
      for (const [playerId, housing] of Object.entries(value)) {
        if (playerId && this.isValidHousingSnapshot(housing)) {
          outbox.set(playerId, structuredClone(housing));
        }
      }
      return outbox;
    } catch {
      return new Map();
    }
  }

  private isValidHousingSnapshot(value: unknown): value is PlayerState['housing'] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const housing = value as Record<string, unknown>;
    if (!Array.isArray(housing.inventory)
      || !housing.inventory.every((item) => typeof item === 'string')
      || !Array.isArray(housing.placements)
      || housing.placements.length > 48) return false;

    const instanceIds = new Set<string>();
    const cells = new Set<string>();
    return housing.placements.every((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const placement = entry as Record<string, unknown>;
      const { instanceId, furnitureId, x, y, rotation } = placement;
      if (typeof instanceId !== 'string' || instanceId.length === 0
        || typeof furnitureId !== 'string' || furnitureId.length === 0
        || typeof x !== 'number' || !Number.isSafeInteger(x) || x < 0 || x > 7
        || typeof y !== 'number' || !Number.isSafeInteger(y) || y < 0 || y > 5
        || (rotation !== undefined && (typeof rotation !== 'number' || !Number.isSafeInteger(rotation)))) {
        return false;
      }
      const cell = `${x},${y}`;
      if (instanceIds.has(instanceId) || cells.has(cell)) return false;
      instanceIds.add(instanceId);
      cells.add(cell);
      return true;
    });
  }

  private load(): PlayerState {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return createDefaultPlayer();
      const parsed = JSON.parse(raw) as PlayerState & {
        __housingOutbox?: unknown;
        __housingNeedsBootstrap?: unknown;
      };
      const {
        __housingOutbox: _outbox,
        __housingNeedsBootstrap: needsHousingBootstrap,
        ...player
      } = parsed;
      void _outbox;
      const id = player.id && player.id !== 'local-player' ? player.id : newPlayerId();
      const restored = { ...createDefaultPlayer(id), ...player, id };
      this.housingNeedsAuthoritativeBootstrap = this.api.enabled && needsHousingBootstrap === true;
      if (!this.isValidHousingSnapshot(restored.housing)) {
        this.housingNeedsAuthoritativeBootstrap = this.api.enabled;
        restored.housing = createDefaultPlayer(id).housing;
      }
      return restored;
    } catch {
      return createDefaultPlayer();
    }
  }

  private commitLocal(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        ...this.state,
        __housingOutbox: Object.fromEntries(this.pendingHousingSaves),
        __housingNeedsBootstrap: this.housingNeedsAuthoritativeBootstrap || undefined,
      }));
    } catch (error) {
      // Local storage is best-effort. A browser quota/privacy failure must not
      // prevent the server-backed housing outbox from attempting its D1 save.
      console.warn('Local player storage unavailable; keeping in-memory state.', error);
    }
    const snapshot = this.snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}
