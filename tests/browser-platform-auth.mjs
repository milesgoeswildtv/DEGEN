// Real Chromium + Vite + local Wrangler/D1 auth smoke test. Never uses --remote.
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'degen-auth-browser-'));
const persist = join(scratch, 'd1');
const wrangler = resolve(root, 'node_modules/.bin/wrangler');
const vite = resolve(root, 'node_modules/.bin/vite');
const botToken = 'degen-browser-test-bot-token';
const api = 'http://127.0.0.1:8792';
const origin = 'http://localhost:5173';
const env = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' };
const children = [];
const logs = new Map();

function command(args) {
  const result = spawnSync(wrangler, args, { cwd: root, env, encoding: 'utf8', timeout: 120000 });
  if (result.error || result.status !== 0) throw Error('wrangler ' + args.join(' ') + ': ' + (result.error ?? '') + result.stdout + result.stderr);
  return result.stdout;
}
function launch(name, exe, args, extra = {}) {
  const child = spawn(exe, args, { cwd: root, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  logs.set(name, '');
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
    logs.set(name, (logs.get(name) + data.toString()).slice(-12000));
  });
  children.push(child);
  return child;
}
async function until(label, check, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await sleep(200);
  }
  throw Error('Timeout waiting for ' + label + (last ? ': ' + last : '') + '\n' + [...logs].map(([name, text]) => name + ':\n' + text).join('\n'));
}
function chromeBinary() {
  for (const exe of [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (exe && spawnSync(exe, ['--version'], { encoding: 'utf8' }).status === 0) return exe;
  }
  throw Error('Chrome/Chromium unavailable on runner');
}
function signedInitData(user) {
  const authDate = Math.floor(Date.now() / 1000);
  const params = new URLSearchParams({ auth_date: String(authDate), user: JSON.stringify(user) });
  const check = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => key + '=' + value).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}
function cdpClient(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (!pending.has(message.id)) return;
    const [resolve, reject] = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(Error(JSON.stringify(message.error)));
    else resolve(message.result);
  });
  const send = async (method, params = {}) => {
    await opened;
    return new Promise((resolve, reject) => {
      const requestId = ++id;
      pending.set(requestId, [resolve, reject]);
      ws.send(JSON.stringify({ id: requestId, method, params }));
    });
  };
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.text);
    return result.result.value;
  };
  return { ws, send, evaluate };
}
function sql(query) {
  const output = command(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist, '--command=' + query, '--json']);
  const parsed = JSON.parse(output);
  return Array.isArray(parsed) ? parsed[0]?.results ?? [] : parsed.results ?? [];
}
async function stopAll() {
  for (const child of children.reverse()) {
    if (child.exitCode !== null) continue;
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(1500)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}
try {
  command(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist, '--file=db/schema.sql']);
  command(['d1', 'migrations', 'apply', 'DEGEN', '--local', '--persist-to=' + persist]);
  launch('worker', wrangler, ['dev', '--local', '--persist-to=' + persist, '--ip=127.0.0.1', '--port=8792', '--var', 'TELEGRAM_BOT_TOKEN:' + botToken]);
  await until('local Worker', async () => (await fetch(api + '/api/health', { signal: AbortSignal.timeout(800) })).ok);
  const unauthenticated = await fetch(api + '/api/world/underpass', { signal: AbortSignal.timeout(3000) });
  assert.equal(unauthenticated.status, 401, 'player-owned routes must reject unauthenticated requests');
  await unauthenticated.text();

  launch('vite', vite, ['--host', '0.0.0.0', '--port=5173', '--strictPort'], {
    VITE_API_BASE: api,
    VITE_DISCORD_CLIENT_ID: 'browser-test-discord-client',
  });
  await until('Vite', async () => (await fetch(origin, { signal: AbortSignal.timeout(800) })).ok);
  launch('chrome', chromeBinary(), [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--enable-unsafe-swiftshader', '--remote-allow-origins=*', '--remote-debugging-port=9222',
    '--user-data-dir=' + join(scratch, 'chrome'), 'about:blank',
  ]);
  const target = await until('Chrome page target', async () => {
    const response = await fetch('http://127.0.0.1:9222/json/list', { signal: AbortSignal.timeout(800) });
    if (!response.ok) return null;
    return (await response.json()).find(item => item.type === 'page' && item.webSocketDebuggerUrl);
  });
  const cdp = cdpClient(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: ['*telegram.org/js/telegram-web-app.js*'] });
  const initData = signedInitData({ id: 42, first_name: 'Browser', last_name: 'QA' });
  const initDataUnsafe = JSON.stringify({ id: 42, first_name: 'Browser', last_name: 'QA' });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
    if (location.search.includes('auth=1')) {
      window.Telegram = { WebApp: {
        initData: ${JSON.stringify(initData)},
        initDataUnsafe: { user: ${initDataUnsafe} },
        ready() {}, expand() {}
      }};
    }
  ` });

  await cdp.send('Page.navigate', { url: origin });
  const unauthenticatedText = await until('fail-closed browser startup', async () => {
    const text = await cdp.evaluate("document.querySelector('#app')?.innerText || ''");
    return text.includes('DEGEN sign-in failed') ? text : null;
  });
  assert.match(unauthenticatedText, /verified platform identity/i);

  await cdp.send('Page.navigate', { url: origin + '/?auth=1' });
  const appText = await until('authenticated Telegram app startup', async () => {
    const text = await cdp.evaluate("document.querySelector('#app')?.innerText || ''");
    return text.length > 0 && !text.includes('DEGEN sign-in failed') && /Home|Map|Underpass/.test(text) ? text : null;
  });
  assert.match(appText, /Home|Map|Underpass/);

  const playerId = await cdp.evaluate("JSON.parse(localStorage.getItem('degen.prototype.player.v2') || '{}').id || ''");
  const sessionToken = await cdp.evaluate("sessionStorage.getItem('degen.player.session.v1') || ''");
  assert.ok(playerId && playerId !== 'attacker', 'the app uses the Worker-resolved player ID');
  assert.match(sessionToken, /^[A-Za-z0-9_-]{43}$/);
  const sessionHash = createHash('sha256').update(sessionToken).digest('hex');
  assert.equal(sql("SELECT COUNT(*) AS n FROM platform_identities WHERE platform='telegram' AND platform_user_id='42'")[0]?.n, 1);
  assert.equal(sql("SELECT COUNT(*) AS n FROM player_sessions WHERE token_hash='" + sessionHash + "' AND player_id='" + playerId + "' AND revoked_at_ms IS NULL")[0]?.n, 1);
  assert.equal(sql("SELECT COUNT(*) AS n FROM player_sessions WHERE token_hash='" + sessionToken + "'")[0]?.n, 0,
    'only the session digest is persisted');

  console.log('PASS real Chromium + Vite + local Worker/D1: unauthenticated startup fails closed; signed Telegram bootstrap starts the app and persists only a hashed session');
} finally {
  await stopAll();
  rmSync(scratch, { recursive: true, force: true });
}
