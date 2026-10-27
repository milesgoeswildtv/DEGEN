import type Phaser from 'phaser';
import { TEST_DEGEN, TUNNEL_MAW } from '../data/testDegen';
import type { BattleActionResult, BattlePermit, RouteKey, WorldEventSnapshot } from '../domain/types';
import { createBattleGame } from '../game/createBattleGame';
import { BattleEngine } from '../game/combat/engine';
import { underpassRewardForClear } from '../game/progression';
import { battleView, homeView, mapView, underpassView, updateBattleDom } from '../ui/views';
import { GameApi, GameApiError, isAuthoritativeBattleActionState } from './api';
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
  private battlePermit?: BattlePermit;
  private battlePermitOwnerId?: string;
  private battleActionPending = false;
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
      const playerId = this.store.snapshot.id;
      for (const permitId of this.pendingRewardPermits(playerId)) void this.queueRewardCompletion(permitId, playerId);
    }
    this.worldRefreshTimer = window.setInterval(() => void this.refreshWorld(true), 30_000);
  }

  private navigate(route: RouteKey): void {
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
    if (!event || event.phase !== 'open') return;

    try {
      const playerId = this.store.snapshot.id;
      const permit = this.api.enabled
        ? await this.api.startUnderpass(playerId, event.cycleId)
        : createPreviewPermit(event.cycleId);

      if (!permit) throw new Error('No battle permit returned.');
      // Do not attach a permit issued for a previous account to the currently active player.
      if (this.store.snapshot.id !== playerId) return;
      this.battlePermit = permit;
      this.battlePermitOwnerId = playerId;
      this.navigate('battle');
      if (this.api.enabled) {
        this.api.acknowledgeUnderpassStart(playerId, permit.cycleId, permit.permitId);
      }
    } catch (error) {
      console.warn('Underpass entry rejected.', error);
      await this.refreshWorld();
      this.render();
    }
  }

  private mountBattle(): void {
    const parent = this.root.querySelector<HTMLElement>('#phaser-battle');
    const permit = this.battlePermit;
    if (!parent || !permit) return;

    this.battleEngine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, (status) => {
      void this.finishBattle(status);
    }, this.api.enabled ? permit.initialState : undefined);

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
    const playerId = this.battlePermitOwnerId ?? this.store.snapshot.id;
    if (this.store.snapshot.id !== playerId) {
      this.setBattleActionStatus('This battle belongs to a different player session. Return to the active player before continuing.');
      return;
    }

    this.setBattleActionStatus();
    this.battleActionPending = true;
    this.setAbilityButtonsDisabled(true);

    try {
      if (this.api.enabled) {
        const authoritative = await this.api.actUnderpass(playerId, permitId, abilityId, engine.snapshot.turnCount);
        if (!authoritative || authoritative.permitId !== permitId) {
          throw new Error('Missing or mismatched authoritative battle action response.');
        }

        // The player can abandon the battle while this request is in flight. A
        // confirmed terminal result still belongs to the server permit even when
        // its original view has been torn down; never strand a resolved victory.
        if (this.store.snapshot.id !== playerId || this.battlePermit?.permitId !== permitId) {
          if (authoritative.status === 'victory') {
            this.rememberPendingReward(permitId, playerId);
            void this.queueRewardCompletion(permitId, playerId);
          } else if (this.store.snapshot.id !== playerId
            && this.battlePermit?.permitId === permitId
            && this.battlePermitOwnerId === playerId) {
            this.battlePermit = undefined;
            this.battlePermitOwnerId = undefined;
          }
          return;
        }
        if (this.battleEngine !== engine) {
          if (this.battleEngine && this.route === 'battle') {
            this.battleEngine.synchronizeAuthoritativeState(authoritative);
          } else if (authoritative.status === 'victory') {
            this.rememberPendingReward(permitId, playerId);
            void this.queueRewardCompletion(permitId, playerId);
          } else if (authoritative.status === 'defeat') {
            this.battlePermit = undefined;
            this.battlePermitOwnerId = undefined;
          }
          return;
        }
        engine.applyAuthoritativeAction(abilityId, authoritative);
      } else {
        engine.useAbility(abilityId);
      }
    } catch (error) {
      let synchronized = false;
      if (error instanceof GameApiError && error.status === 409 && error.payload && typeof error.payload === 'object') {
        const payload = error.payload as { battleState?: unknown; error?: unknown };
        const battleState = payload.battleState;
        if (isAuthoritativeBattleActionState(battleState, permitId)) {
          const samePermit = this.battlePermit?.permitId === permitId
            && this.battlePermitOwnerId === playerId
            && this.store.snapshot.id === playerId;
          const currentEngine = this.battleEngine;
          if (samePermit && currentEngine) {
            // Never let a stale request settle a different permit through an old
            // engine's completion callback. Sync the currently mounted engine when
            // the same permit has been remounted.
            currentEngine.synchronizeAuthoritativeState(battleState);
          } else if (battleState.status === 'victory') {
            this.rememberPendingReward(permitId, playerId);
            void this.queueRewardCompletion(permitId, playerId);
          } else if (this.battlePermit?.permitId === permitId
            && this.battlePermitOwnerId === playerId
            && battleState.status === 'defeat') {
            this.battlePermit = undefined;
            this.battlePermitOwnerId = undefined;
          }
          synchronized = true;

          if (samePermit && this.route === 'battle' && this.battlePermit?.permitId === permitId) {
            if (battleState.status === 'active') {
              const serverMessage = typeof payload.error === 'string' ? payload.error : '';
              this.setBattleActionStatus(serverMessage && serverMessage !== 'Stale battle turn.'
                ? serverMessage
                : 'Battle state refreshed from the server. Choose your next move.');
            } else {
              this.setBattleActionStatus();
            }
          }
        }
      }
      if (!synchronized) {
        if (error instanceof GameApiError && error.status < 500) {
          const payload = error.payload && typeof error.payload === 'object'
            ? error.payload as { error?: unknown }
            : undefined;
          this.setBattleActionStatus(typeof payload?.error === 'string'
            ? payload.error
            : 'The server rejected that move.');
        } else {
          this.setBattleActionStatus('Connection interrupted. The move may have reached the server. Tap the same move again to safely retry; the server prevents duplicate turns.');
        }
      }
      console.warn('Battle action rejected by authoritative server.', error);
    } finally {
      if (this.battleEngine === engine) {
        this.battleActionPending = false;
        if (engine.snapshot.status === 'active') this.setAbilityButtonsDisabled(this.store.snapshot.id !== playerId);
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

  private setBattleActionStatus(message?: string): void {
    const status = this.root.querySelector<HTMLElement>('#battle-action-status');
    if (!status) return;
    status.textContent = message ?? '';
    status.hidden = !message;
  }

  private pendingRewardKey(playerId: string): string {
    return `degen.pending.reward-permits.v1:${playerId}`;
  }

  // Persist only permit identifiers for retry. Rewards and progression stay Worker-owned.
  private pendingRewardPermits(playerId: string): string[] {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(this.pendingRewardKey(playerId)) ?? '[]');
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
    } catch {
      return [];
    }
  }

  private rememberPendingReward(permitId: string, playerId: string): void {
    try {
      const ids = this.pendingRewardPermits(playerId);
      if (!ids.includes(permitId)) localStorage.setItem(this.pendingRewardKey(playerId), JSON.stringify([...ids, permitId]));
    } catch (error) {
      console.warn('Unable to persist pending battle reward retry.', error);
    }
  }

  private forgetPendingReward(permitId: string, playerId: string): void {
    try {
      localStorage.setItem(this.pendingRewardKey(playerId), JSON.stringify(
        this.pendingRewardPermits(playerId).filter((id) => id !== permitId),
      ));
    } catch (error) {
      console.warn('Unable to clear completed battle reward retry.', error);
    }
  }

  private queueRewardCompletion(permitId: string, playerId: string): Promise<void> {
    // Serialize pending completions so an older response cannot replace a newer player snapshot.
    this.rewardResolution = this.rewardResolution.then(async () => {
      try {
        const result = await this.api.completeUnderpass(playerId, permitId);
        if (!result) throw new Error('Missing authoritative battle completion response.');
        const isCurrentPlayer = this.store.snapshot.id === playerId;
        if (isCurrentPlayer) {
          this.store.replaceFromServer(result.player);
          this.underpassEvent = result.worldEvent;
        }
        this.api.acknowledgeUnderpassCompletion(playerId, permitId);
        this.forgetPendingReward(permitId, playerId);
        if (this.battlePermit?.permitId === permitId && this.battlePermitOwnerId === playerId) {
          this.battlePermit = undefined;
          this.battlePermitOwnerId = undefined;
          if (isCurrentPlayer && this.route === 'battle') {
            this.battleReturnTimer = window.setTimeout(() => this.navigate('underpass'), 1400);
          }
        } else if (isCurrentPlayer && this.route !== 'battle') {
          this.render();
        }
      } catch (error) {
        console.warn('Server reward verification failed; retaining permit for retry.', error);
        window.setTimeout(() => void this.queueRewardCompletion(permitId, playerId), 15_000);
      }
    });
    return this.rewardResolution;
  }

  private async finishBattle(status: 'victory' | 'defeat'): Promise<void> {
    if (status === 'victory' && this.battlePermit) {
      const permitId = this.battlePermit.permitId;
      const playerId = this.battlePermitOwnerId ?? this.store.snapshot.id;
      if (this.api.enabled) {
        this.rememberPendingReward(permitId, playerId);
        await this.queueRewardCompletion(permitId, playerId);
        return;
      }

      const clearsBeforeThisFight = recordPreviewClear();
      const previewReward = underpassRewardForClear(
        clearsBeforeThisFight + 1,
        this.underpassEvent?.fullRewardLimit,
      );
      this.store.applyReward(previewReward);
      this.store.markBossDefeated(TUNNEL_MAW.id);
      this.underpassEvent = getPreviewUnderpass();
    }

    this.battlePermit = undefined;
    this.battlePermitOwnerId = undefined;
    this.battleReturnTimer = window.setTimeout(() => this.navigate('underpass'), 1400);
  }

  private async refreshWorld(rerender = false): Promise<void> {
    try {
      this.underpassEvent = this.api.enabled
        ? await this.api.getUnderpass(this.store.snapshot.id)
        : getPreviewUnderpass();
    } catch (error) {
      console.warn('World-event sync failed.', error);
      // Server-backed play must not fabricate an Underpass cycle when auth/network sync fails.
      this.underpassEvent = this.api.enabled ? undefined : getPreviewUnderpass();
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
