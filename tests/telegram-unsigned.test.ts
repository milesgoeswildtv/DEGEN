import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyTelegramInitData } from '../worker/auth/telegramInitData.ts';

test('unsigned Telegram initData is rejected', async () => {
  const raw = new URLSearchParams({ auth_date: '1791510000', user: '{"id":42}' });
  assert.equal(await verifyTelegramInitData(raw.toString(), 'local-test-token', 1791510000), null);
});
