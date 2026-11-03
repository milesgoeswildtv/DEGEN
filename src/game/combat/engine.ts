import type { BattleActionResult, BattleReward, DegenDefinition, EnemyDefinition } from '../../domain/types';
import { assertNoMonsterActionResource, canUseAbility, isValidManaState, isValidShield, resolveCombatTurn } from './rules.ts';

export type BattleStatus = 'active' | 'victory' | 'defeat';

export interface BattleSnapshot {
  status: BattleStatus;
  playerName: string;
  playerHp: number;
  playerMaxHp: number;
  playerMana: number;
  playerMaxMana: number;
  playerShield: number;
  turnCount: number;
  enemyName: string;
  enemyLevel: number;
  enemyHp: number;
  enemyMaxHp: number;
  enemyShield?: number;
  log: string[];
}

export class BattleEngine {
  private playerHp: number;
  private playerMana: number;
  private playerShield: number;
  private shieldAbsorbed: number;
  private retaliationDamage: number;
  private turnCount: number;
  private readonly permitId?: string;
  private enemyHp: number;
  private enemyShield: number;
  private status: BattleStatus = 'active';
  private log: string[] = [];
  private listeners = new Set<(snapshot: BattleSnapshot) => void>();
  private completionSent = false;

  readonly degen: DegenDefinition;
  readonly enemy: EnemyDefinition;
  private readonly onComplete: (status: Exclude<BattleStatus, 'active'>, reward?: BattleReward) => void;

  constructor(
    degen: DegenDefinition,
    enemy: EnemyDefinition,
    onComplete: (status: Exclude<BattleStatus, 'active'>, reward?: BattleReward) => void,
    initialState?: BattleActionResult,
  ) {
    assertNoMonsterActionResource(enemy);
    this.degen = degen;
    this.enemy = enemy;
    this.onComplete = onComplete;
    this.permitId = initialState?.permitId;
    if (enemy.startingShield !== undefined && !isValidShield(enemy.startingShield)) throw new Error('Invalid enemy starting Shield.');
    // Distinguish an omitted offline-preview state from a supplied but malformed
    // Worker payload. A server permit must never silently become a local battle.
    if (initialState !== undefined && (
      !initialState
      || typeof initialState !== 'object'
      || !this.isValidAuthoritativeState(initialState)
      || initialState.status !== 'active'
    )) {
      throw new Error('Invalid authoritative battle start state.');
    }
    this.playerHp = initialState?.playerHp ?? degen.maxHp;
    this.playerMana = initialState?.playerMana ?? degen.maxMana;
    this.playerShield = initialState?.playerShield ?? 0;
    this.shieldAbsorbed = initialState?.shieldAbsorbed ?? 0;
    this.retaliationDamage = initialState?.retaliationDamage ?? 0;
    this.turnCount = initialState?.turnCount ?? 0;
    this.enemyHp = initialState?.enemyHp ?? enemy.maxHp;
    this.enemyShield = initialState?.enemyShield ?? enemy.startingShield ?? 0;
    this.status = initialState?.status ?? 'active';
    this.log = [`${degen.name} manifests.`, `${enemy.name} blocks the path.`];
  }

