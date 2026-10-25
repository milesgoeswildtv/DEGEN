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
    playerMaxMana: number;
    playerShield: number;
    log: string[];
  }) => void;
};

test('battle controls expose each bespoke ability Mana cost', () => {
  const html = ui.battleView({ displayName: 'Player', level: 1, currency: 0 }, TEST_DEGEN);

  assert.match(html, /data-ability="slash" data-mana-cost="0"/);
  assert.match(html, /NO MANA/);
  assert.match(html, /data-ability="crack" data-mana-cost="4"/);
  assert.match(html, /4 MANA/);
  assert.match(html, /id="battle-mana" class="battle-resource">MANA 12\/12/);
});

test('battle controls keep zero-cost abilities enabled and gate paid abilities by current Mana', () => {
  const log = { innerHTML: '', append: (_node: unknown) => undefined };
  const mana = { textContent: '' };
  const shield = { textContent: '' };
  const buttons = [
    { dataset: { manaCost: '0' }, disabled: true },
    { dataset: { manaCost: '4' }, disabled: false },
  ];
  const fakeDocument = {
    querySelector: (selector: string) => selector === '#battle-mana' ? mana : selector === '#battle-shield' ? shield : log,
    querySelectorAll: (_selector: string) => buttons,
  };

  const boundUi = runInNewContext(
    stripTypeScriptTypes(source, { mode: 'transform' }) + '\n({ updateBattleDom });',
    { document: fakeDocument },
  ) as {
    updateBattleDom: (snapshot: {
      status: 'active' | 'victory' | 'defeat';
      playerMana: number;
      playerMaxMana: number;
      playerShield: number;
      log: string[];
    }) => void;
  };

  boundUi.updateBattleDom({ status: 'active', playerMana: 0, playerMaxMana: 12, playerShield: 0, log: [] });
  assert.equal(mana.textContent, 'MANA 0/12');
  assert.equal(shield.textContent, 'SHIELD 0');
  assert.equal(buttons[0]?.disabled, false);
  assert.equal(buttons[1]?.disabled, true);

  boundUi.updateBattleDom({ status: 'active', playerMana: 4, playerMaxMana: 12, playerShield: 3, log: [] });
  assert.equal(mana.textContent, 'MANA 4/12');
  assert.equal(shield.textContent, 'SHIELD 3');
  assert.equal(buttons[0]?.disabled, false);
  assert.equal(buttons[1]?.disabled, false);
});
