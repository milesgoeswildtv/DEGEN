import type { LocationDefinition } from '../domain/types';

// Lightweight SVG geometry is a replaceable visual scaffold, not final city art or lore.
// It renders only districts that exist in WORLD_LOCATIONS.
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char] ?? char);

const isoPoint = (column: number, row: number): [number, number] =>
  [500 + (column - row) * 52, 92 + (column + row) * 29];

const tile = (x: number, y: number, road: boolean, central: boolean): string => {
  const fill = road ? '#34313a' : central ? '#49403d' : '#48413a';
  return `<polygon points="${x},${y - 28} ${x + 50},${y} ${x},${y + 28} ${x - 50},${y}" fill="${fill}" stroke="#17191e" stroke-width="3"/>`;
};

const building = (x: number, y: number, column: number, row: number): string => {
  const central = column >= 4;
  const height = central ? 53 + ((column * 13 + row * 19) % 5) * 15 : 28 + ((column * 11 + row * 7) % 4) * 9;
  const halfWidth = central ? 26 : 23;
  const halfDepth = 14;
  const roofY = y - height;
  const palette = central
    ? ['#72665d', '#4c4449', '#342f38']
    : ['#756d5d', '#534a47', '#3d363b'];
  const [top, left, right] = palette;
  const roof = `${x},${roofY - halfDepth} ${x + halfWidth},${roofY} ${x},${roofY + halfDepth} ${x - halfWidth},${roofY}`;
  const windows = Array.from({ length: Math.max(1, Math.floor(height / 19)) }, (_, index) => {
    const yy = roofY + 16 + index * 18;
    return `<path d="M ${x - halfWidth + 8} ${yy - 5} l 8 4 v 5 l -8 -4 z" fill="#c99b64" opacity=".75"/>
      <path d="M ${x + 8} ${yy + 3} l 8 -4 v 5 l -8 4 z" fill="#b5c3ba" opacity=".55"/>`;
  }).join('');
  const roofDetail = (column + row) % 3 === 0
    ? `<path d="M ${x - 9} ${roofY - 4} l 9 -5 10 5 -9 5 z" fill="#2b3438"/>`
    : '';
  return `<g class="iso-building">
    <polygon points="${x - halfWidth},${roofY} ${x},${roofY + halfDepth} ${x},${y + halfDepth} ${x - halfWidth},${y}" fill="${left}"/>
    <polygon points="${x},${roofY + halfDepth} ${x + halfWidth},${roofY} ${x + halfWidth},${y} ${x},${y + halfDepth}" fill="${right}"/>
    <polygon points="${roof}" fill="${top}" stroke="#998474" stroke-width="1"/>
    ${windows}${roofDetail}
  </g>`;
};

const geometry = (): string => {
  const blocks: string[] = [];
  for (let diagonal = 0; diagonal <= 14; diagonal += 1) {
    for (let column = 0; column < 8; column += 1) {
      const row = diagonal - column;
      if (row < 0 || row >= 8) continue;
      const [x, y] = isoPoint(column, row);
      const road = column === 3 || row === 4;
      blocks.push(tile(x, y, road, column >= 4));
      if (!road && (column + row) % 7 !== 0) blocks.push(building(x, y, column, row));
      if (road) blocks.push(`<path d="M ${x - 8} ${y} l 16 0" stroke="#c0a57c" stroke-width="2" stroke-dasharray="4 5" opacity=".6"/>`);
    }
  }
  return blocks.join('');
};

const cityArt = `<svg class="city-iso-art" viewBox="0 0 1000 620" role="img" aria-label="Stylized isometric city blocks with connected streets">
  <defs>
    <radialGradient id="city-ground"><stop stop-color="#55473c"/><stop offset="1" stop-color="#171a21"/></radialGradient>
    <filter id="city-shadow" x="-30%" y="-30%" width="160%" height="180%"><feDropShadow dx="0" dy="18" stdDeviation="15" flood-color="#000" flood-opacity=".55"/></filter>
  </defs>
  <rect width="1000" height="620" fill="#11141b"/>
  <ellipse cx="500" cy="340" rx="475" ry="225" fill="url(#city-ground)" opacity=".45"/>
  <g filter="url(#city-shadow)">
    <polygon points="500,63 936,309 500,555 64,309" fill="#29272d" stroke="#7a6658" stroke-width="6"/>
    ${geometry()}
  </g>
  <path d="M 120 430 L 880 185" stroke="#c49b6b" stroke-width="2" opacity=".22" stroke-dasharray="6 16"/>
</svg>`;

const anchors: Record<string, { x: number; y: number }> = {
  Residential: { x: 39, y: 58 },
  Central: { x: 61, y: 55 },
};

export const renderIsometricCity = (
  locations: readonly LocationDefinition[],
  unlockedLocations: readonly string[],
  underpassLabel: string,
): string => {
  const districts = [...new Set(locations.map((location) => location.district))];
  const pins = districts.map((district) => {
    const matching = locations.filter((location) => location.district === district);
    const accessible = matching.filter((location) => unlockedLocations.includes(location.id)).length;
    const anchor = anchors[district] ?? { x: 50, y: 50 };
    return `<button class="city-iso-pin" type="button" data-district="${escapeHtml(district)}"
      style="--pin-x:${anchor.x}%;--pin-y:${anchor.y}%;" ${accessible ? '' : 'disabled'}
      aria-label="${escapeHtml(district)}, ${accessible} of ${matching.length} locations accessible">
      <span class="city-pin-marker" aria-hidden="true">⌖</span>
      <strong>${escapeHtml(district)}</strong>
      <small>${accessible}/${matching.length} OPEN${district === 'Central' ? ` · UNDERPASS ${escapeHtml(underpassLabel)}` : ''}</small>
    </button>`;
  }).join('');
  return `<div class="city-viewport" data-city-viewport role="region" tabindex="0" aria-label="Pan and zoom city map">
    <div class="city-world" data-city-world>${cityArt}${pins}</div>
  </div>
  <div class="city-map-controls" aria-label="Map zoom controls">
    <span>DRAG TO PAN · PINCH TO ZOOM</span>
    <button type="button" data-city-zoom="out" aria-label="Zoom out">−</button>
    <button type="button" data-city-reset aria-label="Reset map view">⌖</button>
    <button type="button" data-city-zoom="in" aria-label="Zoom in">+</button>
  </div>`;
};
