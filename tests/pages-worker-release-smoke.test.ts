import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyPagesWorker } from '../scripts/verify-pages-worker-readonly.mjs';

const pages = 'https://degen-8ze.pages.dev';
const worker = 'https://degen-api.afterdarklabs.workers.dev';

function fixture(options: Record<string, boolean> = {}) {
  const requests: Array<{ url: string; method: string }> = [];
  const fetcher = async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    requests.push({ url, method });
    const origin = (init.headers as Record<string, string> | undefined)?.Origin;
    if (url === pages + '/') return new Response(options.missingPage ? '' : '<script type="module" src="/assets/game.js"></script>', { status: options.missingPage ? 404 : 200 });
    if (url === pages + '/assets/game.js') return new Response(options.missingApi ? 'const API=""' : `const API="${worker}"`, { status: 200 });
    if (url === worker + '/api/health') return new Response(JSON.stringify({ ok: true }), { status: options.unhealthy ? 503 : 200,
      headers: { 'access-control-allow-origin': options.badCors ? 'https://wrong.example' : pages } });
    if ([worker + '/api/player/bootstrap', worker + '/api/player/housing'].includes(url) && method === 'OPTIONS') {
      const allow = origin === pages || options.reflectPreview;
      return new Response(null, { status: 204, headers: {
        'access-control-allow-origin': options.wildcardPreview && origin !== pages ? '*' : options.nullPreview && origin !== pages ? 'null' : allow ? origin! : 'https://milesgoeswildtv.github.io',
        'access-control-allow-methods': options.noPost ? 'GET,PUT,OPTIONS' : options.noPut ? 'GET,POST,OPTIONS' : 'GET,POST,PUT,OPTIONS',
        'access-control-allow-headers': options.noContentType ? 'x-custom' : 'content-type',
      } });
    }
    return new Response(null, { status: 404 });
  };
  return { requests, fetcher };
}

test('read-only release gate verifies published API URL and exact-origin CORS', async () => {
  const { fetcher, requests } = fixture();
  const result = await verifyPagesWorker({ pagesUrl: pages, workerUrl: worker, fetcher });
  assert.equal(result.status, 'PASS');
  assert.deepEqual(requests.map(request => request.method), ['GET', 'GET', 'GET', 'OPTIONS', 'OPTIONS', 'OPTIONS']);
  assert.ok(requests.every(request => request.url.startsWith(pages) || request.url.startsWith(worker)));
});

for (const [name, options, pattern] of [
  ['missing Pages', { missingPage: true }, /Pages homepage/],
  ['missing frontend API URL', { missingApi: true }, /Published JS/],
  ['missing Worker CORS', { badCors: true }, /Worker health CORS/],
  ['unhealthy Worker', { unhealthy: true }, /Worker health/],
  ['missing POST preflight', { noPost: true }, /POST must be allowed/],
  ['missing PUT preflight', { noPut: true }, /PUT must be allowed/],
  ['missing content-type header', { noContentType: true }, /content-type request header/],
  ['reflected preview origin', { reflectPreview: true }, /Unapproved preview origin/],
  ['wildcard preview origin', { wildcardPreview: true }, /wildcard CORS/],
  ['opaque null preview origin', { nullPreview: true }, /opaque-origin CORS/],
] as const) {
  test(`read-only release gate rejects ${name}`, async () => {
    await assert.rejects(verifyPagesWorker({ pagesUrl: pages, workerUrl: worker, fetcher: fixture(options).fetcher }), pattern);
  });
}

for (const [label, url] of [
  ['HTTP non-loopback', 'http://example.com'],
  ['credentials', 'https://user:secret@degen-8ze.pages.dev'],
  ['path', pages + '/index.html'],
  ['query', pages + '/?token=bad'],
] as const) {
  test(`read-only release gate rejects unsafe ${label}`, async () => {
    await assert.rejects(verifyPagesWorker({ pagesUrl: url, workerUrl: worker, fetcher: fixture().fetcher }));
  });
}
