import type { AbilityDefinition, BattleReward, DegenDefinition, EnemyDefinition } from '../../domain/types';

export type BattleStatus = 'active' | 'victory' | 'defeat';

export interface BattleSnapshot {
  status: BattleStatus;
  playerName: string;
  playerHp: number;
  playerMaxHp: number;
  enemyName: string;
  enemyLevel: number;
  enemyHp: number;
  enemyMaxHp: number;
  enemyStability: number;
  enemyMaxStability: number;
  enemyBroken: boolean;
  log: string[];
}

export class BattleEngine {
  private playerHp: number;
  private enemyHp: number;
  private enemyStability: number;
  private enemyBroken = false;
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
    this.enemyHp = enemy.maxHp;
    this.enemyStability = enemy.maxStability;
    this.log = [`${degen.name} manifests.`, `${enemy.name} blocks the path.`];
  }

  get snapshot(): BattleSnapshot {
    return {
      status: this.status,
      playerName: this.degen.name,
      playerHp: this.playerHp,
      playerMaxHp: this.degen.maxHp,
      enemyName: this.enemy.name,
      enemyLevel: this.enemy.level,
      enemyHp: this.enemyHp,
      enemyMaxHp: this.enemy.maxHp,
      enemyStability: this.enemyStability,
      enemyMaxStability: this.enemy.maxStability,
      enemyBroken: this.enemyBroken,
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

    this.resolvePlayerAbility(ability);
    if (this.enemyHp <= 0) {
      this.finishVictory();
      return;
    }

    if (this.enemyBroken) {
      this.log.push(`${this.enemy.name} is BROKEN and loses its action.`);
      this.enemyBroken = false;
      this.enemyStability = this.enemy.maxStability;
      this.emit();
      return;
    }

    this.resolveEnemyTurn();
  }

  private resolvePlayerAbility(ability: AbilityDefinition): void {
    const damage = ability.damage + Math.floor(this.degen.power * 0.5);
    const stabilityDamage = ability.stabilityDamage + Math.floor(this.degen.control * 0.25);

    this.enemyHp = Math.max(0, this.enemyHp - damage);
    this.enemyStability = Math.max(0, this.enemyStability - stabilityDamage);
    this.log.push(`${this.degen.name} uses ${ability.name}: ${damage} damage.`);

    if (this.enemyHp > 0 && this.enemyStability === 0) {
      this.enemyBroken = true;
      this.log.push(`BREAK — ${this.enemy.name}'s Stability collapses.`);
    }

    this.trimLog();
    this.emit();
  }

  private resolveEnemyTurn(): void {
    const mitigated = Math.max(1, this.enemy.damage - Math.floor(this.degen.guard * 0.45));
    this.playerHp = Math.max(0, this.playerHp - mitigated);
    this.log.push(`${this.enemy.name} hits back for ${mitigated}.`);
    this.trimLog();

    if (this.playerHp <= 0) {
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
