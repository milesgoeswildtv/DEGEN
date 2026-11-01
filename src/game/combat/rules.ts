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

const FORBIDDEN_MONSTER_ACTION_RESOURCE_FIELDS = [
  'mana',
  'maxMana',
  'currentMana',
  'manaCost',
  'manaPool',
  'resource',
  'resourcePool',
  'resourceCost',
  'actionResource',
  'actionPoints',
  'energy',
  'stamina',
] as const;

const assertNoMonsterActionResource = (enemy: EnemyDefinition): void => {
  const record = enemy as unknown as Record<string, unknown>;
  const forbiddenField = FORBIDDEN_MONSTER_ACTION_RESOURCE_FIELDS.find((field) =>
    Object.prototype.hasOwnProperty.call(record, field));

  if (forbiddenField) {
    throw new TypeError(
      `Monster definitions cannot expose a universal action resource (${forbiddenField}).`,
    );
  }
};

export const isValidManaCost = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export const isValidManaState = (currentMana: unknown, maxMana: unknown): currentMana is number =>
  isValidManaCost(currentMana) && isValidManaCost(maxMana) && currentMana <= maxMana;

export const canUseAbility = (playerMana: number, ability: AbilityDefinition): boolean =>
  isValidManaCost(playerMana)
  && isValidManaCost(ability.manaCost)
  && playerMana >= ability.manaCost;

export const resolveCombatTurn = ({
  playerHp,
  playerMana,
  enemyHp,
  ability,
  degen,
  enemy,
}: CombatTurnInput): CombatTurnResult => {
  assertNoMonsterActionResource(enemy);

  if (!isValidManaCost(ability.manaCost)) {
    throw new RangeError(`Invalid Mana cost for ${ability.name}`);
  }
  if (!isValidManaState(playerMana, degen.maxMana)) {
    throw new RangeError('Invalid player Mana');
  }
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
