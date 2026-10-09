// Isolated HTTP integration against a local Wrangler Worker and local D1 only.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const wrangler = resolve(root, 'node_modules/.bin/wrangler');
const scratch = mkdtempSync(join(tmpdir(), 'degen-identity-d1-'));
const persist = join(scratch, 'state');
const base = 'http://127.0.0.1:8794';
const env = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' };
let server;
let logs = '';

function cli(args) {
  const result = spawnSync(wrangler, args, { cwd: root, env, encoding: 'utf8', timeout: 120000 });
  if (result.error || result.status !== 0) {
    throw new Error('wrangler ' + args.join(' ') + ': ' + (result.error ?? '') + '\n' + result.stdout + result.stderr);
  }
  return result.stdout;
}

async function bootstrap(platform, platformUserId, playerId, displayName) {
  const response = await fetch(base + '/api/player/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform, platformUserId, playerId, displayName }),
    signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, data: await response.json() };
}

try {
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist, '--file=db/schema.sql']);
  cli(['d1', 'migrations', 'apply', 'DEGEN', '--local', '--persist-to=' + persist]);
  server = spawn(wrangler, ['dev', '--local', '--persist-to=' + persist, '--ip=127.0.0.1', '--port=8794'], {
    cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [server.stdout, server.stderr]) {
    stream.on('data', data => { logs = (logs + data.toString()).slice(-12000); });
  }
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null) throw new Error('Worker exited: ' + logs);
    try {
      const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(600) });
      if (response.ok && (await response.json()).ok) { ready = true; break; }
    } catch {}
    await sleep(250);
  }
  assert.ok(ready, 'Worker did not start: ' + logs);

  const first = await bootstrap('discord', 'uid', 'owner', 'Owner');
  assert.equal(first.status, 200);
  const stolen = await bootstrap('discord', 'uid', 'attacker', 'Impostor');
  assert.equal(stolen.status, 409, 'another player cannot claim the existing binding');
  const repeat = await bootstrap('discord', 'uid', 'owner', 'Renamed');
  assert.equal(repeat.status, 200);
  const independent = await bootstrap('telegram', 'uid', 'other-player', 'Telegram');
  assert.equal(independent.status, 200);

  const attempts = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    bootstrap('discord', 'race-user', 'racer-' + index, 'Racer ' + index)));
  assert.equal(attempts.filter(result => result.status === 200).length, 1,
    'exactly one concurrent first-binding request must win: ' + JSON.stringify(attempts));
  assert.equal(attempts.filter(result => result.status === 409).length, 7,
    'every competing bootstrap must receive a conflict');
  const winningIndex = attempts.findIndex(result => result.status === 200);
  assert.equal((await bootstrap('discord', 'race-user', 'late-attacker', 'Late')).status, 409);

  const output = cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist,
    '--command=SELECT platform, platform_user_id, player_id, display_name FROM platform_identities ORDER BY platform, platform_user_id', '--json']);
  const parsed = JSON.parse(output);
  const rows = Array.isArray(parsed) ? parsed[0]?.results : parsed.results;
  assert.ok(Array.isArray(rows), 'D1 must return identity rows');
  assert.deepEqual(rows.map(row => [row.platform, row.platform_user_id, row.player_id]), [
    ['discord', 'race-user', 'racer-' + winningIndex],
    ['discord', 'uid', 'owner'],
    ['telegram', 'uid', 'other-player'],
  ]);
  assert.equal(rows.find(row => row.platform === 'discord' && row.platform_user_id === 'uid').display_name, 'Renamed');
  console.log('PASS local Worker/D1: immutable binding, retry, namespace isolation, 8-way first-binding race');
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), sleep(2000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  rmSync(scratch, { recursive: true, force: true });
}
