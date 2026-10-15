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

export const canUseAbility = (playerMana: number, ability: AbilityDefinition): boolean =>
  playerMana >= ability.manaCost;

export const resolveCombatTurn = ({
  playerHp,
  playerMana,
  playerShield = 0,
  enemyHp,
  ability,
  degen,
  enemy,
}: CombatTurnInput): CombatTurnResult => {
  if (!canUseAbility(playerMana, ability)) {
    throw new RangeError(`Insufficient Mana for ${ability.name}`);
  }

  const nextPlayerMana = playerMana - ability.manaCost;
  const currentShield = Math.max(0, Math.floor(playerShield));
  const shieldGain = Math.max(0, Math.floor(ability.shieldGain ?? 0));
  const shieldBeforeRetaliation = currentShield + shieldGain;
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