  // Validate Worker-owned snapshots at the engine boundary too; the API validator
  // is not the only caller that can reach this stateful object.
  private isValidAuthoritativeState(result: BattleActionResult): boolean {
    if (!result || typeof result !== 'object') return false;
    if (typeof this.permitId !== 'string' || this.permitId.trim().length === 0) return false;
    if (typeof result.permitId !== 'string' || result.permitId !== this.permitId) return false;
    if (!Number.isSafeInteger(result.turnCount) || result.turnCount < 0) return false;
    if (!Number.isSafeInteger(result.playerHp)
      || result.playerHp < 0 || result.playerHp > this.degen.maxHp) return false;
    if (!isValidManaState(result.playerMana, this.degen.maxMana)) return false;
    if (!Number.isSafeInteger(result.enemyHp)
      || result.enemyHp < 0 || result.enemyHp > this.enemy.maxHp) return false;
    const enemyShield = result.enemyShield === undefined ? (this.enemy.startingShield ?? 0) : result.enemyShield;
    if (!isValidShield(enemyShield)
      || (result.enemyShieldAbsorbed !== undefined && !isValidShield(result.enemyShieldAbsorbed))) return false;

    const shieldFields = [result.playerShield, result.shieldAbsorbed, result.retaliationDamage];
    const hasLegacyShieldState = shieldFields.every((field) => field === undefined);
    if (!hasLegacyShieldState && shieldFields.some((field) => field === undefined)) return false;
    const playerShield = result.playerShield === undefined ? 0 : result.playerShield;
    const shieldAbsorbed = result.shieldAbsorbed === undefined ? 0 : result.shieldAbsorbed;
    const retaliationDamage = result.retaliationDamage === undefined ? 0 : result.retaliationDamage;
    if (!isValidShield(playerShield)
      || !isValidShield(shieldAbsorbed)
      || !isValidShield(retaliationDamage)
      || retaliationDamage > this.enemy.damage
      || shieldAbsorbed > retaliationDamage) return false;

    switch (result.status) {
      case 'active': {
        const hasLegacyAuditSentinel = playerShield === 0
          && shieldAbsorbed === 0
          && retaliationDamage === 0;
        const hasConsistentAudit = hasLegacyShieldState
          || hasLegacyAuditSentinel
          || (result.turnCount === 0
            ? playerShield === 0 && shieldAbsorbed === 0 && retaliationDamage === 0
            : retaliationDamage > 0
              && (playerShield === 0 || shieldAbsorbed === retaliationDamage));
        return result.playerHp > 0 && result.enemyHp > 0
          && result.turnCount < Number.MAX_SAFE_INTEGER
          && (result.turnCount !== 0 || enemyShield === (this.enemy.startingShield ?? 0))
          && hasConsistentAudit;
      }
      case 'victory':
        return result.turnCount > 0 && result.playerHp > 0 && result.enemyHp === 0
          && enemyShield === 0
          && shieldAbsorbed === 0 && retaliationDamage === 0;
      case 'defeat': {
        const legacyTerminalAudit = hasLegacyShieldState
          || (shieldAbsorbed === 0 && retaliationDamage === 0);
        return result.turnCount > 0 && result.playerHp === 0 && result.enemyHp > 0
          && playerShield === 0
          && (legacyTerminalAudit || shieldAbsorbed < retaliationDamage);
      }
      default:
        return false;
    }
  }

  get snapshot(): BattleSnapshot {
    return {
      status: this.status,
      playerName: this.degen.name,
      playerHp: this.playerHp,
      playerMaxHp: this.degen.maxHp,
      playerMana: this.playerMana,
      playerMaxMana: this.degen.maxMana,
      playerShield: this.playerShield,
      turnCount: this.turnCount,
      enemyName: this.enemy.name,
      enemyLevel: this.enemy.level,
      enemyHp: this.enemyHp,
      enemyMaxHp: this.enemy.maxHp,
      ...(this.enemyShield > 0 ? { enemyShield: this.enemyShield } : {}),
      log: [...this.log],
    };
  }

