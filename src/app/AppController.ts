import type Phaser from 'phaser';
import { TEST_DEGEN, TUNNEL_MAW } from '../data/testDegen';
import type { BattlePermit, RouteKey, WorldEventSnapshot } from '../domain/types';
import { createBattleGame } from '../game/createBattleGame';
import { BattleEngine } from '../game/combat/engine';
import { underpassRewardForClear } from '../game/progression';
import { battleView, homeView, mapView, underpassView, updateBattleDom } from '../ui/views';
import { BattleTurnConflictError, GameApi } from './api';
import { PlayerStore } from './state';
import { createPreviewPermit, getPreviewUnderpass, recordPreviewClear } from './worldPreview';

export class AppController {
  private route: RouteKey = 'map';
  private selectedFurniture?: string;
  private battleGame?: Phaser.Game;
  private battleEngine?: BattleEngine;
  private battleReturnTimer?: number;
  private worldRefreshTimer?: number;
  private underpassEvent?: WorldEventSnapshot;
  private worldRefreshGeneration = 0;
  private battlePermit?: BattlePermit;
  private battleActionPending = false;
  private underpassEntryPending = false;
  private navigationGeneration = 0;
  private battlePlayerId?: string;
  private rewardResolution: Promise<void> = Promise.resolve();

  constructor(
    private readonly root: HTMLElement,
    private readonly store: PlayerStore,
    private readonly api: GameApi,
  ) {}

  async start(): Promise<void> {
    await this.refreshWorld();
    this.render();
    if (this.api.enabled) {
      for (const permitId of this.pendingRewardPermits()) void this.queueRewardCompletion(permitId);
    }
    this.worldRefreshTimer = window.setInterval(() => void this.refreshWorld(true), 30_000);
  }

  private navigate(route: RouteKey): void {
    this.navigationGeneration += 1;
    if (route !== 'battle') this.destroyBattle();
    this.route = route;
    this.render();
  }

  private render(): void {
    const player = this.store.snapshot;

    switch (this.route) {
      case 'home':
        this.root.innerHTML = homeView(player, this.selectedFurniture);
        break;
      case 'underpass':
        this.root.innerHTML = underpassView(player, this.underpassEvent);
        break;
      case 'battle':
        this.root.innerHTML = battleView(player, TEST_DEGEN);
        break;
      case 'map':
      default:
        this.root.innerHTML = mapView(player, this.underpassEvent);
        break;
    }

    this.bindCommonNavigation();
    if (this.route === 'home') this.bindHousing();
    if (this.route === 'underpass') this.bindUnderpass();
    if (this.route === 'battle') this.mountBattle();
  }

  private bindCommonNavigation(): void {
    this.root.querySelectorAll<HTMLButtonElement>('[data-route]').forEach((button) => {
      button.addEventListener('click', () => {
        const route = button.dataset.route as RouteKey | undefined;
        if (route) this.navigate(route);
      });
    });
  }

  private bindHousing(): void {
    this.root.querySelectorAll<HTMLButtonElement>('[data-furniture]').forEach((button) => {
      button.addEventListener('click', () => {
        this.selectedFurniture = button.dataset.furniture;
        this.render();
      });
    });

    this.root.querySelector<HTMLButtonElement>('[data-clear-selection]')?.addEventListener('click', () => {
      this.selectedFurniture = undefined;
      this.render();
    });

    this.root.querySelectorAll<HTMLButtonElement>('[data-room-x][data-room-y]').forEach((cell) => {
      cell.addEventListener('click', () => {
        const x = Number(cell.dataset.roomX);
        const y = Number(cell.dataset.roomY);
        if (!Number.isInteger(x) || !Number.isInteger(y)) return;

        if (this.selectedFurniture) this.store.placeFurniture(this.selectedFurniture, x, y);
        else this.store.removeFurnitureAt(x, y);
        this.render();
      });
    });
  }

  private bindUnderpass(): void {
    this.root.querySelector<HTMLButtonElement>('[data-start-battle]')?.addEventListener('click', () => {
      void this.enterUnderpass();
    });
  }

