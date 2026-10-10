import assert from 'node:assert/strict';
import test from 'node:test';
import { TEST_DEGEN } from '../src/data/combatPrototype.ts';
import type { BattleSnapshot } from '../src/game/combat/engine.ts';
import { battleView, updateBattleDom } from '../src/ui/views.ts';

const player = {
  id: 'p', displayName: 'Tester', level: 1, xp: 0, currency: 0,
  degenId: TEST_DEGEN.id, inventory: [], unlockedLocations: [],
  housing: { inventory: [], placements: [] }, defeatedBosses: [],
};
const snapshot: BattleSnapshot = {
  status: 'active', playerName: TEST_DEGEN.name,
  playerHp: 120, playerMaxHp: 120, playerMana: 0, playerMaxMana: 12,
  enemyName: 'Tunnel Maw', enemyLevel: 1,
  enemyHp: 92, enemyMaxHp: 92, log: ['Ready'],
};

test('bespoke ability buttons show explicit Degen Mana costs', () => {
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
  const appended: Array<{ textContent: string; className: string }> = [];
  const log = { innerHTML: '', append: (item: { textContent: string; className: string }) => appended.push(item) };
  const fakeDocument = {
    querySelector: (selector: string) => selector === '#battle-log' ? log : null,
    querySelectorAll: (selector: string) => selector === '[data-ability]' ? buttons : [],
    createElement: () => ({ textContent: '', className: '' }),
  };
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: fakeDocument });
  try {
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
  } finally {
    if (prior) Object.defineProperty(globalThis, 'document', prior);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
