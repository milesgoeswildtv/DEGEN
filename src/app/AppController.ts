import type Phaser from 'phaser';
import { TEST_DEGEN, TUNNEL_MAW } from '../data/testDegen';
import type { BattlePermit, RouteKey, WorldEventSnapshot } from '../domain/types';
import { createBattleGame } from '../game/createBattleGame';
import { BattleEngine } from '../game/combat/engine';
import { underpassRewardForClear } from '../game/progression';
import { battleView, homeView, mapView, underpassView, updateBattleDom } from '../ui/views';
import { GameApi } from './api';
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
  private battleActionPending = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly store: PlayerStore,
    private readonly api: GameApi,
  ) {}

  async start(): Promise<void> {
    await this.refreshWorld();
    this.render();
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
      this.battlePermit = this.api.enabled
        ? await this.api.startUnderpass(this.store.snapshot.id, event.cycleId)
        : createPreviewPermit(event.cycleId);

      if (!this.battlePermit) throw new Error('No battle permit returned.');
      this.navigate('battle');
    } catch (error) {
      console.warn('Underpass entry rejected.', error);
      await this.refreshWorld();
      this.render();
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

    this.battleActionPending = true;
    this.setAbilityButtonsDisabled(true);

    try {
      if (this.api.enabled) {
        const authoritative = await this.api.actUnderpass(this.store.snapshot.id, permitId, abilityId);
        if (this.battleEngine !== engine || this.battlePermit?.permitId !== permitId) return;
        if (!authoritative || authoritative.permitId !== permitId) {
          throw new Error('Missing or mismatched authoritative battle action response.');
        }
        engine.applyAuthoritativeAction(abilityId, authoritative);
      } else {
        engine.useAbility(abilityId);
      }
    } catch (error) {
      console.warn('Battle action rejected by authoritative server.', error);
    } finally {
      if (this.battleEngine === engine) {
        this.battleActionPending = false;
        if (engine.snapshot.status === 'active') this.setAbilityButtonsDisabled(false);
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

  private async finishBattle(status: 'victory' | 'defeat'): Promise<void> {
    if (status === 'victory' && this.battlePermit) {
      if (this.api.enabled) {
        try {
          const result = await this.api.completeUnderpass(this.store.snapshot.id, this.battlePermit.permitId);
          if (result) {
            this.store.replaceFromServer(result.player);
            this.underpassEvent = result.worldEvent;
          }
        } catch (error) {
          console.warn('Server reward verification failed.', error);
        }
      } else {
        const clearsBeforeThisFight = recordPreviewClear();
        const previewReward = underpassRewardForClear(
          clearsBeforeThisFight + 1,
          this.underpassEvent?.fullRewardLimit,
        );
        this.store.applyReward(previewReward);
        this.store.markBossDefeated(TUNNEL_MAW.id);
        this.underpassEvent = getPreviewUnderpass();
      }
    }

    this.battlePermit = undefined;
    this.battleReturnTimer = window.setTimeout(() => this.navigate('underpass'), 1400);
  }

  private async refreshWorld(rerender = false): Promise<void> {
    try {
      this.underpassEvent = this.api.enabled
        ? await this.api.getUnderpass(this.store.snapshot.id)
        : getPreviewUnderpass();
    } catch (error) {
      console.warn('World-event sync failed; using local preview clock.', error);
      this.underpassEvent = getPreviewUnderpass();
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
