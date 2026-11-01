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

export const previousLevelForReward = (
  levelAfter: number,
  remainingXp: number,
  xpAward: number,
): number | null => {
  if (!Number.isSafeInteger(levelAfter) || levelAfter < 1
    || !Number.isSafeInteger(remainingXp) || remainingXp < 0
    || !Number.isSafeInteger(xpAward) || xpAward < 0) return null;

  const finalLevel = BigInt(levelAfter);
  const finalRemainder = BigInt(remainingXp);
  const awardedXp = BigInt(xpAward);
  const threshold = (level: bigint): bigint => 100n + (level - 1n) * 75n;
  if (finalRemainder >= threshold(finalLevel)) return null;

  const thresholdsBetween = (start: bigint, endExclusive: bigint): bigint => {
    const count = endExclusive - start;
    if (count <= 0n) return 0n;
    return count * (threshold(start) + threshold(endExclusive - 1n)) / 2n;
  };

  // Reconstruct the unique prior level from the persisted post-award level,
  // remainder, and XP amount; this is presentation data, not client progression.
  let low = 1n;
  let high = finalLevel;
  while (low < high) {
    const middle = (low + high) / 2n;
    const priorXp = finalRemainder - awardedXp + thresholdsBetween(middle, finalLevel);
    if (priorXp < threshold(middle)) high = middle;
    else low = middle + 1n;
  }

  const priorXp = finalRemainder - awardedXp + thresholdsBetween(low, finalLevel);
  if (priorXp < 0n || priorXp >= threshold(low)
    || priorXp > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(low);
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
