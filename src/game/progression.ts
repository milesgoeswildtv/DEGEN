import type { BattleReward } from '../domain/types';

export const UNDERPASS_FULL_REWARD_LIMIT = 3;

export const xpNeededForLevel = (level: number): number => 100 + (level - 1) * 75;

export const advanceLevel = (
  level: number,
  xp: number,
  xpAward: number,
): { level: number; xp: number } => {
  let nextLevel = level;
  let nextXp = xp + xpAward;

  while (nextXp >= xpNeededForLevel(nextLevel)) {
    nextXp -= xpNeededForLevel(nextLevel);
    nextLevel += 1;
  }

  return { level: nextLevel, xp: nextXp };
};

export const underpassRewardForClear = (
  clearNumber: number,
  fullRewardLimit = UNDERPASS_FULL_REWARD_LIMIT,
): BattleReward => (
  clearNumber <= fullRewardLimit
    ? {
      xp: 75,
      currency: 30,
      items: ['underpass-scrap'],
      furniture: ['tunnel-trophy'],
      tier: 'full',
    }
    : {
      xp: 10,
      currency: 3,
      items: [],
      furniture: [],
      tier: 'reduced',
    }
);
