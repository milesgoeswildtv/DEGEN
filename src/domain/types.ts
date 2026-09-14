export type RouteKey = 'map' | 'home' | 'underpass' | 'battle';

export type PlatformName = 'browser' | 'discord' | 'telegram';

export interface PlatformIdentity {
  platform: PlatformName;
  platformUserId: string;
  displayName: string;
}

export interface AbilityDefinition {
  id: string;
  name: string;
  description: string;
  damage: number;
  stabilityDamage: number;
}

export interface DegenDefinition {
  id: string;
  name: string;
  maxHp: number;
  power: number;
  guard: number;
  speed: number;
  control: number;
  abilities: AbilityDefinition[];
}

export interface EnemyDefinition {
  id: string;
  name: string;
  level: number;
  maxHp: number;
  maxStability: number;
  damage: number;
}

export interface LocationDefinition {
  id: string;
  name: string;
  description: string;
  route: RouteKey;
  district: string;
  initiallyUnlocked: boolean;
  kind: 'home' | 'social' | 'combat' | 'shop' | 'story';
}

export interface FurnitureItem {
  id: string;
  name: string;
  icon: string;
}

export interface FurniturePlacement {
  instanceId: string;
  furnitureId: string;
  x: number;
  y: number;
}

export interface HousingState {
  inventory: string[];
  placements: FurniturePlacement[];
}

export interface PlayerState {
  id: string;
  displayName: string;
  level: number;
  xp: number;
  currency: number;
  degenId: string;
  inventory: string[];
  unlockedLocations: string[];
  housing: HousingState;
  defeatedBosses: string[];
}

export interface BattleReward {
  xp: number;
  currency: number;
  items: string[];
  furniture?: string[];
}
