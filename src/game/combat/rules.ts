import type { AbilityDefinition, DegenDefinition, EnemyDefinition } from '../../domain/types';

export interface CombatTurnInput {
  playerHp: number;
  playerMana: number;
  /** Temporary player-owned protection carried between authoritative turns. */
  playerShield?: number;
  enemyHp: number;
  ability: AbilityDefinition;
  degen: DegenDefinition;
  enemy: EnemyDefinition;
}

export interface CombatTurnResult {
  status: 'active' | 'victory' | 'defeat';
  playerHp: number;
  playerMana: number;
  playerShield: number;
  enemyHp: number;
  playerDamage: number;
  retaliationDamage: number;
  shieldAbsorbed: number;
}

const isValidManaCost = (manaCost: number): boolean =>
  Number.isSafeInteger(manaCost) && manaCost >= 0;

const isValidShield = (shield: number): boolean =>
  Number.isSafeInteger(shield) && shield >= 0;

const isValidShieldGain = (shieldGain: number | undefined): boolean =>
  shieldGain === undefined || isValidShield(shieldGain);

export const canUseAbility = (playerMana: number, ability: AbilityDefinition): boolean =>
  Number.isSafeInteger(playerMana)
  && playerMana >= 0
  && isValidManaCost(ability.manaCost)
  && playerMana >= ability.manaCost;

export const resolveCombatTurn = ({
  playerHp,
  playerMana,
  playerShield = 0,
  enemyHp,
  ability,
  degen,
  enemy,
}: CombatTurnInput): CombatTurnResult => {
  if (!isValidManaCost(ability.manaCost)) {
    throw new RangeError('Invalid Mana cost for ' + ability.name);
  }
  if (!Number.isSafeInteger(playerMana) || playerMana < 0) {
    throw new RangeError('Invalid player Mana');
  }
  if (!isValidShield(playerShield)) {
    throw new RangeError('Invalid player Shield');
  }
  if (!isValidShieldGain(ability.shieldGain)) {
    throw new RangeError('Invalid Shield gain for ' + ability.name);
  }
  if (!canUseAbility(playerMana, ability)) {
    throw new RangeError('Insufficient Mana for ' + ability.name);
  }

  const nextPlayerMana = playerMana - ability.manaCost;
  const shieldGain = ability.shieldGain ?? 0;
  const shieldBeforeRetaliation = playerShield + shieldGain;
  if (!Number.isSafeInteger(shieldBeforeRetaliation)) {
    throw new Error('Shield total must be a non-negative safe integer.');
  }
  const playerDamage = ability.damage + Math.floor(degen.power * 0.5);
  const nextEnemyHp = Math.max(0, enemyHp - playerDamage);

  if (nextEnemyHp <= 0) {
    return {
      status: 'victory',
      playerHp,
      playerMana: nextPlayerMana,
      playerShield: shieldBeforeRetaliation,
      enemyHp: nextEnemyHp,
      playerDamage,
      retaliationDamage: 0,
      shieldAbsorbed: 0,
    };
  }

  const retaliationDamage = Math.max(1, enemy.damage - Math.floor(degen.guard * 0.45));
  const shieldAbsorbed = Math.min(shieldBeforeRetaliation, retaliationDamage);
  const nextPlayerShield = shieldBeforeRetaliation - shieldAbsorbed;
  const hpDamage = retaliationDamage - shieldAbsorbed;
  const nextPlayerHp = Math.max(0, playerHp - hpDamage);

  return {
    status: nextPlayerHp <= 0 ? 'defeat' : 'active',
    playerHp: nextPlayerHp,
    playerMana: nextPlayerMana,
    playerShield: nextPlayerShield,
    enemyHp: nextEnemyHp,
    playerDamage,
    retaliationDamage,
    shieldAbsorbed,
  };
};
