import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { verifyTelegramInitData } from '../worker/auth/telegramInitData.ts';

const BOT_TOKEN = 'degen-test-bot-token';
function signedData(user: unknown, authDate = 1_791_510_000): string {
  const params = new URLSearchParams({ auth_date: String(authDate), user: JSON.stringify(user) });
  const check = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

test('valid signed initData resolves the provider ID and bounded display name', async () => {
  const raw = signedData({ id: 42, first_name: 'Degen', last_name: 'Player' });
  assert.deepEqual(await verifyTelegramInitData(raw, BOT_TOKEN, 1_791_510_000), {
    platformUserId: '42', displayName: 'Degen Player', authDate: 1_791_510_000,
  });
});

test('tampering, duplicate fields, missing signature, and malformed user fail closed', async () => {
  const raw = signedData({ id: 42, first_name: 'Degen' });
  assert.equal(await verifyTelegramInitData(raw.replace('id%22%3A42', 'id%22%3A43'), BOT_TOKEN, 1_791_510_000), null);
  assert.equal(await verifyTelegramInitData(raw + '&auth_date=1791510000', BOT_TOKEN, 1_791_510_000), null);
  assert.equal(await verifyTelegramInitData(raw.replace(/&hash=[^&]+/, ''), BOT_TOKEN, 1_791_510_000), null);
  assert.equal(await verifyTelegramInitData(signedData({ id: '42' }), BOT_TOKEN, 1_791_510_000), null);
});

test('stale and implausibly future initData are rejected', async () => {
  const now = 1_791_510_000;
  assert.equal(await verifyTelegramInitData(signedData({ id: 42 }, now - 86401), BOT_TOKEN, now), null);
  assert.equal(await verifyTelegramInitData(signedData({ id: 42 }, now + 31), BOT_TOKEN, now), null);
});

test('malformed payloads and unsafe clocks are rejected', async () => {
  assert.equal(await verifyTelegramInitData('', BOT_TOKEN), null);
  assert.equal(await verifyTelegramInitData('x'.repeat(16385), BOT_TOKEN), null);
  assert.equal(await verifyTelegramInitData('auth_date=1&user=%7B%22id%22%3A1%7D&hash=not-a-hash', BOT_TOKEN), null);
  assert.equal(await verifyTelegramInitData(signedData({ id: 42 }), BOT_TOKEN, Number.MAX_SAFE_INTEGER + 1), null);
});
