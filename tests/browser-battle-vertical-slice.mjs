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
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      const description = details.exception?.description ?? details.exception?.value ?? details.text;
      throw Error('Runtime.evaluate failed: ' + description);
    }
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
  // Use actual mobile touch events, not DOM click simulation. Give each tap
  // its own touch identifier and a short active interval so Chromium emits a
  // complete pointerdown/pointerup/click sequence after a preceding drag.
  let nextTouchId = 2;
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
    const touchId = nextTouchId++ % 10;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: touchId }] });
    await sleep(80);
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
      window.__degenSimulateLostStartResponse = false;
      window.__degenLostStartResponsesRemaining = 0;
      window.__degenLostStartResponses = 0;
      window.__degenStartRequestIds = [];
      window.__degenSimulateLostActionResponse = false;
      window.__degenLostActionResponses = 0;
      window.__degenSimulateMalformedActionResponse = false;
      window.__degenMalformedActionResponses = 0;
      window.__degenSimulateTimedOutActionResponse = false;
      window.__degenTimedOutActionResponses = 0;
      window.__degenSimulateTimedOutCompletionResponse = false;
      window.__degenTimedOutCompletionResponses = 0;
      window.fetch = async (input, init) => {
        const response = await originalFetch(input, init);
        const requestUrl = input instanceof Request ? input.url : String(input);
        const requestPath = new URL(requestUrl, window.location.href).pathname;
        if (requestPath === '/api/battle/start') {
          try { window.__degenStartRequestIds.push(JSON.parse(String(init?.body ?? '{}')).requestId); }
          catch { window.__degenStartRequestIds.push(undefined); }
        }
        if ((window.__degenSimulateLostStartResponse || window.__degenLostStartResponsesRemaining > 0)
          && requestPath === '/api/battle/start') {
          // The Worker has committed the permit, but this client never receives
          // its response. Repeated losses must preserve the same key across reload.
          window.__degenSimulateLostStartResponse = false;
          if (window.__degenLostStartResponsesRemaining > 0) {
            window.__degenLostStartResponsesRemaining -= 1;
          }
          window.__degenLostStartResponses += 1;
          await response.body?.cancel();
          throw new TypeError('simulated lost response after Worker permit issue');
        }
        if (window.__degenSimulateMalformedActionResponse && requestPath === '/api/battle/action') {
          // The Worker commits the action and returns 200, but the browser receives
          // malformed JSON. This verifies the visible recovery message and safe
          // same-turn retry against the real compare-and-swap path.
          window.__degenSimulateMalformedActionResponse = false;
          window.__degenMalformedActionResponses += 1;
          if (!response.ok) return response;
          await response.text();
          return new Response('{', { status: response.status, headers: { 'content-type': 'application/json' } });
        }
        if (window.__degenSimulateTimedOutActionResponse && requestPath === '/api/battle/action') {
          // The Worker has already committed this turn. Withhold its response until
          // GameApi's real AbortController timeout fires, then let the same-turn retry
          // reconcile the Worker CAS conflict instead of applying damage/Mana twice.
          window.__degenSimulateTimedOutActionResponse = false;
          window.__degenTimedOutActionResponses += 1;
          return new Promise((_resolve, reject) => {
            const signal = init?.signal;
            const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
            if (!signal) {
              reject(new Error('Timed-out action test requires an AbortSignal.'));
            } else if (signal.aborted) {
              abort();
            } else {
              signal.addEventListener('abort', abort, { once: true });
            }
          });
        }
        if (window.__degenSimulateTimedOutCompletionResponse && requestPath === '/api/battle/complete') {
          // The Worker has already settled the reward receipt. Withhold the successful
          // response until GameApi's completion timeout fires; the identical retry must
          // replay that receipt without awarding progression or inventory twice.
          window.__degenSimulateTimedOutCompletionResponse = false;
          window.__degenTimedOutCompletionResponses += 1;
          await response.body?.cancel();
          return new Promise((_resolve, reject) => {
            const signal = init?.signal;
            const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
            if (!signal) {
              reject(new Error('Timed-out completion test requires an AbortSignal.'));
            } else if (signal.aborted) {
              abort();
            } else {
              signal.addEventListener('abort', abort, { once: true });
            }
          });
        }
        if (window.__degenSimulateLostActionResponse && requestPath === '/api/battle/action') {
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
  await until('Map', () => cdp.evaluate('!!document.querySelector("[data-district=Central]")'));
  const playerId = await cdp.evaluate("JSON.parse(localStorage.getItem('degen.prototype.player.v2') || '{}').id || ''");
  assert.match(playerId, /^browser-[0-9a-f-]+$/i, 'browser bootstrap should create a stable local test identity');
  // Seed the isolated Worker-owned character just below the existing level threshold
  // so this real reward receipt proves the server-provided level transition.
  sql("UPDATE characters SET xp=50 WHERE player_id='" + playerId + "'");
  assert.equal(await cdp.evaluate('!!document.querySelector("[data-route=home]")'), true);
  await assertFitsMobile('Map');
  await assertFitsCompact('Map');
  const initialCityScale = await cdp.evaluate('Number(document.querySelector("[data-city-viewport]")?.dataset.cityScale)');
  await tap("[data-city-zoom=in]");
  const zoomedCityScale = await cdp.evaluate('Number(document.querySelector("[data-city-viewport]")?.dataset.cityScale)');
  assert.ok(zoomedCityScale > initialCityScale, 'map zoom control must enlarge the city');
  await tap("[data-city-reset]");
  assert.equal(await cdp.evaluate('Number(document.querySelector("[data-city-viewport]")?.dataset.cityScale)'), initialCityScale,
    'map reset must restore the current mobile scale');

  // Verify that the visible map responds to a real Chromium touch drag, not
  // only to the pure camera helper tests or the zoom buttons. Capture the actual
  // browser pointerId rather than assuming CDP touch ids equal pointer ids.
  await cdp.evaluate(`(() => {
    window.__degenCityPointerId = null;
    document.querySelector('[data-city-viewport]').addEventListener('pointerdown', event => {
      window.__degenCityPointerId = event.pointerId;
    }, { once: true });
  })()`);
  const panPoint = await cdp.evaluate(`(() => {
    const rect = document.querySelector('[data-city-viewport]').getBoundingClientRect();
    return { id: 1, x: rect.left + rect.width / 2, y: rect.top + rect.height * 0.8 };
  })()`);
  const cityTransformBeforePan = await cdp.evaluate('document.querySelector("[data-city-world]")?.style.transform ?? ""');
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [panPoint] });
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ ...panPoint, x: panPoint.x + 36, y: panPoint.y + 18 }],
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const cityTransformAfterPan = await cdp.evaluate('document.querySelector("[data-city-world]")?.style.transform ?? ""');
  assert.notEqual(cityTransformAfterPan, cityTransformBeforePan,
    'a real mobile touch drag must pan the city camera');
  const captureAfterPan = await cdp.evaluate(`(() => {
    const viewport = document.querySelector('[data-city-viewport]');
    const pointerId = window.__degenCityPointerId;
    return { pointerId, captured: pointerId !== null && viewport.hasPointerCapture(pointerId) };
  })()`);
  assert.notEqual(captureAfterPan.pointerId, null, 'the real touch drag must produce a pointerdown');
  assert.equal(captureAfterPan.captured, false, 'the viewport must release the touch pointer before the next control tap');
  // Let the completed drag's pointerup/capture-release cycle settle, then
  // keep reset and Home navigation on real touch input.
  await sleep(100);
  await tap("[data-city-reset]");
  await until('city camera reset after touch drag', () =>
    cdp.evaluate('document.querySelector("[data-city-world]")?.style.transform.includes("translate(0px, 0px)") ?? false'));
  await sleep(100);
  await tap("[data-route=home]");
  await until('Home grid', () => cdp.evaluate('!!document.querySelector(".room-grid")'));
  await assertFitsMobile('Home');
  await assertFitsCompact('Home');
  await tap("[data-route=map]");
  await until('Map return', () => cdp.evaluate('!!document.querySelector("[data-district=Central]")'));
  await tap("[data-district=Central]");
  await until('Central district destinations', () => cdp.evaluate('!!document.querySelector("[data-location=downtown]") && !!document.querySelector("[data-location=underpass]")'));
  await assertFitsMobile('Central district');
  await assertFitsCompact('Central district');
  await tap("[data-location=downtown]");
  await until('Downtown location scene', () => cdp.evaluate('!!document.querySelector(".location-scene") && document.querySelector(".location-scene")?.textContent.includes("Downtown")'));
  await assertFitsMobile('Downtown location');
  await assertFitsCompact('Downtown location');
  assert.equal(await cdp.evaluate('document.querySelector(".location-scene-status")?.textContent'), 'ACCESSIBLE // ACTIVITIES IN DEVELOPMENT');
  await tap("[data-route=district]");
  await until('Central district return', () => cdp.evaluate('!!document.querySelector("[data-location=underpass]")'));
  await tap("[data-route=map]");
  await until('Map before Residential', () => cdp.evaluate('!!document.querySelector("[data-district=Residential]")'));
  await tap("[data-district=Residential]");
  await until('Residential district Home destination', () => cdp.evaluate('!!document.querySelector("[data-location=home]")'));
  await tap("[data-location=home]");
  await until('Home reached through Residential district', () => cdp.evaluate('!!document.querySelector(".room-grid")'));
  await assertFitsMobile('Home through district');
  await assertFitsCompact('Home through district');
  await tap("[data-route=map]");
  await until('Map before Underpass', () => cdp.evaluate('!!document.querySelector("[data-district=Central]")'));
  await tap("[data-district=Central]");
  await until('Central district before Underpass', () => cdp.evaluate('!!document.querySelector("[data-location=underpass]")'));
  await tap("[data-location=underpass]");
  await until('Worker-authorized Underpass entry', () => cdp.evaluate('document.querySelector("[data-start-battle]")?.disabled === false'));
  await cdp.evaluate('window.__degenLostStartResponsesRemaining = 2');
  await tap("[data-start-battle]");
  await until('both start responses lost and retry exhausted', () => cdp.evaluate(
    'window.__degenLostStartResponses === 2 && !document.querySelector("[data-ability=crack]")',
  ));
  await sleep(300);
  assert.equal(await cdp.evaluate('window.__degenLostStartResponses'), 2,
    'both bounded start attempts should lose their response before reload');
  const firstStartRequestIds = await cdp.evaluate('window.__degenStartRequestIds');
  assert.equal(firstStartRequestIds.length, 2, 'the first page should issue only the bounded initial request and retry');
  assert.match(firstStartRequestIds[0], /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(firstStartRequestIds[0], firstStartRequestIds[1],
    'both lost responses must use the same request ID');
  assert.equal(sql("SELECT COUNT(*) AS count FROM battle_permits WHERE player_id='" + playerId + "'")[0]?.count, 1,
    'both lost responses must still leave exactly one persisted permit');

  // Reload the actual browser page. localStorage must retain the uncertain key,
  // allowing a fresh GameApi instance to recover the already-issued permit.
  await cdp.send('Page.reload');
  await until('Map after reload', () => cdp.evaluate('!!document.querySelector("[data-district=Central]")'));
  assert.equal(await cdp.evaluate("JSON.parse(localStorage.getItem('degen.prototype.player.v2') || '{}').id || ''"), playerId,
    'the same test player must survive the reload');
  await assertFitsMobile('Map after reload');
  await tap("[data-district=Central]");
  await until('Central district after reload', () => cdp.evaluate('!!document.querySelector("[data-location=underpass]")'));
  await tap("[data-location=underpass]");
  await until('Recoverable Underpass encounter after reload', () => cdp.evaluate('!!document.querySelector("[data-resume-battle]")'));
  assert.equal(await cdp.evaluate('!!document.querySelector("[data-start-battle]")'), false,
    'a persisted uncertain start must offer resume, not mint a second permit');
  await tap("[data-resume-battle]");
  await until('Manifested Degen abilities after persisted-key recovery', () => cdp.evaluate('!!document.querySelector("[data-ability=crack]")'));
  await until('rendered initial Mana HUD', () => cdp.evaluate("window.__degenRenderedBattleText?.includes('MANA 12/12') && window.__degenRenderedBattleText?.includes('MANIFESTED')"));
  const initialAccessibleHud = await cdp.evaluate('document.querySelector("#battle-accessible-hud")?.textContent ?? ""');
  assert.equal(initialAccessibleHud,
    'TEST_DEGEN: HP 120 of 120, Mana 12 of 12. Tunnel Maw: HP 92 of 92. Turn 0. Choose an action.',
    'the live DOM status must expose the initial Worker-backed battle snapshot outside the Phaser canvas');
  assert.deepEqual(await cdp.evaluate("(() => { const status = document.querySelector('#battle-action-status'); return { exists: !!status, hidden: status?.hidden, ariaLive: status?.getAttribute('aria-live'), display: status ? getComputedStyle(status).display : null }; })()"),
    { exists: true, hidden: true, ariaLive: 'polite', display: 'none' },
    'the mobile battle screen must render an initially hidden, accessible action-status region');
  const activeRows = sql("SELECT id, player_hp, player_mana, enemy_hp, battle_status, turn_count FROM battle_permits WHERE player_id='" + playerId + "' AND event_key='underpass' AND encounter_key='tunnel-maw' AND completed_at IS NULL ORDER BY started_at DESC LIMIT 1");
  assert.equal(activeRows.length, 1, 'Worker battle start should return one persisted active permit');
  assert.equal(await cdp.evaluate('window.__degenLostStartResponses'), 0,
    'the successful post-reload recovery should not lose another response');
  const startRequestIds = await cdp.evaluate('window.__degenStartRequestIds');
  assert.equal(startRequestIds.length, 1, 'the reloaded page should issue one request to recover the permit');
  assert.equal(startRequestIds[0], firstStartRequestIds[0],
    'the reloaded page must reuse the persisted request ID from both failed attempts');
  assert.equal(sql("SELECT COUNT(*) AS count FROM battle_permits WHERE player_id='" + playerId + "'")[0]?.count, 1,
    'recovery after reload must not create a duplicate permit');
  const startStorageKey = 'degen:battle-start:' + encodeURIComponent(playerId);
  const activeStartKey = await cdp.evaluate('JSON.parse(localStorage.getItem(' + JSON.stringify(startStorageKey) + ') || "null")');
  assert.deepEqual(activeStartKey, {
    cycleId: 'browser-cycle',
    requestId: firstStartRequestIds[0],
    state: 'active',
  }, 'recovery must retain the player-scoped active key until authoritative reward completion');
  const permitId = activeRows[0].id;
  assert.equal(permitId, startRequestIds[0], 'the recovered permit ID must match the request idempotency key');
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
    if (turn === 2) await cdp.evaluate('window.__degenSimulateTimedOutActionResponse = true');
    if (turn === 3) await cdp.evaluate('window.__degenSimulateTimedOutCompletionResponse = true');
    await tap("[data-ability=crack]");
    if (turn === 1) {
      await until('Recovered authoritative state after lost response', () => cdp.evaluate(
        '(document.querySelector("#battle-log")?.textContent || "").includes("Battle state synchronized with server.") && window.__degenLostActionResponses === 1'));
      assert.equal(await cdp.evaluate('document.querySelector("#battle-action-status")?.textContent'),
        'Battle state refreshed from the server. Choose your next move.',
        'the player should see that the committed turn was recovered from authoritative state');
    } else if (turn === 2) {
      await until('Recovered authoritative state after timed-out response', () => cdp.evaluate(
        'window.__degenTimedOutActionResponses === 1 && document.querySelector("#battle-action-status")?.textContent === "Battle state refreshed from the server. Choose your next move."'));
    } else if (turn === 3) {
      await until('Recovered terminal victory after lost response', () => cdp.evaluate('window.__degenLostActionResponses === 2'));
    }
    const expected = {
      player_hp: turn === 3 ? 100 : 120 - turn * 10,
      player_mana: 12 - turn * 4,
      enemy_hp: Math.max(0, 92 - turn * 35),
      battle_status: turn === 3 ? 'victory' : 'active',
      turn_count: turn,
    };
    await until('accessible DOM HUD after authoritative turn ' + turn, () => cdp.evaluate(`(() => {
      const text = document.querySelector("#battle-accessible-hud")?.textContent ?? "";
      return text.includes(${JSON.stringify(`Mana ${expected.player_mana} of 12`)})
        && text.includes(${JSON.stringify(`Turn ${turn}.`)})
        && text.includes(${JSON.stringify(turn === 3 ? 'Victory. Verifying rewards.' : 'Choose an action.')});
    })()`));
    const accessibleHud = await cdp.evaluate('document.querySelector("#battle-accessible-hud")?.textContent ?? ""');
    assert.ok(accessibleHud.includes(`Mana ${expected.player_mana} of 12`),
      'accessible HUD Mana must follow the Worker result for turn ' + turn);
    assert.ok(accessibleHud.includes(`Turn ${turn}.`),
      'accessible HUD turn count must follow the Worker result for turn ' + turn);
    assert.ok(accessibleHud.includes(turn === 3 ? 'Victory. Verifying rewards.' : 'Choose an action.'),
      'accessible HUD outcome must follow the authoritative battle state for turn ' + turn);
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

    if (turn === 1) {
      const activeCycleId = sql("SELECT cycle_id FROM battle_permits WHERE id='" + permitId + "'")[0]?.cycle_id;
      assert.ok(activeCycleId, 'the active permit must retain its issuing cycle');
      // Preserve started_at < closes_at, then let that issuing cycle close naturally.
      sql("UPDATE world_event_cycles SET closes_at = datetime('now', '+1 second') WHERE id='" + activeCycleId + "'");
      await sleep(1500);
      const closedWorld = await (await fetch(
        'http://127.0.0.1:8789/api/world/underpass?playerId=' + encodeURIComponent(playerId),
      )).json();
      assert.equal(closedWorld.phase, 'sealed', 'the current Underpass must be closed before resume');
      assert.notEqual(closedWorld.cycleId, activeCycleId, 'the current world cycle must advance after closure');

      await tap("[data-route=underpass]");
      await until('resume action after the issuing cycle closes', () => cdp.evaluate(
        '!!document.querySelector("[data-resume-battle]") && !document.querySelector("[data-start-battle]")',
      ));
      await tap("[data-resume-battle]");
      await until('persisted active encounter resumed after cycle closure', () => cdp.evaluate(
        '(() => { const hud = document.querySelector("#battle-accessible-hud")?.textContent ?? ""; return !!document.querySelector("[data-ability=crack]") && hud.includes("HP 110 of 120, Mana 8 of 12") && hud.includes("Tunnel Maw: HP 57 of 92. Turn 1."); })()',
      ));
      const resumedState = sql("SELECT player_hp, player_mana, enemy_hp, battle_status, turn_count FROM battle_permits WHERE id='" + permitId + "'")[0];
      assert.deepEqual(resumedState, {
        player_hp: 110, player_mana: 8, enemy_hp: 57, battle_status: 'active', turn_count: 1,
      }, 'resume must remount from the persisted Worker snapshot without applying another turn');
      await assertFitsMobile('Resumed battle after Underpass closure');
      await assertFitsCompact('Resumed battle after Underpass closure');
    }
  }
  await until('Reward settled and Underpass returned', () => cdp.evaluate('!!document.querySelector("[data-start-battle]")'), 40000);
  await until('authoritative reward receipt shows loot and level-up', () => cdp.evaluate(`(() => {
    const receipt = document.querySelector('[data-battle-reward-receipt]');
    const text = receipt?.textContent ?? '';
    return !!receipt && text.includes('FULL CLEAR') && text.includes('+75 XP')
      && text.includes('+30 CR') && text.includes('UNDERPASS SCRAP')
      && text.includes('Underpass Trophy') && text.includes('LEVEL UP · LV.1 → LV.2');
  })()`));
  assert.equal(await cdp.evaluate('document.querySelector(".player-chip strong")?.textContent'), 'LV.2',
    'the player chip must reflect the Worker-authoritative level after reward settlement');
  await assertFitsMobile('Underpass reward receipt');
  await assertFitsCompact('Underpass reward receipt');
  assert.equal(await cdp.evaluate('document.querySelector("[data-battle-reward-receipt]")?.dataset.permitId'), permitId,
    'the first visible receipt must be tied to the first completed permit');

  // Settle another real Worker-backed encounter before dismissing the first receipt.
  // Both rewards remain Worker/D1-owned; the client only queues their validated receipts.
  const firstAwardedCharacter = sql("SELECT level, xp, currency FROM characters WHERE player_id='" + playerId + "'")[0];
  assert.deepEqual(firstAwardedCharacter, { level: 2, xp: 25, currency: 30 },
    'the first reward must be persisted before starting the next encounter');
  await tap("[data-start-battle]");
  await until('second manifested battle with the first receipt retained', () => cdp.evaluate(
    '!!document.querySelector("[data-ability=crack]") && document.querySelector("#battle-accessible-hud")?.textContent.includes("Mana 12 of 12")',
  ));
  const secondPermitRow = await until('second Worker-issued battle permit', () => sql(
    "SELECT id FROM battle_permits WHERE player_id='" + playerId + "' AND event_key='underpass' AND encounter_key='tunnel-maw' AND completed_at IS NULL AND battle_status='active' AND id<>'" + permitId + "' ORDER BY started_at DESC LIMIT 1",
  )[0]);
  const secondPermitId = secondPermitRow.id;
  assert.notEqual(secondPermitId, permitId, 'the second encounter must receive its own permit');
  assert.equal(await cdp.evaluate('document.querySelector("[data-battle-reward-receipt]")?.dataset.permitId'), permitId,
    'starting another encounter must not replace the first receipt');
  await assertFitsMobile('Second battle with a queued receipt');

  for (let turn = 1; turn <= 3; turn++) {
    await until('second battle Crack ready ' + turn, () => cdp.evaluate(
      'document.querySelector("[data-ability=crack]")?.disabled === false',
    ));
    await tap("[data-ability=crack]");
    await until('second battle turn ' + turn + ' persisted', () => {
      const row = sql("SELECT player_hp, player_mana, enemy_hp, battle_status, turn_count FROM battle_permits WHERE id='" + secondPermitId + "'")[0];
      return row?.turn_count === turn && row?.battle_status === (turn === 3 ? 'victory' : 'active') ? row : null;
    });
  }
  const secondSettledPermit = await until('second battle reward settled', () => {
    const row = sql("SELECT battle_status, reward_state, reward_tier, player_mana, turn_count, completed_at FROM battle_permits WHERE id='" + secondPermitId + "'")[0];
    return row?.battle_status === 'victory' && row?.reward_state === 'awarded' && row?.completed_at ? row : null;
  });
  assert.equal(secondSettledPermit.reward_tier, 'full');
  await until('Underpass returned after the second victory', () => cdp.evaluate('!!document.querySelector("[data-start-battle]")'));
  assert.equal(await cdp.evaluate('document.querySelector("[data-battle-reward-receipt]")?.dataset.permitId'), permitId,
    'the older receipt must stay at the front while the second reward settles');

  await tap("[data-route=home]");
  await until('reward receipt remains visible on Home', () => cdp.evaluate('!!document.querySelector("[data-battle-reward-receipt]")'));
  await until('Server-earned trophy in Home', () => cdp.evaluate('document.querySelector(".furniture-list")?.textContent?.includes("Underpass Trophy")'), 30000);

  // The earned trophy must be usable as actual housing furniture, not only
  // present in inventory. Place it, then reload through the real Worker/D1
  // bootstrap path and prove the room snapshot restores that display.
  await tap('[data-furniture="tunnel-trophy"]');
  await until('earned trophy selected for display', () => cdp.evaluate(
    'document.querySelector("[data-furniture=tunnel-trophy]")?.classList.contains("selected") === true',
  ));
  await tap('[data-room-x="4"][data-room-y="2"]');
  const earnedTrophyCellSelector = '[data-room-x="4"][data-room-y="2"]';
  await until('earned trophy placed in the room', () => cdp.evaluate(
    'document.querySelector(' + JSON.stringify(earnedTrophyCellSelector) + ')?.getAttribute("aria-label")?.includes("Underpass Trophy") === true',
  ));
  await until('earned trophy saved to local D1', () =>
    sql("SELECT COUNT(*) AS count FROM housing_placements WHERE player_id='" + playerId + "' AND furniture_key='tunnel-trophy' AND grid_x=4 AND grid_y=2")[0]?.count === 1 ? true : null);
  assert.equal(sql("SELECT COUNT(*) AS count FROM housing_placements WHERE player_id='" + playerId + "' AND furniture_key='tunnel-trophy' AND grid_x=4 AND grid_y=2")[0]?.count, 1,
    'the earned trophy must persist at the selected room cell');
  await tap('[data-dismiss-reward]');
  await until('second recovered receipt advances after first dismissal', () => cdp.evaluate(
    'document.querySelector("[data-battle-reward-receipt]")?.dataset.permitId === ' + JSON.stringify(secondPermitId),
  ));
  const secondReceiptText = await cdp.evaluate('document.querySelector("[data-battle-reward-receipt]")?.textContent ?? ""');
  assert.match(secondReceiptText, /FULL CLEAR/);
  assert.match(secondReceiptText, /\+75 XP/);
  assert.match(secondReceiptText, /\+30 CR/);
  assert.doesNotMatch(secondReceiptText, /LEVEL UP/,
    'the second receipt must not reuse the first encounter level-up transition');
  await assertFitsMobile('Second queued reward receipt');
  await tap('[data-dismiss-reward]');
  assert.equal(await cdp.evaluate('!!document.querySelector("[data-battle-reward-receipt]")'), false,
    'each recovered receipt can be dismissed without altering awarded player state');
  const finalPermit = sql("SELECT battle_status, reward_state, player_mana, turn_count, completed_at FROM battle_permits WHERE id='" + permitId + "'")[0];
  assert.equal(finalPermit?.battle_status, 'victory');
  assert.equal(finalPermit?.reward_state, 'awarded');
  assert.equal(finalPermit?.player_mana, 0);
  assert.equal(finalPermit?.turn_count, 3);
  assert.ok(finalPermit?.completed_at, 'Worker should persist completion after awarding the victory receipt');
  assert.equal(await cdp.evaluate('localStorage.getItem(' + JSON.stringify(startStorageKey) + ')'), null,
    'only the accepted authoritative reward receipt clears the active start key');
  assert.equal(await cdp.evaluate('window.__degenLostActionResponses'), 2,
    'both the first active turn and the killing blow should recover after their committed responses are lost');
  assert.equal(await cdp.evaluate('window.__degenTimedOutActionResponses'), 1,
    'a committed turn whose response times out must reconcile through the same-turn CAS retry');
  assert.equal(await cdp.evaluate('window.__degenTimedOutCompletionResponses'), 1,
    'a settled reward whose response times out must recover through the identical completion retry');
  const awardedCharacter = sql("SELECT level, xp, currency FROM characters WHERE player_id='" + playerId + "'")[0];
  assert.equal(awardedCharacter?.level, 2, 'the Worker must persist the level-up earned by the first reward');
  assert.equal(awardedCharacter?.xp, 100, 'both Worker receipts must award XP exactly once');
  assert.equal(awardedCharacter?.currency, 60, 'both Worker receipts must award currency exactly once');
  const awardedScrap = sql("SELECT quantity FROM player_inventory WHERE player_id='" + playerId + "' AND item_key='underpass-scrap' AND item_type='item'")[0];
  assert.equal(awardedScrap?.quantity, 2, 'each full clear must add one scrap without replay duplication');
  const awardedTrophy = sql("SELECT COUNT(*) AS count FROM player_inventory WHERE player_id='" + playerId + "' AND item_key='tunnel-trophy' AND item_type='furniture'")[0];
  assert.equal(awardedTrophy?.count, 1, 'the recovered completion must grant one trophy');
  const victoryHistory = sql("SELECT COUNT(*) AS count FROM battle_history WHERE player_id='" + playerId + "' AND encounter_key='tunnel-maw' AND result='victory'")[0];
  assert.equal(victoryHistory?.count, 2,
    'both completed encounters must settle exactly one victory-history row each');
  const secondFinalPermit = sql("SELECT battle_status, reward_state, reward_tier, player_mana, turn_count, completed_at FROM battle_permits WHERE id='" + secondPermitId + "'")[0];
  assert.equal(secondFinalPermit?.battle_status, 'victory');
  assert.equal(secondFinalPermit?.reward_state, 'awarded');
  assert.equal(secondFinalPermit?.reward_tier, 'full');
  assert.equal(secondFinalPermit?.player_mana, 0);
  assert.equal(secondFinalPermit?.turn_count, 3);
  assert.ok(secondFinalPermit?.completed_at, 'the second server-owned victory must be settled before its receipt is dismissed');

  // Reload only after checking the response-loss counters above: a new document
  // installs fresh browser instrumentation. The persisted trophy must still render.
  await cdp.send('Page.reload');
  await until('Map after trophy placement reload', () => cdp.evaluate('!!document.querySelector("[data-district=Central]")'));
  await tap('[data-route=home]');
  await until('persisted trophy displayed after reload', () => cdp.evaluate(
    'document.querySelector(' + JSON.stringify(earnedTrophyCellSelector) + ')?.getAttribute("aria-label")?.includes("Underpass Trophy") === true',
  ));
  await assertFitsMobile('Home with earned trophy');
  await assertFitsCompact('Home with earned trophy');

  // Exercise the actual running UI with an authoritative active snapshot at zero
  // Mana. The local D1 fixture models a valid Worker-owned zero-Mana snapshot
  // for UI QA; it does not add or name a Mana-drain mechanic or monster resource.
  sql("UPDATE world_event_cycles SET opens_at = datetime('now','-10 minutes'), closes_at = datetime('now','+90 minutes') WHERE id = (SELECT id FROM world_event_cycles WHERE event_key='underpass' ORDER BY closes_at DESC LIMIT 1)");
  await tap("[data-route=map]");
  await until('Map for Mana affordability check', () => cdp.evaluate('!!document.querySelector("[data-district=Central]")'));
  await tap("[data-district=Central]");
  await until('Central district for Mana affordability check', () => cdp.evaluate('!!document.querySelector("[data-location=underpass]")'));
  await tap("[data-location=underpass]");
  await until('Open Underpass for Mana affordability check', () => cdp.evaluate('(() => { const button = document.querySelector("[data-start-battle]"); return !!button && !button.disabled; })()'));
  await tap("[data-start-battle]");
  await until('second manifested battle for Mana affordability check', () => cdp.evaluate('!!document.querySelector("[data-ability=crack]") && document.querySelector("#battle-accessible-hud")?.textContent.includes("Mana 12 of 12")'));

  const affordabilityPermit = sql("SELECT id FROM battle_permits WHERE player_id='" + playerId + "' AND event_key='underpass' AND encounter_key='tunnel-maw' AND completed_at IS NULL AND battle_status='active' ORDER BY started_at DESC LIMIT 1")[0];
  assert.ok(affordabilityPermit?.id, 'the affordability scenario must use a real Worker-issued local permit');
  assert.notEqual(affordabilityPermit.id, permitId, 'the affordability scenario must not reuse the awarded permit');
  // Corrupt only the response body after the real Worker has committed a paid
  // action. The UI must retain its old snapshot and clearly ask for a safe retry;
  // that same-turn retry must recover the committed state without double-spending.
  await cdp.evaluate('window.__degenSimulateMalformedActionResponse = true');
  await tap("[data-ability=crack]");
  await until('visible recovery message after malformed Worker response', () => cdp.evaluate(`(() =>
    window.__degenMalformedActionResponses === 1
    && document.querySelector("#battle-action-status")?.textContent.includes("unreadable battle response")
  )()`));
  const clientAfterMalformed = await cdp.evaluate(`(() => ({
    hud: document.querySelector("#battle-accessible-hud")?.textContent ?? "",
    status: document.querySelector("#battle-action-status")?.textContent ?? ""
  }))()`);
  assert.match(clientAfterMalformed.hud, /Mana 12 of 12.*Turn 0\./,
    'the client must not apply a turn when the response cannot be parsed');
  assert.match(clientAfterMalformed.status, /same move again to safely resync/i);
  const committedMalformedTurn = sql("SELECT player_hp, player_mana, enemy_hp, battle_status, turn_count FROM battle_permits WHERE id='" + affordabilityPermit.id + "'");
  assert.deepEqual(committedMalformedTurn, [{
    player_hp: 110, player_mana: 8, enemy_hp: 57, battle_status: 'active', turn_count: 1,
  }], 'the test must prove the Worker committed exactly one turn before the malformed response');

  await tap("[data-ability=crack]");
  await until('safe same-turn retry resynchronizes from the Worker', () => cdp.evaluate(`(() => {
    const hud = document.querySelector("#battle-accessible-hud")?.textContent ?? "";
    const status = document.querySelector("#battle-action-status")?.textContent ?? "";
    return status === "Battle state refreshed from the server. Choose your next move."
      && hud.includes("Mana 8 of 12") && hud.includes("Turn 1.");
  })()`));
  assert.deepEqual(sql("SELECT player_hp, player_mana, enemy_hp, battle_status, turn_count FROM battle_permits WHERE id='" + affordabilityPermit.id + "'"), committedMalformedTurn,
    'safe retry must recover the committed turn without applying damage or Mana twice');

  // Model a recovered encounter after its persisted Mana snapshot has changed.
  // Leave and resume through the real Worker start/replay path so the client reads
  // the authoritative zero-Mana state instead of accepting conflicting same-turn data.
  sql("UPDATE battle_permits SET player_mana=0 WHERE id='" + affordabilityPermit.id + "' AND player_id='" + playerId + "' AND completed_at IS NULL");
  await tap("[data-route=underpass]");
  await until('Underpass exposes the active encounter for recovery', () => cdp.evaluate(`(() => {
    const resume = document.querySelector("[data-resume-battle]");
    return !!resume && !resume.disabled;
  })()`));
  await tap("[data-resume-battle]");
  await until('resumed authoritative zero-Mana snapshot disables the paid move', () => cdp.evaluate(`(() => {
    const paid = document.querySelector("[data-ability=crack]");
    const free = document.querySelector("[data-ability=slash]");
    const hud = document.querySelector("#battle-accessible-hud")?.textContent ?? "";
    return paid?.disabled === true
      && paid.querySelector("small")?.textContent === "NEED 4 MANA"
      && free?.disabled === false
      && free.querySelector("small")?.textContent === "NO MANA"
      && hud.includes("Mana 0 of 12") && hud.includes("Turn 1.");
  })()`));
  await assertFitsMobile('Mana-starved battle');
  await assertFitsCompact('Mana-starved battle');

  // Corrupt only the rendered cost metadata to exercise the UI fail-closed
  // guard in the live app. The Worker still resolves the real zero-cost slash.
  await cdp.evaluate('document.querySelector("[data-ability=crack]")?.setAttribute("data-mana-cost", "NaN")');
  await tap("[data-ability=slash]");
  await until('invalid Mana cost metadata fails closed after an authoritative refresh', () => cdp.evaluate(`(() => {
    const paid = document.querySelector("[data-ability=crack]");
    const free = document.querySelector("[data-ability=slash]");
    const hud = document.querySelector("#battle-accessible-hud")?.textContent ?? "";
    return paid?.disabled === true && paid.querySelector("small")?.textContent === "UNAVAILABLE"
      && free?.disabled === false && free.querySelector("small")?.textContent === "NO MANA"
      && hud.includes("Mana 0 of 12") && hud.includes("Turn 2.");
  })()`));
  await assertFitsMobile('Malformed Mana cost');
  await assertFitsCompact('Malformed Mana cost');
  const zeroManaActive = sql("SELECT player_hp, player_mana, enemy_hp, battle_status, turn_count FROM battle_permits WHERE id='" + affordabilityPermit.id + "'")[0];
  assert.deepEqual(zeroManaActive, {
    player_hp: 100, player_mana: 0, enemy_hp: 28, battle_status: 'active', turn_count: 2,
  }, 'the free action advances the real Worker-backed battle while Mana remains zero');
  await until('Phaser keeps the Degen manifested at zero Mana in the running app', () => cdp.evaluate(`(() => {
    const rendered = window.__degenRenderedBattleText || [];
    const mana = rendered.lastIndexOf("MANA 0/12");
    return mana >= 0 && rendered.lastIndexOf("MANIFESTED") > mana;
  })()`));

  console.log('PASS Chromium + Vite + local Wrangler/D1: Map > District > Location > Home/Underpass > Degen battle > Worker reward > Home trophy, plus city zoom, zero-Mana affordability feedback and free-action continuation');
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
