import type { AbilityDefinition, DegenDefinition, EnemyDefinition } from '../../domain/types';

export interface CombatTurnInput {
  playerHp: number; playerMana: number; playerShield?: number; enemyHp: number; enemyShield?: number;
  ability: AbilityDefinition; degen: DegenDefinition; enemy: EnemyDefinition;
}
export interface CombatTurnResult {
  status: 'active' | 'victory' | 'defeat';
  playerHp: number; playerMana: number; playerShield: number; enemyHp: number; enemyShield: number;
  playerDamage: number; retaliationDamage: number; shieldAbsorbed: number; enemyShieldAbsorbed: number;
}
const FORBIDDEN_MONSTER_ACTION_RESOURCE_ALIASES = [
  'resource',
  'actionresource',
  'actionpoint',
  'energy',
  'stamina',
  'focus',
  'magicpoint',
  'mp',
] as const;

const RESOURCE_FIELD_PREFIXES = ['max', 'current', 'base', 'starting', 'initial'] as const;
const RESOURCE_FIELD_SUFFIXES = [
  'cost', 'pool', 'regeneration', 'regen', 'steal', 'drain',
  'recovery', 'restore', 'gain', 'amount', 'value', 'point', 'points',
  'max', 'current', 'base', 'starting', 'initial',
] as const;

const normalizeMonsterActionResourceField = (field: string): string =>
  // NFKC folds compatibility characters (for example full-width Latin letters)
  // before separator removal, so visually disguised resource aliases fail closed.
  field.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');

const isResourceAliasField = (normalizedField: string, alias: string): boolean => {
  const bases = [alias, `${alias}s`];
  for (const base of bases) {
    if (normalizedField === base) return true;
    for (const prefix of RESOURCE_FIELD_PREFIXES) {
      if (normalizedField === `${prefix}${base}`) return true;
    }
    for (const suffix of RESOURCE_FIELD_SUFFIXES) {
      if (normalizedField === `${base}${suffix}`) return true;
      for (const prefix of RESOURCE_FIELD_PREFIXES) {
        if (normalizedField === `${prefix}${base}${suffix}`) return true;
      }
    }
  }
  return false;
};

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
      || FORBIDDEN_MONSTER_ACTION_RESOURCE_ALIASES.some((alias) => isResourceAliasField(normalizedField, alias))) {
      return fieldPath;
    }

    const nestedForbiddenField = findForbiddenMonsterActionResource(nestedValue, fieldPath, visited);
    if (nestedForbiddenField) return nestedForbiddenField;
  }

  return undefined;
};

const DEGEN_MECHANIC_COLLECTION_FIELDS = new Set([
  'ability', 'abilities', 'move', 'moves', 'loadout',
  'signature', 'signatures', 'signatureeffect', 'signatureeffects', 'effect', 'effects',
  'status', 'statuses', 'statuseffect', 'statuseffects', 'appliedstatus', 'appliedstatuses', 'degenstatus', 'degenstatuses',
  'degeneffect', 'degeneffects', 'abilityeffect', 'abilityeffects', 'moveeffect', 'moveeffects',
  'appliedeffect', 'appliedeffects',
  'mechanic', 'mechanics', 'degenmechanic', 'degenmechanics',
]);

const DEGEN_MECHANIC_DIRECT_NAME_FIELDS = new Set([
  'effect', 'appliedeffect', 'status', 'statusname', 'appliedstatus', 'appliedstatuses',
  'effectname', 'signature', 'signaturename',
  'degeneffect', 'degenstatus', 'mechanic', 'mechanicname',
]);

const DEGEN_MECHANIC_NESTED_NAME_FIELDS = new Set([
  'id', 'key', 'name', 'type', 'value',
  'effect', 'appliedeffect', 'status', 'statusname', 'appliedstatus', 'appliedstatuses',
  'effectname', 'signature', 'signaturename',
  'degeneffect', 'degenstatus', 'mechanic', 'mechanicname',
]);

