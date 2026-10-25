// Real isolated local Worker/D1 concurrent cycle test; never touches remote D1.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const wrangler = resolve(root, 'node_modules/.bin/wrangler');
const scratch = mkdtempSync(join(tmpdir(), 'degen-cycle-d1-'));
const persist = join(scratch, 'state');
const base = 'http://127.0.0.1:8793';
const env = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' };
let server;
let logs = '';
function cli(args) {
  const r = spawnSync(wrangler, args, { cwd: root, env, encoding: 'utf8', timeout: 120000 });
  if (r.error || r.status !== 0) throw new Error('wrangler ' + args.join(' ') + ': ' + (r.error ?? '') + r.stdout + r.stderr);
}
async function world(i) {
  const r = await fetch(base + '/api/world/underpass?playerId=cycle-test-' + i, { signal: AbortSignal.timeout(8000) });
  assert.equal(r.status, 200, 'world request ' + i);
  const data = await r.json();
  assert.equal(data.eventKey, 'underpass');
  assert.equal(data.source, 'server');
  assert.ok(data.cycleId);
  return data;
}
try {
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist, '--file=db/schema.sql']);
  cli(['d1', 'migrations', 'apply', 'DEGEN', '--local', '--persist-to=' + persist]);
  server = spawn(wrangler, ['dev', '--local', '--persist-to=' + persist, '--ip=127.0.0.1', '--port=8793'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', d => { logs = (logs + d.toString()).slice(-12000); });
  let ready = false;
  for (let i = 0; i < 80; i++) {
    if (server.exitCode !== null) throw new Error('Worker exited: ' + logs);
    try { const r = await fetch(base + '/api/health', { signal: AbortSignal.timeout(600) }); if (r.ok && (await r.json()).ok) { ready = true; break; } } catch {}
    await sleep(250);
  }
  assert.ok(ready, 'Worker did not start: ' + logs);
  const a = await Promise.all(Array.from({ length: 30 }, (_, i) => world(i)));
  const id = a[0].cycleId;
  assert.ok(a.every(e => e.cycleId === id), 'competing cycle IDs from simultaneous requests');
  const b = await Promise.all(Array.from({ length: 30 }, (_, i) => world(i + 30)));
  assert.ok(b.every(e => e.cycleId === id), 'cycle changed across repeated reads');
  assert.ok(Date.parse(a[0].opensAt) < Date.parse(a[0].closesAt));
  const check = spawnSync(wrangler, ['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist,
    "--command=SELECT COUNT(*) AS n FROM world_event_cycles WHERE event_key = 'underpass'", '--json'],
    { cwd: root, env, encoding: 'utf8', timeout: 120000 });
  assert.equal(check.status, 0, 'local D1 count query failed: ' + check.stderr);
  const result = JSON.parse(check.stdout);
  const row = Array.isArray(result) ? result[0]?.results?.[0] : result.results?.[0];
  assert.equal(row?.n, 1, 'concurrent requests must persist exactly one Underpass cycle');
  console.log('PASS isolated Worker/D1: 60 requests and exactly one persisted cycle');
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(r => server.once('exit', r)), sleep(2000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  rmSync(scratch, { recursive: true, force: true });
}
