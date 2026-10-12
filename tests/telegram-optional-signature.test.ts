import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { verifyTelegramInitData as verify } from '../worker/auth/telegramInitData.ts';

function signWithSignature(signature: string): string {
  const fields = new URLSearchParams({ auth_date: '1791510000', signature, user: '{"id":42}' });
  const data = [...fields].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update('test').digest();
  fields.set('hash', createHmac('sha256', secret).update(data).digest('hex'));
  return fields.toString();
}

test('optional signature is included in first-party bot-token HMAC', async () => {
  const raw = signWithSignature('fixture-ed25519-signature');
  assert.equal((await verify(raw, 'test', 1791510000))?.platformUserId, '42');
  assert.equal(await verify(raw.replace('fixture-ed25519-signature', 'tampered-signature'), 'test', 1791510000), null);
});
