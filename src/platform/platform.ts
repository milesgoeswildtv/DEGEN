import type { PlatformIdentity, PlatformName } from '../domain/types';

export interface PlatformAdapter {
  readonly name: PlatformName;
  getIdentity(): Promise<PlatformIdentity>;
}

export class BrowserPlatformAdapter implements PlatformAdapter {
  readonly name = 'browser' as const;

  async getIdentity(): Promise<PlatformIdentity> {
    return {
      platform: 'browser',
      platformUserId: 'local-dev',
      displayName: 'Player',
    };
  }
}

// Discord and Telegram adapters will implement this same contract so the RPG core
// never needs platform-specific logic in combat, housing, progression, or world code.
export const createPlatformAdapter = (): PlatformAdapter => new BrowserPlatformAdapter();
