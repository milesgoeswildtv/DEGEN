import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyTelegramInitData as verify } from '../worker/auth/telegramInitData.ts';
const raw='auth_date=1791510000&user=%7B%22id%22%3A9007199254740992%7D&hash=7968f1856fbdc209e5c739b58170e06b2ebceeb1434ab83296ac80467dc0dada';
test('signed unsafe numeric ID cannot become player identity',async()=>{
  assert.equal(await verify(raw,'test',1791510000),null);
});
