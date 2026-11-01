export type RouteKey = 'map' | 'district' | 'location' | 'home' | 'underpass' | 'battle';
export type LocationRouteKey = 'location' | 'home' | 'underpass';

export type PlatformName = 'browser' | 'discord' | 'telegram';
export type WorldEventPhase = 'sealed' | 'warning' | 'open';

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
  manaCost: number;
}

export interface DegenDefinition {
  id: string;
  name: string;
  maxHp: number;
  maxMana: number;
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
  damage: number;
}

// A monster may have archetype-specific signature state, but never a universal
// action-resource pool or a Mana-priced move. Keep that boundary compile-time
// visible as the EnemyDefinition grows.
type ForbiddenMonsterActionResourceField =
  | 'mana'
  | 'maxMana'
  | 'currentMana'
  | 'manaCost'
  | 'manaPool'
  | 'resource'
  | 'resourcePool'
  | 'resourceCost'
  | 'actionResource'
  | 'actionPoints'
  | 'energy'
  | 'stamina';

type AssertNoMonsterActionResource<T extends never> = T;
type _EnemyDefinitionHasNoUniversalActionResource = AssertNoMonsterActionResource<
  Extract<keyof EnemyDefinition, ForbiddenMonsterActionResourceField>
>;

export interface LocationDefinition {
  id: string;
  name: string;
  description: string;
  route: LocationRouteKey;
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
  tier?: 'full' | 'reduced';
}

export interface WorldEventSnapshot {
  eventKey: string;
  cycleId: string;
  phase: WorldEventPhase;
  opensAt: string;
  closesAt: string;
  fullRewardClears: number;
  fullRewardLimit: number;
  source: 'server' | 'preview';
}

export interface BattlePermit {
  permitId: string;
  eventKey: string;
  cycleId: string;
  encounterKey: string;
  expiresAt: string;
  // Server-backed entry returns the exact initial combat state persisted on the permit.
  // Offline preview permits omit this and use the local prototype initializer.
  initialState?: BattleActionResult;
}

export interface BattleActionResult {
  permitId: string;
  status: 'active' | 'victory' | 'defeat';
  playerHp: number;
  playerMana: number;
  enemyHp: number;
  turnCount: number;
}

export interface BattleCompletionResult {
  player: PlayerState;
  reward: BattleReward;
  worldEvent: WorldEventSnapshot;
}
