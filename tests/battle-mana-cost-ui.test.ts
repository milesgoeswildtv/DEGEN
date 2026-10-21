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
  stripTypeScriptTypes(source, { mode: 'transform' }) + '\\nbattleView; updateBattleDom;',
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
});

test('battle controls keep zero-cost abilities enabled and gate paid abilities by current Mana', () => {
  const log = { innerHTML: '', append: (_node: unknown) => undefined };
  const buttons = [
    { dataset: { manaCost: '0' }, disabled: true },
    { dataset: { manaCost: '4' }, disabled: false },
  ];
  const fakeDocument = {
    querySelector: (_selector: string) => log,
    querySelectorAll: (_selector: string) => buttons,
  };

  const boundUi = runInNewContext(
    stripTypeScriptTypes(source, { mode: 'transform' }) + '\\nupdateBattleDom;',
    { document: fakeDocument },
  ) as {
    updateBattleDom: (snapshot: {
      status: 'active' | 'victory' | 'defeat';
      playerMana: number;
      log: string[];
    }) => void;
  };

  boundUi.updateBattleDom({ status: 'active', playerMana: 0, log: [] });
  assert.equal(buttons[0]?.disabled, false);
  assert.equal(buttons[1]?.disabled, true);

  boundUi.updateBattleDom({ status: 'active', playerMana: 4, log: [] });
  assert.equal(buttons[0]?.disabled, false);
  assert.equal(buttons[1]?.disabled, false);
});
