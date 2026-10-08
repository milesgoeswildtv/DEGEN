import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

const config = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const allowlist = /^ALLOWED_ORIGINS = "([^"]+)"$/m.exec(config)?.[1]?.split(',').map((s) => s.trim());

test('production Pages is an exact Worker CORS origin', () => {
  assert.ok(allowlist);
  assert.ok(allowlist.includes('https://degen-8ze.pages.dev'));
});

test('legacy and local development origins remain supported', () => {
  assert.ok(allowlist);
  assert.ok(allowlist.includes('https://milesgoeswildtv.github.io'));
  assert.ok(allowlist.includes('http://localhost:5173'));
});

test('unapproved preview, scheme mismatch and wildcard are not allowed', () => {
  assert.ok(allowlist);
  assert.ok(allowlist.every((origin) => !origin.includes('*')));
  for (const origin of [
    'https://7f122271.degen-8ze.pages.dev',
    'https://degen-8ze.pages.dev.evil.example',
    'http://degen-8ze.pages.dev',
  ]) assert.ok(!allowlist.includes(origin));
});

const workerSource = readFileSync(new URL('../worker/index.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '')
  .replace(/^export default\s*\{/m, 'const worker = {');
const worker = runInNewContext(stripTypeScriptTypes(workerSource, { mode: 'transform' }) + '\nworker;', {
  Request, Response, URL, crypto, console, Uint32Array,
}) as { fetch(request: Request, env: { ALLOWED_ORIGINS: string }): Promise<Response> };

async function preflight(origin: string): Promise<Response> {
  const request = new Request('https://degen-api.afterdarklabs.workers.dev/api/player/bootstrap', {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
  });
  return worker.fetch(request, { ALLOWED_ORIGINS: allowlist!.join(',') });
}

test('real Worker OPTIONS responds to production Pages origin', async () => {
  const response = await preflight('https://degen-8ze.pages.dev');
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://degen-8ze.pages.dev');
  assert.equal(response.headers.get('vary'), 'Origin');
  assert.match(response.headers.get('access-control-allow-methods') ?? '', /POST/);
});

test('real Worker OPTIONS preserves legacy and local origins', async () => {
  for (const origin of ['https://milesgoeswildtv.github.io', 'http://localhost:5173']) {
    const response = await preflight(origin);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
  }
});

test('real Worker OPTIONS never echoes an unapproved origin', async () => {
  for (const origin of ['null', 'https://7f122271.degen-8ze.pages.dev', 'https://degen-8ze.pages.dev.evil.example']) {
    const response = await preflight(origin);
    assert.notEqual(response.headers.get('access-control-allow-origin'), origin);
  }
});
