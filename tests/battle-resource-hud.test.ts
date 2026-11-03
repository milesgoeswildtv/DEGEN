import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

import { TEST_DEGEN } from '../src/data/combatPrototype.ts';
import { isValidManaCost, isValidManaState, isValidShieldGain } from '../src/game/combat/rules.ts';

const source = readFileSync(new URL('../src/ui/views.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/\bexport const /g, 'const ');
const hpPill = { textContent: '' };
const manaPill = { textContent: '' };
const shieldPill = { textContent: '' };
const enemyHpPill = { textContent: '' };
const enemyShieldPill = { textContent: '', hidden: false };
const accessibleHud = { textContent: '' };
const log = { innerHTML: '', append: () => undefined };
const fakeDocument = {
  querySelector(selector: string) {
    return ({
      '#battle-accessible-hud': accessibleHud,
      '#battle-hp': hpPill,
      '#battle-mana': manaPill,
      '#battle-shield': shieldPill,
      '#battle-enemy-hp': enemyHpPill,
      '#battle-enemy-shield': enemyShieldPill,
      '#battle-log': log,
    } as Record<string, unknown>)[selector] ?? null;
  },
  querySelectorAll: () => [],
};
const { battleView, updateBattleDom } = runInNewContext(
  stripTypeScriptTypes(source, { mode: 'transform' }) + '\n({ battleView, updateBattleDom });',
  { document: fakeDocument, isValidManaCost, isValidManaState, isValidShieldGain },
) as {
  battleView: (player: { displayName: string; level: number; currency: number }, degen: typeof TEST_DEGEN) => string;
  updateBattleDom: (snapshot: {
    status: 'active' | 'victory' | 'defeat';
    playerName: string; playerHp: number; playerMaxHp: number;
    playerMana: number; playerMaxMana: number; playerShield: number;
    enemyName: string; enemyHp: number; enemyMaxHp: number;
    turnCount: number; log: string[];
  }) => void;
};

const player = { displayName: 'Player', level: 1, currency: 0 };

test('battle resource HUD starts with the Degen maximum HP', () => {
  const html = battleView(player, TEST_DEGEN);
  assert.ok(html.includes('role="group" aria-label="Combat status"'));
  assert.doesNotMatch(html, /class="battle-resources"[^>]*aria-live=/,
    'the hidden combined HUD is the single live region, avoiding duplicate status announcements');
  assert.ok(html.includes('id="battle-hp" class="battle-resource">HP 120/120'));
  assert.ok(html.includes('id="battle-enemy-hp" class="battle-resource">ENEMY HP 92/92'));
});

test('visible HP pill follows the Worker-backed battle snapshot on every update', () => {
  updateBattleDom({
    status: 'active',
    playerName: 'TEST_DEGEN', playerHp: 83, playerMaxHp: 120,
    playerMana: 8, playerMaxMana: 12, playerShield: 5,
    enemyName: 'Tunnel Maw', enemyHp: 51, enemyMaxHp: 92,
    turnCount: 2, log: [],
  });
  assert.equal(hpPill.textContent, 'HP 83/120');
  assert.equal(manaPill.textContent, 'MANA 8/12');
  assert.equal(shieldPill.textContent, 'SHIELD 5');
  assert.equal(enemyHpPill.textContent, 'ENEMY HP 51/92');
});
