import assert from 'node:assert/strict';
import test from 'node:test';

import { TUNNEL_MAW } from '../src/data/combatPrototype.ts';

const forbiddenRuntimeKeys = [
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
] as const;

test('enemy runtime definitions expose no universal Mana-equivalent resource', () => {
  const enemy = TUNNEL_MAW as unknown as Record<string, unknown>;
  const present = Object.keys(enemy).filter((key) =>
    forbiddenRuntimeKeys.includes(key as (typeof forbiddenRuntimeKeys)[number]),
  );

  assert.deepEqual(present, []);
});
