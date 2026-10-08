import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

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
