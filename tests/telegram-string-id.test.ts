import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyTelegramInitData as verify } from '../worker/auth/telegramInitData.ts';
const raw='auth_date=1791510000&user=%7B%22id%22%3A%2242%22%7D&hash=1bc4e5a47edc178ee97d91e2f916be83847c9db348f5e7733e593d5eb005107a';
test('signed string ID cannot become player identity',async()=>{
  assert.equal(await verify(raw,'test',1791510000),null);
});
