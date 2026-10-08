export interface CityCamera { x: number; y: number; scale: number }
export const MIN_CITY_ZOOM = 0.7;
export const MAX_CITY_ZOOM = 2.2;
const WIDTH = 1000;
const HEIGHT = 620;

export const constrainCityCamera = (camera: CityCamera, width: number, height: number): CityCamera => {
  const scale = Math.min(MAX_CITY_ZOOM, Math.max(MIN_CITY_ZOOM, camera.scale));
  const limitX = Math.max(0, (WIDTH * scale - width) / 2);
  const limitY = Math.max(0, (HEIGHT * scale - height) / 2);
  return { scale, x: Math.max(-limitX, Math.min(limitX, camera.x)), y: Math.max(-limitY, Math.min(limitY, camera.y)) };
};

// Purely presentational; authoritative game state remains in the Worker.
export const bindCityViewport = (root: HTMLElement, previous: CityCamera | undefined, onChange: (camera: CityCamera) => void): () => void => {
  const viewport = root.querySelector<HTMLElement>('[data-city-viewport]');
  const world = root.querySelector<HTMLElement>('[data-city-world]');
  if (!viewport || !world) return () => {};
  const defaultScale = () => viewport.clientWidth < 700 ? 0.8 : 1;
  let camera = previous ?? { x: 0, y: 0, scale: defaultScale() };
  const pointers = new Map<number, { x: number; y: number }>();
  let lastPinch = 0;
  let lastCenter = { x: 0, y: 0 };
  const render = () => {
    camera = constrainCityCamera(camera, viewport.clientWidth, viewport.clientHeight);
    world.style.transform = `translate(-50%, -50%) translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
    viewport.dataset.cityScale = camera.scale.toFixed(2);
    // Preserve readable, full-size touch targets at every map zoom.
    root.querySelectorAll<HTMLElement>('.city-iso-pin').forEach((pin) => {
      pin.style.transform = `translate(-50%, -50%) scale(${1 / camera.scale})`;
    });
    root.querySelectorAll<HTMLButtonElement>('[data-city-zoom]').forEach(button => {
      button.disabled = button.dataset.cityZoom === 'in' ? camera.scale >= MAX_CITY_ZOOM : camera.scale <= MIN_CITY_ZOOM;
    });
    onChange({ ...camera });
  };
  const zoom = (factor: number, fx = viewport.clientWidth / 2, fy = viewport.clientHeight / 2) => {
    const next = Math.max(MIN_CITY_ZOOM, Math.min(MAX_CITY_ZOOM, camera.scale * factor));
    const ratio = next / camera.scale;
    camera.x += (fx - viewport.clientWidth / 2 - camera.x) * (1 - ratio);
    camera.y += (fy - viewport.clientHeight / 2 - camera.y) * (1 - ratio);
    camera.scale = next;
    render();
  };
  const reset = () => { camera = { x: 0, y: 0, scale: defaultScale() }; render(); };
  const pinch = () => {
    const [a, b] = [...pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
    const rect = viewport.getBoundingClientRect();
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), center: { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top } };
  };
  viewport.addEventListener('pointerdown', event => {
    if ((event.target as Element).closest('button')) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    viewport.setPointerCapture(event.pointerId);
    if (pointers.size === 2) { const p = pinch(); lastPinch = p.distance; lastCenter = p.center; }
  });
  viewport.addEventListener('pointermove', event => {
    const prior = pointers.get(event.pointerId);
    if (!prior) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) {
      camera.x += event.clientX - prior.x; camera.y += event.clientY - prior.y; render();
    } else if (pointers.size === 2) {
      const p = pinch();
      camera.x += p.center.x - lastCenter.x; camera.y += p.center.y - lastCenter.y;
      if (lastPinch > 0) zoom(p.distance / lastPinch, p.center.x, p.center.y);
      else render();
      lastPinch = p.distance; lastCenter = p.center;
    }
  });
  const end = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    lastPinch = 0;
    if (pointers.size === 2) { const p = pinch(); lastPinch = p.distance; lastCenter = p.center; }
  };
  viewport.addEventListener('pointerup', end);
  viewport.addEventListener('pointercancel', end);
  viewport.addEventListener('lostpointercapture', end);
  viewport.addEventListener('wheel', event => {
    event.preventDefault();
    const rect = viewport.getBoundingClientRect();
    zoom(event.deltaY < 0 ? 1.12 : 1 / 1.12, event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });
  viewport.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft') camera.x += 48;
    else if (event.key === 'ArrowRight') camera.x -= 48;
    else if (event.key === 'ArrowUp') camera.y += 48;
    else if (event.key === 'ArrowDown') camera.y -= 48;
    else if (event.key === '+' || event.key === '=') zoom(1.2);
    else if (event.key === '-') zoom(1 / 1.2);
    else if (event.key === '0') reset();
    else return;
    event.preventDefault(); render();
  });
  root.querySelectorAll<HTMLButtonElement>('[data-city-zoom]').forEach(button => {
    button.addEventListener('click', () => zoom(button.dataset.cityZoom === 'in' ? 1.2 : 1 / 1.2));
  });
  root.querySelector<HTMLButtonElement>('[data-city-reset]')?.addEventListener('click', reset);
  const resizeObserver = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => render());
  resizeObserver?.observe(viewport);
  render();
  return () => { resizeObserver?.disconnect(); pointers.clear(); };
};
