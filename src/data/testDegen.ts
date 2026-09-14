import type { DegenDefinition, EnemyDefinition } from '../domain/types';

// Deliberately temporary. Final Degen definitions are owned by the character-design pipeline.
export const TEST_DEGEN: DegenDefinition = {
  id: 'test-degen',
  name: 'TEST_DEGEN',
  maxHp: 120,
  power: 18,
  guard: 8,
  speed: 10,
  control: 12,
  abilities: [
    {
      id: 'slash',
      name: 'Slash',
      description: 'Reliable damage.',
      damage: 20,
      stabilityDamage: 8,
    },
    {
      id: 'crack',
      name: 'Crack',
      description: 'Lower damage, heavy Stability damage.',
      damage: 11,
      stabilityDamage: 26,
    },
  ],
};

export const TUNNEL_MAW: EnemyDefinition = {
  id: 'tunnel-maw',
  name: 'Tunnel Maw',
  level: 1,
  maxHp: 92,
  maxStability: 52,
  damage: 13,
};
