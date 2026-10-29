import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

import { TEST_DEGEN } from '../src/data/combatPrototype.ts';

const source = readFileSync(new URL('../src/ui/views.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/\bexport const /g, 'const ');
const buttonWithCostLabel = (manaCost: string | undefined, label: string) => {
  const costLabel = { textContent: label };
  return {
    dataset: { manaCost },
    disabled: false,
    costLabel,
    querySelector: (selector: string) => selector === 'small' ? costLabel : null,
  };
};

const ui = runInNewContext(
  stripTypeScriptTypes(source, { mode: 'transform' }) + '\n({ battleView, updateBattleDom });',
  { document: undefined },
) as {
  battleView: (player: { displayName: string; level: number; currency: number }, degen: typeof TEST_DEGEN) => string;
  updateBattleDom: (snapshot: {
    status: 'active' | 'victory' | 'defeat';
    playerMana: number;
    log: string[];
  }) => void;
};

test('battle controls expose each bespoke ability Mana cost', () => {
  const html = ui.battleView({ displayName: 'Player', level: 1, currency: 0 }, TEST_DEGEN);

  assert.match(html, /data-ability="slash" data-mana-cost="0"/);
  assert.match(html, /NO MANA/);
  assert.match(html, /data-ability="crack" data-mana-cost="4"/);
  assert.match(html, /4 MANA/);
  assert.match(html, /id="battle-accessible-hud" class="visually-hidden" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /role="log" aria-label="Battle event log" aria-live="off" tabindex="0"/);
});

test('battle controls keep zero-cost abilities enabled and gate paid abilities by current Mana', () => {
  const log = { innerHTML: '', append: (_node: unknown) => undefined };
  const accessibleHud = { textContent: '' };
  const buttons = [
    buttonWithCostLabel('0', 'NO MANA'),
    buttonWithCostLabel('4', '4 MANA'),
  ];
  const fakeDocument = {
    querySelector: (selector: string) => selector === '#battle-accessible-hud' ? accessibleHud : log,
    querySelectorAll: (_selector: string) => buttons,
  };

  const boundUi = runInNewContext(
    stripTypeScriptTypes(source, { mode: 'transform' }) + '\n({ updateBattleDom });',
    { document: fakeDocument },
  ) as {
    updateBattleDom: (snapshot: {
      status: 'active' | 'victory' | 'defeat';
      playerName: string;
      playerHp: number;
      playerMaxHp: number;
      playerMana: number;
      playerMaxMana: number;
      enemyName: string;
      enemyHp: number;
      enemyMaxHp: number;
      turnCount: number;
      log: string[];
    }) => void;
  };

  const snapshot = (playerMana: number) => ({
    status: 'active' as const,
    playerName: 'TEST_DEGEN',
    playerHp: 73,
    playerMaxHp: 120,
    playerMana,
    playerMaxMana: 12,
    enemyName: 'Tunnel Maw',
    enemyHp: 51,
    enemyMaxHp: 92,
    turnCount: 2,
    log: [],
  });

  boundUi.updateBattleDom(snapshot(0));
  assert.equal(buttons[0]?.disabled, false);
  assert.equal(buttons[1]?.disabled, true);
  assert.equal(buttons[0]?.costLabel.textContent, 'NO MANA');
  assert.equal(buttons[1]?.costLabel.textContent, 'NEED 4 MANA',
    'an unaffordable paid move must explain why it is unavailable');
  assert.match(accessibleHud.textContent, /TEST_DEGEN: HP 73 of 120, Mana 0 of 12/);
  assert.match(accessibleHud.textContent, /Tunnel Maw: HP 51 of 92\. Turn 2\. Choose an action\./);

  boundUi.updateBattleDom(snapshot(4));
  assert.equal(buttons[0]?.disabled, false);
  assert.equal(buttons[1]?.disabled, false);
  assert.equal(buttons[0]?.costLabel.textContent, 'NO MANA');
  assert.equal(buttons[1]?.costLabel.textContent, '4 MANA',
    'the normal cost label returns when the move becomes affordable');
  assert.match(accessibleHud.textContent, /Mana 4 of 12/);
});

test('battle terminal outcomes announce defeat/victory and disable every ability', () => {
  const appended: Array<{ className: string; textContent: string }> = [];
  const log = {
    innerHTML: '',
    append: (node: { className: string; textContent: string }) => { appended.push(node); },
  };
  const accessibleHud = { textContent: '' };
  const buttons = [
    buttonWithCostLabel('0', 'NO MANA'),
    buttonWithCostLabel('4', '4 MANA'),
  ];
  const fakeDocument = {
    querySelector: (selector: string) => selector === '#battle-accessible-hud' ? accessibleHud : log,
    querySelectorAll: (_selector: string) => buttons,
    createElement: (_tag: string) => ({ className: '', textContent: '' }),
  };
  const boundUi = runInNewContext(
    stripTypeScriptTypes(source, { mode: 'transform' }) + '\n({ updateBattleDom });',
    { document: fakeDocument },
  ) as {
    updateBattleDom: (snapshot: {
      status: 'active' | 'victory' | 'defeat';
      playerName: string;
      playerHp: number;
      playerMaxHp: number;
      playerMana: number;
      playerMaxMana: number;
      enemyName: string;
      enemyHp: number;
      enemyMaxHp: number;
      turnCount: number;
      log: string[];
    }) => void;
  };

  const base = {
    playerName: 'TEST_DEGEN',
    playerHp: 0,
    playerMaxHp: 120,
    playerMana: 0,
    playerMaxMana: 12,
    enemyName: 'Tunnel Maw',
    enemyHp: 51,
    enemyMaxHp: 92,
    turnCount: 3,
    log: [],
  };

  for (const status of ['defeat', 'victory'] as const) {
    buttons.forEach((button) => { button.disabled = false; });
    appended.length = 0;
    boundUi.updateBattleDom({ ...base, status });

    assert.ok(buttons.every((button) => button.disabled), status + ' must disable free and paid abilities');
    assert.equal(buttons[0]?.costLabel.textContent, 'NO MANA');
    assert.equal(buttons[1]?.costLabel.textContent, '4 MANA',
      'terminal controls should show the move cost, not a live affordability warning');
    assert.match(accessibleHud.textContent, status === 'defeat'
      ? /Defeat\. Returning to the Underpass\./
      : /Victory\. Verifying rewards\./);
    assert.equal(appended.at(-1)?.className, 'battle-result ' + status);
    assert.equal(appended.at(-1)?.textContent, status === 'defeat'
      ? 'DEFEAT — returning to the Underpass.'
      : 'VICTORY — verifying rewards.');
  }
});


test('malformed Mana costs and snapshots fail closed in battle controls', () => {
  const malformedDegen = {
    ...TEST_DEGEN,
    abilities: TEST_DEGEN.abilities.map((ability, index) => ({
      ...ability,
      manaCost: index === 0 ? Number.NaN : -1,
    })),
  };
  const markup = ui.battleView({ displayName: 'Player', level: 1, currency: 0 }, malformedDegen as typeof TEST_DEGEN);
  assert.match(markup, /data-ability="slash" data-mana-cost="" disabled/);
  assert.match(markup, /data-ability="crack" data-mana-cost="" disabled/);
  assert.equal((markup.match(/UNAVAILABLE/g) ?? []).length, 2,
    'invalid costs must not be presented as usable abilities before the first snapshot update');

  const log = { innerHTML: '', append: (_node: unknown) => undefined };
  const accessibleHud = { textContent: '' };
  const costs: Array<string | undefined> = ['0', 'NaN', '-1', '1.5', '9007199254740992', '', undefined];
  const buttons = costs.map((cost) => buttonWithCostLabel(cost, cost ?? 'MISSING COST'));
  const fakeDocument = {
    querySelector: (selector: string) => selector === '#battle-accessible-hud' ? accessibleHud : log,
    querySelectorAll: (_selector: string) => buttons,
  };
  const boundUi = runInNewContext(
    stripTypeScriptTypes(source, { mode: 'transform' }) + '\\n({ updateBattleDom });',
    { document: fakeDocument },
  ) as {
    updateBattleDom: (snapshot: {
      status: 'active' | 'victory' | 'defeat';
      playerName: string;
      playerHp: number;
      playerMaxHp: number;
      playerMana: number;
      playerMaxMana: number;
      enemyName: string;
      enemyHp: number;
      enemyMaxHp: number;
      turnCount: number;
      log: string[];
    }) => void;
  };
  const snapshot = (playerMana: number) => ({
    status: 'active' as const,
    playerName: 'TEST_DEGEN',
    playerHp: 80,
    playerMaxHp: 120,
    playerMana,
    playerMaxMana: 12,
    enemyName: 'Tunnel Maw',
    enemyHp: 50,
    enemyMaxHp: 92,
    turnCount: 1,
    log: [],
  });

  boundUi.updateBattleDom(snapshot(0));
  assert.equal(buttons[0]?.disabled, false, 'valid zero-cost abilities remain usable at zero Mana');
  assert.equal(buttons[0]?.costLabel.textContent, 'NO MANA');
  assert.ok(buttons.slice(1).every((button) => button.disabled),
    'NaN, negative, fractional, unsafe, empty, and missing costs must be disabled');
  assert.ok(buttons.slice(1).every((button) => button.costLabel.textContent === 'UNAVAILABLE'));
  assert.match(accessibleHud.textContent, /Mana 0 of 12/);

  for (const invalidMana of [-1, 13, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    buttons.forEach((button) => { button.disabled = false; });
    boundUi.updateBattleDom(snapshot(invalidMana));
    assert.ok(buttons.every((button) => button.disabled),
      `invalid player Mana ${invalidMana} must disable every ability`);
    assert.ok(buttons.every((button) => button.costLabel.textContent === 'UNAVAILABLE'));
    assert.match(accessibleHud.textContent, /Mana unavailable/);
  }
});
