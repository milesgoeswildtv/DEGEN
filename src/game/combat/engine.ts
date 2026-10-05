import type { BattleReward, DegenDefinition, EnemyDefinition } from '../../domain/types';
import { canUseAbility, resolveCombatTurn } from './rules';

export type BattleStatus = 'active' | 'victory' | 'defeat';

export interface BattleSnapshot {
  status: BattleStatus;
  playerName: string;
  playerHp: number;
  playerMaxHp: number;
  playerMana: number;
  playerMaxMana: number;
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
