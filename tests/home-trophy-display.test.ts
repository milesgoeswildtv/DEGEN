import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const compile = (file: string): string => stripTypeScriptTypes(
  readFileSync(new URL(file, import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace(/^export const /gm, 'const ')
    .replace(/^export class /gm, 'class '),
  { mode: 'transform' },
);

const world = runInNewContext(
  compile('../src/data/world.ts') + '\n({ WORLD_LOCATIONS, FURNITURE_CATALOG, getFurniture });',
  {},
) as {
  WORLD_LOCATIONS: unknown[];
  FURNITURE_CATALOG: Array<{ id: string; name: string; icon: string }>;
  getFurniture: (id: string) => { id: string; name: string; icon: string } | undefined;
};

const views = runInNewContext(
  compile('../src/ui/views.ts') + '\n({ homeView });',
  {
    WORLD_LOCATIONS: world.WORLD_LOCATIONS,
    FURNITURE_CATALOG: world.FURNITURE_CATALOG,
    getFurniture: world.getFurniture,
    renderIsometricCity: () => '',
    renderIsometricDistrict: () => '',
    isValidManaCost: (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0,
    isValidManaState: () => true,
  },
) as {
  homeView: (player: unknown, selectedFurniture?: string) => string;
  rewardReceiptView: (reward: { xp: number; currency: number; items: string[]; furniture?: string[]; tier?: 'full' | 'reduced' }, previousLevel: number, currentLevel: number) => string;
};

const basePlayer = {
  id: 'trophy-test',
  displayName: 'Trophy Test',
  level: 1,
  xp: 0,
  currency: 0,
  degenId: 'test-degen',
  inventory: [],
  unlockedLocations: ['home'],
  housing: {
    inventory: ['starter-bed', 'starter-chair', 'starter-lamp', 'starter-rug'],
    placements: [],
  },
  defeatedBosses: [],
};

test('Home explains how the first trophy is earned before one is owned', () => {
  const html = views.homeView(basePlayer);
  assert.match(html, /TROPHY DISPLAY/);
  assert.match(html, /0 EARNED/);
  assert.match(html, /No trophies yet/);
  assert.match(html, /A full Underpass clear awards the first display piece/);
  assert.doesNotMatch(html, /data-furniture="tunnel-trophy"/);
});

test('an earned but unplaced trophy is marked ready to display and selectable', () => {
  const player = {
    ...basePlayer,
    housing: { ...basePlayer.housing, inventory: [...basePlayer.housing.inventory, 'tunnel-trophy'] },
  };
  const html = views.homeView(player);
  assert.match(html, /1 EARNED/);
  assert.match(html, /Underpass Trophy/);
  assert.match(html, /READY TO DISPLAY/);
  assert.match(html, /data-furniture="tunnel-trophy"/);
  assert.match(html, /PLACE TROPHY/);
  assert.match(html, /aria-pressed="false"/);
});

test('a placed trophy reports its saved room cell and selected state', () => {
  const player = {
    ...basePlayer,
    housing: {
      ...basePlayer.housing,
      inventory: [...basePlayer.housing.inventory, 'tunnel-trophy'],
      placements: [{ instanceId: 'trophy-placement', furnitureId: 'tunnel-trophy', x: 6, y: 4 }],
    },
  };
  const html = views.homeView(player, 'tunnel-trophy');
  assert.match(html, /DISPLAYED · ROOM CELL 7, 5/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /SELECTED/);
  assert.match(html, /Room cell 7, 5: Underpass Trophy/);
});


test('authoritative reward receipt shows loot, currency, XP, and the server level transition', () => {
  const html = views.rewardReceiptView({
    xp: 75,
    currency: 30,
    items: ['underpass-scrap'],
    furniture: ['tunnel-trophy'],
    tier: 'full',
  }, 1, 2);
  assert.match(html, /FULL CLEAR/);
  assert.match(html, /\\+75 XP/);
  assert.match(html, /\\+30 CR/);
  assert.match(html, /UNDERPASS SCRAP/);
  assert.match(html, /Underpass Trophy/);
  assert.match(html, /LEVEL UP · LV\\.1 → LV\\.2/);
  assert.match(html, /data-dismiss-reward/);
});

test('reduced reward receipt escapes item keys and does not invent a level-up', () => {
  const html = views.rewardReceiptView({
    xp: 10,
    currency: 3,
    items: ['<img src=x onerror=alert(1)>'],
    furniture: [],
    tier: 'reduced',
  }, 2, 2);
  assert.match(html, /REDUCED CLEAR/);
  assert.match(html, /&lt;IMG SRC=X ONERROR=ALERT\\(1\\)&gt;/);
  assert.doesNotMatch(html, /<img src=x/i);
  assert.doesNotMatch(html, /LEVEL UP/);
});
