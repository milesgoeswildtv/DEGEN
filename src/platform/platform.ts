import type { PlatformIdentity, PlatformName } from '../domain/types';

export interface PlatformAdapter {
  readonly name: PlatformName;
  getIdentity(): Promise<PlatformIdentity>;
}
export interface DiscordChallengeProvider {
  readonly enabled: boolean;
  createDiscordChallenge(): Promise<string>;
}

type TelegramWebApp = {
  initData: string;
  initDataUnsafe?: { user?: { id?: number; first_name?: string; last_name?: string; username?: string } };
  ready?: () => void;
  expand?: () => void;
};
declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export class BrowserPlatformAdapter implements PlatformAdapter {
  readonly name = 'browser' as const;
  async getIdentity(): Promise<PlatformIdentity> {
    return { platform: 'browser', platformUserId: 'local-dev', displayName: 'Player' };
  }
}

class TelegramPlatformAdapter implements PlatformAdapter {
  readonly name = 'telegram' as const;
  constructor(private readonly webApp: TelegramWebApp) {}
  async getIdentity(): Promise<PlatformIdentity> {
    const telegramInitData = this.webApp.initData;
    if (typeof telegramInitData !== 'string' || telegramInitData.length === 0) {
      throw new Error('Telegram did not provide signed Mini App initData.');
    }
    this.webApp.ready?.();
    this.webApp.expand?.();
    const user = this.webApp.initDataUnsafe?.user;
    const name = [user?.first_name, user?.last_name].filter((value): value is string => typeof value === 'string')
      .join(' ').trim() || user?.username || 'Player';
    return {
      platform: 'telegram',
      // This client hint is never used to select an account on the Worker.
      platformUserId: typeof user?.id === 'number' ? String(user.id) : '',
      displayName: name.slice(0, 32),
      telegramInitData,
    };
  }
}

class DiscordPlatformAdapter implements PlatformAdapter {
  readonly name = 'discord' as const;
  constructor(private readonly api: DiscordChallengeProvider) {}
  async getIdentity(): Promise<PlatformIdentity> {
    const clientId = import.meta.env.VITE_DISCORD_CLIENT_ID;
    if (!clientId) throw new Error('VITE_DISCORD_CLIENT_ID must be configured for Discord Activity authentication.');
    const { DiscordSDK } = await import('@discord/embedded-app-sdk');
    const sdk = new DiscordSDK(clientId);
    await sdk.ready();
    const state = await this.api.createDiscordChallenge();
    const authorization = await sdk.commands.authorize({
      client_id: clientId,
      response_type: 'code',
      state,
      prompt: 'none',
      scope: ['identify'],
    });
    if (typeof authorization.code !== 'string' || !authorization.code) {
      throw new Error('Discord did not return an authorization code.');
    }
    return {
      platform: 'discord',
      displayName: 'Player',
      discordAuthorizationCode: authorization.code,
      discordState: state,
    };
  }
}

export const createPlatformAdapter = (api: DiscordChallengeProvider): PlatformAdapter => {
  if (!api.enabled) return new BrowserPlatformAdapter();
  const telegram = window.Telegram?.WebApp;
  if (telegram && typeof telegram.initData === 'string' && telegram.initData.length > 0) {
    return new TelegramPlatformAdapter(telegram);
  }
  const query = new URLSearchParams(window.location.search);
  if (query.has('frame_id')) return new DiscordPlatformAdapter(api);
  // A server-backed build is not allowed to fall back to a caller-chosen browser identity.
  return new BrowserPlatformAdapter();
};
