/// <reference types="@cloudflare/workers-types" />

interface Env {
  DB: D1Database;
  ALLOWED_ORIGINS?: string;
}

const FULL_REWARD_LIMIT = 3;
const STARTER_FURNITURE = ['starter-bed', 'starter-chair', 'starter-lamp', 'starter-rug'];
const STARTER_LOCATIONS = ['home', 'downtown', 'underpass'];

const corsHeaders = (request: Request, env: Env): HeadersInit => {
  const origin = request.headers.get('origin') ?? '';
  const allowed = (env.ALLOWED_ORIGINS ?? 'https://milesgoeswildtv.github.io,http://localhost:5173')
    .split(',')
    .map((value) => value.trim());
  const allowOrigin = allowed.includes(origin) ? origin : allowed[0] ?? '*';
  return {
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'vary': 'Origin',
  };
};

const json = (request: Request, env: Env, data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(request, env) },
  });

const fail = (request: Request, env: Env, message: string, status = 400): Response =>
  json(request, env, { error: message }, status);

const body = async <T>(request: Request): Promise<T> => request.json<T>();
const iso = (value = Date.now()): string => new Date(value).toISOString();
const randomInt = (min: number, max: number): number => {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return min + ((bytes[0] ?? 0) % (max - min + 1));
};
const xpNeeded = (level: number): number => 100 + (level - 1) * 75;

type CycleRow = { id: string; event_key: string; opens_at: string; closes_at: string };

type CharacterRow = { level: number; xp: number; currency: number; degen_key: string };

async function ensurePlayer(db: D1Database, playerId: string, displayName: string): Promise<void> {
  await db.batch([
    db.prepare(`INSERT INTO players (id, display_name) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, updated_at = CURRENT_TIMESTAMP`).bind(playerId, displayName.slice(0, 32)),
    db.prepare(`INSERT OR IGNORE INTO characters (player_id, level, xp, currency, degen_key) VALUES (?, 1, 0, 0, 'test-degen')`).bind(playerId),
    ...STARTER_LOCATIONS.map((location) => db.prepare(`INSERT OR IGNORE INTO unlocked_locations (player_id, location_key) VALUES (?, ?)`).bind(playerId, location)),
    ...STARTER_FURNITURE.map((item) => db.prepare(`INSERT OR IGNORE INTO player_inventory (id, player_id, item_key, item_type, quantity) VALUES (?, ?, ?, 'furniture', 1)`).bind(`${playerId}:furniture:${item}`, playerId, item)),
  ]);

  const housing = await db.prepare(`SELECT COUNT(*) AS count FROM housing_placements WHERE player_id = ?`).bind(playerId).first<{ count: number }>();
  if ((housing?.count ?? 0) === 0) {
    await db.prepare(`INSERT INTO housing_placements (id, player_id, furniture_key, grid_x, grid_y, rotation) VALUES (?, ?, 'starter-bed', 1, 1, 0)`)
      .bind(`${playerId}:starter-bed-placed`, playerId).run();
  }
}

