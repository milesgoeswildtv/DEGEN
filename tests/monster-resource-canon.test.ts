import assert from 'node:assert/strict';
import test from 'node:test';

import type { EnemyDefinition } from '../src/domain/types.ts';
import { TUNNEL_MAW } from '../src/data/combatPrototype.ts';

// Keep a type-level tripwire against introducing a universal monster resource
// under Mana or a common renamed equivalent. Degen-specific resource fields
// belong on DegenDefinition/AbilityDefinition, never EnemyDefinition.
type ForbiddenMonsterResourceKey =
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
export type EnemyHasNoUniversalResource = Assert<
  IsNever<Extract<keyof EnemyDefinition, ForbiddenMonsterResourceKey>>
>;

const forbiddenRuntimeKeys: readonly ForbiddenMonsterResourceKey[] = [
  'mana',
  'maxMana',
  'currentMana',
  'manaCost',
  'energy',
  'maxEnergy',
  'stamina',
  'maxStamina',
  'focus',
  'maxFocus',
  'resource',
  'resourceAmount',
  'resourceMax',
];

test('enemy runtime definitions expose no universal Mana-equivalent resource', () => {
  const enemy = TUNNEL_MAW as unknown as Record<string, unknown>;
  const present = Object.keys(enemy).filter((key) =>
    forbiddenRuntimeKeys.includes(key as ForbiddenMonsterResourceKey),
  );

  assert.deepEqual(present, []);
});
