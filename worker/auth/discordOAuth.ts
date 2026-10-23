export type DiscordOAuthEnvironment = {
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_REDIRECT_URI?: string;
};
export type VerifiedDiscordIdentity = { platformUserId: string; displayName: string };

type TokenResponse = { access_token?: unknown; token_type?: unknown; scope?: unknown };
type OAuthMeResponse = { application?: { id?: unknown }; scopes?: unknown };
type DiscordUserResponse = { id?: unknown; username?: unknown; global_name?: unknown };

const hasIdentify = (value: unknown): boolean => typeof value === 'string'
  && value.split(/\s+/).includes('identify');
const isDiscordUserId = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{17,20}$/.test(value);

export async function exchangeDiscordAuthorizationCode(
  code: string, env: DiscordOAuthEnvironment, fetcher: typeof fetch = fetch,
): Promise<VerifiedDiscordIdentity | null> {
  const clientId = env.DISCORD_CLIENT_ID;
  const clientSecret = env.DISCORD_CLIENT_SECRET;
  if (!clientId || !clientSecret || typeof code !== 'string' || !code.trim()
    || code.length > 2048 || /[\u0000-\u001f\u007f]/.test(code)) return null;

  try {
    const form = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
    });
    if (env.DISCORD_REDIRECT_URI) form.set('redirect_uri', env.DISCORD_REDIRECT_URI);
    const tokenResponse = await fetcher('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    if (!tokenResponse.ok) return null;
    const token = await tokenResponse.json() as TokenResponse;
    if (typeof token.access_token !== 'string' || !token.access_token
      || typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer'
      || !hasIdentify(token.scope)) return null;

    const authorization = { authorization: `Bearer ${token.access_token}` };
    const metadataResponse = await fetcher('https://discord.com/api/v10/oauth2/@me', { headers: authorization });
    if (!metadataResponse.ok) return null;
    const metadata = await metadataResponse.json() as OAuthMeResponse;
    if (metadata.application?.id !== clientId
      || !Array.isArray(metadata.scopes) || !metadata.scopes.includes('identify')) return null;

    const userResponse = await fetcher('https://discord.com/api/v10/users/@me', { headers: authorization });
    if (!userResponse.ok) return null;
    const user = await userResponse.json() as DiscordUserResponse;
    if (!isDiscordUserId(user.id)) return null;
    const name = typeof user.global_name === 'string' && user.global_name.trim()
      ? user.global_name.trim()
      : typeof user.username === 'string' && user.username.trim() ? user.username.trim() : 'Player';
    return { platformUserId: user.id, displayName: name.slice(0, 32) };
  } catch {
    return null;
  }
}
