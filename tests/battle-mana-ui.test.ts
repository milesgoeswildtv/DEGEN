import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype.ts';
import { isValidManaCost, isValidManaState, isValidShieldGain } from '../src/game/combat/rules.ts';
import type { BattleSnapshot } from '../src/game/combat/engine.ts';
import type { PlayerState } from '../src/domain/types.ts';

const viewsSource = readFileSync(new URL('../src/ui/views.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/\bexport const /g, 'const ');
const viewContext: Record<string, unknown> = {
  isValidManaCost,
  isValidManaState,
  isValidShieldGain,
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
  playerShield: 0,
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


test('Shield ability gains and the authoritative remaining Shield are visible in the battle HUD', () => {
  const shieldDegen = {
    ...TEST_DEGEN,
    abilities: [{ ...TEST_DEGEN.abilities[0]!, shieldGain: 5 }],
  };
  const markup = battleView(player, shieldDegen as typeof TEST_DEGEN);
  assert.match(markup, /data-shield-gain="5"/);
  assert.match(markup, /NO MANA · SHIELD \\+5/);

  const log = { innerHTML: '', append: () => undefined };
  const accessibleHud = { textContent: '' };
  const manaPill = { textContent: '' };
  const shieldPill = { textContent: '' };
  const fakeDocument = {
    querySelector: (selector: string) => ({
      '#battle-accessible-hud': accessibleHud,
      '#battle-mana': manaPill,
      '#battle-shield': shieldPill,
      '#battle-log': log,
    } as Record<string, unknown>)[selector],
    querySelectorAll: () => [],
  };
  const boundUi = runInNewContext(
    stripTypeScriptTypes(viewsSource, { mode: 'transform' }) + '\\n({ updateBattleDom });',
    { document: fakeDocument, isValidManaCost, isValidManaState, isValidShieldGain },
  ) as { updateBattleDom: (state: BattleSnapshot) => void };

  boundUi.updateBattleDom({ ...snapshot(0), playerShield: 7, turnCount: 2 });
  assert.equal(manaPill.textContent, 'MANA 0/12');
  assert.equal(shieldPill.textContent, 'SHIELD 7');
  assert.match(accessibleHud.textContent, /Mana 0 of 12, Shield 7/);
});
