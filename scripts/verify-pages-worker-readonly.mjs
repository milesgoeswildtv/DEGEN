#!/usr/bin/env node
// Read-only production release gate: GET Pages assets/Worker health, OPTIONS preflight.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

function strictUrl(value, label, allowDirectory = false) {
  const url = new URL(value);
  assert.ok(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)), `${label}: HTTPS required except loopback`);
  assert.equal(url.username, '', `${label}: credentials prohibited`);
  assert.equal(url.password, '', `${label}: credentials prohibited`);
  if (allowDirectory) assert.ok(url.pathname.endsWith('/'), `${label}: directory URL must end with /`);
  else assert.equal(url.pathname, '/', `${label}: origin only`);
  assert.equal(url.search, '', `${label}: query prohibited`);
  assert.equal(url.hash, '', `${label}: fragment prohibited`);
  return url;
}

export async function verifyPagesWorker({ pagesUrl, workerUrl, fetcher = fetch, timeoutMs = 15000 }) {
  const pagesBase = strictUrl(pagesUrl, 'PAGES_URL', true);
  const pages = pagesBase.origin;
  const worker = strictUrl(workerUrl, 'WORKER_URL').origin;
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 60000, 'timeoutMs must be 1000–60000');
  const request = (url, init = {}) => fetcher(url, {
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs), ...init,
  });
  const page = await request(pagesBase.href);
  assert.equal(page.status, 200, 'Pages homepage must return 200');
  const html = await page.text();
  const scriptUrls = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g)]
    .map(match => new URL(match[1], pagesBase).href)
    .filter(url => {
      const asset = new URL(url);
      return asset.origin === pages && asset.pathname.startsWith(pagesBase.pathname);
    });
  assert.ok(scriptUrls.length, 'Pages must serve its own JS bundle');
  let hasApiBase = false;
  let hasExpectedTurnContract = false;
  for (const asset of scriptUrls.slice(0, 10)) {
    const response = await request(asset);
    assert.equal(response.status, 200, `Pages JS bundle unavailable: ${asset}`);
    const bundle = await response.text();
    if (bundle.includes(worker)) hasApiBase = true;
    if (bundle.includes('expectedTurnCount')) hasExpectedTurnContract = true;
  }
  assert.ok(hasApiBase, `Published JS must embed Worker API origin ${worker}`);
  assert.ok(hasExpectedTurnContract,
    'Published JS must include expectedTurnCount before strict Worker turn enforcement');
  const health = await request(worker + '/api/health', { headers: { Origin: pages } });
  assert.equal(health.status, 200, 'Worker health must return 200');
  assert.equal(health.headers.get('access-control-allow-origin'), pages, 'Worker health CORS must allow Pages origin');
  assert.equal((await health.json()).ok, true, 'Worker health payload must be ok');
  const preflight = (origin, path, method) => request(worker + path, {
    method: 'OPTIONS', headers: {
      Origin: origin, 'Access-Control-Request-Method': method,
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  for (const [path, method] of [['/api/player/bootstrap', 'POST'], ['/api/player/housing', 'PUT']]) {
    const allowed = await preflight(pages, path, method);
    assert.equal(allowed.status, 204, `Pages ${method} preflight must return 204`);
    assert.equal(allowed.headers.get('access-control-allow-origin'), pages, `Pages ${method} preflight CORS must match exactly`);
    const methods = (allowed.headers.get('access-control-allow-methods') ?? '').split(',').map(value => value.trim());
    assert.ok(methods.includes(method), `${method} must be allowed`);
    const headers = (allowed.headers.get('access-control-allow-headers') ?? '').split(',').map(value => value.trim().toLowerCase());
    assert.ok(headers.includes('content-type'), 'content-type request header must be allowed');
  }
  const preview = pages.replace('://', '://preview-not-allowed.');
  const denied = await preflight(preview, '/api/player/bootstrap', 'POST');
  assert.notEqual(denied.headers.get('access-control-allow-origin'), preview, 'Unapproved preview origin must not be reflected');
  assert.notEqual(denied.headers.get('access-control-allow-origin'), '*', 'Unapproved preview origin must not receive wildcard CORS');
  assert.notEqual(denied.headers.get('access-control-allow-origin'), 'null', 'Unapproved preview origin must not receive opaque-origin CORS');
  return { status: 'PASS', mode: 'READ_ONLY', pages, pagesBase: pagesBase.href, worker, checked: ['published JS API base', 'expected-turn battle action contract', 'Worker health', 'bootstrap POST preflight', 'housing PUT preflight', 'content-type header', 'preview-origin rejection'] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyPagesWorker({
      pagesUrl: process.env.PAGES_URL, workerUrl: process.env.WORKER_URL,
      timeoutMs: Number(process.env.SMOKE_TIMEOUT_MS ?? 15000),
    });
    console.log(JSON.stringify(result, null, 2));
    console.log('This does not prove signed identity, account authorization, or live gameplay.');
  } catch (error) {
    console.error('READ-ONLY RELEASE GATE FAILED:', error);
    process.exitCode = 1;
  }
}
