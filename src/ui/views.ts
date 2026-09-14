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

export const mapView = (player: PlayerState, underpass?: WorldEventSnapshot): string => {
  const eventStatus = underpassStatus(underpass);
  const cards = WORLD_LOCATIONS.map((location) => {
    const unlocked = player.unlockedLocations.includes(location.id);
    const isUnderpass = location.id === 'underpass';
    const status = isUnderpass ? eventStatus.label : unlocked ? 'OPEN' : 'LOCKED';
    const detail = isUnderpass ? `<span class="event-detail">${escapeHtml(eventStatus.detail)}</span>` : '';
    return `
      <button class="location-card ${isUnderpass ? `world-event ${eventStatus.className}` : ''}" type="button" data-route="${location.route}" ${unlocked ? '' : 'disabled'}>
        <span class="eyebrow">${escapeHtml(location.district)} // ${location.kind.toUpperCase()}</span>
        <strong>${escapeHtml(location.name)}</strong>
        <span>${escapeHtml(location.description)}</span>
        ${detail}
        <em>${escapeHtml(status)}</em>
      </button>
    `;
  }).join('');

  return appShell(player, `
    <section class="hero-block">
      <span class="eyebrow">CITY MAP // LIVE WORLD</span>
      <h1>Where are you going?</h1>
      <p>Locations can open, close, mutate, or appear without turning the city into an open-world traversal game.</p>
    </section>
    <section class="location-grid">${cards}</section>
    ${underpass?.source === 'preview' ? '<p class="preview-note">PREVIEW MODE — this browser is simulating the world-event clock until the Cloudflare backend is connected.</p>' : ''}
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

export const underpassView = (player: PlayerState, event?: WorldEventSnapshot): string => {
  const status = underpassStatus(event);
  const isOpen = event?.phase === 'open';
  const clears = event ? `${Math.min(event.fullRewardClears, event.fullRewardLimit)}/${event.fullRewardLimit}` : '—';
  return appShell(player, `
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
      ${event?.source === 'preview' ? '<small class="preview-note">Local preview cycle — production timing will be server-authoritative.</small>' : ''}
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
          <button type="button" data-ability="${ability.id}">
            <strong>${escapeHtml(ability.name)}</strong>
            <span>${escapeHtml(ability.description)}</span>
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
    button.disabled = snapshot.status !== 'active';
  });

  if (snapshot.status !== 'active') {
    const result = document.createElement('strong');
    result.className = `battle-result ${snapshot.status}`;
    result.textContent = snapshot.status === 'victory' ? 'VICTORY — verifying rewards.' : 'DEFEAT — returning to the Underpass.';
    log.append(result);
  }
};
