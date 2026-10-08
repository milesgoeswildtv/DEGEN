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

const renderIsometricCity = runInNewContext(
  compile('../src/ui/isometricCity.ts') + '\nrenderIsometricCity;'
  {},
);

const renderIsometricDistrict = runInNewContext(
  compile('../src/ui/isometricCity.ts') + '\nrenderIsometricDistrict;',
  {},
);

const views = runInNewContext(
  compile('../src/ui/views.ts') + '\n({ mapView, districtView, locationView, underpassView });',
  { WORLD_LOCATIONS, FURNITURE_CATALOG: [], getFurniture: () => undefined, renderIsometricCity, renderIsometricDistrict },
) as {
  mapView: (player: unknown, event?: unknown, backendOffline?: boolean) => string;
  districtView: (player: unknown, district: string, event?: unknown, backendOffline?: boolean) => string;
  locationView: (player: unknown, id: string) => string;
  underpassView: (player: unknown, event?: unknown, backendOffline?: boolean) => string;
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
  assert.match(html, /data-city-viewport/);
  assert.match(html, /data-city-world/);
  assert.match(html, /data-city-zoom="in"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /&lt;Player&gt;/);
});

test('district view exposes the existing Central destinations and Underpass live state', () => {
  const html = views.districtView(player, 'Central', {
    phase: 'sealed', opensAt: new Date(Date.now() + 600_000).toISOString(),
  });
  assert.match(html, /data-location="downtown"/);
  assert.match(html, /district-iso-scene/);
  assert.match(html, /city-iso-art/);
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
  assert.match(html, /data-location="underpass"/);
});

test('locked destinations are disabled and cannot expose their location scene', () => {
  const restricted = { ...player, unlockedLocations: ['home'] };
  const central = views.districtView(restricted, 'Central');
  assert.match(central, /data-location="downtown" disabled/);
  assert.match(central, /data-location="underpass" disabled/);
  const map = views.mapView(restricted);
  assert.match(map, /data-district="Central"[^>]*disabled/);
  assert.doesNotMatch(views.locationView(restricted, 'downtown'), /ACTIVITIES IN DEVELOPMENT/);
  assert.doesNotMatch(views.locationView({ ...player, unlockedLocations: ['downtown'] }, 'downtown'), /data-location="underpass"/);
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
      bindCityViewport: () => {},
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
  locationButton.dataset.location = 'underpass';
  locationButton.click();
  assert.equal(controller.route, 'underpass');
  assert.equal(root.innerHTML, 'underpass');
  locationButton.dataset.location = 'downtown';
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

test('Underpass retains a breadcrumb back to its Central district', () => {
  const html = views.underpassView(player, {
    phase: 'sealed', fullRewardClears: 0, fullRewardLimit: 3,
  });
  assert.match(html, /data-route="district">CENTRAL/);
  assert.match(html, /data-route="map"/);
  assert.match(html, /UNDERPASS SEALED/);
});

test('server-backed offline mode exposes a warning and disables fake Underpass entry', () => {
  const event = { phase: 'open', fullRewardClears: 0, fullRewardLimit: 3, source: 'preview' };
  const map = views.mapView(player, event, true);
  assert.match(map, /UNDERPASS \/\/ OFFLINE/);
  assert.match(map, /LIVE WORLD UNAVAILABLE/);
  const district = views.districtView(player, 'Central', event, true);
  assert.match(district, /LIVE WORLD UNAVAILABLE/);
  const underpass = views.underpassView(player, event, true);
  assert.match(underpass, /UNDERPASS SEALED/);
  assert.match(underpass, /data-start-battle disabled/);
  assert.doesNotMatch(underpass, /Local preview cycle/);
});

test('controller does not issue server battle permits against fallback preview cycles', async () => {
  const root = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null };
  let starts = 0;
  const Controller = runInNewContext(
    compile('../src/app/AppController.ts') + '\nAppController;',
    {
      getPreviewUnderpass: () => ({ phase: 'open', cycleId: 'preview', source: 'preview' }),
      console: { warn: () => {} },
    },
  ) as new (root: unknown, store: unknown, api: unknown) => {
    worldSyncFailed: boolean;
    refreshWorld(): Promise<void>;
    enterUnderpass(): Promise<void>;
  };
  const controller = new Controller(root, { snapshot: player }, {
    enabled: true,
    getUnderpass: async () => { throw new Error('CORS blocked'); },
    startUnderpass: async () => { starts += 1; return undefined; },
  });
  await controller.refreshWorld();
  assert.equal(controller.worldSyncFailed, true);
  await controller.enterUnderpass();
  assert.equal(starts, 0);
});

test('world sync recovery restores authoritative event state after a transient failure', async () => {
  let attempts = 0;
  const Controller = runInNewContext(
    compile('../src/app/AppController.ts') + '\nAppController;',
    {
      getPreviewUnderpass: () => ({ phase: 'open', cycleId: 'preview', source: 'preview' }),
      console: { warn: () => {} },
    },
  ) as new (root: unknown, store: unknown, api: unknown) => {
    worldSyncFailed: boolean;
    underpassEvent?: { source: string; cycleId: string };
    refreshWorld(): Promise<void>;
  };
  const controller = new Controller(
    { innerHTML: '', querySelectorAll: () => [], querySelector: () => null },
    { snapshot: player },
    {
      enabled: true,
      getUnderpass: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('Temporary network failure');
        return { phase: 'open', cycleId: 'server-cycle', source: 'server' };
      },
    },
  );
  await controller.refreshWorld();
  assert.equal(controller.worldSyncFailed, true);
  assert.equal(controller.underpassEvent?.source, 'preview');
  await controller.refreshWorld();
  assert.equal(controller.worldSyncFailed, false);
  assert.equal(controller.underpassEvent?.cycleId, 'server-cycle');
});


