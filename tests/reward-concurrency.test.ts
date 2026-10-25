import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { advanceLevel, underpassRewardForClear } from '../src/game/progression.ts';

// SQLite model of the Worker D1 atomic batch, not an endpoint/D1 runtime test.
const migration = readFileSync(new URL('../db/migrations/0005_reward_claim_character_guard.sql', import.meta.url), 'utf8');
const setup = () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE characters(player_id TEXT PRIMARY KEY,level INTEGER,xp INTEGER,
    currency INTEGER,updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE battle_permits(id TEXT PRIMARY KEY,player_id TEXT,reward_state TEXT,
    reward_claim_token TEXT,reward_xp INTEGER,reward_currency INTEGER);
    CREATE TABLE battle_history(id TEXT PRIMARY KEY,player_id TEXT,xp_awarded INTEGER);
    CREATE TABLE player_inventory(id TEXT PRIMARY KEY,quantity INTEGER);
    INSERT INTO characters(player_id,level,xp,currency) VALUES('p',1,0,0);
    INSERT INTO battle_permits(id,player_id,reward_state,reward_claim_token)
    VALUES('A','p','claiming','token-A'),('B','p','claiming','token-B');`);
  db.exec(migration);
  return db;
};
const read = (db: DatabaseSync) => db.prepare(`SELECT level,xp,currency,last_reward_claim_token FROM characters WHERE player_id='p'`).get()!;
const grant = (db: DatabaseSync, permit: string, token: string, observed: {level:number;xp:number}) => {
  const reward = underpassRewardForClear(1);
  const next = advanceLevel(observed.level,observed.xp,reward.xp);
  const owns = `EXISTS(SELECT 1 FROM battle_permits WHERE id=? AND player_id='p'
    AND reward_state='claiming' AND reward_claim_token=?)`;
  const applied = `EXISTS(SELECT 1 FROM characters WHERE player_id='p'
    AND last_reward_claim_token=?)`;
  db.exec('BEGIN');
  try {
    const updated = db.prepare(`UPDATE characters SET level=?,xp=?,currency=currency+?,
      last_reward_claim_token=? WHERE player_id='p' AND level=? AND xp=? AND ${owns}`)
      .run(next.level,next.xp,reward.currency,token,observed.level,observed.xp,permit,token).changes;
    db.prepare(`INSERT INTO battle_history(id,player_id,xp_awarded)
      SELECT ?,'p',? WHERE ${owns} AND ${applied}`)
      .run(`${permit}:victory`,reward.xp,permit,token,token);
    db.prepare(`INSERT INTO player_inventory(id,quantity)
      SELECT 'scrap',1 WHERE ${owns} AND ${applied}
      ON CONFLICT(id) DO UPDATE SET quantity=quantity+1`)
      .run(permit,token,token);
    const awarded = db.prepare(`UPDATE battle_permits SET reward_state='awarded',
      reward_xp=?,reward_currency=? WHERE id=? AND reward_state='claiming'
      AND reward_claim_token=? AND ${applied}`)
      .run(reward.xp,reward.currency,permit,token,token).changes;
    db.exec('COMMIT');
    return {updated,awarded};
  } catch (e) { db.exec('ROLLBACK'); throw e; }
};

test('distinct permit snapshots cannot lose XP, duplicate inventory, or double-award', () => {
  const db=setup();
  const staleA=read(db),staleB=read(db);
  assert.deepEqual(grant(db,'A','token-A',staleA as {level:number;xp:number}),{updated:1,awarded:1});
  assert.deepEqual(grant(db,'B','token-B',staleB as {level:number;xp:number}),{updated:0,awarded:0});
  assert.deepEqual(grant(db,'B','token-B',read(db) as {level:number;xp:number}),{updated:1,awarded:1});
  const final=read(db);
  assert.deepEqual({level:final.level,xp:final.xp,currency:final.currency},{level:2,xp:50,currency:60});
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM battle_history`).get()!.n,2);
  assert.equal(db.prepare(`SELECT quantity FROM player_inventory`).get()!.quantity,2);
  assert.deepEqual(grant(db,'A','token-A',read(db) as {level:number;xp:number}),{updated:0,awarded:0});
});

test('revoked token cannot change progression or receipts', () => {
  const db=setup();
  db.exec(`UPDATE battle_permits SET reward_claim_token='revoked' WHERE id='A'`);
  const before=read(db);
  assert.deepEqual(grant(db,'A','token-A',before as {level:number;xp:number}),{updated:0,awarded:0});
  assert.deepEqual(read(db),before);
});

test('pre-existing deterministic victory marker fails closed and rolls back', () => {
  const db=setup();
  db.exec(`INSERT INTO battle_history VALUES('A:victory','p',75)`);
  const before=read(db);
  assert.throws(()=>grant(db,'A','token-A',before as {level:number;xp:number}),/UNIQUE constraint failed/);
  assert.deepEqual(read(db),before);
  assert.equal(db.prepare(`SELECT reward_state FROM battle_permits WHERE id='A'`).get()!.reward_state,'claiming');
});