async function loadPlayer(db: D1Database, playerId: string) {
  const player = await db.prepare(`SELECT display_name FROM players WHERE id = ?`).bind(playerId).first<{ display_name: string }>();
  const character = await db.prepare(`SELECT level, xp, currency, degen_key FROM characters WHERE player_id = ?`).bind(playerId).first<CharacterRow>();
  if (!player || !character) return undefined;

  const [inventory, locations, housing, bosses] = await Promise.all([
    db.prepare(`SELECT item_key, item_type, quantity FROM player_inventory WHERE player_id = ?`).bind(playerId).all<{ item_key: string; item_type: string; quantity: number }>(),
    db.prepare(`SELECT location_key FROM unlocked_locations WHERE player_id = ?`).bind(playerId).all<{ location_key: string }>(),
    db.prepare(`SELECT id, furniture_key, grid_x, grid_y, rotation FROM housing_placements WHERE player_id = ?`).bind(playerId).all<{ id: string; furniture_key: string; grid_x: number; grid_y: number; rotation: number }>(),
    db.prepare(`SELECT boss_key FROM defeated_bosses WHERE player_id = ?`).bind(playerId).all<{ boss_key: string }>(),
  ]);

  const furniture = inventory.results.filter((row) => row.item_type === 'furniture').map((row) => row.item_key);
  const items = inventory.results
    .filter((row) => row.item_type !== 'furniture')
    .flatMap((row) => Array.from({ length: row.quantity }, () => row.item_key));

  return {
    id: playerId,
    displayName: player.display_name,
    level: character.level,
    xp: character.xp,
    currency: character.currency,
    degenId: character.degen_key,
    inventory: items,
    unlockedLocations: locations.results.map((row) => row.location_key),
    housing: {
      inventory: furniture,
      placements: housing.results.map((row) => ({
        instanceId: row.id,
        furnitureId: row.furniture_key,
        x: row.grid_x,
        y: row.grid_y,
        rotation: row.rotation,
      })),
    },
    defeatedBosses: bosses.results.map((row) => row.boss_key),
  };
}

async function ensureUnderpassCycle(db: D1Database): Promise<CycleRow> {
  const now = Date.now();
  const latest = await db.prepare(`SELECT id, event_key, opens_at, closes_at FROM world_event_cycles WHERE event_key = 'underpass' ORDER BY closes_at DESC LIMIT 1`).first<CycleRow>();
  if (latest && Date.parse(latest.closes_at) > now) return latest;

  const closedMinutes = randomInt(120, 240);
  const openMinutes = randomInt(60, 90);
  const opensAt = now + closedMinutes * 60_000;
  const cycle: CycleRow = {
    id: crypto.randomUUID(),
    event_key: 'underpass',
    opens_at: iso(opensAt),
    closes_at: iso(opensAt + openMinutes * 60_000),
  };
  await db.prepare(`INSERT INTO world_event_cycles (id, event_key, opens_at, closes_at) VALUES (?, ?, ?, ?)`)
    .bind(cycle.id, cycle.event_key, cycle.opens_at, cycle.closes_at).run();
  return cycle;
}

function phaseFor(cycle: CycleRow): 'sealed' | 'warning' | 'open' {
  const now = Date.now();
  const opens = Date.parse(cycle.opens_at);
  const closes = Date.parse(cycle.closes_at);
  if (now >= opens && now < closes) return 'open';
  if (opens - now <= 15 * 60_000 && now < opens) return 'warning';
  return 'sealed';
}

async function worldSnapshot(db: D1Database, playerId: string, cycle?: CycleRow) {
  const activeCycle = cycle ?? await ensureUnderpassCycle(db);
  const clears = await db.prepare(`SELECT full_reward_clears FROM world_event_clears WHERE player_id = ? AND event_key = 'underpass' AND cycle_id = ?`)
    .bind(playerId, activeCycle.id).first<{ full_reward_clears: number }>();
  return {
    eventKey: 'underpass',
    cycleId: activeCycle.id,
    phase: phaseFor(activeCycle),
    opensAt: activeCycle.opens_at,
    closesAt: activeCycle.closes_at,
    fullRewardClears: clears?.full_reward_clears ?? 0,
    fullRewardLimit: FULL_REWARD_LIMIT,
    source: 'server' as const,
  };
}

async function handleBootstrap(request: Request, env: Env): Promise<Response> {
  const input = await body<{ playerId?: string; displayName?: string; platform?: string; platformUserId?: string }>(request);
  if (!input.playerId) return fail(request, env, 'playerId is required');
  await ensurePlayer(env.DB, input.playerId, input.displayName || 'Player');

  if ((input.platform === 'discord' || input.platform === 'telegram') && input.platformUserId) {
    await env.DB.prepare(`INSERT INTO platform_identities (platform, platform_user_id, player_id, display_name) VALUES (?, ?, ?, ?)
      ON CONFLICT(platform, platform_user_id) DO UPDATE SET player_id = excluded.player_id, display_name = excluded.display_name`)
      .bind(input.platform, input.platformUserId, input.playerId, (input.displayName || 'Player').slice(0, 32)).run();
  }

  const player = await loadPlayer(env.DB, input.playerId);
  return json(request, env, player);
}

