import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyTelegramInitData as verify } from '../worker/auth/telegramInitData.ts';
// Independently signed first-party HMAC includes signature=x.
const raw='auth_date=1791510000&signature=x&user=%7B%22id%22%3A42%7D&hash=aeb590c10d97fefdd2ac128d13199faf942bed89f36692fa98202c72a86d0bad';
test('duplicate optional signature is rejected with a valid signed base',async()=>{
  assert.equal((await verify(raw,'test',1791510000))?.platformUserId,'42');
  assert.equal(await verify(raw+'&signature=z','test',1791510000),null);
});
