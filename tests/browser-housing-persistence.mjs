// Real Chromium + Vite + isolated local Worker/D1 housing persistence test.
// This test uses a 390x844 mobile viewport and never connects to remote D1.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'degen-housing-browser-'));
const persist = join(scratch, 'd1');
const wrangler = resolve(root, 'node_modules/.bin/wrangler');
const vite = resolve(root, 'node_modules/.bin/vite');
const api = 'http://127.0.0.1:8793';
const origin = 'http://localhost:5173';
const env = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' };
const children = [];
const logs = new Map();
let cdp;

function command(args) {
  const result = spawnSync(wrangler, args, { cwd: root, env, encoding: 'utf8', timeout: 120000 });
  if (result.error || result.status !== 0) {
    throw Error('wrangler ' + args.join(' ') + ': ' + (result.error ?? '') + '\n' + result.stdout + '\n' + result.stderr);
  }
  return result.stdout;
}

function sql(query) {
  const output = command(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist, '--json', '--command=' + query]);
  const parsed = JSON.parse(output);
  const row = Array.isArray(parsed) ? parsed[0] : parsed;
  return row?.results ?? row?.result?.[0]?.results ?? [];
}

function launch(name, executable, args, extraEnv = {}) {
  const child = spawn(executable, args, {
    cwd: root,
    env: { ...env, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  logs.set(name, '');
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', data => logs.set(name, (logs.get(name) + data.toString()).slice(-12000)));
  }
  children.push(child);
  return child;
}

async function until(label, check, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    for (const child of children) {
      if (child.exitCode !== null) {
        throw Error(label + ': child process exited unexpectedly\n' +
          Array.from(logs, ([name, value]) => name + ':\n' + value).join('\n'));
      }
    }
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(200);
  }
  throw Error('Timeout waiting for ' + label + (last ? ': ' + last : '') + '\n' +
    Array.from(logs, ([name, value]) => name + ':\n' + value).join('\n'));
}

function chromeBinary() {
  for (const executable of [process.env.CHROME_BIN, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (executable && spawnSync(executable, ['--version'], { encoding: 'utf8' }).status === 0) return executable;
  }
  throw Error('Chrome/Chromium unavailable on runner');
}

function cdpClient(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let nextId = 0;
  const opened = new Promise((resolveOpen, rejectOpen) => {
    ws.addEventListener('open', resolveOpen, { once: true });
    ws.addEventListener('error', rejectOpen, { once: true });
  });
  ws.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (!pending.has(message.id)) return;
    const [resolveMessage, rejectMessage] = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) rejectMessage(Error(JSON.stringify(message.error)));
    else resolveMessage(message.result);
  });
  const send = async (method, params = {}) => {
    await opened;
    return new Promise((resolveMessage, rejectMessage) => {
      const id = ++nextId;
      pending.set(id, [resolveMessage, rejectMessage]);
      ws.send(JSON.stringify({ id, method, params }));
    });
  };
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.text);
    return result.result.value;
  };
  return { ws, send, evaluate };
}

async function click(selector) {
  const expression = '(() => { const node = document.querySelector(' + JSON.stringify(selector) +
    '); if (!node) return false; node.click(); return true; })()';
  assert.equal(await cdp.evaluate(expression), true, 'expected browser control: ' + selector);
}

