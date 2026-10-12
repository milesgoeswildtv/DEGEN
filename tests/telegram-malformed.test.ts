import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyTelegramInitData as verify } from '../worker/auth/telegramInitData.ts';
test('reject malformed Telegram login data',async()=>{
  for(const raw of ['', 'hash=x', 'auth_date=1791510000&user=%7B%22id%22%3A42%7D', 'x'.repeat(16385)]) {
    assert.equal(await verify(raw,'test',1791510000),null);
  }
  assert.equal(await verify('x','',1791510000),null);
});
