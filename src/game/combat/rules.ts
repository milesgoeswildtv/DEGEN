import type { AbilityDefinition, DegenDefinition, EnemyDefinition } from '../../domain/types';

export interface CombatTurnInput {
  playerHp: number;
  enemyHp: number;
  ability: AbilityDefinition;
  degen: DegenDefinition;
  enemy: EnemyDefinition;
}

export interface CombatTurnResult {
  status: 'active' | 'victory' | 'defeat';
  playerHp: number;
  enemyHp: number;
  playerDamage: number;
  retaliationDamage: number;
}

export const resolveCombatTurn = ({
  playerHp,
  enemyHp,
  ability,
  degen,
  enemy,
}: CombatTurnInput): CombatTurnResult => {
  const playerDamage = ability.damage + Math.floor(degen.power * 0.5);
  const nextEnemyHp = Math.max(0, enemyHp - playerDamage);

  if (nextEnemyHp <= 0) {
    return {
      status: 'victory',
      playerHp,
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
    enemyHp: nextEnemyHp,
    playerDamage,
    retaliationDamage,
  };
};
