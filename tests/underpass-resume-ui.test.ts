import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../src/ui/views.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\\r?\\n/gm, '')
  .replace(/\\bexport const /g, 'const ');
const ui = runInNewContext(
  stripTypeScriptTypes(source, { mode: 'transform' }) + '\\n({ underpassView });',
  {},
) as {
  underpassView: (
    player: { displayName: string; level: number; currency: number },
    event: { phase: 'sealed' | 'warning' | 'open'; opensAt: string; closesAt: string; fullRewardClears: number; fullRewardLimit: number; source: 'server' | 'preview' },
    hasRecoverableEncounter?: boolean,
  ) => string;
};

const player = { displayName: 'Player', level: 1, currency: 0 };
const sealedEvent = {
  eventKey: 'underpass',
  cycleId: 'closed-cycle',
  phase: 'sealed' as const,
  opensAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  closesAt: new Date(Date.now() - 1_000).toISOString(),
  fullRewardClears: 0,
  fullRewardLimit: 4,
  source: 'server' as const,
};

test('a sealed Underpass keeps a recoverable active encounter available', () => {
  const html = ui.underpassView(player, sealedEvent, true);
  assert.match(html, /data-resume-battle/);
  assert.match(html, /RESUME ACTIVE ENCOUNTER/);
  assert.match(html, /id="underpass-action-status"[^>]*role="status"[^>]*hidden/);
  assert.doesNotMatch(html, /data-start-battle/);
});

test('a sealed Underpass without a recoverable permit remains sealed', () => {
  const html = ui.underpassView(player, sealedEvent, false);
  assert.match(html, /data-start-battle disabled/);
  assert.match(html, /UNDERPASS SEALED/);
  assert.doesNotMatch(html, /data-resume-battle/);
});
