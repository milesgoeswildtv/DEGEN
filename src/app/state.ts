import type { BattleReward, FurniturePlacement, PlayerState } from '../domain/types';

const STORAGE_KEY = 'degen.prototype.player.v1';

const createDefaultPlayer = (): PlayerState => ({
  id: 'local-player',
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

  constructor() {
    this.state = this.load();
  }

  get snapshot(): PlayerState {
    return structuredClone(this.state);
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
    this.commit();
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

    this.commit();
  }

  markBossDefeated(bossId: string): void {
    if (!this.state.defeatedBosses.includes(bossId)) {
      this.state.defeatedBosses.push(bossId);
      this.commit();
    }
  }

  placeFurniture(furnitureId: string, x: number, y: number): void {
    if (!this.state.housing.inventory.includes(furnitureId)) return;
    if (x < 0 || x > 7 || y < 0 || y > 5) return;

    const occupied = this.state.housing.placements.findIndex((item) => item.x === x && item.y === y);
    if (occupied >= 0) {
      this.state.housing.placements.splice(occupied, 1);
    }

    const existing = this.state.housing.placements.findIndex((item) => item.furnitureId === furnitureId);
    if (existing >= 0) {
      this.state.housing.placements.splice(existing, 1);
    }

    const placement: FurniturePlacement = {
      instanceId: `${furnitureId}-${Date.now()}`,
      furnitureId,
      x,
      y,
    };

    this.state.housing.placements.push(placement);
    this.commit();
  }

  removeFurnitureAt(x: number, y: number): void {
    this.state.housing.placements = this.state.housing.placements.filter(
      (item) => item.x !== x || item.y !== y,
    );
    this.commit();
  }

  resetPrototype(): void {
    this.state = createDefaultPlayer();
    this.commit();
  }

  private load(): PlayerState {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return createDefaultPlayer();
      return { ...createDefaultPlayer(), ...(JSON.parse(raw) as PlayerState) };
    } catch {
      return createDefaultPlayer();
    }
  }

  private commit(): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    const snapshot = this.snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }
}
