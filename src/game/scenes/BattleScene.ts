import Phaser from 'phaser';
import type { BattleEngine, BattleSnapshot } from '../combat/engine';

export class BattleScene extends Phaser.Scene {
  private hpText?: Phaser.GameObjects.Text;
  private enemyText?: Phaser.GameObjects.Text;
  private statusText?: Phaser.GameObjects.Text;
  private unsubscribe?: () => void;

  constructor(private readonly engine: BattleEngine) {
    super({ key: 'battle' });
  }

  create(): void {
    this.add.text(32, 28, 'DEGEN // COMBAT', {
      fontFamily: 'monospace',
      fontSize: '20px',
      color: '#f0f0f0',
    });

    this.add.rectangle(160, 210, 210, 240, 0x1b1b24, 1).setStrokeStyle(2, 0x4a4a5c);
    this.add.rectangle(560, 210, 210, 240, 0x241b1b, 1).setStrokeStyle(2, 0x5c4a4a);

    this.hpText = this.add.text(70, 120, '', {
      fontFamily: 'monospace',
      fontSize: '18px',
      color: '#f0f0f0',
    });

    this.enemyText = this.add.text(470, 120, '', {
      fontFamily: 'monospace',
      fontSize: '18px',
      color: '#f0f0f0',
    });

    this.statusText = this.add.text(360, 350, '', {
      fontFamily: 'monospace',
      fontSize: '18px',
      color: '#f0f0f0',
    }).setOrigin(0.5);

    this.unsubscribe = this.engine.subscribe((snapshot) => this.renderSnapshot(snapshot));
    this.events.once('shutdown', () => this.unsubscribe?.());
    this.events.once('destroy', () => this.unsubscribe?.());
  }

  private renderSnapshot(snapshot: BattleSnapshot): void {
    this.hpText?.setText([
      snapshot.playerName,
      `HP ${snapshot.playerHp}/${snapshot.playerMaxHp}`,
      'MANIFESTED',
    ]);

    this.enemyText?.setText([
      `${snapshot.enemyName}  Lv.${snapshot.enemyLevel}`,
      `HP ${snapshot.enemyHp}/${snapshot.enemyMaxHp}`,
      `STB ${snapshot.enemyStability}/${snapshot.enemyMaxStability}`,
    ]);

    const status = snapshot.status === 'active'
      ? snapshot.enemyBroken ? 'BREAK' : 'CHOOSE AN ACTION'
      : snapshot.status.toUpperCase();
    this.statusText?.setText(status);
  }
}
