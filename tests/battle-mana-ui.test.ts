import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';
import { isValidManaCost, isValidManaState } from '../src/game/combat/rules.ts';
import type { BattleSnapshot } from '../src/game/combat/engine.ts';
import type { PlayerState } from '../src/domain/types.ts';

const viewsSource = readFileSync(new URL('../src/ui/views.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/\bexport const /g, 'const ');
const viewContext: Record<string, unknown> = {
  isValidManaCost,
  isValidManaState,
  FURNITURE_CATALOG: [],
  WORLD_LOCATIONS: [],
  getFurniture: () => undefined,
};
const { battleView, updateBattleDom } = runInNewContext(
  stripTypeScriptTypes(viewsSource, { mode: 'transform' }) + '\n({ battleView, updateBattleDom });',
  viewContext,
) as {
  battleView: (player: PlayerState, degen: typeof TEST_DEGEN) => string;
  updateBattleDom: (snapshot: BattleSnapshot) => void;
};

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
  const buttonWithCostLabel = (manaCost: string, label: string) => {
    const costLabel = { textContent: label };
    return {
      dataset: { manaCost },
      disabled: false,
      costLabel,
      querySelector: (selector: string) => selector === 'small' ? costLabel : null,
    };
  };
  const buttons = [
    buttonWithCostLabel('0', 'NO MANA'),
    buttonWithCostLabel('4', '4 MANA'),
  ];
  viewContext.document = {
    querySelector: () => log,
    querySelectorAll: () => buttons,
  };

  try {
    updateBattleDom(snapshot(0));
    assert.equal(buttons[0].disabled, false, 'zero-cost action remains usable at zero Mana');
    assert.equal(buttons[1].disabled, true, 'paid action is unavailable when unaffordable');
    assert.equal(buttons[0].costLabel.textContent, 'NO MANA');
    assert.equal(buttons[1].costLabel.textContent, 'NEED 4 MANA');

    updateBattleDom(snapshot(4));
    assert.equal(buttons[0].disabled, false);
    assert.equal(buttons[1].disabled, false, 'paid action becomes available once affordable');
    assert.equal(buttons[1].costLabel.textContent, '4 MANA');
  } finally {
    Reflect.deleteProperty(viewContext, 'document');
  }
});