  subscribe(listener: (snapshot: BattleSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  // Worker-backed battles render the authoritative result; offline preview alone resolves locally.
  applyAuthoritativeAction(abilityId: string, result: BattleActionResult): void {
    if (this.status !== 'active') return;
    const ability = this.degen.abilities.find((candidate) => candidate.id === abilityId);
    if (!ability || !this.isValidAuthoritativeState(result)) return;
    if (!this.permitId || result.permitId !== this.permitId) return;
    if (result.turnCount !== this.turnCount + 1) {
      this.synchronizeAuthoritativeState(result);
      return;
    }

    const playerDamage = Math.max(0, this.enemyHp - result.enemyHp);
    const retaliationDamage = result.retaliationDamage ?? Math.max(0, this.playerHp - result.playerHp);
    const manaSpent = Math.max(0, this.playerMana - result.playerMana);
    const nextPlayerShield = result.playerShield ?? 0;
    const shieldGained = Math.max(0, nextPlayerShield + (result.shieldAbsorbed ?? 0) - this.playerShield);
    const nextEnemyShield = result.enemyShield ?? this.enemy.startingShield ?? 0;
    // A single accepted action can only consume existing enemy Shield. Reject
    // forged or malformed Shield deltas before presenting the Worker snapshot.
    const expectedEnemyShieldAbsorbed = this.enemyShield - nextEnemyShield;
    const enemyShieldAbsorbed = result.enemyShieldAbsorbed ?? expectedEnemyShieldAbsorbed;
    if (expectedEnemyShieldAbsorbed < 0 || enemyShieldAbsorbed !== expectedEnemyShieldAbsorbed) return;
    this.playerHp = result.playerHp;
    this.playerMana = result.playerMana;
    this.playerShield = nextPlayerShield;
    this.shieldAbsorbed = result.shieldAbsorbed ?? 0;
    this.retaliationDamage = result.retaliationDamage ?? 0;
    this.enemyHp = result.enemyHp;
    this.enemyShield = nextEnemyShield;
    this.turnCount = result.turnCount;
    this.log.push(`${this.degen.name} uses ${ability.name}: ${playerDamage} damage.`);
    if (manaSpent > 0) this.log.push(`Mana -${manaSpent}.`);
    if (shieldGained > 0) this.log.push(`Shield +${shieldGained}.`);
    if ((result.shieldAbsorbed ?? 0) > 0) this.log.push(`Shield absorbs ${result.shieldAbsorbed}.`);
    if (enemyShieldAbsorbed > 0) this.log.push(`${this.enemy.name} Shield absorbs ${enemyShieldAbsorbed}.`);

    if (result.status === 'victory') {
      this.status = 'victory';
      this.log.push(`${this.enemy.name} is defeated.`);
      this.trimLog();
      this.emit();
      this.finish('victory');
      return;
    }

    if (retaliationDamage > 0) {
      this.log.push(`${this.enemy.name} hits back for ${retaliationDamage}.`);
    }
    if (result.status === 'defeat') {
      this.status = 'defeat';
      this.log.push(`${this.degen.name} goes down.`);
      this.trimLog();
      this.emit();
      this.finish('defeat');
      return;
    }
    this.trimLog();
    this.emit();
  }

  synchronizeAuthoritativeState(result: BattleActionResult): void {
    if (this.status !== 'active' || !this.isValidAuthoritativeState(result)) return;
    if (!this.permitId || result.permitId !== this.permitId) return;
    if (result.turnCount < this.turnCount) return;

    // A turn count identifies one immutable combat snapshot. Same-turn retries
    // are idempotent only when every authoritative field agrees; a conflicting
    // same-turn response must not roll back or rewrite the displayed battle.
    if (result.turnCount === this.turnCount && (
      result.playerHp !== this.playerHp
      || result.playerMana !== this.playerMana
      || (result.playerShield ?? 0) !== this.playerShield
      || (result.shieldAbsorbed ?? 0) !== this.shieldAbsorbed
      || (result.retaliationDamage ?? 0) !== this.retaliationDamage
      || result.enemyHp !== this.enemyHp
      || (result.enemyShield ?? this.enemy.startingShield ?? 0) !== this.enemyShield
      || result.status !== this.status
    )) return;

    const changed = this.playerHp !== result.playerHp
      || this.playerMana !== result.playerMana
      || this.playerShield !== (result.playerShield ?? 0)
      || this.shieldAbsorbed !== (result.shieldAbsorbed ?? 0)
      || this.retaliationDamage !== (result.retaliationDamage ?? 0)
      || this.enemyHp !== result.enemyHp
      || this.enemyShield !== (result.enemyShield ?? this.enemy.startingShield ?? 0)
      || this.turnCount !== result.turnCount
      || this.status !== result.status;
    this.playerHp = result.playerHp;
    this.playerMana = result.playerMana;
    this.playerShield = result.playerShield ?? 0;
    this.shieldAbsorbed = result.shieldAbsorbed ?? 0;
    this.retaliationDamage = result.retaliationDamage ?? 0;
    this.enemyHp = result.enemyHp;
    this.enemyShield = result.enemyShield ?? this.enemy.startingShield ?? 0;
    this.turnCount = result.turnCount;
    this.status = result.status;
    if (changed) this.log.push('Battle state synchronized with server.');
    if (this.status === 'victory') this.log.push(`${this.enemy.name} is defeated.`);
    if (this.status === 'defeat') this.log.push(`${this.degen.name} goes down.`);
    this.trimLog();
    this.emit();
    if (this.status !== 'active') this.finish(this.status);
  }

  useAbility(abilityId: string): void {
    // A permit means Worker/D1 owns every action and terminal outcome.
    // Local simulation and its prototype reward callback are offline-preview only.
    if (this.permitId || this.status !== 'active') return;

    const ability = this.degen.abilities.find((candidate) => candidate.id === abilityId);
    if (!ability) return;

    if (!isValidManaState(this.playerMana, this.degen.maxMana)) {
      this.log.push('Mana state is invalid; refresh the encounter.');
      this.trimLog();
      this.emit();
      return;
    }

    if (!canUseAbility(this.playerMana, ability)) {
      this.log.push(`Not enough Mana for ${ability.name}.`);
      this.trimLog();
      this.emit();
      return;
    }

    const result = resolveCombatTurn({
      playerHp: this.playerHp,
      playerMana: this.playerMana,
      playerShield: this.playerShield,
      enemyHp: this.enemyHp,
      enemyShield: this.enemyShield,
      ability,
      degen: this.degen,
      enemy: this.enemy,
    });

    this.playerHp = result.playerHp;
    this.playerMana = result.playerMana;
    this.playerShield = result.playerShield;
    this.shieldAbsorbed = result.shieldAbsorbed;
    this.retaliationDamage = result.retaliationDamage;
    this.enemyHp = result.enemyHp;
    this.enemyShield = result.enemyShield;
    this.turnCount += 1;
    this.log.push(`${this.degen.name} uses ${ability.name}: ${result.playerDamage} damage.`);

    if (ability.manaCost > 0) this.log.push(`Mana -${ability.manaCost}.`);
    if ((ability.shieldGain ?? 0) > 0) this.log.push(`Shield +${ability.shieldGain}.`);
    if (result.shieldAbsorbed > 0) this.log.push(`Shield absorbs ${result.shieldAbsorbed}.`);
    if (result.enemyShieldAbsorbed > 0) this.log.push(`${this.enemy.name} Shield absorbs ${result.enemyShieldAbsorbed}.`);

    if (result.status === 'victory') {
      this.trimLog();
      this.emit();
      this.finishVictory();
      return;
    }

    this.log.push(`${this.enemy.name} hits back for ${result.retaliationDamage}.`);
    this.trimLog();

    if (result.status === 'defeat') {
      this.status = 'defeat';
      this.log.push(`${this.degen.name} goes down.`);
      this.emit();
      this.finish('defeat');
      return;
    }

    this.emit();
  }

  private finishVictory(): void {
    this.status = 'victory';
    this.log.push(`${this.enemy.name} is defeated.`);
    this.emit();
    this.finish('victory', {
      xp: 75,
      currency: 30,
      items: ['underpass-scrap'],
      furniture: ['tunnel-trophy'],
    });
  }

  private finish(status: Exclude<BattleStatus, 'active'>, reward?: BattleReward): void {
    if (this.completionSent) return;
    this.completionSent = true;
    this.onComplete(status, reward);
  }

  private emit(): void {
    const snapshot = this.snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

  private trimLog(): void {
    if (this.log.length > 6) this.log = this.log.slice(-6);
  }
}
