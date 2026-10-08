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
  const palettes = central
    ? [
      ['#8b6d58', '#5d4548', '#382f3b'],
      ['#566f73', '#344c56', '#26313d'],
      ['#85725f', '#57483e', '#3a3338'],
      ['#78657e', '#4c405a', '#302e42'],
    ]
    : [
      ['#a27b62', '#70544b', '#514147'],
      ['#797b66', '#555a4d', '#3a4441'],
      ['#b18c63', '#7c5c49', '#5a4541'],
      ['#6e7f83', '#4e5d62', '#384349'],
    ];
  const [top, left, right] = palettes[(column * 3 + row * 5) % palettes.length]!;
  const roof = `${x},${roofY - halfDepth} ${x + halfWidth},${roofY} ${x},${roofY + halfDepth} ${x - halfWidth},${roofY}`;
  const windows = Array.from({ length: Math.max(1, Math.floor(height / 19)) }, (_, index) => {
    const yy = roofY + 16 + index * 18;
    return `<path d="M ${x - halfWidth + 8} ${yy - 5} l 8 4 v 5 l -8 -4 z" fill="#c99b64" opacity=".75"/>
      <path d="M ${x + 8} ${yy + 3} l 8 -4 v 5 l -8 4 z" fill="#b5c3ba" opacity=".55"/>`;
  }).join('');
  const roofDetail = (column + row) % 3 === 0
    ? `<path d="M ${x - 9} ${roofY - 4} l 9 -5 10 5 -9 5 z" fill="#2b3438"/>`
    : '';
  const variation = (column * 7 + row * 11) % 9;
  // Visual identity comes from deterministic, inexpensive SVG details.
  // No new location, faction, character, or gameplay content is implied.
  const rooftopClutter = variation % 3 === 0
    ? `<g stroke="#302e31" stroke-width="1">
        <path d="M ${x - 12} ${roofY - 3} l 10 -6 11 6 -10 6 z" fill="#9b765e"/>
        <path d="M ${x - 2} ${roofY - 9} v -10 l 9 -5 v 10" fill="none" stroke="#c9a68a" stroke-width="2"/>
      </g>`
    : variation % 3 === 1
      ? `<g><ellipse cx="${x + 2}" cy="${roofY - 4}" rx="8" ry="4" fill="#273b42"/>
          <path d="M ${x - 6} ${roofY - 4} v -10 q 8 -6 16 0 v 10" fill="#4e6d6d" stroke="#182b33"/>
          <ellipse cx="${x + 2}" cy="${roofY - 14}" rx="8" ry="4" fill="#7b8c7e"/>
        </g>`
      : `<path d="M ${x - 10} ${roofY - 2} l 8 -5 10 5 -8 5 z" fill="#d1a66f" stroke="#5e4539"/>`;
  const facadeDetail = variation % 2 === 0
    ? `<path d="M ${x - halfWidth + 3} ${roofY + 13} v ${height - 17} m 5 -${height - 17} v ${height - 17}" stroke="#bb8869" stroke-width="2" opacity=".65"/>
       <path d="M ${x - halfWidth + 3} ${y - 3} l 12 6" stroke="#a8b1a5" stroke-width="2"/>`
    : `<path d="M ${x + halfWidth - 3} ${roofY + 15} v ${height - 18} m -6 -${height - 18} v ${height - 18}" stroke="#647c7c" stroke-width="2" opacity=".75"/>
       <path d="M ${x + 4} ${y - 5} l 14 -8" stroke="#b6a68d" stroke-width="2"/>`;
  const improvised = variation === 2 || variation === 5
    ? `<g><path d="M ${x - halfWidth - 3} ${roofY + 13} l -9 -5 v 12 l 9 5" fill="#846f64" stroke="#d0aa79"/>
       <path d="M ${x - halfWidth - 9} ${roofY + 20} v ${Math.max(6, height - 22)}" stroke="#3d4c52" stroke-width="2" stroke-dasharray="5 4"/>
       <path d="M ${x - halfWidth - 10} ${roofY + 16} l 11 6" stroke="#c1a07a" stroke-width="2"/></g>`
    : '';
  const rooftopSign = central && variation === 7
    ? `<g><path d="M ${x - 15} ${roofY - 10} v -23 m 29 23 v -23" stroke="#514344" stroke-width="3"/>
       <path d="M ${x - 15} ${roofY - 33} l 29 0 v 16 l -29 0 z" fill="#2d303e" stroke="#d6a077" stroke-width="2"/>
       <path d="M ${x - 10} ${roofY - 25} h 19" stroke="#e4b18c" stroke-width="3"/></g>`
    : '';
  const wallMarks = variation === 4 || variation === 8
    ? `<path d="M ${x + 4} ${y - 14} l 7 -4 4 2 -6 5 8 -1" fill="none" stroke="#c89a7e" stroke-width="2" opacity=".85"/>`
    : '';
  return `<g class="iso-building">
    <polygon points="${x - halfWidth},${roofY} ${x},${roofY + halfDepth} ${x},${y + halfDepth} ${x - halfWidth},${y}" fill="${left}"/>
    <polygon points="${x},${roofY + halfDepth} ${x + halfWidth},${roofY} ${x + halfWidth},${y} ${x},${y + halfDepth}" fill="${right}"/>
    <polygon points="${roof}" fill="${top}" stroke="#998474" stroke-width="1"/>
    ${windows}${roofDetail}${rooftopClutter}${facadeDetail}${improvised}${rooftopSign}${wallMarks}
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
  Residential: { x: 40, y: 58 },
  Central: { x: 60, y: 55 },
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
      <small>${accessible}/${matching.length} OPEN${district === 'Central' ? ` · UNDERPASS // ${escapeHtml(underpassLabel)}` : ''}</small>
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

/** District close-up reuses the same connected city geometry; no second world map. */
export const renderIsometricDistrict = (
  district: string,
  locations: readonly LocationDefinition[],
  unlockedLocations: readonly string[],
  underpassLabel: string,
): string => {
  const anchor = anchors[district] ?? { x: 50, y: 50 };
  const pins = locations.filter((location) => location.district === district).map((location, index) => {
    const accessible = unlockedLocations.includes(location.id);
    const eventLabel = location.id === 'underpass' ? ` · ${escapeHtml(underpassLabel)}` : '';
    const accessibleLabel = location.id === 'underpass' ? `, ${escapeHtml(underpassLabel)}` : '';
    return `<button class="district-iso-pin" type="button" data-location="${escapeHtml(location.id)}"
      style="--district-pin-x:${index % 2 ? 65 : 35}%;--district-pin-y:${index % 2 ? 73 : 30}%;"
      ${accessible ? '' : 'disabled'} aria-label="${escapeHtml(location.name)}${accessibleLabel}${accessible ? '' : ', locked'}">
      <strong>${escapeHtml(location.name)}</strong><small>${accessible ? 'ENTER' : 'LOCKED'}${eventLabel}</small>
    </button>`;
  }).join('');
  return `<div class="district-iso-scene" role="group" aria-label="Isometric view of ${escapeHtml(district)} district destinations">
    <div class="district-iso-world" aria-hidden="true" style="transform:translate(-${anchor.x}%,-${anchor.y}%)">
      ${cityArt}
    </div>
    <div class="district-iso-hotspots">${pins}</div>
  </div>`;
};
