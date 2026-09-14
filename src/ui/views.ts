import { FURNITURE_CATALOG, WORLD_LOCATIONS, getFurniture } from '../data/world';
import type { BattleSnapshot } from '../game/combat/engine';
import type { DegenDefinition, PlayerState } from '../domain/types';

const escapeHtml = (value: string): string =>
  value.replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char] ?? char);

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

export const mapView = (player: PlayerState): string => {
  const cards = WORLD_LOCATIONS.map((location) => {
    const unlocked = player.unlockedLocations.includes(location.id);
    return `
      <button class="location-card" type="button" data-route="${location.route}" ${unlocked ? '' : 'disabled'}>
        <span class="eyebrow">${escapeHtml(location.district)} // ${location.kind.toUpperCase()}</span>
        <strong>${escapeHtml(location.name)}</strong>
        <span>${escapeHtml(location.description)}</span>
        <em>${unlocked ? 'OPEN' : 'LOCKED'}</em>
      </button>
    `;
  }).join('');

  return appShell(player, `
    <section class="hero-block">
      <span class="eyebrow">CITY MAP // PROTOTYPE</span>
      <h1>Where are you going?</h1>
      <p>The final city will expand through destinations and unlockable locations instead of open-world traversal.</p>
    </section>
    <section class="location-grid">${cards}</section>
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

export const underpassView = (player: PlayerState): string => appShell(player, `
  <section class="hero-block danger">
    <span class="eyebrow">CENTRAL // COMBAT LOCATION</span>
    <h1>The Underpass</h1>
    <p>Something is moving below the service road. Entering a battle means manifesting as your Degen immediately. There is no human-form combat.</p>
    <button class="primary-action" type="button" data-start-battle>ENTER UNDERPASS</button>
  </section>
`);

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
    result.textContent = snapshot.status === 'victory' ? 'VICTORY — returning to the Underpass.' : 'DEFEAT — returning to the Underpass.';
    log.append(result);
  }
};
