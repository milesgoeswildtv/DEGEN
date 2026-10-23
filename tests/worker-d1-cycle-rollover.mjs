// Real isolated local Worker/D1 concurrent rollover test; never connects to remote D1.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const wrangler = resolve(root, 'node_modules/.bin/wrangler');
const scratch = mkdtempSync(join(tmpdir(), 'degen-cycle-rollover-'));
const persist = join(scratch, 'state');
const base = 'http://127.0.0.1:8794';
const env = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' };
const SESSION_TOKEN = Buffer.alloc(32, 12).toString('base64url');
const SESSION_HASH = createHash('sha256').update(SESSION_TOKEN).digest('hex');
let server;
let logs = '';
function cli(args) {
  const r = spawnSync(wrangler, args, { cwd: root, env, encoding: 'utf8', timeout: 120000 });
  if (r.error || r.status !== 0) throw new Error('wrangler ' + args.join(' ') + ': ' + (r.error ?? '') + r.stdout + r.stderr);
}
function countRows(query) {
  const r = spawnSync(wrangler, ['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist,
    '--command=' + query, '--json'], { cwd: root, env, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, 'local D1 query failed: ' + r.stderr);
  const result = JSON.parse(r.stdout);
  const row = Array.isArray(result) ? result[0]?.results?.[0] : result.results?.[0];
  return row?.n;
}
async function world(i) {
  const response = await fetch(base + '/api/world/underpass?playerId=rollover-test-' + i,
    { headers: { authorization: 'Bearer ' + SESSION_TOKEN }, signal: AbortSignal.timeout(8000) });
  assert.equal(response.status, 200, 'world request ' + i);
  const snapshot = await response.json();
  assert.equal(snapshot.eventKey, 'underpass');
  assert.equal(snapshot.source, 'server');
  assert.ok(snapshot.cycleId);
  return snapshot;
}
try {
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist, '--file=db/schema.sql']);
  cli(['d1', 'migrations', 'apply', 'DEGEN', '--local', '--persist-to=' + persist]);
  const seed = join(scratch, 'expired-cycle.sql');
  writeFileSync(seed, `INSERT INTO players(id,display_name) VALUES('rollover-owner','Rollover Owner');
    INSERT INTO player_sessions(token_hash,player_id,created_at_ms,expires_at_ms,revoked_at_ms)
      VALUES('${SESSION_HASH}','rollover-owner',${Date.now()},${Date.now()+3600000},NULL);
    INSERT INTO world_event_cycles (id, event_key, opens_at, closes_at)
      VALUES ('expired-underpass-cycle', 'underpass', datetime('now', '-2 hours'), datetime('now', '-1 second'));`);
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist, '--file=' + seed]);

  server = spawn(wrangler, ['dev', '--local', '--persist-to=' + persist, '--ip=127.0.0.1', '--port=8794'],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [server.stdout, server.stderr]) {
    stream.on('data', data => { logs = (logs + data.toString()).slice(-12000); });
  }
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (server.exitCode !== null) throw new Error('Worker exited: ' + logs);
    try {
      const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(600) });
      if (response.ok && (await response.json()).ok) { ready = true; break; }
    } catch {}
    await sleep(250);
  }
  assert.ok(ready, 'Worker did not start: ' + logs);

  const responses = await Promise.all(Array.from({ length: 60 }, (_, i) => world(i)));
  const activeId = responses[0].cycleId;
  assert.notEqual(activeId, 'expired-underpass-cycle', 'expired cycle must not be reused');
  assert.ok(responses.every(snapshot => snapshot.cycleId === activeId),
    'concurrent rollover requests must converge on one new cycle');
  assert.equal(countRows("SELECT COUNT(*) AS n FROM world_event_cycles WHERE event_key = 'underpass'"), 2);
  assert.equal(countRows("SELECT COUNT(*) AS n FROM world_event_cycles WHERE event_key = 'underpass' AND julianday(closes_at) > julianday('now')"), 1);
  console.log('PASS isolated Worker/D1: 60 concurrent requests roll an expired Underpass cycle exactly once');
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), sleep(2000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  rmSync(scratch, { recursive: true, force: true });
}
