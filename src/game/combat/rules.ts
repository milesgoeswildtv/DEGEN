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

const FORBIDDEN_MONSTER_ACTION_RESOURCE_ALIASES = [
  'actionpoint',
  'energy',
  'stamina',
  'focus',
] as const;

const normalizeMonsterActionResourceField = (field: string): string =>
  // NFKC folds compatibility characters (for example full-width Latin letters)
  // before separator removal, so visually disguised resource aliases fail closed.
  field.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');

const isMonsterMpResourceAlias = (normalizedField: string): boolean =>
  // MP is the conventional abbreviation for Mana Points. Match resource-shaped
  // names only; a broad substring check would incorrectly reject move names
  // such as "jump" or "stomp".
  /^(?:(?:max|current|base|starting|initial)?mp(?:cost|pool|regeneration|regen|steal|drain|recovery|restore|gain|amount|value)?)$/.test(normalizedField)
  || normalizedField.includes('magicpoint');

const findForbiddenMonsterActionResource = (
  value: unknown,
  path: string,
  visited: WeakSet<object>,
): string | undefined => {
  if (value === null || typeof value !== 'object' || visited.has(value)) return undefined;
  visited.add(value);

  for (const [field, nestedValue] of Object.entries(value)) {
    const fieldPath = path ? `${path}.${field}` : field;
    const normalizedField = normalizeMonsterActionResourceField(field);
    if (normalizedField.includes('mana')
      || normalizedField.includes('resource')
      || isMonsterMpResourceAlias(normalizedField)
      || FORBIDDEN_MONSTER_ACTION_RESOURCE_ALIASES.some((alias) => normalizedField.includes(alias))) {
      return fieldPath;
    }

    const nestedForbiddenField = findForbiddenMonsterActionResource(nestedValue, fieldPath, visited);
    if (nestedForbiddenField) return nestedForbiddenField;
  }

  return undefined;
};

const DEGEN_MECHANIC_COLLECTION_FIELDS = new Set([
  'ability', 'abilities', 'move', 'moves', 'loadout',
  'signature', 'signatures', 'effect', 'effects',
  'status', 'statuses', 'appliedeffect', 'appliedeffects',
  'mechanic', 'mechanics', 'degenmechanic', 'degenmechanics',
]);

const DEGEN_MECHANIC_DIRECT_NAME_FIELDS = new Set([
  'effect', 'appliedeffect', 'status', 'statusname',
  'effectname', 'signature', 'signaturename',
  'degeneffect', 'degenstatus', 'mechanic', 'mechanicname',
]);

const DEGEN_MECHANIC_NESTED_NAME_FIELDS = new Set([
  'id', 'key', 'name', 'type', 'value',
  'effect', 'appliedeffect', 'status', 'statusname',
  'effectname', 'signature', 'signaturename',
  'degeneffect', 'degenstatus', 'mechanic', 'mechanicname',
]);

const findForbiddenDegenOwnedEffect = (
  value: unknown,
  path: string,
  insideMechanic: boolean,
  visitedContexts: WeakMap<object, number>,
): string | undefined => {
  if (value === null || typeof value !== 'object') return undefined;

  // The same nested object can be reachable through ordinary metadata and a
  // mechanic path. Track each traversal context separately so an earlier
  // non-mechanic visit cannot hide a Degen-only effect on the mechanic path.
  const contextMask = insideMechanic ? 2 : 1;
  const seenContexts = visitedContexts.get(value) ?? 0;
  if ((seenContexts & contextMask) !== 0) return undefined;
  visitedContexts.set(value, seenContexts | contextMask);

  for (const [field, nestedValue] of Object.entries(value)) {
    const fieldPath = path ? path + '.' + field : field;
    const normalizedField = normalizeMonsterActionResourceField(field);
    const mechanicContext = insideMechanic || DEGEN_MECHANIC_COLLECTION_FIELDS.has(normalizedField);
    const directMechanicName = DEGEN_MECHANIC_DIRECT_NAME_FIELDS.has(normalizedField);
    const nestedMechanicName = mechanicContext && DEGEN_MECHANIC_NESTED_NAME_FIELDS.has(normalizedField);
    const mechanicCollection = DEGEN_MECHANIC_COLLECTION_FIELDS.has(normalizedField);

    // Only inspect arrays stored in mechanic/name fields or known mechanic
    // collections. A prose array inside a move remains descriptive text.
    if (Array.isArray(nestedValue)
      && (directMechanicName || nestedMechanicName || mechanicCollection)) {
      const leakIndex = nestedValue.findIndex((item) => typeof item === 'string'
        && item.normalize('NFKC').trim().toUpperCase() === 'LEAK');
      if (leakIndex >= 0) return fieldPath + '.' + leakIndex;
    }

    if (typeof nestedValue === 'string'
      && nestedValue.normalize('NFKC').trim().toUpperCase() === 'LEAK'
      && (directMechanicName || nestedMechanicName)) {
      return fieldPath;
    }

    const nestedForbiddenEffect = findForbiddenDegenOwnedEffect(
      nestedValue,
      fieldPath,
      mechanicContext,
      visitedContexts,
    );
    if (nestedForbiddenEffect) return nestedForbiddenEffect;
  }

  return undefined;
};

export const assertNoMonsterActionResource = (enemy: EnemyDefinition): void => {
  const forbiddenField = findForbiddenMonsterActionResource(enemy, '', new WeakSet<object>());

  if (forbiddenField) {
    throw new TypeError(
      `Monster definitions cannot expose a universal action resource (${forbiddenField}).`,
    );
  }

  // LEAK is a GLITCHRAT-owned Degen effect, never a monster status or signature.
  // Inspect only mechanical names/IDs; ordinary descriptive prose is not a use.
  const forbiddenDegenEffect = findForbiddenDegenOwnedEffect(enemy, '', false, new WeakMap<object, number>());
  if (forbiddenDegenEffect) {
    throw new TypeError(
      `Monster definitions cannot use the Degen-owned effect LEAK (${forbiddenDegenEffect}).`,
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
