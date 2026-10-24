import assert from 'node:assert/strict';
import test from 'node:test';
import { exchangeDiscordAuthorizationCode } from '../worker/auth/discordOAuth.ts';

const env = { DISCORD_CLIENT_ID: 'client-id', DISCORD_CLIENT_SECRET: 'test-secret' };
function mockFetch(options: { tokenOk?: boolean; tokenScope?: string; appId?: string; appScopes?: string[]; userId?: string }) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.endsWith('/oauth2/token')) {
      assert.equal(init?.method, 'POST');
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get('client_id'), 'client-id');
      assert.equal(form.get('client_secret'), 'test-secret');
      assert.equal(form.get('code'), 'one-use-code');
      return Response.json(options.tokenOk === false ? { error: 'invalid_grant' } : {
        access_token: 'server-only-access-token', token_type: 'Bearer', scope: options.tokenScope ?? 'identify',
      }, { status: options.tokenOk === false ? 400 : 200 });
    }
    if (url.endsWith('/oauth2/@me')) return Response.json({
      application: { id: options.appId ?? 'client-id' }, scopes: options.appScopes ?? ['identify'],
    });
    if (url.endsWith('/users/@me')) return Response.json({
      id: options.userId ?? '123456789012345678', username: 'degen', global_name: 'Degen Player',
    });
    throw new Error('Unexpected Discord endpoint: ' + url);
  };
}

test('Discord code exchange verifies application, identify scope, and provider user', async () => {
  assert.deepEqual(await exchangeDiscordAuthorizationCode('one-use-code', env, mockFetch({})), {
    platformUserId: '123456789012345678', displayName: 'Degen Player',
  });
});

test('Discord rejects invalid codes, wrong applications, and missing identify scope', async () => {
  assert.equal(await exchangeDiscordAuthorizationCode('', env, mockFetch({})), null);
  assert.equal(await exchangeDiscordAuthorizationCode('one-use-code', env, mockFetch({ appId: 'other-app' })), null);
  assert.equal(await exchangeDiscordAuthorizationCode('one-use-code', env, mockFetch({ tokenScope: 'guilds' })), null);
  assert.equal(await exchangeDiscordAuthorizationCode('one-use-code', env, mockFetch({ appScopes: ['guilds'] })), null);
  assert.equal(await exchangeDiscordAuthorizationCode('one-use-code', env, mockFetch({ tokenOk: false })), null);
  assert.equal(await exchangeDiscordAuthorizationCode('one-use-code', {}, mockFetch({})), null);
});
