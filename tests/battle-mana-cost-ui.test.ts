import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

import { TEST_DEGEN } from '../src/data/combatPrototype.ts';

const source = readFileSync(new URL('../src/ui/views.ts', import.meta.url), 'utf8')
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/\bexport const /g, 'const ');
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
    { dataset: { manaCost: '0' }, disabled: true },
    { dataset: { manaCost: '4' }, disabled: false },
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
  assert.match(accessibleHud.textContent, /TEST_DEGEN: HP 73 of 120, Mana 0 of 12/);
  assert.match(accessibleHud.textContent, /Tunnel Maw: HP 51 of 92\. Turn 2\. Choose an action\./);

  boundUi.updateBattleDom(snapshot(4));
  assert.equal(buttons[0]?.disabled, false);
  assert.equal(buttons[1]?.disabled, false);
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
    { dataset: { manaCost: '0' }, disabled: false },
    { dataset: { manaCost: '4' }, disabled: false },
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
    assert.match(accessibleHud.textContent, status === 'defeat'
      ? /Defeat\. Returning to the Underpass\./
      : /Victory\. Verifying rewards\./);
    assert.equal(appended.at(-1)?.className, 'battle-result ' + status);
    assert.equal(appended.at(-1)?.textContent, status === 'defeat'
      ? 'DEFEAT — returning to the Underpass.'
      : 'VICTORY — verifying rewards.');
  }
});
