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

const WORLD_LOCATIONS = runInNewContext(
  compile('../src/data/world.ts') + '\nWORLD_LOCATIONS;',
  {},
) as Array<{ id: string; name: string; route: string; district: string }>;

const views = runInNewContext(
  compile('../src/ui/views.ts') + '\n({ mapView, districtView, locationView });',
  { WORLD_LOCATIONS, FURNITURE_CATALOG: [], getFurniture: () => undefined },
) as {
  mapView: (player: unknown, event?: unknown) => string;
  districtView: (player: unknown, district: string, event?: unknown) => string;
  locationView: (player: unknown, id: string) => string;
};

const player = {
  id: 'test', displayName: '<Player>', level: 1, currency: 0,
  unlockedLocations: ['home', 'downtown', 'underpass'],
};

test('city map derives only existing districts and routes through district selection', () => {
  assert.deepEqual([...new Set(WORLD_LOCATIONS.map((place) => place.district))], ['Residential', 'Central']);
  const html = views.mapView(player);
  assert.match(html, /data-district="Central"/);
  assert.match(html, /data-district="Residential"/);
  assert.doesNotMatch(html, /data-location="underpass"/);
  assert.match(html, /data-route="home"/);
  assert.match(html, /&lt;Player&gt;/);
});

test('district view exposes the existing Central destinations and Underpass live state', () => {
  const html = views.districtView(player, 'Central', {
    phase: 'sealed', opensAt: new Date(Date.now() + 600_000).toISOString(),
  });
  assert.match(html, /data-location="downtown"/);
  assert.match(html, /data-location="underpass"/);
  assert.match(html, /SEALED/);
  assert.match(html, /data-route="map"/);
  assert.doesNotMatch(html, /data-location="home"/);
  const residential = views.districtView(player, 'Residential');
  assert.match(residential, /data-location="home"/);
  assert.doesNotMatch(residential, /data-location="underpass"/);
});

test('Downtown is a reachable location scene but unimplemented activities are labeled', () => {
  assert.equal(WORLD_LOCATIONS.find((place) => place.id === 'downtown')?.route, 'location');
  const html = views.locationView(player, 'downtown');
  assert.match(html, /Downtown/);
  assert.match(html, /ACTIVITIES IN DEVELOPMENT/);
  assert.match(html, /data-route="district"/);
});

test('locked destinations are disabled and cannot expose their location scene', () => {
  const restricted = { ...player, unlockedLocations: ['home'] };
  const central = views.districtView(restricted, 'Central');
  assert.match(central, /data-location="downtown" disabled/);
  assert.match(central, /data-location="underpass" disabled/);
  const map = views.mapView(restricted);
  assert.match(map, /data-district="Central" disabled/);
  assert.doesNotMatch(views.locationView(restricted, 'downtown'), /ACTIVITIES IN DEVELOPMENT/);
});

test('controller follows map to district to location and rejects locked navigation', () => {
  const makeButton = (dataset: Record<string, string>) => {
    let click = () => {};
    return {
      dataset,
      addEventListener: (_event: string, handler: () => void) => { click = handler; },
      click: () => click(),
    };
  };
  const districtButton = makeButton({ district: 'Central' });
  const locationButton = makeButton({ location: 'downtown' });
  const backButton = makeButton({ route: 'district' });
  const root = {
    innerHTML: '',
    querySelectorAll: (selector: string) => {
      if (selector === '[data-district]') return [districtButton];
      if (selector === '[data-location]') return [locationButton];
      if (selector === '[data-route]') return [backButton];
      return [];
    },
    querySelector: () => null,
  };
  const store = { snapshot: { ...player } };
  const Controller = runInNewContext(
    compile('../src/app/AppController.ts') + '\nAppController;',
    {
      WORLD_LOCATIONS,
      mapView: () => 'map', districtView: () => 'district', locationView: () => 'location',
      homeView: () => 'home', underpassView: () => 'underpass', battleView: () => 'battle',
    },
  ) as new (root: unknown, store: unknown, api: unknown) => {
    route: string;
    render(): void;
    navigate(route: string): void;
  };
  const controller = new Controller(root, store, { enabled: false });
  controller.render();
  assert.equal(root.innerHTML, 'map');
  districtButton.click();
  assert.equal(controller.route, 'district');
  assert.equal(root.innerHTML, 'district');
  locationButton.click();
  assert.equal(controller.route, 'location');
  assert.equal(root.innerHTML, 'location');
  backButton.click();
  assert.equal(controller.route, 'district');

  store.snapshot.unlockedLocations = ['home'];
  controller.navigate('map');
  districtButton.click();
  assert.equal(controller.route, 'map');
  controller.navigate('district');
  locationButton.click();
  assert.equal(controller.route, 'district');
});