  private async enterUnderpass(): Promise<void> {
    const event = this.underpassEvent;
    if (this.route !== 'underpass' || !event || event.phase !== 'open' || this.underpassEntryPending) return;
    const entryGeneration = this.navigationGeneration;
    const playerId = this.store.snapshot.id;
    this.underpassEntryPending = true;
    // A fresh entry must not leave a detached previous permit actionable.
    this.battlePermit = undefined;
    this.battlePlayerId = undefined;

    try {
      const permit = this.api.enabled
        ? await this.api.startUnderpass(playerId, event.cycleId)
        : createPreviewPermit(event.cycleId);

      if (!permit || typeof permit.permitId !== 'string' || !permit.permitId.trim()) {
        throw new Error('No valid battle permit returned.');
      }
      // A legal permit survives event closure, but cannot be used under another account.
      if (this.route !== 'underpass' || this.navigationGeneration !== entryGeneration
        || this.store.snapshot.id !== playerId) return;
      this.battlePermit = permit;
      this.battlePlayerId = playerId;
      this.navigate('battle');
    } catch (error) {
      console.warn('Underpass entry rejected.', error);
      await this.refreshWorld();
      this.render();
    } finally {
      this.underpassEntryPending = false;
    }
  }

  private mountBattle(): void {
    const parent = this.root.querySelector<HTMLElement>('#phaser-battle');
    if (!parent || !this.battlePermit) return;

    this.battleEngine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, (status) => {
      void this.finishBattle(status);
    });

    this.battleEngine.subscribe(updateBattleDom);
    this.battleGame = createBattleGame(parent, this.battleEngine);

