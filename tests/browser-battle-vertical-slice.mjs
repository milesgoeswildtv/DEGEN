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
  return r.stdout;
}
function sql(query) {
  const parsed = JSON.parse(command(['d1', 'execute', 'DEGEN', '--local', '--persist-to=' + persist, '--json', '--command=' + query]));
  const row = Array.isArray(parsed) ? parsed[0] : parsed;
  return row?.results ?? row?.result?.[0]?.results ?? [];
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
  // Use actual mobile touch events, not DOM click simulation.
  const tap = async (selector) => {
    const point = await cdp.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element || element.disabled) return null;
      element.scrollIntoView({ block: 'center', inline: 'center' });
      const box = element.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const hit = document.elementFromPoint(x, y);
      return hit && (hit === element || element.contains(hit)) ? { x, y } : null;
    })()`);
    assert.ok(point && point.x >= 0 && point.x < 390 && point.y >= 0 && point.y < 844,
      'Touch target must be visible and unobstructed: ' + selector);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  const assertFitsMobile = async route => {
    assert.equal(await cdp.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'),
      true, route + ' must not overflow horizontally');
  };
  const assertFitsCompact = async (route) => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 2, mobile: true });
    await until('compact viewport resize', () => cdp.evaluate('window.innerWidth === 320'));
    const dimensions = await cdp.evaluate('({ width: window.innerWidth, scroll: document.documentElement.scrollWidth })');
    assert.equal(dimensions.width, 320, route + ' compact viewport width');
    assert.ok(dimensions.scroll <= 321, route + ' and long display name must not overflow at 320px; got ' + dimensions.scroll);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, screenWidth: 390, screenHeight: 844, deviceScaleFactor: 1, mobile: true });
  };
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // Observe the actual Phaser text canvas so the browser test proves the HUD follows
  // Worker-confirmed Mana and keeps the Degen manifested at zero, not just D1 state.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      const rendered = [];
      Object.defineProperty(window, '__degenRenderedBattleText', { value: rendered });
      const original = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function(text, ...args) {
        if (typeof text === 'string' && (text.startsWith('MANA ') || text === 'MANIFESTED')) rendered.push(text);
        return original.call(this, text, ...args);
      };

      // Simulate a response lost after the local Worker has committed the turn.
      // The app's already-bound fetcher must observe this wrapper before boot.
      const originalFetch = window.fetch.bind(window);
      window.__degenSimulateLostActionResponse = false;
      window.__degenLostActionResponses = 0;
      window.fetch = async (input, init) => {
        const response = await originalFetch(input, init);
        const requestUrl = input instanceof Request ? input.url : String(input);
        if (window.__degenSimulateLostActionResponse
          && new URL(requestUrl, window.location.href).pathname === '/api/battle/action') {
          window.__degenSimulateLostActionResponse = false;
          window.__degenLostActionResponses += 1;
          throw new TypeError('simulated lost response after Worker commit');
        }
        return response;
      };
    })();`,
  });
  // Exercise the entire Worker-backed slice in mobile portrait; not physical-device QA.
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, screenWidth: 390, screenHeight: 844, deviceScaleFactor: 1, mobile: true,
  });
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  const nav = await cdp.send('Page.navigate', { url: origin });
  if (nav.errorText) throw Error('Browser navigation rejected: ' + nav.errorText);
  await until('Map', () => cdp.evaluate('!!document.querySelector("[data-route=underpass]")'));
  const playerId = await cdp.evaluate("JSON.parse(localStorage.getItem('degen.prototype.player.v2') || '{}').id || ''");
  assert.match(playerId, /^browser-[0-9a-f-]+$/i, 'browser bootstrap should create a stable local test identity');
  assert.equal(await cdp.evaluate('!!document.querySelector("[data-route=home]")'), true);
  await assertFitsMobile('Map');
  await assertFitsCompact('Map');
  await tap("[data-route=home]");
  await until('Home grid', () => cdp.evaluate('!!document.querySelector(".room-grid")'));
  await assertFitsMobile('Home');
  await assertFitsCompact('Home');
  await tap("[data-route=map]");
  await until('Map return', () => cdp.evaluate('!!document.querySelector("[data-route=underpass]")'));
  await tap("[data-route=underpass]");
  await until('Worker-authorized Underpass entry', () => cdp.evaluate('document.querySelector("[data-start-battle]")?.disabled === false'));
  await tap("[data-start-battle]");
  await until('Manifested Degen abilities', () => cdp.evaluate('!!document.querySelector("[data-ability=crack]")'));
  await until('rendered initial Mana HUD', () => cdp.evaluate("window.__degenRenderedBattleText?.includes('MANA 12/12') && window.__degenRenderedBattleText?.includes('MANIFESTED')"));
  assert.deepEqual(await cdp.evaluate("(() => { const status = document.querySelector('#battle-action-status'); return { exists: !!status, hidden: status?.hidden, ariaLive: status?.getAttribute('aria-live'), display: status ? getComputedStyle(status).display : null }; })()"),
    { exists: true, hidden: true, ariaLive: 'polite', display: 'none' },
    'the mobile battle screen must render an initially hidden, accessible action-status region');
  const activeRows = sql("SELECT id, player_hp, player_mana, enemy_hp, battle_status, turn_count FROM battle_permits WHERE player_id='" + playerId + "' AND event_key='underpass' AND encounter_key='tunnel-maw' AND completed_at IS NULL ORDER BY started_at DESC LIMIT 1");
  assert.equal(activeRows.length, 1, 'Worker battle start should issue one persisted active permit');
  const permitId = activeRows[0].id;
  assert.equal(activeRows[0].player_hp, 120);
  assert.equal(activeRows[0].player_mana, 12);
  assert.equal(activeRows[0].enemy_hp, 92);
  assert.equal(activeRows[0].battle_status, 'active');
  assert.equal(activeRows[0].turn_count, 0);
  assert.equal(await cdp.evaluate('document.querySelector("[data-ability=crack]")?.dataset.manaCost'), '4');
  assert.equal(await cdp.evaluate('document.querySelector("[data-ability=crack] small")?.textContent'), '4 MANA');
  assert.equal(await cdp.evaluate('document.querySelector("[data-ability=slash] small")?.textContent'), 'NO MANA');
  await assertFitsMobile('Battle');
  await assertFitsCompact('Battle');
  for (let turn = 1; turn <= 3; turn++) {
    await until('Crack ready ' + turn, () => cdp.evaluate('document.querySelector("[data-ability=crack]")?.disabled === false'));
    if (turn === 1 || turn === 3) await cdp.evaluate('window.__degenSimulateLostActionResponse = true');
    await tap("[data-ability=crack]");
    if (turn === 1) {
      await until('Recovered authoritative state after lost response', () => cdp.evaluate(
        '(document.querySelector("#battle-log")?.textContent || "").includes("Battle state synchronized with server.") && window.__degenLostActionResponses === 1'));
      assert.equal(await cdp.evaluate('document.querySelector("#battle-action-status")?.textContent'),
        'Battle state refreshed from the server. Choose your next move.',
        'the player should see that the committed turn was recovered from authoritative state');
    } else if (turn === 3) {
      await until('Recovered terminal victory after lost response', () => cdp.evaluate('window.__degenLostActionResponses === 2'));
    } else if (turn < 3) {
      await until('Authoritative action ' + turn, () => cdp.evaluate(
        '(document.querySelector("#battle-log")?.textContent?.match(/uses Crack/g) || []).length >= ' + (turn - 1)));
    }
    const expected = {
      player_hp: turn === 3 ? 100 : 120 - turn * 10,
      player_mana: 12 - turn * 4,
      enemy_hp: Math.max(0, 92 - turn * 35),
      battle_status: turn === 3 ? 'victory' : 'active',
      turn_count: turn,
    };
    const persisted = await until('D1 state for authoritative turn ' + turn, () => {
      const row = sql("SELECT player_hp, player_mana, enemy_hp, battle_status, turn_count FROM battle_permits WHERE id='" + permitId + "'")[0];
      return row?.turn_count === turn ? row : null;
    });
    for (const [key, value] of Object.entries(expected)) assert.equal(persisted[key], value, 'persisted turn ' + turn + ' ' + key);
    const displayedMana = `MANA ${expected.player_mana}/12`;
    await until('rendered authoritative Mana HUD after turn ' + turn,
      () => cdp.evaluate(`window.__degenRenderedBattleText?.includes(${JSON.stringify(displayedMana)})`));
    const hudOrder = await cdp.evaluate(`(() => {
      const rendered = window.__degenRenderedBattleText || [];
      return { mana: rendered.lastIndexOf(${JSON.stringify(displayedMana)}), manifested: rendered.lastIndexOf('MANIFESTED') };
    })()`);
    assert.ok(hudOrder.mana >= 0, 'the current authoritative Mana value must be rendered');
    assert.ok(hudOrder.manifested > hudOrder.mana,
      'MANIFESTED must be rendered after the current Mana value, including at zero Mana');
  }
  await until('Reward settled and Underpass returned', () => cdp.evaluate('!!document.querySelector("[data-start-battle]")'), 40000);
  await tap("[data-route=home]");
  await until('Server-earned trophy in Home', () => cdp.evaluate('document.querySelector(".furniture-list")?.textContent?.includes("Underpass Trophy")'), 30000);
  const finalPermit = sql("SELECT battle_status, reward_state, player_mana, turn_count, completed_at FROM battle_permits WHERE id='" + permitId + "'")[0];
  assert.equal(finalPermit?.battle_status, 'victory');
  assert.equal(finalPermit?.reward_state, 'awarded');
  assert.equal(finalPermit?.player_mana, 0);
  assert.equal(finalPermit?.turn_count, 3);
  assert.ok(finalPermit?.completed_at, 'Worker should persist completion after awarding the victory receipt');
  assert.equal(await cdp.evaluate('window.__degenLostActionResponses'), 2,
    'both an active turn and the killing blow should recover after their committed responses are lost');
  const victoryHistory = sql("SELECT COUNT(*) AS count FROM battle_history WHERE player_id='" + playerId + "' AND encounter_key='tunnel-maw' AND result='victory'")[0];
  assert.equal(victoryHistory?.count, 1,
    'recovering the lost killing-blow response must settle exactly one victory-history row');
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
