import type { AbilityDefinition, DegenDefinition, EnemyDefinition } from '../../domain/types';

export interface CombatTurnInput {
  playerHp: number;
  playerMana: number;
  enemyHp: number;
  ability: AbilityDefinition;
  degen: DegenDefinition;
  enemy: EnemyDefinition;
}

export interface CombatTurnResult {
  status: 'active' | 'victory' | 'defeat';
  playerHp: number;
  playerMana: number;
  enemyHp: number;
  playerDamage: number;
  retaliationDamage: number;
}

export const canUseAbility = (playerMana: number, ability: AbilityDefinition): boolean =>
  playerMana >= ability.manaCost;

export const resolveCombatTurn = ({
  playerHp,
  playerMana,
  enemyHp,
  ability,
  degen,
  enemy,
}: CombatTurnInput): CombatTurnResult => {
  if (!canUseAbility(playerMana, ability)) {
    throw new RangeError(`Insufficient Mana for ${ability.name}`);
  }

  const nextPlayerMana = playerMana - ability.manaCost;
  const playerDamage = ability.damage + Math.floor(degen.power * 0.5);
  const nextEnemyHp = Math.max(0, enemyHp - playerDamage);

  if (nextEnemyHp <= 0) {
    return {
      status: 'victory',
      playerHp,
      playerMana: nextPlayerMana,
      enemyHp: nextEnemyHp,
      playerDamage,
      retaliationDamage: 0,
    };
  }

  const retaliationDamage = Math.max(1, enemy.damage - Math.floor(degen.guard * 0.45));
  const nextPlayerHp = Math.max(0, playerHp - retaliationDamage);

  return {
    status: nextPlayerHp <= 0 ? 'defeat' : 'active',
    playerHp: nextPlayerHp,
    playerMana: nextPlayerMana,
    enemyHp: nextEnemyHp,
    playerDamage,
    retaliationDamage,
  };
};
