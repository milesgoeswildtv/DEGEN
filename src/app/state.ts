import type { BattleReward, FurniturePlacement, PlatformIdentity, PlayerState } from '../domain/types';
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

const xpNeededForLevel = (level: number): number => 100 + (level - 1) * 75;

export class PlayerStore {
  private state: PlayerState;
  private listeners = new Set<(state: PlayerState) => void>();

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
    this.state = player;
    this.commitLocal();
  }

  applyReward(reward: BattleReward): void {
    this.state.xp += reward.xp;
    this.state.currency += reward.currency;
    this.state.inventory.push(...reward.items);

    for (const furnitureId of reward.furniture ?? []) {
      if (!this.state.housing.inventory.includes(furnitureId)) {
        this.state.housing.inventory.push(furnitureId);
      }
    }

    while (this.state.xp >= xpNeededForLevel(this.state.level)) {
      this.state.xp -= xpNeededForLevel(this.state.level);
      this.state.level += 1;
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
    try {
      await this.api.saveHousing(this.state.id, this.state.housing);
    } catch (error) {
      console.warn('Housing save failed; local copy retained.', error);
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