async function stopAll() {
  for (const child of children.reverse()) {
    if (child.exitCode !== null) continue;
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolveExit => child.once('exit', resolveExit)), sleep(1500)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

try {
  command(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist, '--file=db/schema.sql']);
  command(['d1', 'migrations', 'apply', 'DEGEN', '--local', '--persist-to=' + persist]);

  launch('worker', wrangler, ['dev', '--local', '--persist-to=' + persist, '--ip=127.0.0.1', '--port=8793']);
  await until('local Worker health', async () => {
    const response = await fetch(api + '/api/health', { signal: AbortSignal.timeout(800) });
    if (!response.ok) return null;
    const result = await response.json();
    return result.ok ? true : null;
  });

  launch('vite', vite, ['--host', '0.0.0.0', '--port=5173', '--strictPort'], { VITE_API_BASE: api });
  await until('Vite startup', async () => {
    const response = await fetch(origin, { signal: AbortSignal.timeout(800) });
    return response.ok ? true : null;
  });

  launch('chrome', chromeBinary(), [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--enable-unsafe-swiftshader', '--remote-allow-origins=*', '--remote-debugging-port=9222',
    '--user-data-dir=' + join(scratch, 'chrome'), 'about:blank',
  ]);
  const target = await until('Chrome page target', async () => {
    const response = await fetch('http://127.0.0.1:9222/json/list', { signal: AbortSignal.timeout(800) });
    if (!response.ok) return null;
    return (await response.json()).find(item => item.type === 'page' && item.webSocketDebuggerUrl);
  }, 60_000);

  cdp = cdpClient(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 390, screenHeight: 844,
  });
  await cdp.send('Page.navigate', { url: origin });
  const cityMapReady = async () => await cdp.evaluate(
    "Boolean(document.querySelector('[data-district=\"Central\"]') && document.querySelector('[data-route=\"home\"]'))",
  );
  await until('city map and permanent Home navigation', async () =>
    await cityMapReady() ? true : null);

  const playerId = await cdp.evaluate("JSON.parse(localStorage.getItem('degen.prototype.player.v2') || '{}').id || ''");
  assert.match(playerId, /^browser-[0-9a-f-]+$/i, 'browser bootstrap should create a stable local test identity');
  await click('[data-route="home"]');
  await until('home and starter furniture', async () => {
    const text = await cdp.evaluate("document.querySelector('#app')?.innerText || ''");
    return text.includes('Make it yours.') && text.includes('Plastic Chair') ? text : null;
  });

  const cellSize = await cdp.evaluate("(() => { const r = document.querySelector('[data-room-x=\"0\"][data-room-y=\"0\"]').getBoundingClientRect(); return { width: r.width, height: r.height }; })()");
  assert.ok(cellSize.width >= 32 && cellSize.height >= 32,
    'housing cells should remain comfortably tappable at a 390px mobile viewport');

  await click('[data-furniture="starter-chair"]');
  await until('chair selection', async () =>
    await cdp.evaluate("Boolean(document.querySelector('[data-furniture=\"starter-chair\"].selected'))") ? true : null);
  await click('[data-room-x="3"][data-room-y="2"]');
  await until('chair rendered in the selected room cell', async () => {
    const label = await cdp.evaluate("document.querySelector('[data-room-x=\"3\"][data-room-y=\"2\"]')?.getAttribute('aria-label') || ''");
    return label.includes('Plastic Chair') ? label : null;
  });
  await until('chair saved to local D1', async () =>
    sql("SELECT COUNT(*) AS n FROM housing_placements WHERE player_id='" + playerId +
      "' AND furniture_key='starter-chair' AND grid_x=3 AND grid_y=2")[0]?.n === 1 ? true : null);

  await cdp.send('Page.navigate', { url: origin });
  await until('city map after browser reload', async () =>
    await cityMapReady() ? true : null);
  await click('[data-route="home"]');
  await until('persisted chair after browser reload', async () => {
    const label = await cdp.evaluate("document.querySelector('[data-room-x=\"3\"][data-room-y=\"2\"]')?.getAttribute('aria-label') || ''");
    return label.includes('Plastic Chair') ? label : null;
  });

  await click('[data-clear-selection]');
  await click('[data-room-x="3"][data-room-y="2"]');
  await until('chair removed from room', async () => {
    const label = await cdp.evaluate("document.querySelector('[data-room-x=\"3\"][data-room-y=\"2\"]')?.getAttribute('aria-label') || ''");
    return label === 'Room cell 4, 3' ? label : null;
  });
  await click('[data-room-x="1"][data-room-y="1"]');
  await until('empty room saved', async () =>
    sql("SELECT COUNT(*) AS n FROM housing_placements WHERE player_id='" + playerId + "'")[0]?.n === 0 ? true : null);

  await cdp.send('Page.navigate', { url: origin });
  await until('city map after empty-room reload', async () =>
    await cityMapReady() ? true : null);
  await click('[data-route="home"]');
  await until('empty room remains empty after bootstrap', async () =>
    await cdp.evaluate("document.querySelectorAll('.room-cell.occupied').length") === 0 ? true : null);
  assert.equal(sql("SELECT COUNT(*) AS n FROM housing_placements WHERE player_id='" + playerId + "'")[0]?.n, 0,
    'bootstrap must not reseed furniture after an explicit room clear');

  // A full Underpass clear awards this existing furniture item. Seed the local D1
  // inventory row to exercise the real trophy-selection and room-placement path.
  sql("INSERT OR IGNORE INTO player_inventory (id, player_id, item_key, item_type, quantity) VALUES ('" +
    playerId + ":furniture:tunnel-trophy', '" + playerId + "', 'tunnel-trophy', 'furniture', 1)");
  await cdp.send('Page.navigate', { url: origin });
  await until('city map after trophy reward', async () => await cityMapReady() ? true : null);
  await click('[data-route="home"]');
  await until('earned trophy appears in the display panel', async () => {
    const text = await cdp.evaluate("document.querySelector('#app')?.innerText || ''");
    return text.includes('TROPHY DISPLAY') && text.includes('READY TO DISPLAY') ? text : null;
  });
  await click('.trophy-select[data-furniture="tunnel-trophy"]');
  await until('trophy selection', async () =>
    await cdp.evaluate("Boolean(document.querySelector('.trophy-select[data-furniture=\\"tunnel-trophy\\\"].selected'))") ? true : null);
  await click('[data-room-x="6"][data-room-y="4"]');
  await until('trophy rendered in the selected room cell', async () => {
    const label = await cdp.evaluate("document.querySelector('[data-room-x=\\"6\\"][data-room-y=\\"4\\"]')?.getAttribute('aria-label') || ''");
    return label.includes('Underpass Trophy') ? label : null;
  });
  await until('trophy saved to local D1', async () =>
    sql("SELECT COUNT(*) AS n FROM housing_placements WHERE player_id='" + playerId +
      "' AND furniture_key='tunnel-trophy' AND grid_x=6 AND grid_y=4")[0]?.n === 1 ? true : null);

  await cdp.send('Page.navigate', { url: origin });
  await until('city map after trophy placement reload', async () => await cityMapReady() ? true : null);
  await click('[data-route="home"]');
  await until('trophy display reflects persisted room placement', async () => {
    const text = await cdp.evaluate("document.querySelector('#app')?.innerText || ''");
    return text.includes('DISPLAYED · ROOM CELL 7, 5') ? text : null;
  });
  const trophyCell = await cdp.evaluate("document.querySelector('[data-room-x=\\"6\\"][data-room-y=\\"4\\"]')?.getAttribute('aria-label') || ''");
  assert.match(trophyCell, /Underpass Trophy/, 'placed trophy must remain visible after reload');

  console.log('PASS real Chromium mobile viewport + Vite + local Worker/D1: housing placement persists after reload, empty room remains empty, and the earned Underpass Trophy can be selected, displayed, and recovered after reload');
} finally {
  if (cdp) cdp.ws.close();
  await stopAll();
  rmSync(scratch, { recursive: true, force: true });
}