async function handleHousing(request: Request, env: Env): Promise<Response> {
  const input = await body<{ playerId?: string; housing?: { inventory?: string[]; placements?: Array<{ instanceId: string; furnitureId: string; x: number; y: number; rotation?: number }> } }>(request);
  if (!input.playerId || !input.housing) return fail(request, env, 'playerId and housing are required');
  const allowed = new Set((await env.DB.prepare(`SELECT item_key FROM player_inventory WHERE player_id = ? AND item_type = 'furniture'`).bind(input.playerId).all<{ item_key: string }>()).results.map((row) => row.item_key));
  const placements = (input.housing.placements ?? []).filter((item) => allowed.has(item.furnitureId) && Number.isInteger(item.x) && Number.isInteger(item.y) && item.x >= 0 && item.x <= 7 && item.y >= 0 && item.y <= 5);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM housing_placements WHERE player_id = ?`).bind(input.playerId),
    ...placements.map((item) => env.DB.prepare(`INSERT INTO housing_placements (id, player_id, furniture_key, grid_x, grid_y, rotation) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(item.instanceId, input.playerId, item.furnitureId, item.x, item.y, item.rotation ?? 0)),
  ]);
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

async function handleStartBattle(request: Request, env: Env): Promise<Response> {
  const input = await body<{ playerId?: string; eventKey?: string; cycleId?: string; encounterKey?: string }>(request);
  if (!input.playerId || input.eventKey !== 'underpass' || !input.cycleId || input.encounterKey !== 'tunnel-maw') return fail(request, env, 'Invalid battle start request');
  const cycle = await ensureUnderpassCycle(env.DB);
  if (cycle.id !== input.cycleId || phaseFor(cycle) !== 'open') return fail(request, env, 'The Underpass is sealed.', 409);

  const permitId = crypto.randomUUID();
  const expiresAt = iso(Date.now() + 20 * 60_000);
  await env.DB.prepare(`INSERT INTO battle_permits (id, player_id, event_key, cycle_id, encounter_key, expires_at) VALUES (?, ?, 'underpass', ?, 'tunnel-maw', ?)`)
    .bind(permitId, input.playerId, cycle.id, expiresAt).run();
  return json(request, env, { permitId, eventKey: 'underpass', cycleId: cycle.id, encounterKey: 'tunnel-maw', expiresAt });
}

