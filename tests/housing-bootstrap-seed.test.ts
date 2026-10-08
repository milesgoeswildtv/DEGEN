import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const source = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '')
  .replace(/^export default\s*\{/m, 'const worker = {');
const { ensurePlayer, handleHousing } = runInNewContext(
  stripTypeScriptTypes(source, { mode: 'transform' }) + '\n({ ensurePlayer, handleHousing });',
  { crypto, console, Request, Response, URL, Uint32Array },
) as {
  ensurePlayer: (db: unknown, playerId: string, displayName: string) => Promise<void>;
  handleHousing: (request: Request, env: unknown) => Promise<Response>;
};

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  const migrations = new URL('../db/migrations/', import.meta.url);
  for (const filename of readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(filename, migrations), 'utf8'));
  }
  const adapter = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          const statement = db.prepare(sql);
          return {
            run: () => statement.run(...params),
            first: () => statement.get(...params),
            all: () => ({ results: statement.all(...params) }),
          };
        },
      };
    },
    async batch(statements: Array<{ run(): unknown }>) {
      db.exec('BEGIN');
      try {
        for (const statement of statements) statement.run();
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return { db, adapter };
}

test('new player receives starter furniture once, without reseeding on bootstrap', async () => {
  const { db, adapter } = makeDb();
  await ensurePlayer(adapter, 'new-player', 'New Player');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM housing_placements').get()!.n, 1);
  await ensurePlayer(adapter, 'new-player', 'Renamed');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM housing_placements').get()!.n, 1);
  assert.equal(db.prepare('SELECT display_name FROM players').get()!.display_name, 'Renamed');
  db.close();
});

test('intentionally cleared home remains empty after bootstrap', async () => {
  const { db, adapter } = makeDb();
  await ensurePlayer(adapter, 'player-a', 'A');
  db.prepare('DELETE FROM housing_placements WHERE player_id = ?').run('player-a');
  await ensurePlayer(adapter, 'player-a', 'A');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM housing_placements').get()!.n, 0);
  db.close();
});

test('existing character with zero placements does not acquire furniture', async () => {
  const { db, adapter } = makeDb();
  db.prepare('INSERT INTO players(id,display_name) VALUES(?,?)').run('player-b', 'B');
  db.prepare("INSERT INTO characters(player_id,level,xp,currency,degen_key) VALUES(?,1,0,0,'test-degen')").run('player-b');
  await ensurePlayer(adapter, 'player-b', 'B');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM housing_placements').get()!.n, 0);
  db.close();
});

test('moved starter bed stays in its saved position', async () => {
  const { db, adapter } = makeDb();
  await ensurePlayer(adapter, 'mover', 'Mover');
  db.prepare('UPDATE housing_placements SET grid_x = 6, grid_y = 5 WHERE player_id = ?').run('mover');
  await ensurePlayer(adapter, 'mover', 'Mover');
  const placements = db.prepare('SELECT grid_x, grid_y FROM housing_placements').all();
  assert.equal(placements.length, 1);
  assert.equal(placements[0]!.grid_x, 6);
  assert.equal(placements[0]!.grid_y, 5);
  db.close();
});

test('one player clearing furniture does not affect another player', async () => {
  const { db, adapter } = makeDb();
  await ensurePlayer(adapter, 'first', 'First');
  await ensurePlayer(adapter, 'second', 'Second');
  db.prepare('DELETE FROM housing_placements WHERE player_id = ?').run('first');
  await ensurePlayer(adapter, 'first', 'First');
  await ensurePlayer(adapter, 'second', 'Second');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM housing_placements WHERE player_id = ?').get('first')!.n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM housing_placements WHERE player_id = ?').get('second')!.n, 1);
  db.close();
});

test('Worker PUT clearing the room survives subsequent bootstrap', async () => {
  const { db, adapter } = makeDb();
  await ensurePlayer(adapter, 'player-housing', 'Housing');
  const request = new Request('https://degen-api.example/api/player/housing', {
    method: 'PUT',
    body: JSON.stringify({ playerId: 'player-housing', housing: { inventory: [], placements: [] } }),
  });
  const response = await handleHousing(request, { DB: adapter });
  assert.equal(response.status, 204);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM housing_placements').get()!.n, 0);
  await ensurePlayer(adapter, 'player-housing', 'Housing');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM housing_placements').get()!.n, 0);
  db.close();
});
