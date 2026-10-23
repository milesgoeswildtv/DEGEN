import type { BattleActionResult, BattleReward, DegenDefinition, EnemyDefinition } from '../../domain/types';
import { canUseAbility, resolveCombatTurn } from './rules';

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
  log: string[];
}

export class BattleEngine {
  private playerHp: number;
  private playerMana: number;
  private playerShield: number;
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
    this.playerHp = initialState?.playerHp ?? degen.maxHp;
    this.playerMana = initialState?.playerMana ?? degen.maxMana;
    this.playerShield = initialState?.playerShield ?? 0;
    this.turnCount = initialState?.turnCount ?? 0;
    this.permitId = initialState?.permitId;
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
      playerShield: this.playerShield,
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

  // Worker-backed battles render the authoritative result; offline preview alone resolves locally.
  applyAuthoritativeAction(abilityId: string, result: BattleActionResult): void {
    if (this.status !== 'active') return;
    const ability = this.degen.abilities.find((candidate) => candidate.id === abilityId);
    if (!ability) return;
    if (!this.permitId || result.permitId !== this.permitId) return;
    if (result.turnCount !== this.turnCount + 1) {
      this.synchronizeAuthoritativeState(result);
      return;
    }

    const playerDamage = Math.max(0, this.enemyHp - result.enemyHp);
    const retaliationDamage = Math.max(0, this.playerHp - result.playerHp);
    const manaSpent = Math.max(0, this.playerMana - result.playerMana);
    const shieldGained = Math.max(0, result.playerShield + result.shieldAbsorbed - this.playerShield);
    this.playerHp = result.playerHp;
    this.playerMana = result.playerMana;
    this.playerShield = result.playerShield;
    this.enemyHp = result.enemyHp;
    this.turnCount = result.turnCount;
    this.log.push(`${this.degen.name} uses ${ability.name}: ${playerDamage} damage.`);
    if (manaSpent > 0) this.log.push(`Mana -${manaSpent}.`);
    if (shieldGained > 0) this.log.push(`Shield +${shieldGained}.`);
    if (result.shieldAbsorbed > 0) this.log.push(`Shield absorbs ${result.shieldAbsorbed}.`);

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
    if (this.status !== 'active' || !this.permitId || result.permitId !== this.permitId) return;
    if (!Number.isSafeInteger(result.turnCount) || result.turnCount < this.turnCount) return;

    const changed = this.playerHp !== result.playerHp
      || this.playerMana !== result.playerMana
      || this.playerShield !== result.playerShield
      || this.enemyHp !== result.enemyHp
      || this.turnCount !== result.turnCount
      || this.status !== result.status;
    this.playerHp = result.playerHp;
    this.playerMana = result.playerMana;
    this.playerShield = result.playerShield;
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
    if (this.status !== 'active') return;

    const ability = this.degen.abilities.find((candidate) => candidate.id === abilityId);
    if (!ability) return;

    if (!canUseAbility(this.playerMana, ability)) {
      this.log.push(`Not enough Mana for ${ability.name}.`);
      this.trimLog();
      this.emit();
      return;
    }

    const previousShield = this.playerShield;
    const result = resolveCombatTurn({
      playerHp: this.playerHp,
      playerMana: this.playerMana,
      playerShield: this.playerShield,
      enemyHp: this.enemyHp,
      ability,
      degen: this.degen,
      enemy: this.enemy,
    });

    const shieldGained = Math.max(0, result.playerShield + result.shieldAbsorbed - previousShield);
    this.playerHp = result.playerHp;
    this.playerMana = result.playerMana;
    this.playerShield = result.playerShield;
    this.enemyHp = result.enemyHp;
    this.turnCount += 1;
    this.log.push(`${this.degen.name} uses ${ability.name}: ${result.playerDamage} damage.`);

    if (ability.manaCost > 0) {
      this.log.push(`Mana -${ability.manaCost}.`);
    }
    if (shieldGained > 0) this.log.push(`Shield +${shieldGained}.`);
    if (result.shieldAbsorbed > 0) this.log.push(`Shield absorbs ${result.shieldAbsorbed}.`);

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
