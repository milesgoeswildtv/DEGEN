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
  private enemyHp: number;
  private turnCount = 0;
  private status: BattleStatus = 'active';
  private log: string[] = [];
  private listeners = new Set<(snapshot: BattleSnapshot) => void>();
  private completionSent = false;

  constructor(
    readonly degen: DegenDefinition,
    readonly enemy: EnemyDefinition,
    private readonly onComplete: (status: Exclude<BattleStatus, 'active'>, reward?: BattleReward) => void,
  ) {
    this.playerHp = degen.maxHp;
    this.playerMana = degen.maxMana;
    this.enemyHp = enemy.maxHp;
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

  // Worker-backed battles render the authoritative result; offline preview alone resolves locally.
  applyAuthoritativeAction(abilityId: string, result: BattleActionResult): void {
    if (this.status !== 'active' || result.turnCount <= this.turnCount) return;
    const ability = this.degen.abilities.find((candidate) => candidate.id === abilityId);
    if (!ability) return;

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

  // Restore Worker-owned state after a stale response; no client damage/reward calculation.
  syncAuthoritativeState(result: BattleActionResult): void {
    if (this.status !== 'active' || result.turnCount < this.turnCount) return;
    if (result.turnCount === this.turnCount && result.status === this.status
      && result.playerHp === this.playerHp && result.playerMana === this.playerMana
      && result.enemyHp === this.enemyHp) return;
    this.playerHp = result.playerHp;
    this.playerMana = result.playerMana;
    this.enemyHp = result.enemyHp;
    this.turnCount = result.turnCount;
    this.status = result.status;
    this.log.push('Battle state synchronized with server.');
    if (result.status === 'victory') this.log.push(`${this.enemy.name} is defeated.`);
    if (result.status === 'defeat') this.log.push(`${this.degen.name} goes down.`);
    this.trimLog();
    this.emit();
    if (result.status !== 'active') this.finish(result.status);
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
