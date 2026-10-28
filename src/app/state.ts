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

  constructor(private readonly api: GameApi) {
    this.state = this.load();
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
      if (remote) {
        this.state = remote;
        this.commitLocal();
      }
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
    const unsavedHousing = pending ?? inFlight;
    const placements = unsavedHousing
      ? structuredClone(wasActive
        ? this.state.housing.placements
        : unsavedHousing.placements)
      : undefined;
    this.state = placements ? { ...player, housing: { ...player.housing, placements } } : player;
    this.commitLocal();

    // Retry a queued layout on reactivation. If only an in-flight snapshot exists,
    // remember the reactivation so a later failure can get one bounded retry.
    if (pending) void this.persistHousing();
    else if (inFlight && !wasActive) this.reactivatedHousingPlayers.add(player.id);
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
    this.commitLocal();
    void this.persistHousing();
  }

  removeFurnitureAt(x: number, y: number): void {
    this.state.housing.placements = this.state.housing.placements.filter(
      (item) => item.x !== x || item.y !== y,
    );
    this.commitLocal();
    void this.persistHousing();
  }

  private async persistHousing(): Promise<void> {
    // Serialize requests to prevent an older response from overwriting a newer layout.
    // Coalesce intermediate edits while retaining the latest immutable snapshot.
    this.pendingHousingSaves.set(this.state.id, structuredClone(this.state.housing));
    if (this.housingSaveInFlight) return;
    this.housingSaveInFlight = true;
    const failedSnapshots = new Map<string, PlayerState['housing']>();
    try {
      while (this.pendingHousingSaves.size > 0) {
        // A failed latest snapshot stays queued for the next edit, but is attempted
        // only once in this drain so a persistent outage cannot spin forever or
        // block queued saves for other accounts. A newer snapshot for the same
        // player remains eligible even if an earlier snapshot failed.
        const activePlayerId = this.state.id;
        const next = [...this.pendingHousingSaves.entries()]
          .find(([playerId, housing]) =>
            playerId === activePlayerId && failedSnapshots.get(playerId) !== housing);
        if (!next) break;
        const [playerId, housing] = next;
        this.pendingHousingSaves.delete(playerId);
        this.housingSavePlayerId = playerId;
        this.housingSaveSnapshot = structuredClone(housing);
        try {
          await this.api.saveHousing(playerId, housing);
          this.reactivatedHousingPlayers.delete(playerId);
        } catch (error) {
          const retryAfterReactivation = this.reactivatedHousingPlayers.delete(playerId)
            && this.state.id === playerId;
          if (!this.pendingHousingSaves.has(playerId)) {
            this.pendingHousingSaves.set(playerId, housing);
            failedSnapshots.set(playerId, housing);
          }
          // Permit exactly one retry when the account was reactivated mid-flight;
          // a second failure remains queued for a later edit/reactivation.
          if (retryAfterReactivation) failedSnapshots.delete(playerId);
          console.warn('Housing save failed; local copy retained for retry on the next edit.', error);
        } finally {
          this.housingSavePlayerId = undefined;
          this.housingSaveSnapshot = undefined;
        }
      }
    } finally {
      this.housingSaveInFlight = false;
    }
  }

  private load(): PlayerState {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return createDefaultPlayer();
      const parsed = JSON.parse(raw) as PlayerState;
      const id = parsed.id && parsed.id !== 'local-player' ? parsed.id : newPlayerId();
      return { ...createDefaultPlayer(id), ...parsed, id };
    } catch {
      return createDefaultPlayer();
    }
  }

  private commitLocal(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    const snapshot = this.snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}
