import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyTelegramInitData as verify } from '../worker/auth/telegramInitData.ts';
const raw='auth_date=1791510000&signature=x&user=%7B%22id%22%3A42%7D&hash=1a9ea3e1d8d30d863ca20f7ff8d0516660a8c4e5e1f03c0150fe14da35b3cd92';
test('duplicate optional signature is rejected',async()=>{
  assert.equal(await verify(raw+'&signature=z','test',1791510000),null);
});
