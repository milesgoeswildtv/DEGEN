import Phaser from 'phaser';
import type { BattleEngine } from './combat/engine';
import { BattleScene } from './scenes/BattleScene';

export const createBattleGame = (parent: HTMLElement, engine: BattleEngine): Phaser.Game =>
  new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    width: 720,
    height: 420,
    backgroundColor: '#0a0a0e',
    scene: [new BattleScene(engine)],
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH,
    },
  });
