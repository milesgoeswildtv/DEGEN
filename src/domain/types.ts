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
// action-resource pool or a Mana-priced move. Check nested definition objects too.
type KeysContainingMana<T> = T extends readonly (infer Item)[]
  ? KeysContainingMana<Item>
  : T extends object
    ? {
        [Key in keyof T]: Key extends string
          ? Lowercase<Key> extends `${string}mana${string}` ? Key : KeysContainingMana<T[Key]>
          : never;
      }[keyof T]
    : never;

type MonsterActionResourceAlphaNumericCharacter =
  | '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'
  | 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g' | 'h' | 'i' | 'j' | 'k' | 'l' | 'm'
  | 'n' | 'o' | 'p' | 'q' | 'r' | 's' | 't' | 'u' | 'v' | 'w' | 'x' | 'y' | 'z'
  | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M'
  | 'N' | 'O' | 'P' | 'Q' | 'R' | 'S' | 'T' | 'U' | 'V' | 'W' | 'X' | 'Y' | 'Z';

type NormalizeMonsterActionResourceKey<Key extends string> =
  Key extends `${infer Character}${infer Rest}`
    ? Character extends MonsterActionResourceAlphaNumericCharacter
      ? `${Lowercase<Character>}${NormalizeMonsterActionResourceKey<Rest>}`
      : NormalizeMonsterActionResourceKey<Rest>
    : '';

type AssertMonsterResourceGuard<T extends true> = T;
type _MonsterResourceDotSeparatorIsGuarded = AssertMonsterResourceGuard<
  Extract<
    KeysMatchingForbiddenMonsterActionResource<{ signature: { 'resource.amount': number } }>,
    'resource.amount'
  > extends never ? false : true
>;
type _MonsterResourceSpaceSeparatorIsGuarded = AssertMonsterResourceGuard<
  Extract<
    KeysMatchingForbiddenMonsterActionResource<{ signature: { 'resource amount': number } }>,
    'resource amount'
  > extends never ? false : true
>;
type _MonsterResourceSlashSeparatorIsGuarded = AssertMonsterResourceGuard<
  Extract<
    KeysMatchingForbiddenMonsterActionResource<{ signature: { 'resource/amount': number } }>,
    'resource/amount'
  > extends never ? false : true
>;

type ForbiddenNormalizedMonsterActionResourceField =
  // The whole generic resource namespace is reserved for Degen-only Mana.
  // Catch cost, capacity, regeneration, drain, theft, and future aliases alike.
  | `${string}resource${string}`
  | `${string}actionpoint${string}`
  | `${string}energy${string}`
  | `${string}stamina${string}`
  | `${string}focus${string}`;

type KeysMatchingForbiddenMonsterActionResource<T> = T extends readonly (infer Item)[]
  ? KeysMatchingForbiddenMonsterActionResource<Item>
  : T extends object
    ? {
        [Key in keyof T]: Key extends string
          ? NormalizeMonsterActionResourceKey<Key> extends ForbiddenNormalizedMonsterActionResourceField
            ? Key
            : KeysMatchingForbiddenMonsterActionResource<T[Key]>
          : never;
      }[keyof T]
    : never;

type ForbiddenMonsterActionResourceField =
  | KeysContainingMana<EnemyDefinition>
  | KeysMatchingForbiddenMonsterActionResource<EnemyDefinition>;

type AssertNoMonsterActionResource<T extends never> = T;
type _EnemyDefinitionHasNoUniversalActionResource = AssertNoMonsterActionResource<
  ForbiddenMonsterActionResourceField
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