    this.root.querySelectorAll<HTMLButtonElement>('[data-ability]').forEach((button) => {
      button.addEventListener('click', () => {
        const ability = button.dataset.ability;
        if (ability) void this.useBattleAbility(ability);
      });
    });
  }

  private async useBattleAbility(abilityId: string): Promise<void> {
    if (!this.battleEngine || !this.battlePermit || this.battleActionPending) return;
    const engine = this.battleEngine;
    const permitId = this.battlePermit.permitId;
    const playerId = this.battlePlayerId ?? this.store.snapshot.id;
    if (this.store.snapshot.id !== playerId) return;

    this.battleActionPending = true;
    this.setAbilityButtonsDisabled(true);

    try {
      if (this.api.enabled) {
        const authoritative = await this.api.actUnderpass(playerId, permitId, abilityId, engine.snapshot.turnCount);
        if (!authoritative || authoritative.permitId !== permitId) {
          throw new Error('Missing or mismatched authoritative battle action response.');
        }
        if (this.store.snapshot.id !== playerId || this.battleEngine !== engine || this.battlePermit?.permitId !== permitId) {
          // A detached action cannot mutate the current battle. Only a Worker-confirmed
          // victory may be queued for its original account's server-owned reward.
          if (authoritative.status === 'victory') {
            this.rememberPendingReward(permitId, playerId);
            await this.queueRewardCompletion(permitId, playerId);
          }
          return;
        }
        engine.applyAuthoritativeAction(abilityId, authoritative);
      } else {
        engine.useAbility(abilityId);
      }
    } catch (error) {
      if (error instanceof BattleTurnConflictError && error.battleState.permitId === permitId) {
        if (this.store.snapshot.id === playerId && this.battleEngine === engine && this.battlePermit?.permitId === permitId) {
          engine.syncAuthoritativeState(error.battleState);
        } else if (error.battleState.status === 'victory') {
          this.rememberPendingReward(permitId, playerId);
          await this.queueRewardCompletion(permitId, playerId);
        }
      } else {
        console.warn('Battle action rejected by authoritative server.', error);
      }
    } finally {
      if (this.battleEngine === engine) {
        this.battleActionPending = false;
        if (this.store.snapshot.id === playerId && engine.snapshot.status === 'active') {
          this.setAbilityButtonsDisabled(false);
        }
      }
    }
  }

  private setAbilityButtonsDisabled(disabled: boolean): void {
    const snapshot = this.battleEngine?.snapshot;
    this.root.querySelectorAll<HTMLButtonElement>('[data-ability]').forEach((button) => {
      const manaCost = Number(button.dataset.manaCost ?? 0);
      button.disabled = disabled
        || !snapshot
        || snapshot.status !== 'active'
        || manaCost > snapshot.playerMana;
    });
  }

  private pendingRewardKey(playerId = this.store.snapshot.id): string {
    return `degen.pending.reward-permits.v1:${playerId}`;
  }

  // Persist only permit identifiers for retry. Rewards and progression stay Worker-owned.
  private pendingRewardPermits(playerId = this.store.snapshot.id): string[] {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(this.pendingRewardKey(playerId)) ?? '[]');
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
    } catch {
      return [];
    }
  }

  private rememberPendingReward(permitId: string, playerId = this.store.snapshot.id): void {
    try {
      const ids = this.pendingRewardPermits(playerId);
      if (!ids.includes(permitId)) localStorage.setItem(this.pendingRewardKey(playerId), JSON.stringify([...ids, permitId]));
    } catch (error) {
      console.warn('Unable to persist pending battle reward retry.', error);
    }
  }

  private forgetPendingReward(permitId: string, playerId = this.store.snapshot.id): void {
    try {
      localStorage.setItem(this.pendingRewardKey(playerId), JSON.stringify(
        this.pendingRewardPermits(playerId).filter((id) => id !== permitId),
      ));
    } catch (error) {
      console.warn('Unable to clear completed battle reward retry.', error);
    }
  }

  private queueRewardCompletion(permitId: string, playerId = this.store.snapshot.id): Promise<void> {
    this.rewardResolution = this.rewardResolution.then(async () => {
      if (this.store.snapshot.id !== playerId) return;
      try {
        const result = await this.api.completeUnderpass(playerId, permitId);
        if (!result || !result.player || result.player.id !== playerId) {
          throw new Error('Missing or mismatched authoritative battle completion response.');
        }
        // A late receipt must not overwrite a different account's progression.
        if (this.store.snapshot.id !== playerId) return;
        this.store.replaceFromServer(result.player);
        this.worldRefreshGeneration += 1;
        this.underpassEvent = result.worldEvent;
        this.forgetPendingReward(permitId, playerId);
        if (this.battlePermit?.permitId === permitId) {
          this.battlePermit = undefined;
          this.battlePlayerId = undefined;
          if (this.route === 'battle') {
            this.battleReturnTimer = window.setTimeout(() => this.navigate('underpass'), 1400);
          }
        }
        if (this.route !== 'battle') this.render();
      } catch (error) {
        console.warn('Server reward verification failed; retaining permit for retry.', error);
        if (this.store.snapshot.id === playerId) {
          window.setTimeout(() => void this.queueRewardCompletion(permitId, playerId), 15_000);
        }
      }
    });
    return this.rewardResolution;
  }

  private async finishBattle(status: 'victory' | 'defeat'): Promise<void> {
    const playerId = this.battlePlayerId ?? this.store.snapshot.id;
    if (status === 'victory' && this.battlePermit) {
      if (this.api.enabled) {
        const permitId = this.battlePermit.permitId;
        this.rememberPendingReward(permitId, playerId);
        await this.queueRewardCompletion(permitId, playerId);
        return;
      }

      if (this.store.snapshot.id !== playerId) return;
      const clearsBeforeThisFight = recordPreviewClear();
      const previewReward = underpassRewardForClear(
        clearsBeforeThisFight + 1,
        this.underpassEvent?.fullRewardLimit,
      );
      this.store.applyReward(previewReward);
      this.store.markBossDefeated(TUNNEL_MAW.id);
      this.underpassEvent = getPreviewUnderpass();
    }

    if (this.store.snapshot.id !== playerId) return;
    this.battlePermit = undefined;
    this.battlePlayerId = undefined;
    this.battleReturnTimer = window.setTimeout(() => this.navigate('underpass'), 1400);
  }

  private async refreshWorld(rerender = false): Promise<void> {
    const generation = ++this.worldRefreshGeneration;
    const playerId = this.store.snapshot.id;
    try {
      const event = this.api.enabled
        ? await this.api.getUnderpass(playerId)
        : getPreviewUnderpass();
      if (generation !== this.worldRefreshGeneration || this.store.snapshot.id !== playerId) return;
      this.underpassEvent = event;
    } catch (error) {
      if (generation !== this.worldRefreshGeneration || this.store.snapshot.id !== playerId) return;
      console.warn('World-event sync failed; keeping server-backed event unavailable.', error);
      this.underpassEvent = undefined;
    }

    if (rerender && (this.route === 'map' || this.route === 'underpass')) this.render();
  }

  private destroyBattle(): void {
    if (this.battleReturnTimer !== undefined) {
      window.clearTimeout(this.battleReturnTimer);
      this.battleReturnTimer = undefined;
    }
    this.battleGame?.destroy(true);
    this.battleGame = undefined;
    this.battleEngine = undefined;
    this.battleActionPending = false;
  }
}
