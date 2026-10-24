import assert from 'node:assert/strict';
import test from 'node:test';

import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';
import type { BattleSnapshot } from '../src/game/combat/engine.ts';
import { battleView, updateBattleDom } from '../src/ui/views.ts';
import type { PlayerState } from '../src/domain/types.ts';

const player: PlayerState = {
  id: 'mana-ui-player',
  displayName: 'Mana Tester',
  level: 1,
  xp: 0,
  currency: 0,
  degenId: TEST_DEGEN.id,
  inventory: [],
  unlockedLocations: [],
  housing: { inventory: [], placements: [] },
  defeatedBosses: [],
};

const snapshot = (playerMana: number): BattleSnapshot => ({
  status: 'active',
  playerName: TEST_DEGEN.name,
  playerHp: TEST_DEGEN.maxHp,
  playerMaxHp: TEST_DEGEN.maxHp,
  playerMana,
  playerMaxMana: TEST_DEGEN.maxMana,
  turnCount: 0,
  enemyName: TUNNEL_MAW.name,
  enemyLevel: TUNNEL_MAW.level,
  enemyHp: TUNNEL_MAW.maxHp,
  enemyMaxHp: TUNNEL_MAW.maxHp,
  log: [],
});

test('ability controls visibly disclose zero and paid Mana costs', () => {
  const markup = battleView(player, TEST_DEGEN);
  assert.match(markup, /data-mana-cost="0"/);
  assert.match(markup, /NO MANA/);
  assert.match(markup, /data-mana-cost="4"/);
  assert.match(markup, /4 MANA/);
});

test('ability controls disable only unaffordable abilities and preserve free actions at zero Mana', () => {
  const log = { innerHTML: '', append: () => undefined };
  const buttons = [
    { dataset: { manaCost: '0' }, disabled: false },
    { dataset: { manaCost: '4' }, disabled: false },
  ];
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      querySelector: () => log,
      querySelectorAll: () => buttons,
    },
  });

  try {
    updateBattleDom(snapshot(0));
    assert.equal(buttons[0].disabled, false, 'zero-cost action remains usable at zero Mana');
    assert.equal(buttons[1].disabled, true, 'paid action is unavailable when unaffordable');

    updateBattleDom(snapshot(4));
    assert.equal(buttons[0].disabled, false);
    assert.equal(buttons[1].disabled, false, 'paid action becomes available once affordable');
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
