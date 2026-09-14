import type Phaser from 'phaser';
import { TEST_DEGEN, TUNNEL_MAW } from '../data/testDegen';
import type { RouteKey } from '../domain/types';
import { createBattleGame } from '../game/createBattleGame';
import { BattleEngine } from '../game/combat/engine';
import { PlayerStore } from './state';
import { battleView, homeView, mapView, underpassView, updateBattleDom } from '../ui/views';

export class AppController {
  private route: RouteKey = 'map';
  private selectedFurniture?: string;
  private battleGame?: Phaser.Game;
  private battleEngine?: BattleEngine;
  private battleReturnTimer?: number;

  constructor(
    private readonly root: HTMLElement,
    private readonly store: PlayerStore,
  ) {}

  start(): void {
    this.render();
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
        this.root.innerHTML = underpassView(player);
        break;
      case 'battle':
        this.root.innerHTML = battleView(player, TEST_DEGEN);
        break;
      case 'map':
      default:
        this.root.innerHTML = mapView(player);
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

        if (this.selectedFurniture) {
          this.store.placeFurniture(this.selectedFurniture, x, y);
        } else {
          this.store.removeFurnitureAt(x, y);
        }
        this.render();
      });
    });
  }

  private bindUnderpass(): void {
    this.root.querySelector<HTMLButtonElement>('[data-start-battle]')?.addEventListener('click', () => {
      this.navigate('battle');
    });
  }

  private mountBattle(): void {
    const parent = this.root.querySelector<HTMLElement>('#phaser-battle');
    if (!parent) return;

    this.battleEngine = new BattleEngine(TEST_DEGEN, TUNNEL_MAW, (status, reward) => {
      if (status === 'victory' && reward) {
        this.store.applyReward(reward);
        this.store.markBossDefeated(TUNNEL_MAW.id);
      }

      this.battleReturnTimer = window.setTimeout(() => this.navigate('underpass'), 1400);
    });

    this.battleEngine.subscribe(updateBattleDom);
    this.battleGame = createBattleGame(parent, this.battleEngine);

    this.root.querySelectorAll<HTMLButtonElement>('[data-ability]').forEach((button) => {
      button.addEventListener('click', () => {
        const ability = button.dataset.ability;
        if (ability) this.battleEngine?.useAbility(ability);
      });
    });
  }

  private destroyBattle(): void {
    if (this.battleReturnTimer !== undefined) {
      window.clearTimeout(this.battleReturnTimer);
      this.battleReturnTimer = undefined;
    }
    this.battleGame?.destroy(true);
    this.battleGame = undefined;
    this.battleEngine = undefined;
  }
}
