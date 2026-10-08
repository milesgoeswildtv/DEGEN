import assert from 'node:assert/strict';
import test from 'node:test';
import { constrainCityCamera, bindCityViewport, MAX_CITY_ZOOM, MIN_CITY_ZOOM } from '../src/ui/cityViewport.ts';

const makeMap = (width = 380, height = 420) => {
  const events = new Map<string, (event: any) => void>();
  const viewport = {
    clientWidth: width, clientHeight: height,
    style: {} as Record<string, string>, dataset: {} as Record<string, string>,
    addEventListener: (name: string, fn: (event: any) => void) => events.set(name, fn),
    setPointerCapture: (_id: number) => {},
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  const world = { style: {} as Record<string, string> };
  const pin = { style: {} as Record<string, string> };
  const zoomIn = { dataset: { cityZoom: 'in' }, disabled: false, addEventListener: (_: string, fn: () => void) => { zoomInClick = fn; } };
  const zoomOut = { dataset: { cityZoom: 'out' }, disabled: false, addEventListener: (_: string, fn: () => void) => { zoomOutClick = fn; } };
  const reset = { addEventListener: (_: string, fn: () => void) => { resetClick = fn; } };
  let zoomInClick = () => {};
  let zoomOutClick = () => {};
  let resetClick = () => {};
  const root = {
    querySelector: (selector: string) =>
      selector === '[data-city-viewport]' ? viewport :
      selector === '[data-city-world]' ? world :
      selector === '[data-city-reset]' ? reset : null,
    querySelectorAll: (selector: string) => selector === '[data-city-zoom]' ? [zoomIn, zoomOut] : selector === '.city-iso-pin' ? [pin] : [],
  };
  let current = { x: 0, y: 0, scale: 1 };
  bindCityViewport(root as unknown as HTMLElement, undefined, (camera) => { current = camera; });
  const event = (name: string, overrides: Record<string, unknown> = {}) =>
    events.get(name)?.({
      pointerId: 1, clientX: 100, clientY: 100,
      target: { closest: () => null }, key: '', preventDefault: () => {},
      ...overrides,
    });
  return { viewport, world, pin, event, zoomIn: () => zoomInClick(), zoomOut: () => zoomOutClick(), reset: () => resetClick(), camera: () => current };
};

test('camera zoom is bounded and does not pan off the connected metropolis', () => {
  assert.equal(constrainCityCamera({ x: 9999, y: -9999, scale: 9 }, 380, 420).scale, MAX_CITY_ZOOM);
  assert.equal(constrainCityCamera({ x: 9999, y: -9999, scale: 0.01 }, 380, 420).scale, MIN_CITY_ZOOM);
  const c = constrainCityCamera({ x: 9999, y: -9999, scale: 1 }, 380, 420);
  assert.equal(c.x, 310);
  assert.equal(c.y, -100);
  assert.deepEqual(constrainCityCamera({ x: 99, y: 99, scale: 1 }, 1400, 800), { x: 0, y: 0, scale: 1 });
});

test('touch drag pans the camera and zoom controls remain bounded', () => {
  const map = makeMap();
  const original = map.camera();
  map.event('pointerdown');
  map.event('pointermove', { clientX: 160, clientY: 125 });
  assert.equal(map.camera().x, original.x + 60);
  assert.equal(map.camera().y, original.y + 25);
  map.event('pointerup');
  for (let i = 0; i < 30; i += 1) map.zoomIn();
  assert.equal(map.camera().scale, MAX_CITY_ZOOM);
  for (let i = 0; i < 40; i += 1) map.zoomOut();
  assert.equal(map.camera().scale, MIN_CITY_ZOOM);
  map.reset();
  assert.equal(map.camera().scale, 0.8);
  assert.equal(map.camera().x, 0);
  assert.equal(map.camera().y, 0);
});

test('wheel and keyboard zoom update the same camera, and drag ignores district buttons', () => {
  const map = makeMap();
  map.event('pointerdown', { target: { closest: () => ({}) } });
  map.event('pointermove', { clientX: 190 });
  assert.equal(map.camera().x, 0);
  map.event('wheel', { deltaY: -1 });
  assert.ok(map.camera().scale > 0.8);
  map.event('keydown', { key: '0' });
  assert.equal(map.camera().scale, 0.8);
  assert.ok(map.pin.style.transform.endsWith('scale(1.25)'));
  assert.match(map.world.style.transform, /scale\(0\.8\)/);
});

test('pinch zoom responds to two independent pointers', () => {
  const map = makeMap();
  map.event('pointerdown', { pointerId: 1, clientX: 100, clientY: 100 });
  map.event('pointerdown', { pointerId: 2, clientX: 200, clientY: 100 });
  map.event('pointermove', { pointerId: 2, clientX: 240, clientY: 100 });
  assert.ok(map.camera().scale > 0.8);
  map.event('pointerup', { pointerId: 2 });
  map.event('pointerup', { pointerId: 1 });
});


test('cancelled touch and lost capture never leave the map dragging', () => {
  const map = makeMap();
  map.event('pointerdown', { pointerId: 1, clientX: 100 });
  map.event('pointercancel', { pointerId: 1 });
  map.event('pointermove', { pointerId: 1, clientX: 240 });
  assert.equal(map.camera().x, 0);
  map.event('pointerdown', { pointerId: 2, clientX: 100 });
  map.event('lostpointercapture', { pointerId: 2 });
  map.event('pointermove', { pointerId: 2, clientX: 240 });
  assert.equal(map.camera().x, 0);
});

test('viewport resize keeps current zoom and clamps camera to new dimensions', () => {
  const original = globalThis.ResizeObserver;
  let observer: { fire(): void; disconnect(): void; disconnected: boolean } | undefined;
  class FakeObserver {
    disconnected = false;
    private callback: () => void;
    constructor(callback: () => void) { this.callback = callback; observer = this; }
    observe(_element: unknown) {}
    disconnect() { this.disconnected = true; }
    fire() { if (!this.disconnected) this.callback(); }
  }
  try {
    globalThis.ResizeObserver = FakeObserver as unknown as typeof ResizeObserver;
    const viewport = { clientWidth: 320, clientHeight: 365, dataset: {}, addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
    const world = { style: {} as Record<string, string> };
    const pin = { style: {} as Record<string, string> };
    const root = {
      querySelector: (s: string) => s === '[data-city-viewport]' ? viewport : s === '[data-city-world]' ? world : null,
      querySelectorAll: (s: string) => s === '.city-iso-pin' ? [pin] : [],
    };
    const history: Array<{ x: number; y: number; scale: number }> = [];
    const release = bindCityViewport(root as unknown as HTMLElement, { x: 300, y: 200, scale: 1 }, (camera) => history.push(camera));
    assert.equal(history.at(-1)?.y, 127.5);
    viewport.clientWidth = 900;
    viewport.clientHeight = 650;
    observer!.fire();
    assert.equal(history.at(-1)?.x, 50);
    assert.equal(history.at(-1)?.y, 0);
    assert.equal(history.at(-1)?.scale, 1);
    assert.equal(pin.style.transform, 'translate(-50%, -50%) scale(1)');
    release();
    assert.equal(observer?.disconnected, true);
    const count = history.length;
    observer!.fire();
    assert.equal(history.length, count, 'disposed observer must not update stale map');
  } finally {
    globalThis.ResizeObserver = original;
  }
});

test('map reset uses the current viewport width after rotation', () => {
  const original = globalThis.ResizeObserver;
  try {
    globalThis.ResizeObserver = undefined as unknown as typeof ResizeObserver;
    const viewport = { clientWidth: 320, clientHeight: 365, dataset: {}, addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
    const world = { style: {} };
    let reset = () => {};
    const root = {
      querySelector: (s: string) => s === '[data-city-viewport]' ? viewport : s === '[data-city-world]' ? world :
        s === '[data-city-reset]' ? { addEventListener: (_type: string, fn: () => void) => { reset = fn; } } : null,
      querySelectorAll: () => [],
    };
    let camera = { x: 0, y: 0, scale: 0 };
    const release = bindCityViewport(root as unknown as HTMLElement, undefined, (next) => { camera = next; });
    assert.equal(camera.scale, 0.8);
    viewport.clientWidth = 900;
    viewport.clientHeight = 600;
    reset();
    assert.equal(camera.scale, 1);
    viewport.clientWidth = 320;
    reset();
    assert.equal(camera.scale, 0.8);
    release();
  } finally {
    globalThis.ResizeObserver = original;
  }
});