async function handleCompleteBattle(request: Request, env: Env): Promise<Response> {
  const input = await body<{ playerId?: string; permitId?: string }>(request);
  if (!input.playerId || !input.permitId) return fail(request, env, 'playerId and permitId are required');

  const permit = await env.DB.prepare(`UPDATE battle_permits SET completed_at = CURRENT_TIMESTAMP WHERE id = ? AND player_id = ? AND completed_at IS NULL AND expires_at > CURRENT_TIMESTAMP RETURNING cycle_id, encounter_key`)
    .bind(input.permitId, input.playerId).first<{ cycle_id: string; encounter_key: string }>();
  if (!permit) return fail(request, env, 'Battle permit is invalid, expired, or already completed.', 409);

  await env.DB.prepare(`INSERT OR IGNORE INTO world_event_clears (player_id, event_key, cycle_id, full_reward_clears) VALUES (?, 'underpass', ?, 0)`)
    .bind(input.playerId, permit.cycle_id).run();
  const clearRow = await env.DB.prepare(`UPDATE world_event_clears SET full_reward_clears = full_reward_clears + 1 WHERE player_id = ? AND event_key = 'underpass' AND cycle_id = ? RETURNING full_reward_clears`)
    .bind(input.playerId, permit.cycle_id).first<{ full_reward_clears: number }>();
  const fullReward = (clearRow?.full_reward_clears ?? FULL_REWARD_LIMIT + 1) <= FULL_REWARD_LIMIT;

  const reward = fullReward
    ? { xp: 75, currency: 30, items: ['underpass-scrap'], furniture: ['tunnel-trophy'], tier: 'full' as const }
    : { xp: 10, currency: 3, items: [] as string[], furniture: [] as string[], tier: 'reduced' as const };

  const character = await env.DB.prepare(`SELECT level, xp, currency, degen_key FROM characters WHERE player_id = ?`).bind(input.playerId).first<CharacterRow>();
  if (!character) return fail(request, env, 'Player character not found.', 404);
  let level = character.level;
  let xp = character.xp + reward.xp;
  while (xp >= xpNeeded(level)) {
    xp -= xpNeeded(level);
    level += 1;
  }

  const writes = [
    env.DB.prepare(`UPDATE characters SET level = ?, xp = ?, currency = currency + ?, updated_at = CURRENT_TIMESTAMP WHERE player_id = ?`).bind(level, xp, reward.currency, input.playerId),
    env.DB.prepare(`INSERT INTO battle_history (id, player_id, encounter_key, result, player_level, xp_awarded, currency_awarded) VALUES (?, ?, 'tunnel-maw', 'victory', ?, ?, ?)`).bind(crypto.randomUUID(), input.playerId, level, reward.xp, reward.currency),
    env.DB.prepare(`INSERT OR IGNORE INTO defeated_bosses (player_id, boss_key) VALUES (?, 'tunnel-maw')`).bind(input.playerId),
  ];

  if (fullReward) {
    writes.push(
      env.DB.prepare(`INSERT INTO player_inventory (id, player_id, item_key, item_type, quantity) VALUES (?, ?, 'underpass-scrap', 'item', 1)
        ON CONFLICT(id) DO UPDATE SET quantity = quantity + 1`).bind(`${input.playerId}:item:underpass-scrap`, input.playerId),
      env.DB.prepare(`INSERT OR IGNORE INTO player_inventory (id, player_id, item_key, item_type, quantity) VALUES (?, ?, 'tunnel-trophy', 'furniture', 1)`).bind(`${input.playerId}:furniture:tunnel-trophy`, input.playerId),
    );
  }
  await env.DB.batch(writes);

  const player = await loadPlayer(env.DB, input.playerId);
  const cycle = await env.DB.prepare(`SELECT id, event_key, opens_at, closes_at FROM world_event_cycles WHERE id = ?`).bind(permit.cycle_id).first<CycleRow>();
  const event = cycle ? await worldSnapshot(env.DB, input.playerId, cycle) : await worldSnapshot(env.DB, input.playerId);
  return json(request, env, { player, reward, worldEvent: event });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    const url = new URL(request.url);

    try {
      if (request.method === 'GET' && url.pathname === '/api/health') return json(request, env, { ok: true, service: 'degen-api' });
      if (request.method === 'POST' && url.pathname === '/api/player/bootstrap') return handleBootstrap(request, env);
      if (request.method === 'PUT' && url.pathname === '/api/player/housing') return handleHousing(request, env);
      if (request.method === 'GET' && url.pathname === '/api/world/underpass') {
        const playerId = url.searchParams.get('playerId');
        if (!playerId) return fail(request, env, 'playerId is required');
        const snapshot = await worldSnapshot(env.DB, playerId);
        return json(request, env, snapshot);
      }
      if (request.method === 'POST' && url.pathname === '/api/battle/start') return handleStartBattle(request, env);
      if (request.method === 'POST' && url.pathname === '/api/battle/complete') return handleCompleteBattle(request, env);
      return fail(request, env, 'Not found', 404);
    } catch (error) {
      console.error(error);
      return fail(request, env, error instanceof Error ? error.message : 'Internal server error', 500);
    }
  },
} satisfies ExportedHandler<Env>;
