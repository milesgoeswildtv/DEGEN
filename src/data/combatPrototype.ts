import type { DegenDefinition, EnemyDefinition } from '../domain/types';

// Temporary shared prototype combat content. Both the web client and Worker import this file so
// authoritative combat math cannot silently drift between presentation and reward validation.
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
    },
    {
      id: 'crack',
      name: 'Crack',
      description: 'Heavy direct damage.',
      damage: 26,
    },
  ],
};

export const TUNNEL_MAW: EnemyDefinition = {
  id: 'tunnel-maw',
  name: 'Tunnel Maw',
  level: 1,
  maxHp: 92,
  damage: 13,
};