const DEGEN_DESCRIPTIVE_FIELDS = new Set([
  'metadata', 'description', 'descriptions', 'lore', 'notes', 'flavor', 'flavour', 'text',
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
    // Descriptive subtrees remain prose even when nested under a move/signature.
    // The independent resource guard still rejects Mana/resource fields there.
    if (DEGEN_DESCRIPTIVE_FIELDS.has(normalizedField)) continue;
    const directMechanicName = DEGEN_MECHANIC_DIRECT_NAME_FIELDS.has(normalizedField);
    const mechanicContext = insideMechanic
      || DEGEN_MECHANIC_COLLECTION_FIELDS.has(normalizedField)
      || directMechanicName;
    // Some canonical content formats represent effects/statuses as object keys
    // rather than string values (for example signature.effects.LEAK: {...}).
    // Treat those keys as mechanic names only inside a mechanic namespace; prose
    // metadata with a coincidental LEAK key remains descriptive.
    if (mechanicContext && field.normalize('NFKC').trim().toUpperCase() === 'LEAK') {
      return fieldPath;
    }
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

const isValidNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export const isValidManaCost = (value: unknown): value is number =>
  isValidNonNegativeSafeInteger(value);
export const isValidManaState = (currentMana: unknown, maxMana: unknown): currentMana is number =>
  isValidManaCost(currentMana) && isValidManaCost(maxMana) && currentMana <= maxMana;
export const isValidShield = (value: unknown): value is number =>
  isValidNonNegativeSafeInteger(value);
export const isValidShieldGain = (value: unknown): value is number | undefined =>
  value === undefined || isValidShield(value);

// Upper bound for one accepted enemy-Shield absorption audit. Derive it from
// the Degen's actual bespoke abilities so multi-turn recovery cannot accept an
// impossible audit delta that the one-turn resolver would reject.
export const maxAbilityDamage = (degen: DegenDefinition): number | undefined => {
  if (!isValidNonNegativeSafeInteger(degen.power) || !Array.isArray(degen.abilities)) return undefined;
  const powerBonus = Math.floor(degen.power * 0.5);
  let maximum = 0;
  for (const ability of degen.abilities) {
    if (!isValidNonNegativeSafeInteger(ability.damage)) return undefined;
    const damage = ability.damage + powerBonus;
    if (!Number.isSafeInteger(damage)) return undefined;
    maximum = Math.max(maximum, damage);
  }
  return maximum;
};
export const canUseAbility = (playerMana: number, ability: AbilityDefinition): boolean =>
  isValidManaCost(playerMana) && isValidManaCost(ability.manaCost) && playerMana >= ability.manaCost;

export const resolveCombatTurn = (input: CombatTurnInput): CombatTurnResult => {
  const {
    playerHp, playerMana, playerShield = 0, enemyHp, ability, degen, enemy,
  } = input;
  const enemyShield = input.enemyShield === undefined ? (enemy.startingShield ?? 0) : input.enemyShield;
  assertNoMonsterActionResource(enemy);
  if (enemy.startingShield !== undefined && !isValidShield(enemy.startingShield)) throw new RangeError('Invalid enemy starting Shield');
  if (!isValidShield(enemyShield)) throw new RangeError('Invalid enemy Shield');
  if (!isValidManaCost(ability.manaCost)) throw new RangeError(`Invalid Mana cost for ${ability.name}`);
  if (!isValidManaState(playerMana, degen.maxMana)) throw new RangeError('Invalid player Mana');
  if (!isValidNonNegativeSafeInteger(degen.maxHp) || degen.maxHp === 0
    || !isValidNonNegativeSafeInteger(playerHp) || playerHp === 0 || playerHp > degen.maxHp) {
    throw new RangeError('Invalid player HP');
  }
  if (!isValidNonNegativeSafeInteger(enemy.maxHp) || enemy.maxHp === 0
    || !isValidNonNegativeSafeInteger(enemyHp) || enemyHp === 0 || enemyHp > enemy.maxHp) {
    throw new RangeError('Invalid enemy HP');
  }
  if (!isValidNonNegativeSafeInteger(ability.damage)
    || !isValidNonNegativeSafeInteger(degen.power)
    || !isValidNonNegativeSafeInteger(degen.guard)
    || !isValidNonNegativeSafeInteger(enemy.damage)) {
    throw new RangeError('Invalid combat definition');
  }
  if (!isValidShield(playerShield)) throw new RangeError('Invalid player Shield');
  if (!isValidShieldGain(ability.shieldGain)) throw new RangeError(`Invalid Shield gain for ${ability.name}`);
  if (!canUseAbility(playerMana, ability)) throw new RangeError(`Insufficient Mana for ${ability.name}`);

  const nextPlayerMana = playerMana - ability.manaCost;
  const shieldBeforeRetaliation = playerShield + (ability.shieldGain ?? 0);
  if (!Number.isSafeInteger(shieldBeforeRetaliation)) throw new RangeError('Player Shield must remain a non-negative safe integer.');
  const playerDamage = ability.damage + Math.floor(degen.power * 0.5);
  if (!isValidNonNegativeSafeInteger(playerDamage)) throw new RangeError('Player damage must remain a non-negative safe integer.');
  const enemyShieldAbsorbed = Math.min(enemyShield, playerDamage);
  const nextEnemyShield = enemyShield - enemyShieldAbsorbed;
  const nextEnemyHp = Math.max(0, enemyHp - (playerDamage - enemyShieldAbsorbed));
  if (nextEnemyHp <= 0) return {
    status: 'victory', playerHp, playerMana: nextPlayerMana, playerShield: shieldBeforeRetaliation,
    enemyHp: nextEnemyHp, enemyShield: nextEnemyShield, enemyShieldAbsorbed,
    playerDamage, retaliationDamage: 0, shieldAbsorbed: 0,
  };

  const retaliationDamage = Math.max(1, enemy.damage - Math.floor(degen.guard * 0.45));
  if (!isValidNonNegativeSafeInteger(retaliationDamage)) throw new RangeError('Retaliation damage must remain a non-negative safe integer.');
  const shieldAbsorbed = Math.min(shieldBeforeRetaliation, retaliationDamage);
  const nextPlayerShield = shieldBeforeRetaliation - shieldAbsorbed;
  const nextPlayerHp = Math.max(0, playerHp - (retaliationDamage - shieldAbsorbed));
  return {
    status: nextPlayerHp <= 0 ? 'defeat' : 'active',
    playerHp: nextPlayerHp, playerMana: nextPlayerMana, playerShield: nextPlayerShield,
    enemyHp: nextEnemyHp, enemyShield: nextEnemyShield, enemyShieldAbsorbed,
    playerDamage, retaliationDamage, shieldAbsorbed,
  };
};
