import type { BattleActionResult, BattleReward, DegenDefinition, EnemyDefinition } from '../../domain/types';
import { canUseAbility, isValidManaState, resolveCombatTurn } from './rules';

export type BattleStatus = 'active' | 'victory' | 'defeat';

export interface BattleSnapshot {
  status: BattleStatus;
  playerName: string;
  playerHp: number;
  playerMaxHp: number;
  playerMana: number;
  playerMaxMana: number;
  turnCount: number;
  enemyName: string;
  enemyLevel: number;
  enemyHp: number;
  enemyMaxHp: number;
  log: string[];
}

export class BattleEngine {
  private playerHp: number;
  private playerMana: number;
  private turnCount: number;
  private readonly permitId?: string;
  private enemyHp: number;
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
    this.degen = degen;
    this.enemy = enemy;
    this.onComplete = onComplete;
    this.permitId = initialState?.permitId;
    if (initialState && (!this.isValidAuthoritativeState(initialState) || initialState.status !== 'active')) {
      throw new Error('Invalid authoritative battle start state.');
    }
    this.playerHp = initialState?.playerHp ?? degen.maxHp;
    this.playerMana = initialState?.playerMana ?? degen.maxMana;
    this.turnCount = initialState?.turnCount ?? 0;
    this.enemyHp = initialState?.enemyHp ?? enemy.maxHp;
    this.status = initialState?.status ?? 'active';
    this.log = [`${degen.name} manifests.`, `${enemy.name} blocks the path.`];
  }

  get snapshot(): BattleSnapshot {
    return {
      status: this.status,
      playerName: this.degen.name,
      playerHp: this.playerHp,
      playerMaxHp: this.degen.maxHp,
      playerMana: this.playerMana,
      playerMaxMana: this.degen.maxMana,
      turnCount: this.turnCount,
      enemyName: this.enemy.name,
      enemyLevel: this.enemy.level,
      enemyHp: this.enemyHp,
      enemyMaxHp: this.enemy.maxHp,
      log: [...this.log],
    };
  }

  subscribe(listener: (snapshot: BattleSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  // Validate the complete Worker snapshot at the engine boundary as well as the API boundary.
  // A malformed response must never alter the displayed battle or emit a terminal callback.
  private isValidAuthoritativeState(result: BattleActionResult): boolean {
    if (!this.permitId || result.permitId !== this.permitId) return false;
    if (!Number.isSafeInteger(result.turnCount) || result.turnCount < 0) return false;
    if (!Number.isSafeInteger(result.playerHp)
      || result.playerHp < 0 || result.playerHp > this.degen.maxHp) return false;
    if (!isValidManaState(result.playerMana, this.degen.maxMana)) return false;
    if (!Number.isSafeInteger(result.enemyHp)
      || result.enemyHp < 0 || result.enemyHp > this.enemy.maxHp) return false;

    switch (result.status) {
      case 'active':
        return result.playerHp > 0 && result.enemyHp > 0 && result.turnCount < Number.MAX_SAFE_INTEGER;
      case 'victory':
        return result.turnCount > 0 && result.playerHp > 0 && result.enemyHp === 0;
      case 'defeat':
        return result.turnCount > 0 && result.playerHp === 0 && result.enemyHp > 0;
      default:
        return false;
    }
  }

  // Worker-backed battles render the authoritative result; offline preview alone resolves locally.
  applyAuthoritativeAction(abilityId: string, result: BattleActionResult): void {
    if (this.status !== 'active') return;
    const ability = this.degen.abilities.find((candidate) => candidate.id === abilityId);
    if (!ability || !this.isValidAuthoritativeState(result)) return;
    if (result.turnCount !== this.turnCount + 1) {
      this.synchronizeAuthoritativeState(result);
      return;
    }

    const playerDamage = Math.max(0, this.enemyHp - result.enemyHp);
    const retaliationDamage = Math.max(0, this.playerHp - result.playerHp);
    const manaSpent = Math.max(0, this.playerMana - result.playerMana);
    this.playerHp = result.playerHp;
    this.playerMana = result.playerMana;
    this.enemyHp = result.enemyHp;
    this.turnCount = result.turnCount;
    this.log.push(`${this.degen.name} uses ${ability.name}: ${playerDamage} damage.`);
    if (manaSpent > 0) this.log.push(`Mana -${manaSpent}.`);

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
    if (result.turnCount < this.turnCount) return;

    // A turn count identifies one immutable combat snapshot. Same-turn retries
    // are idempotent only when every authoritative field agrees; a conflicting
    // same-turn response must not roll back or rewrite the displayed battle.
    if (result.turnCount === this.turnCount && (
      result.playerHp !== this.playerHp
      || result.playerMana !== this.playerMana
      || result.enemyHp !== this.enemyHp
      || result.status !== this.status
    )) return;

    const changed = this.playerHp !== result.playerHp
      || this.playerMana !== result.playerMana
      || this.enemyHp !== result.enemyHp
      || this.turnCount !== result.turnCount
      || this.status !== result.status;
    this.playerHp = result.playerHp;
    this.playerMana = result.playerMana;
    this.enemyHp = result.enemyHp;
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
      enemyHp: this.enemyHp,
      ability,
      degen: this.degen,
      enemy: this.enemy,
    });

    this.playerHp = result.playerHp;
    this.playerMana = result.playerMana;
    this.enemyHp = result.enemyHp;
    this.turnCount += 1;
    this.log.push(`${this.degen.name} uses ${ability.name}: ${result.playerDamage} damage.`);

    if (ability.manaCost > 0) {
      this.log.push(`Mana -${ability.manaCost}.`);
    }

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
