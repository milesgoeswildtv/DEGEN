// Isolated Chromium + Vite + local Wrangler/D1 vertical slice. NEVER use --remote.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'degen-browser-'));
const persist = join(scratch, 'd1');
const wrangler = resolve(root, 'node_modules/.bin/wrangler');
const vite = resolve(root, 'node_modules/.bin/vite');
const env = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' };
const children = [], logs = new Map();
let socket;
function command(args) {
  const r = spawnSync(wrangler, args, { cwd: root, env, encoding: 'utf8', timeout: 120000 });
  if (r.error || r.status !== 0) throw Error('wrangler ' + args.join(' ') + ': ' + (r.error ?? '') + r.stdout + r.stderr);
}
function launch(name, exe, args, extra = {}) {
  const child = spawn(exe, args, { cwd: root, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  logs.set(name, '');
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => {
    logs.set(name, (logs.get(name) + data.toString()).slice(-12000));
  });
  children.push(child);
}
async function until(label, check, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try { const result = await check(); if (result) return result; } catch (error) { last = error; }
    await sleep(200);
  }
  throw Error('Timeout waiting for ' + label + (last ? ': ' + last : ''));
}
function chromeBinary() {
  for (const exe of [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (exe && spawnSync(exe, ['--version'], { encoding: 'utf8' }).status === 0) return exe;
  }
  throw Error('Chrome/Chromium unavailable on runner');
}
function cdpClient(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let id = 0;
  const opened = new Promise((ok, bad) => {
    ws.addEventListener('open', ok, { once: true });
    ws.addEventListener('error', bad, { once: true });
  });
  ws.addEventListener('message', event => {
    const msg = JSON.parse(String(event.data));
    if (!pending.has(msg.id)) return;
    const [ok, bad] = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) bad(Error(JSON.stringify(msg.error)));
    else ok(msg.result);
  });
  const send = async (method, params = {}) => {
    await opened;
    return new Promise((ok, bad) => {
      const requestId = ++id;
      pending.set(requestId, [ok, bad]);
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
try {
  command(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist, '--file=db/schema.sql']);
  command(['d1', 'migrations', 'apply', 'DEGEN', '--local', '--persist-to=' + persist]);
  const seed = join(scratch, 'seed.sql');
  writeFileSync(seed, "INSERT INTO world_event_cycles(id,event_key,opens_at,closes_at) VALUES('browser-cycle','underpass',datetime('now','-10 minutes'),datetime('now','+90 minutes'));\n");
  command(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist, '--file=' + seed]);
  launch('worker', wrangler, ['dev', '--local', '--persist-to=' + persist, '--ip=127.0.0.1', '--port=8789']);
  await until('local Worker', async () => (await fetch('http://127.0.0.1:8789/api/health', { signal: AbortSignal.timeout(800) })).ok);
  const origin = 'http://localhost:5173';
  const preflight = await fetch('http://127.0.0.1:8789/api/player/bootstrap', {
    method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
  launch('vite', vite, ['--host', '0.0.0.0', '--port=5173', '--strictPort'], { VITE_API_BASE: 'http://127.0.0.1:8789' });
  await until('Vite', async () => (await fetch('http://127.0.0.1:5173', { signal: AbortSignal.timeout(800) })).ok);
  launch('chrome', chromeBinary(), [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--enable-unsafe-swiftshader', '--remote-allow-origins=*', '--remote-debugging-port=9222',
    '--user-data-dir=' + join(scratch, 'chrome'), 'about:blank',
  ]);
  const target = await until('Chrome debugger', async () => {
    const r = await fetch('http://127.0.0.1:9222/json/list', { signal: AbortSignal.timeout(800) });
    if (!r.ok) return null;
    return (await r.json()).find(page => page.type === 'page' && page.webSocketDebuggerUrl);
  });
  const cdp = cdpClient(target.webSocketDebuggerUrl);
  socket = cdp.ws;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  const nav = await cdp.send('Page.navigate', { url: origin });
  if (nav.errorText) throw Error('Browser navigation rejected: ' + nav.errorText);
  await until('Map', () => cdp.evaluate('!!document.querySelector("[data-route=underpass]")'));
  assert.equal(await cdp.evaluate('!!document.querySelector("[data-route=home]")'), true);
  await cdp.evaluate('document.querySelector("[data-route=home]").click()');
  await until('Home grid', () => cdp.evaluate('!!document.querySelector(".room-grid")'));
  await cdp.evaluate('document.querySelector("[data-route=map]").click()');
  await until('Map return', () => cdp.evaluate('!!document.querySelector("[data-route=underpass]")'));
  await cdp.evaluate('document.querySelector("[data-route=underpass]").click()');
  await until('Worker-authorized Underpass entry', () => cdp.evaluate('document.querySelector("[data-start-battle]")?.disabled === false'));
  await cdp.evaluate('document.querySelector("[data-start-battle]").click()');
  await until('Manifested Degen abilities', () => cdp.evaluate('!!document.querySelector("[data-ability=crack]")'));
  assert.equal(await cdp.evaluate('document.querySelector("[data-ability=crack]")?.dataset.manaCost'), '4');
  for (let turn = 1; turn <= 3; turn++) {
    await until('Crack ready ' + turn, () => cdp.evaluate('document.querySelector("[data-ability=crack]")?.disabled === false'));
    await cdp.evaluate('document.querySelector("[data-ability=crack]").click()');
    if (turn < 3) await until('Authoritative action ' + turn, () => cdp.evaluate('(document.querySelector("#battle-log")?.textContent?.match(/uses Crack/g) || []).length >= ' + turn));
  }
  await until('Reward settled and Underpass returned', () => cdp.evaluate('!!document.querySelector("[data-start-battle]")'), 40000);
  await cdp.evaluate('document.querySelector("[data-route=home]").click()');
  await until('Server-earned trophy in Home', () => cdp.evaluate('document.querySelector(".furniture-list")?.textContent?.includes("Underpass Trophy")'), 30000);
  console.log('PASS Chromium + Vite + local Wrangler/D1: Map > Home > Underpass > Degen battle > Worker reward > Home trophy');
} catch (error) {
  console.error('Browser vertical slice FAILED:', error);
  for (const [name, output] of logs) console.error(name + ' logs:\n' + output);
  throw error;
} finally {
  socket?.close();
  for (const child of children.reverse()) if (child.exitCode === null) child.kill('SIGTERM');
  await sleep(500);
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  rmSync(scratch, { recursive: true, force: true });
}
