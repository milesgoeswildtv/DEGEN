import type { EnemyDefinition } from './types';

// Compile-time guard: enemy definitions may gain approved identity, behavior,
// status, or move-library fields, but never a universal Mana-equivalent bar.
// Keep this namespace separate from DegenDefinition and bespoke ability costs.
type ForbiddenEnemyResourceKey =
  | 'mana'
  | 'maxMana'
  | 'currentMana'
  | 'manaCost'
  | 'energy'
  | 'maxEnergy'
  | 'stamina'
  | 'maxStamina'
  | 'focus'
  | 'maxFocus'
  | 'resource'
  | 'resourceAmount'
  | 'resourceMax';

type Assert<T extends true> = T;
type IsNever<T> = [T] extends [never] ? true : false;

export type EnemyDefinitionResourceCanon = Assert<
  IsNever<Extract<keyof EnemyDefinition, ForbiddenEnemyResourceKey>>
>;
