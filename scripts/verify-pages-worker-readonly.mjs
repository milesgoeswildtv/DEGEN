#!/usr/bin/env node
// Read-only production release gate: GET Pages assets/Worker health, OPTIONS preflight.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

function strictOrigin(value, label) {
  const url = new URL(value);
  assert.ok(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)), `${label}: HTTPS required except loopback`);
  assert.equal(url.username, '', `${label}: credentials prohibited`);
  assert.equal(url.password, '', `${label}: credentials prohibited`);
  assert.equal(url.pathname, '/', `${label}: origin only`);
  assert.equal(url.search, '', `${label}: query prohibited`);
  assert.equal(url.hash, '', `${label}: fragment prohibited`);
  return url.origin;
}

export async function verifyPagesWorker({ pagesUrl, workerUrl, fetcher = fetch, timeoutMs = 15000 }) {
  const pages = strictOrigin(pagesUrl, 'PAGES_URL');
  const worker = strictOrigin(workerUrl, 'WORKER_URL');
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 60000, 'timeoutMs must be 1000–60000');
  const request = (url, init = {}) => fetcher(url, {
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs), ...init,
  });
  const page = await request(pages + '/');
  assert.equal(page.status, 200, 'Pages homepage must return 200');
  const html = await page.text();
  const scriptUrls = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g)]
    .map(match => new URL(match[1], pages).href)
    .filter(url => new URL(url).origin === pages);
  assert.ok(scriptUrls.length, 'Pages must serve its own JS bundle');
  let hasApiBase = false;
  for (const asset of scriptUrls.slice(0, 10)) {
    const response = await request(asset);
    assert.equal(response.status, 200, `Pages JS bundle unavailable: ${asset}`);
    if ((await response.text()).includes(worker)) hasApiBase = true;
  }
  assert.ok(hasApiBase, `Published JS must embed Worker API origin ${worker}`);
  const health = await request(worker + '/api/health', { headers: { Origin: pages } });
  assert.equal(health.status, 200, 'Worker health must return 200');
  assert.equal(health.headers.get('access-control-allow-origin'), pages, 'Worker health CORS must allow Pages origin');
  assert.equal((await health.json()).ok, true, 'Worker health payload must be ok');
  const preflight = origin => request(worker + '/api/player/bootstrap', {
    method: 'OPTIONS', headers: {
      Origin: origin, 'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type',
    },
  });
  const allowed = await preflight(pages);
  assert.equal(allowed.status, 204, 'Pages preflight must return 204');
  assert.equal(allowed.headers.get('access-control-allow-origin'), pages, 'Pages preflight CORS must match exactly');
  assert.match(allowed.headers.get('access-control-allow-methods') ?? '', /\bPOST\b/, 'POST must be allowed');
  const preview = pages.replace('://', '://preview-not-allowed.');
  const denied = await preflight(preview);
  assert.notEqual(denied.headers.get('access-control-allow-origin'), preview, 'Unapproved preview origin must not be reflected');
  return { status: 'PASS', mode: 'READ_ONLY', pages, worker, checked: ['published JS API base', 'Worker health', 'Pages preflight', 'preview-origin rejection'] };
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
