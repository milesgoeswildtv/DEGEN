import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { TEST_DEGEN } from '../src/data/combatPrototype.ts';

// Execute the real view source without Node's unsupported extensionless Vite imports.
const source = readFileSync(new URL('../src/ui/views.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/^export const /gm, 'const ');
const stripped = stripTypeScriptTypes(source, { mode: 'transform' });
const views = (document = {}) => runInNewContext(stripped + '\n({ battleView, updateBattleDom });', {
  FURNITURE_CATALOG: [], WORLD_LOCATIONS: [], getFurniture: () => undefined, document,
});
const player = {
  id: 'p', displayName: 'Tester', level: 1, xp: 0, currency: 0,
  degenId: TEST_DEGEN.id, inventory: [], unlockedLocations: [],
  housing: { inventory: [], placements: [] }, defeatedBosses: [],
};
const snapshot = {
  status: 'active', playerName: TEST_DEGEN.name,
  playerHp: 120, playerMaxHp: 120, playerMana: 0, playerMaxMana: 12,
  enemyName: 'Tunnel Maw', enemyLevel: 1,
  enemyHp: 92, enemyMaxHp: 92, log: ['Ready'],
};

test('bespoke ability buttons show explicit Degen Mana costs', () => {
  const { battleView } = views();
  const html = battleView(player, TEST_DEGEN);
  assert.match(html, /data-ability="crack" data-mana-cost="4"/);
  assert.match(html, /data-ability="slash" data-mana-cost="0"/);
  assert.match(html, /4 MANA/);
  assert.match(html, /NO MANA/);
});

test('zero Mana disables paid abilities, preserves free ability, and victory disables both', () => {
  const buttons = [
    { dataset: { manaCost: '4' }, disabled: false },
    { dataset: { manaCost: '0' }, disabled: false },
  ];
  const appended = [];
  const log = { innerHTML: '', append: item => appended.push(item) };
  const fakeDocument = {
    querySelector: selector => selector === '#battle-log' ? log : null,
    querySelectorAll: selector => selector === '[data-ability]' ? buttons : [],
    createElement: () => ({ textContent: '', className: '' }),
  };
  const { updateBattleDom } = views(fakeDocument);
  updateBattleDom(snapshot);
  assert.equal(buttons[0].disabled, true);
  assert.equal(buttons[1].disabled, false);
  assert.match(log.innerHTML, /Ready/);

  updateBattleDom({ ...snapshot, playerMana: 4 });
  assert.equal(buttons[0].disabled, false);
  assert.equal(buttons[1].disabled, false);

  updateBattleDom({ ...snapshot, status: 'victory', playerMana: 0 });
  assert.equal(buttons[0].disabled, true);
  assert.equal(buttons[1].disabled, true);
  assert.equal(appended.at(-1)?.textContent, 'VICTORY — verifying rewards.');
});
