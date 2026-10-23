// Isolated HTTP integration against a local Wrangler Worker and local D1 only.
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const wrangler = resolve(root, 'node_modules/.bin/wrangler');
const scratch = mkdtempSync(join(tmpdir(), 'degen-auth-d1-'));
const persist = join(scratch, 'state');
const base = 'http://127.0.0.1:8794';
const BOT_TOKEN = 'degen-test-bot-token';
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
function sql(query) {
  const output = cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist, '--command=' + query, '--json']);
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed[0]?.results ?? [] : parsed.results ?? [];
}
function signedInitData(user, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({ auth_date: String(authDate), user: JSON.stringify(user) });
  const check = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => key + '=' + value).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}
async function request(path, init = {}) {
  return fetch(base + path, { ...init, signal: AbortSignal.timeout(15000) });
}
async function bootstrap(initData, claimedPlayerId = 'attacker') {
  const response = await request('/api/player/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      platform: 'telegram',
      telegramInitData: initData,
      playerId: claimedPlayerId,
      platformUserId: 'forged-provider-id',
      displayName: 'Forged Display Name',
    }),
  });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : undefined; } catch { data = raw; }
  return { status: response.status, data, cacheControl: response.headers.get('cache-control') };
}
async function startWorker(includeBotToken = true) {
  logs = '';
  const args = [
    'dev', '--local', '--persist-to=' + persist, '--ip=127.0.0.1', '--port=8794',
  ];
  if (includeBotToken) args.push('--var', 'TELEGRAM_BOT_TOKEN:' + BOT_TOKEN);
  server = spawn(wrangler, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [server.stdout, server.stderr]) {
    stream.on('data', data => { logs = (logs + data.toString()).slice(-12000); });
  }
  for (let attempt = 0; attempt < 80; attempt++) {
    if (server.exitCode !== null) throw new Error('Worker exited: ' + logs);
    try {
      const response = await fetch(base + '/api/health', { signal: AbortSignal.timeout(600) });
      if (response.ok && (await response.json()).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error('Worker did not start: ' + logs);
}
async function stopWorker() {
  if (!server || server.exitCode !== null) return;
  const child = server;
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(2000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
  server = undefined;
}

try {
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist, '--file=db/schema.sql']);
  cli(['d1', 'migrations', 'apply', 'DEGEN', '--local', '--persist-to=' + persist]);
  const seed = join(scratch, 'seed.sql');
  writeFileSync(seed, `
    INSERT INTO players(id,display_name) VALUES('attacker','Existing Account');
    INSERT INTO characters(player_id,level,xp,currency,degen_key)
      VALUES('attacker',7,9,123,'test-degen');
    INSERT INTO player_inventory(id,player_id,item_key,item_type,quantity)
      VALUES('attacker:starter-bed','attacker','starter-bed','furniture',1);
    INSERT INTO housing_placements(id,player_id,furniture_key,grid_x,grid_y,rotation)
      VALUES('attacker:bed','attacker','starter-bed',1,1,0);
    INSERT INTO players(id,display_name) VALUES('empty-room','Empty Room Owner');
    INSERT INTO characters(player_id,level,xp,currency,degen_key)
      VALUES('empty-room',3,25,40,'test-degen');
    -- This row represents a binding established by the authenticated flow.
    INSERT INTO platform_identities(platform,platform_user_id,player_id,display_name,verified_at)
      VALUES('telegram','77','empty-room','Empty Room Owner',CURRENT_TIMESTAMP);
    -- Pre-auth builds accepted caller-supplied provider IDs; this row must remain untrusted.
    INSERT INTO platform_identities(platform,platform_user_id,player_id,display_name)
      VALUES('telegram','88','attacker','Legacy Unverified Owner');
  `);
  cli(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist, '--file=' + seed]);

  // Missing production credentials must fail closed without creating an account.
  await startWorker(false);
  const unconfigured = await bootstrap(signedInitData({ id: 41, first_name: 'Unconfigured' }));
  assert.equal(unconfigured.status, 503, 'Telegram bootstrap must fail closed when the bot token is not configured');
  assert.equal(sql("SELECT COUNT(*) AS n FROM platform_identities WHERE platform='telegram' AND platform_user_id='41'")[0].n, 0,
    'missing credentials must not create a platform identity');
  const unconfiguredDiscord = await request('/api/auth/discord/challenge', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(unconfiguredDiscord.status, 503, 'Discord challenge must fail closed when OAuth credentials are missing');
  await unconfiguredDiscord.text();
  assert.equal(sql('SELECT COUNT(*) AS n FROM auth_nonces')[0].n, 0,
    'missing Discord credentials must not allocate auth nonces');
  await stopWorker();

  await startWorker();
  const productionOrigin = 'https://degen-8ze.pages.dev';
  const productionPreflight = await request('/api/battle/start', {
    method: 'OPTIONS',
    headers: {
      origin: productionOrigin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,authorization',
    },
  });
  assert.equal(productionPreflight.status, 204);
  assert.equal(productionPreflight.headers.get('access-control-allow-origin'), productionOrigin,
    'the exact production Pages origin must be allowed to call the Worker');
  assert.match(productionPreflight.headers.get('access-control-allow-headers') ?? '', /authorization/i,
    'browser preflight must allow the bearer Authorization header');
  assert.match(productionPreflight.headers.get('access-control-allow-methods') ?? '', /POST/i);

  const previewOrigin = 'https://untrusted-preview.degen-8ze.pages.dev';
  const previewPreflight = await request('/api/battle/start', {
    method: 'OPTIONS',
    headers: {
      origin: previewOrigin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,authorization',
    },
  });
  assert.notEqual(previewPreflight.headers.get('access-control-allow-origin'), previewOrigin,
    'unlisted Pages preview origins must remain disallowed');

  const noProof = await request('/api/player/bootstrap', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'telegram', playerId: 'missing-proof', platformUserId: '42' }),
  });
  assert.equal(noProof.status, 401, 'unsigned provider identifiers must not authenticate');
  await noProof.text();

  const validHash = signedInitData({ id: 42, first_name: 'Verified' });
  const forgedHash = validHash.replace(/hash=([a-f0-9])/, (_match, first) => 'hash=' + (first === '0' ? '1' : '0'));
  assert.equal((await bootstrap(forgedHash)).status, 401, 'tampered Telegram initData must reject');

  const first = await bootstrap(signedInitData({ id: 42, first_name: 'Verified', last_name: 'Player' }));
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.cacheControl, 'no-store', 'verified bootstrap responses must not be cached');
  assert.ok(first.data.player.id && first.data.player.id !== 'attacker',
    'client-supplied playerId cannot select an existing account');
  assert.equal(first.data.player.displayName, 'Verified Player', 'display name comes from verified provider data');
  assert.equal(sql("SELECT COUNT(*) AS n FROM housing_placements WHERE player_id='" + first.data.player.id + "'")[0].n, 1,
    'new characters receive the starter bed during bootstrap');
  assert.match(first.data.session.token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(first.data.session.expiresAtMs > Date.now());

  const emptyRoomLogin = await bootstrap(signedInitData({ id: 77, first_name: 'Empty Room Owner' }), 'attacker');
  assert.equal(emptyRoomLogin.status, 200, JSON.stringify(emptyRoomLogin.data));
  assert.equal(emptyRoomLogin.data.player.id, 'empty-room', 'verified identity resolves its existing account');
  assert.equal(sql("SELECT COUNT(*) AS n FROM housing_placements WHERE player_id='empty-room'")[0].n, 0,
    'sign-in must not reseed a deliberately empty saved room');

  const legacySessionsBefore = sql('SELECT COUNT(*) AS n FROM player_sessions')[0].n;
  const legacyPlayersBefore = sql('SELECT COUNT(*) AS n FROM players')[0].n;
  const legacyClaim = await bootstrap(signedInitData({ id: 88, first_name: 'Verified Claimant' }), 'attacker');
  assert.equal(legacyClaim.status, 409, 'verified proof must not trust a pre-auth caller-supplied identity row');
  assert.match(legacyClaim.data.error, /legacy platform identity needs account recovery/i);
  const legacyBinding = sql("SELECT player_id, verified_at FROM platform_identities WHERE platform='telegram' AND platform_user_id='88'")[0];
  assert.equal(legacyBinding.player_id, 'attacker');
  assert.equal(legacyBinding.verified_at, null, 'legacy row is preserved but remains unverified');
  assert.equal(sql('SELECT COUNT(*) AS n FROM player_sessions')[0].n, legacySessionsBefore,
    'legacy collision must not issue a session');
  assert.equal(sql('SELECT COUNT(*) AS n FROM players')[0].n, legacyPlayersBefore,
    'legacy collision must not create an orphan account');

  const attackerAfter = sql("SELECT p.display_name, c.level, c.xp, c.currency FROM players p JOIN characters c ON c.player_id=p.id WHERE p.id='attacker'");
  assert.deepEqual({ ...attackerAfter[0] }, { display_name: 'Existing Account', level: 7, xp: 9, currency: 123 },
    'forged bootstrap fields cannot mutate another account');

  const repeated = await bootstrap(signedInitData({ id: 42, first_name: 'Verified', last_name: 'Player' }), 'some-other-id');
  assert.equal(repeated.status, 200, JSON.stringify(repeated.data));
  assert.equal(repeated.data.player.id, first.data.player.id, 'rebootstrap resolves the existing verified provider binding');

  const token = first.data.session.token;
  const noSession = await request('/api/world/underpass?playerId=' + encodeURIComponent(first.data.player.id));
  assert.equal(noSession.status, 401, 'caller-supplied query identity cannot access player-owned routes');
  await noSession.text();

  const noAuthHousing = await request('/api/player/housing', {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: first.data.player.id, housing: { placements: [] } }),
  });
  assert.equal(noAuthHousing.status, 401);
  await noAuthHousing.text();

  const spoofedHousing = await request('/api/player/housing', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ playerId: 'attacker', housing: { placements: [] } }),
  });
  assert.equal(spoofedHousing.status, 204, 'valid session owns housing regardless of body playerId');
  assert.equal(sql("SELECT COUNT(*) AS n FROM housing_placements WHERE player_id='attacker'")[0].n, 1,
    'body playerId cannot delete another player housing');
  assert.equal(sql("SELECT COUNT(*) AS n FROM housing_placements WHERE player_id='" + first.data.player.id + "'")[0].n, 0,
    'session owner housing is updated');

  for (const [path, body] of [
    ['/api/battle/start', { playerId: first.data.player.id, eventKey: 'underpass', cycleId: 'x', encounterKey: 'tunnel-maw' }],
    ['/api/battle/action', { playerId: first.data.player.id, permitId: 'x', abilityId: 'slash' }],
    ['/api/battle/complete', { playerId: first.data.player.id, permitId: 'x' }],
  ]) {
    const response = await request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 401, path + ' must reject without a session');
    await response.text();
  }

  const ownerWorld = await request('/api/world/underpass?playerId=attacker', {
    headers: { authorization: 'Bearer ' + repeated.data.session.token },
  });
  assert.equal(ownerWorld.status, 200, 'authenticated world lookup uses the session owner, not the query');
  assert.equal(ownerWorld.headers.get('cache-control'), 'no-store', 'player-specific world responses must not be cached');
  assert.equal((await ownerWorld.json()).source, 'server');

  const expiredToken = Buffer.alloc(32, 4).toString('base64url');
  const expiredHash = createHash('sha256').update(expiredToken).digest('hex');
  sql(`INSERT INTO player_sessions(token_hash,player_id,created_at_ms,expires_at_ms,revoked_at_ms)
    VALUES('${expiredHash}','${first.data.player.id}',${Date.now()-60000},${Date.now()-1},NULL)`);
  const expired = await request('/api/world/underpass', { headers: { authorization: 'Bearer ' + expiredToken } });
  assert.equal(expired.status, 401, 'expired bearer sessions must fail closed');
  await expired.text();

  const races = await Promise.all(Array.from({ length: 8 }, () =>
    bootstrap(signedInitData({ id: 99, first_name: 'Race User' }), 'attacker')));
  assert.ok(races.every(result => result.status === 200),
    'concurrent bootstrap retries for one verified identity converge: ' + JSON.stringify(races));
  assert.equal(new Set(races.map(result => result.data.player.id)).size, 1,
    'concurrent bootstrap creates exactly one player identity');
  const racePlayerId = races[0].data.player.id;
  assert.equal(sql("SELECT COUNT(*) AS n FROM housing_placements WHERE player_id='" + racePlayerId + "'")[0].n, 1,
    'concurrent first bootstrap creates exactly one starter placement');
  assert.equal(sql("SELECT COUNT(*) AS n FROM platform_identities WHERE platform='telegram' AND platform_user_id='99'")[0].n, 1);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM players WHERE id NOT IN ('attacker','empty-room','${first.data.player.id}')`)[0].n, 1,
    'the race creates one account, not orphan accounts');

  const logout = await request('/api/auth/logout', {
    method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: 'attacker' }),
  });
  assert.equal(logout.status, 204);
  const afterLogout = await request('/api/world/underpass', { headers: { authorization: 'Bearer ' + token } });
  assert.equal(afterLogout.status, 401, 'logout revokes the server-side session');
  await afterLogout.text();

  console.log('PASS local Worker/D1: signed Telegram bootstrap, immutable provider binding, opaque sessions, per-route ownership, expiry, logout, concurrent first bind');
} finally {
  await stopWorker();
  rmSync(scratch, { recursive: true, force: true });
}
