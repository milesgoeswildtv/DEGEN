import { FURNITURE_CATALOG, WORLD_LOCATIONS, getFurniture } from '../data/world';
import type { BattleSnapshot } from '../game/combat/engine';
import type { DegenDefinition, PlayerState, WorldEventSnapshot } from '../domain/types';

const escapeHtml = (value: string): string =>
  value.replace(/[&<>'\"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '\"': '&quot;',
  })[char] ?? char);

const remainingText = (target: string): string => {
  const ms = Math.max(0, Date.parse(target) - Date.now());
  const totalMinutes = Math.ceil(ms / 60_000);
  if (totalMinutes >= 60) return `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;
  return `${totalMinutes}m`;
};

const underpassStatus = (event?: WorldEventSnapshot): { label: string; detail: string; className: string } => {
  if (!event) return { label: 'SYNCING', detail: 'Checking city activity…', className: 'syncing' };
  if (event.phase === 'open') {
    return { label: 'OPEN', detail: `${remainingText(event.closesAt)} remaining`, className: 'open' };
  }
  if (event.phase === 'warning') {
    return { label: 'INSTABILITY RISING', detail: `Breach likely in ${remainingText(event.opensAt)}`, className: 'warning' };
  }
  return { label: 'SEALED', detail: 'Next breach unknown', className: 'sealed' };
};

const worldStatus = (event?: WorldEventSnapshot, backendOffline = false) =>
  backendOffline
    ? { label: 'OFFLINE', detail: 'Cannot reach the DEGEN server', className: 'sealed' }
    : underpassStatus(event);

const worldConnectionNotice = (backendOffline: boolean): string =>
  backendOffline
    ? '<p class="world-connection-error" role="status">LIVE WORLD UNAVAILABLE — The game cannot reach its server. Underpass combat is disabled until connection is restored.</p>'
    : '';

export const appShell = (player: PlayerState, content: string): string => `
  <header class="topbar">
    <button class="brand" type="button" data-route="map">DEGEN</button>
    <div class="player-chip">
      <span>${escapeHtml(player.displayName)}</span>
      <strong>LV.${player.level}</strong>
      <span>${player.currency} cr</span>
    </div>
  </header>
  <main class="screen">${content}</main>
  <nav class="bottom-nav" aria-label="Primary">
    <button type="button" data-route="map">MAP</button>
    <button type="button" data-route="home">HOME</button>
  </nav>
`;

export const mapView = (player: PlayerState, underpass?: WorldEventSnapshot, backendOffline = false): string => {
  const status = worldStatus(underpass, backendOffline);
  const districts = [...new Set(WORLD_LOCATIONS.map((location) => location.district))];
  const cards = districts.map((district) => {
    const locations = WORLD_LOCATIONS.filter((location) => location.district === district);
    const accessible = locations.filter((location) => player.unlockedLocations.includes(location.id)).length;
    return `<button type="button" class="city-district ${district === 'Central' ? 'central' : 'residential'}" data-district="${escapeHtml(district)}" ${accessible ? '' : 'disabled'}>
      <span class="city-district-art" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
      <span class="eyebrow">DISTRICT // ${escapeHtml(district.toUpperCase())}</span>
      <strong>${escapeHtml(district)}</strong>
      <span>${accessible} OF ${locations.length} LOCATIONS ACCESSIBLE</span>
      ${district === 'Central' ? `<span class="city-event-pill ${status.className}">UNDERPASS // ${escapeHtml(status.label)}</span>` : ''}
      <em>EXPLORE DISTRICT ↗</em>
    </button>`;
  }).join('');
  return appShell(player, `
    <section class="hero-block city-heading"><span class="eyebrow">CITY MAP // DISTRICTS</span>
      <h1>Choose your district.</h1><p>Select a district, then a location. Home is always one tap away.</p>
    </section>
    <section class="city-overview" aria-label="City map">
      <div class="city-map-header"><span>DEGEN // CITY GRID</span><span>SELECT A DISTRICT</span></div>
      <div class="city-district-grid">${cards}</div>
      <div class="city-map-footer">MAP → DISTRICT → LOCATION</div>
    </section>
    ${worldConnectionNotice(backendOffline)}
    ${!backendOffline && underpass?.source === 'preview' ? '<p class="preview-note">PREVIEW MODE — world-event timing is simulated until the backend is connected.</p>' : ''}
  `);
};

export const districtView = (player: PlayerState, district: string, underpass?: WorldEventSnapshot, backendOffline = false): string => {
  const locations = WORLD_LOCATIONS.filter((location) => location.district === district);
  if (!locations.length) return mapView(player, underpass, backendOffline);
  const status = worldStatus(underpass, backendOffline);
  const cards = locations.map((location) => {
    const unlocked = player.unlockedLocations.includes(location.id);
    const event = location.id === 'underpass';
    return `<button class="city-destination ${event ? `world-event ${status.className}` : ''}" type="button" data-location="${escapeHtml(location.id)}" ${unlocked ? '' : 'disabled'}>
      <span class="eyebrow">${escapeHtml(location.kind.toUpperCase())} // ${escapeHtml(district.toUpperCase())}</span>
      <strong>${escapeHtml(location.name)}</strong><span>${escapeHtml(location.description)}</span>
      ${event ? `<span class="event-detail">${escapeHtml(status.detail)}</span>` : ''}
      <em>${!unlocked ? 'LOCKED' : event ? escapeHtml(status.label) : 'ENTER LOCATION'} ↗</em>
    </button>`;
  }).join('');
  return appShell(player, `
    <div class="city-breadcrumb"><button type="button" data-route="map">← CITY MAP</button><span>/</span><strong>${escapeHtml(district.toUpperCase())}</strong></div>
    <section class="district-hero ${district === 'Central' ? 'central' : 'residential'}"><span class="eyebrow">CITY DISTRICT</span><h1>${escapeHtml(district)}</h1>
      <p>Select a location to enter.</p><div class="district-skyline" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
    </section>
    ${worldConnectionNotice(backendOffline)}
    <section class="district-locations" aria-label="${escapeHtml(district)} locations">${cards}</section>
  `);
};

export const locationView = (player: PlayerState, locationId: string): string => {
  const location = WORLD_LOCATIONS.find((item) => item.id === locationId && item.route === 'location');
  if (!location || !player.unlockedLocations.includes(location.id)) return mapView(player);
  const otherDestinations = WORLD_LOCATIONS
    .filter((item) => item.district === location.district && item.id !== location.id
      && player.unlockedLocations.includes(item.id))
    .map((item) => `<button class="city-connected-location" type="button" data-location="${escapeHtml(item.id)}">
      <span class="eyebrow">${escapeHtml(item.kind.toUpperCase())}</span><strong>${escapeHtml(item.name)}</strong><span aria-hidden="true">↗</span>
    </button>`).join('');
  return appShell(player, `
    <div class="city-breadcrumb"><button type="button" data-route="map">← CITY MAP</button><span>/</span><button type="button" data-route="district">${escapeHtml(location.district.toUpperCase())}</button></div>
    <section class="location-scene"><div class="location-scene-art" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
      <div class="location-scene-copy"><span class="eyebrow">${escapeHtml(location.district)} // ${escapeHtml(location.kind.toUpperCase())}</span>
      <h1>${escapeHtml(location.name)}</h1><p>${escapeHtml(location.description)}</p>
      <span class="location-scene-status">ACCESSIBLE // ACTIVITIES IN DEVELOPMENT</span></div>
    </section>
    ${otherDestinations ? `<section class="city-connected" aria-label="Other destinations in ${escapeHtml(location.district)}">
      <span class="eyebrow">MORE IN ${escapeHtml(location.district.toUpperCase())}</span><div>${otherDestinations}</div>
    </section>` : ''}
    <button class="secondary-action city-back-action" type="button" data-route="district">← BACK TO ${escapeHtml(location.district.toUpperCase())}</button>
  `);
};

export const homeView = (player: PlayerState, selectedFurniture?: string): string => {
  const cells = Array.from({ length: 48 }, (_, index) => {
    const x = index % 8;
    const y = Math.floor(index / 8);
    const placement = player.housing.placements.find((item) => item.x === x && item.y === y);
    const furniture = placement ? getFurniture(placement.furnitureId) : undefined;
    return `
      <button class="room-cell ${furniture ? 'occupied' : ''}" type="button" data-room-x="${x}" data-room-y="${y}" aria-label="Room cell ${x + 1}, ${y + 1}${furniture ? `: ${escapeHtml(furniture.name)}` : ''}">
        ${furniture ? `<span>${escapeHtml(furniture.icon)}</span><small>${escapeHtml(furniture.name)}</small>` : ''}
      </button>
    `;
  }).join('');

  const furnitureButtons = FURNITURE_CATALOG
    .filter((item) => player.housing.inventory.includes(item.id))
    .map((item) => `
      <button class="inventory-item ${selectedFurniture === item.id ? 'selected' : ''}" type="button" data-furniture="${item.id}">
        <span>${escapeHtml(item.icon)}</span>
        <small>${escapeHtml(item.name)}</small>
      </button>
    `).join('');

  return appShell(player, `
    <section class="hero-block compact">
      <span class="eyebrow">HOME // YOUR SPACE</span>
      <h1>Make it yours.</h1>
      <p>Select furniture, then tap a room cell to place or move it. With nothing selected, tapping occupied furniture removes it.</p>
    </section>
    <section class="housing-layout">
      <div class="room-grid" aria-label="Housing placement grid">${cells}</div>
      <aside class="furniture-panel">
        <div class="panel-heading">
          <strong>FURNITURE</strong>
          <button type="button" data-clear-selection>CLEAR</button>
        </div>
        <div class="furniture-list">${furnitureButtons}</div>
      </aside>
    </section>
  `);
};

export const underpassView = (player: PlayerState, event?: WorldEventSnapshot, backendOffline = false): string => {
  const status = worldStatus(event, backendOffline);
  const isOpen = event?.phase === 'open' && !backendOffline;
  const clears = event && !backendOffline ? `${Math.min(event.fullRewardClears, event.fullRewardLimit)}/${event.fullRewardLimit}` : '—';
  return appShell(player, `
    <div class="city-breadcrumb"><button type="button" data-route="map">← CITY MAP</button><span>/</span><button type="button" data-route="district">CENTRAL</button></div>
    <section class="hero-block danger underpass-hero ${status.className}">
      <span class="eyebrow">CENTRAL // WORLD EVENT</span>
      <div class="event-status ${status.className}">${escapeHtml(status.label)}</div>
      <h1>The Underpass</h1>
      <p>${escapeHtml(status.detail)}</p>
      <div class="event-meta">
        <span><strong>${clears}</strong> full-reward clears this breach</span>
        <span>Closed 2–4h // Open 60–90m</span>
      </div>
      <p>When combat begins, you manifest as your Degen immediately. The entrance cannot be farmed while sealed.</p>
      <button class="primary-action" type="button" data-start-battle ${isOpen ? '' : 'disabled'}>${isOpen ? 'ENTER UNDERPASS' : 'UNDERPASS SEALED'}</button>
      ${worldConnectionNotice(backendOffline)}
      ${!backendOffline && event?.source === 'preview' ? '<small class="preview-note">Local preview cycle — production timing will be server-authoritative.</small>' : ''}
    </section>
  `);
};

export const battleView = (player: PlayerState, degen: DegenDefinition): string => appShell(player, `
  <section class="battle-layout">
    <div id="phaser-battle" class="battle-canvas" aria-label="Battle scene"></div>
    <div class="battle-controls">
      <span class="eyebrow">MANIFESTED // ${escapeHtml(degen.name)}</span>
      <div class="ability-grid">
        ${degen.abilities.map((ability) => `
          <button type="button" data-ability="${ability.id}" data-mana-cost="${ability.manaCost}">
            <strong>${escapeHtml(ability.name)}</strong>
            <span>${escapeHtml(ability.description)}</span>
            <small>${ability.manaCost === 0 ? 'NO MANA' : `${ability.manaCost} MANA`}</small>
          </button>
        `).join('')}
      </div>
      <div id="battle-log" class="battle-log" aria-live="polite"></div>
      <button class="secondary-action" type="button" data-route="underpass">ABANDON FIGHT</button>
    </div>
  </section>
`);

export const updateBattleDom = (snapshot: BattleSnapshot): void => {
  const log = document.querySelector<HTMLElement>('#battle-log');
  if (!log) return;

  log.innerHTML = snapshot.log.map((entry) => `<div>${escapeHtml(entry)}</div>`).join('');

  document.querySelectorAll<HTMLButtonElement>('[data-ability]').forEach((button) => {
    const manaCost = Number(button.dataset.manaCost ?? 0);
    button.disabled = snapshot.status !== 'active' || manaCost > snapshot.playerMana;
  });

  if (snapshot.status !== 'active') {
    const result = document.createElement('strong');
    result.className = `battle-result ${snapshot.status}`;
    result.textContent = snapshot.status === 'victory' ? 'VICTORY — verifying rewards.' : 'DEFEAT — returning to the Underpass.';
    log.append(result);
  }
};