test('isometric city scaffold has distinct buildings without inventing playable destinations', () => {
  const html = views.mapView(player, { phase: 'open', closesAt: new Date(Date.now() + 60_000).toISOString() });
  const buildings = html.match(/class="iso-building"/g) ?? [];
  assert.ok(buildings.length >= 35, 'expected dense but lightweight SVG blocks');
  assert.match(html, /#566f73/);
  assert.match(html, /#a27b62/);
  assert.match(html, /#4e6d6d/);
  assert.doesNotMatch(html, /data-location="unknown"/);
  assert.match(html, /data-district="Residential"/);
  assert.match(html, /data-district="Central"/);
});


test('map camera persists across authoritative world refresh rerenders', async () => {
  const cameraHistory: Array<{ x: number; y: number; scale: number } | undefined> = [];
  const Controller = runInNewContext(
    compile('../src/app/AppController.ts') + '\nAppController;',
    {
      WORLD_LOCATIONS,
      mapView: () => 'map', districtView: () => 'district', locationView: () => 'location',
      homeView: () => 'home', underpassView: () => 'underpass', battleView: () => 'battle',
      getPreviewUnderpass: () => ({ phase: 'sealed', source: 'preview' }),
      bindCityViewport: (_root: unknown, previous: { x: number; y: number; scale: number } | undefined,
        onChange: (camera: { x: number; y: number; scale: number }) => void) => {
        cameraHistory.push(previous);
        if (!previous) onChange({ x: 48, y: -16, scale: 1.25 });
      },
    },
  ) as new (root: unknown, store: unknown, api: unknown) => {
    render(): void;
    refreshWorld(rerender?: boolean): Promise<void>;
  };
  const controller = new Controller(
    { innerHTML: '', querySelectorAll: () => [], querySelector: () => null },
    { snapshot: player },
    { enabled: false },
  );
  controller.render();
  await controller.refreshWorld(true);
  assert.equal(cameraHistory.length, 2);
  assert.equal(cameraHistory[0], undefined);
  assert.equal(cameraHistory[1]?.x, 48);
  assert.equal(cameraHistory[1]?.y, -16);
  assert.equal(cameraHistory[1]?.scale, 1.25);
});
