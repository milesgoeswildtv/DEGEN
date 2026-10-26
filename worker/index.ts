/// <reference types="@cloudflare/workers-types" />

import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype';
import { canUseAbility, resolveCombatTurn } from '../src/game/combat/rules';
import { UNDERPASS_FULL_REWARD_LIMIT, advanceLevel, underpassRewardForClear, xpNeededForLevel } from '../src/game/progression';

interface Env {
  DB: D1Database;
  ALLOWED_ORIGINS?: string;
}

const STARTER_FURNITURE = ['starter-bed', 'starter-chair', 'starter-lamp', 'starter-rug'];
const STARTER_LOCATIONS = ['home', 'downtown', 'underpass'];

const corsHeaders = (request: Request, env: Env): HeadersInit => {
  const origin = request.headers.get('origin') ?? '';
  const allowed = (env.ALLOWED_ORIGINS ?? 'https://milesgoeswildtv.github.io,http://localhost:5173')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const headers: Record<string, string> = {
    'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'vary': 'Origin',
  };
  // A missing or unlisted Origin must never receive an Access-Control-Allow-Origin grant.
  if (origin && allowed.includes(origin)) headers['access-control-allow-origin'] = origin;
  return headers;
};

const json = (request: Request, env: Env, data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...corsHeaders(request, env) },
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

type CycleRow = { id: string; event_key: string; opens_at: string; closes_at: string };
type CharacterRow = { level: number; xp: number; currency: number; degen_key: string };
type BattlePermitStateRow = {
  cycle_id: string;
  encounter_key: string;
  player_hp: number | null;
  player_mana: number | null;
  enemy_hp: number | null;
  battle_status: 'active' | 'victory' | 'defeat';
  turn_count: number;
};

type BattleActionPermitRow = BattlePermitStateRow & {
  event_key: string;
  cycle_event_key: string | null;
};

const isSafeIntegerBetween = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

// The current PlayerState contract expands stack quantities into string[] entries.
// Keep malformed/corrupt D1 rows from allocating unbounded arrays; this is an API
// snapshot safety bound, not a gameplay inventory or stack-balance rule.
const MAX_INVENTORY_SNAPSHOT_ITEMS = 10_000;
type InventoryQuantityRow = { item_type: string; quantity: number };

class InventoryIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InventoryIntegrityError';
  }
}

const countInventorySnapshotItems = (rows: InventoryQuantityRow[]): number => {
  let total = 0;
  for (const row of rows) {
    if (!isSafeIntegerBetween(row.quantity, 1, Number.MAX_SAFE_INTEGER)) {
      throw new InventoryIntegrityError('Player inventory quantity is invalid.');
    }
    if (row.item_type !== 'furniture') {
      if (row.quantity > MAX_INVENTORY_SNAPSHOT_ITEMS - total) {
        throw new InventoryIntegrityError('Player inventory exceeds the supported snapshot size.');
      }
      total += row.quantity;
    }
  }
  return total;
};

async function inventorySnapshotItemCount(db: D1Database, playerId: string): Promise<number> {
  const inventory = await db.prepare(`SELECT item_type, quantity FROM player_inventory WHERE player_id = ?`)
    .bind(playerId).all<InventoryQuantityRow>();
  return countInventorySnapshotItems(inventory.results);
}

const isValidProgressionState = (level: unknown, xp: unknown): boolean => {
  if (!isSafeIntegerBetween(level, 1, Number.MAX_SAFE_INTEGER)
    || !isSafeIntegerBetween(xp, 0, Number.MAX_SAFE_INTEGER)) return false;
  const threshold = xpNeededForLevel(level);
  return isSafeIntegerBetween(threshold, 1, Number.MAX_SAFE_INTEGER) && xp < threshold;
};

// A persisted permit must satisfy the same bounds and terminal-state invariants
// enforced by the client snapshot parser before it can advance another turn.
const isValidBattlePermitState = (state: BattlePermitStateRow): boolean => {
  const playerHp = state.player_hp;
  const playerMana = state.player_mana;
  const enemyHp = state.enemy_hp;
  const turnCount = state.turn_count;

  // Pre-Mana terminal permits can legitimately retain NULL: Mana did not exist
  // when their outcome was resolved. Active permits must always carry persisted Mana.
  const hasValidMana = isSafeIntegerBetween(playerMana, 0, TEST_DEGEN.maxMana)
    || (playerMana === null && state.battle_status !== 'active');

  if (!isSafeIntegerBetween(playerHp, 0, TEST_DEGEN.maxHp)
    || !hasValidMana
    || !isSafeIntegerBetween(enemyHp, 0, TUNNEL_MAW.maxHp)
    || !isSafeIntegerBetween(turnCount, 0, Number.MAX_SAFE_INTEGER)) return false;

  switch (state.battle_status) {
    case 'active':
      // An accepted action must be able to increment turn_count without leaving safe-integer range.
      return playerHp > 0 && enemyHp > 0 && turnCount < Number.MAX_SAFE_INTEGER;
    case 'victory':
      return turnCount > 0 && playerHp > 0 && enemyHp === 0;
    case 'defeat':
      return turnCount > 0 && playerHp === 0 && enemyHp > 0;
    default:
      return false;
  }
};

// A missing Mana value is projected only for validated terminal legacy snapshots.
// It is never persisted and can never authorize another action.
const playerManaForSnapshot = (state: BattlePermitStateRow): number =>
  state.player_mana ?? TEST_DEGEN.maxMana;

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

  countInventorySnapshotItems(inventory.results);
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
  // Serialize cycle creation in SQLite rather than trusting the earlier read.
  const inserted = await db.prepare(`INSERT INTO world_event_cycles (id, event_key, opens_at, closes_at)
    SELECT ?, 'underpass', ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM world_event_cycles
      WHERE event_key = 'underpass' AND julianday(closes_at) > julianday(?)
    )
    RETURNING id, event_key, opens_at, closes_at`)
    .bind(cycle.id, cycle.opens_at, cycle.closes_at, iso(now)).first<CycleRow>();
  if (inserted) return inserted;

  const concurrent = await db.prepare(`SELECT id, event_key, opens_at, closes_at FROM world_event_cycles
    WHERE event_key = 'underpass' AND julianday(closes_at) > julianday(?)
    ORDER BY closes_at DESC LIMIT 1`).bind(iso(now)).first<CycleRow>();
  if (concurrent) return concurrent;
  throw new Error('Unable to resolve the current Underpass cycle.');
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
    fullRewardLimit: UNDERPASS_FULL_REWARD_LIMIT,
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
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store', ...corsHeaders(request, env) } });
}

async function handleStartBattle(request: Request, env: Env): Promise<Response> {
  const input = await body<{ playerId?: string; eventKey?: string; cycleId?: string; encounterKey?: string }>(request);
  if (!input.playerId || input.eventKey !== 'underpass' || !input.cycleId || input.encounterKey !== TUNNEL_MAW.id) {
    return fail(request, env, 'Invalid battle start request');
  }

  const cycle = await ensureUnderpassCycle(env.DB);
  if (cycle.id !== input.cycleId || phaseFor(cycle) !== 'open') return fail(request, env, 'The Underpass is sealed.', 409);

  const permitId = crypto.randomUUID();
  const now = Date.now();
  const startedAt = iso(now);
  const expiresAt = iso(now + 20 * 60_000);
  const initialState = {
    permitId,
    status: 'active' as const,
    playerHp: TEST_DEGEN.maxHp,
    playerMana: TEST_DEGEN.maxMana,
    enemyHp: TUNNEL_MAW.maxHp,
    turnCount: 0,
  };
  // Recheck the cycle inside the permit-issuing statement. The earlier phase
  // read is advisory: the cycle can close between that read and this write.
  const issuedPermit = await env.DB.prepare(`INSERT INTO battle_permits (
      id, player_id, event_key, cycle_id, encounter_key, started_at, expires_at,
      player_hp, player_mana, enemy_hp, battle_status, turn_count
    )
    SELECT ?, ?, 'underpass', ?, ?, ?, ?, ?, ?, ?, 'active', 0
    WHERE EXISTS (
      SELECT 1 FROM world_event_cycles
      WHERE id = ? AND event_key = 'underpass'
        AND julianday(opens_at) <= julianday(?)
        AND julianday(?) < julianday(closes_at)
        AND julianday(closes_at) > julianday('now')
    )
    RETURNING id`)
    .bind(permitId, input.playerId, cycle.id, TUNNEL_MAW.id, startedAt, expiresAt,
      initialState.playerHp, initialState.playerMana, initialState.enemyHp, cycle.id, startedAt, startedAt)
    .first<{ id: string }>();
  if (!issuedPermit) return fail(request, env, 'The Underpass is sealed.', 409);

  return json(request, env, {
    permitId,
    eventKey: 'underpass',
    cycleId: cycle.id,
    encounterKey: TUNNEL_MAW.id,
    expiresAt,
    initialState,
  });
}

async function handleBattleAction(request: Request, env: Env): Promise<Response> {
  const input = await body<{ playerId?: string; permitId?: string; abilityId?: string; expectedTurnCount: number }>(request);
  if (!input.playerId || !input.permitId || !input.abilityId) {
    return fail(request, env, 'playerId, permitId, and abilityId are required');
  }
  // This is a compare-and-swap precondition only; combat state remains Worker-owned.
  if (!Number.isSafeInteger(input.expectedTurnCount) || input.expectedTurnCount < 0) {
    return fail(request, env, 'expectedTurnCount is required and must be a non-negative safe integer.', 400);
  }

  const ability = TEST_DEGEN.abilities.find((candidate) => candidate.id === input.abilityId);
  if (!ability) return fail(request, env, 'Unknown ability.', 400);

  const permit = await env.DB.prepare(`SELECT
      permit.event_key, cycle.event_key AS cycle_event_key,
      permit.cycle_id, permit.encounter_key, permit.player_hp, permit.player_mana,
      permit.enemy_hp, permit.battle_status, permit.turn_count
    FROM battle_permits AS permit
    LEFT JOIN world_event_cycles AS cycle ON cycle.id = permit.cycle_id
    WHERE permit.id = ? AND permit.player_id = ? AND permit.completed_at IS NULL
      AND julianday(permit.expires_at) > julianday('now')
      AND julianday(cycle.opens_at) <= julianday(permit.started_at)
      AND julianday(permit.started_at) < julianday(cycle.closes_at)`)
    .bind(input.permitId, input.playerId)
    .first<BattleActionPermitRow>();

  if (!permit) {
    // Preserve the existing awarded-receipt replay path for a delayed second tab.
    const completed = await env.DB.prepare(`SELECT
        permit.event_key, cycle.event_key AS cycle_event_key,
        permit.cycle_id, permit.encounter_key, permit.player_hp, permit.player_mana,
        permit.enemy_hp, permit.battle_status, permit.turn_count
      FROM battle_permits AS permit
      LEFT JOIN world_event_cycles AS cycle ON cycle.id = permit.cycle_id
      WHERE permit.id = ? AND permit.player_id = ? AND permit.completed_at IS NOT NULL
        AND permit.reward_state = 'awarded' AND permit.battle_status = 'victory'
        AND julianday(cycle.opens_at) <= julianday(permit.started_at)
        AND julianday(permit.started_at) < julianday(cycle.closes_at)`)
      .bind(input.permitId, input.playerId)
      .first<BattleActionPermitRow>();
    if (completed
      && completed.event_key === 'underpass'
      && completed.cycle_event_key === 'underpass'
      && completed.encounter_key === TUNNEL_MAW.id
      && isValidBattlePermitState(completed)) {
      return json(request, env, {
        error: 'Battle permit is already completed.',
        battleState: {
          permitId: input.permitId,
          status: completed.battle_status,
          playerHp: completed.player_hp,
          playerMana: playerManaForSnapshot(completed),
          enemyHp: completed.enemy_hp,
          turnCount: completed.turn_count,
        },
      }, 409);
    }

    // A terminal action can commit before expiry while its HTTP response is lost.
    // Recover only the owner-scoped, persisted terminal snapshot; this never reopens
    // the permit or authorizes another action. Active expired permits still fail closed.
    const terminal = await env.DB.prepare(`SELECT
        permit.event_key, cycle.event_key AS cycle_event_key,
        permit.cycle_id, permit.encounter_key, permit.player_hp, permit.player_mana,
        permit.enemy_hp, permit.battle_status, permit.turn_count,
        permit.completed_at, permit.reward_state
      FROM battle_permits AS permit
      LEFT JOIN world_event_cycles AS cycle ON cycle.id = permit.cycle_id
      WHERE permit.id = ? AND permit.player_id = ? AND permit.completed_at IS NULL
        AND permit.battle_status IN ('victory', 'defeat')
        AND julianday(cycle.opens_at) <= julianday(permit.started_at)
        AND julianday(permit.started_at) < julianday(cycle.closes_at)`)
      .bind(input.permitId, input.playerId)
      .first<BattleActionPermitRow & {
        completed_at: string | null;
        reward_state: 'pending' | 'claiming' | 'awarded';
      }>();
    const pendingVictory = terminal?.battle_status === 'victory'
      && (terminal.reward_state === 'pending' || terminal.reward_state === 'claiming');
    const unresolvedDefeat = terminal?.battle_status === 'defeat'
      && terminal.reward_state === 'pending';
    if (terminal
      && terminal.event_key === 'underpass'
      && terminal.cycle_event_key === 'underpass'
      && terminal.encounter_key === TUNNEL_MAW.id
      && isValidBattlePermitState(terminal)
      && (pendingVictory || unresolvedDefeat)) {
      return json(request, env, {
        error: pendingVictory
          ? 'Battle victory is awaiting reward completion.'
          : 'Battle is already defeated.',
        battleState: {
          permitId: input.permitId,
          status: terminal.battle_status,
          playerHp: terminal.player_hp,
          playerMana: playerManaForSnapshot(terminal),
          enemyHp: terminal.enemy_hp,
          turnCount: terminal.turn_count,
        },
      }, 409);
    }
    return fail(request, env, 'Battle permit is invalid, expired, or already completed.', 409);
  }
  if (permit.event_key !== 'underpass' || permit.cycle_event_key !== 'underpass') {
    return fail(request, env, 'Unsupported battle permit.', 409);
  }
  if (permit.encounter_key !== TUNNEL_MAW.id) return fail(request, env, 'Unsupported encounter.', 409);
  if (permit.player_hp === null || permit.enemy_hp === null
    || (permit.player_mana === null && permit.battle_status === 'active')) {
    return fail(request, env, 'Battle state is unavailable.', 409);
  }
  if (!isValidBattlePermitState(permit)) {
    return fail(request, env, 'Battle state is invalid.', 409);
  }
  const battleState = {
    permitId: input.permitId,
    status: permit.battle_status,
    playerHp: permit.player_hp,
    playerMana: playerManaForSnapshot(permit),
    enemyHp: permit.enemy_hp,
    turnCount: permit.turn_count,
  };
  // A rejection may race with another accepted action after the initial SELECT.
  // Re-read persisted state for every conflict so the client never synchronizes to
  // the pre-race snapshot. This remains presentation/recovery only; the CAS below
  // is still the authority that decides whether an action commits.
  const conflict = async (message: string): Promise<Response> => {
    const latest = await env.DB.prepare(`SELECT
        permit.event_key, cycle.event_key AS cycle_event_key,
        permit.cycle_id, permit.encounter_key, permit.player_hp, permit.player_mana,
        permit.enemy_hp, permit.battle_status, permit.turn_count
      FROM battle_permits AS permit
      LEFT JOIN world_event_cycles AS cycle ON cycle.id = permit.cycle_id
      WHERE permit.id = ? AND permit.player_id = ?
        AND julianday(cycle.opens_at) <= julianday(permit.started_at)
        AND julianday(permit.started_at) < julianday(cycle.closes_at)`)
      .bind(input.permitId, input.playerId)
      .first<BattleActionPermitRow>();
    if (latest && (latest.event_key !== 'underpass' || latest.cycle_event_key !== 'underpass' || latest.encounter_key !== TUNNEL_MAW.id)) {
      return fail(request, env, 'Unsupported battle permit.', 409);
    }
    if (!latest || !isValidBattlePermitState(latest)) {
      return fail(request, env, 'Battle state changed; authoritative snapshot unavailable.', 409);
    }
    return json(request, env, {
      error: message,
      battleState: {
        permitId: input.permitId,
        status: latest.battle_status,
        playerHp: latest.player_hp,
        playerMana: playerManaForSnapshot(latest),
        enemyHp: latest.enemy_hp,
        turnCount: latest.turn_count,
      },
    }, 409);
  };
  if (input.expectedTurnCount !== permit.turn_count) {
    return conflict('Stale battle turn.');
  }
  if (permit.battle_status !== 'active') return conflict(`Battle is already ${permit.battle_status}.`);
  // The earlier null guard permits NULL only for terminal legacy rows, which
  // have already returned above. Keep the active-action path explicitly narrowed.
  if (permit.player_mana === null) return fail(request, env, 'Battle state is unavailable.', 409);
  if (!canUseAbility(permit.player_mana, ability)) {
    return conflict('Not enough Mana for that ability.');
  }

  const turn = resolveCombatTurn({
    playerHp: permit.player_hp,
    playerMana: permit.player_mana,
    enemyHp: permit.enemy_hp,
    ability,
    degen: TEST_DEGEN,
    enemy: TUNNEL_MAW,
  });
  const { playerHp, playerMana, enemyHp, status } = turn;

  // Do not persist an active state at the terminal safe-integer boundary: the
  // next increment would leave the active-state invariant. A victory or defeat
  // may still resolve on this final safe turn.
  if (status === 'active' && permit.turn_count >= Number.MAX_SAFE_INTEGER - 1) {
    return fail(request, env, 'Battle turn limit reached.', 409);
  }

  const actionUpdate = env.DB.prepare(`UPDATE battle_permits
    SET player_hp = ?, player_mana = ?, enemy_hp = ?, battle_status = ?, turn_count = turn_count + 1
    WHERE id = ? AND player_id = ? AND completed_at IS NULL AND battle_status = 'active'
      AND julianday(expires_at) > julianday('now')
      AND event_key = 'underpass' AND encounter_key = ?
      AND EXISTS (SELECT 1 FROM world_event_cycles
        WHERE id = battle_permits.cycle_id AND event_key = 'underpass'
          AND julianday(opens_at) <= julianday(battle_permits.started_at)
          AND julianday(battle_permits.started_at) < julianday(closes_at))
      AND turn_count = ?
    RETURNING turn_count`)
    .bind(playerHp, playerMana, enemyHp, status, input.permitId, input.playerId,
      TUNNEL_MAW.id, permit.turn_count);

  let updated: { turn_count: number } | null | undefined;
  if (status === 'defeat') {
    const character = await env.DB.prepare(`SELECT level FROM characters WHERE player_id = ?`)
      .bind(input.playerId).first<{ level: number }>();
    if (!character) return fail(request, env, 'Player character not found.', 404);

    // The terminal turn and its deterministic history marker must commit or roll back together.
    const results = await env.DB.batch([
      actionUpdate,
      env.DB.prepare(`INSERT INTO battle_history (
        id, player_id, encounter_key, result, player_level, xp_awarded, currency_awarded
      ) SELECT ?, ?, ?, 'defeat', ?, 0, 0
        WHERE EXISTS (SELECT 1 FROM battle_permits WHERE id = ? AND player_id = ?
          AND battle_status = 'defeat' AND turn_count = ? AND completed_at IS NULL)
        ON CONFLICT(id) DO NOTHING`)
        .bind(`${input.permitId}:defeat`, input.playerId, TUNNEL_MAW.id, character.level,
          input.permitId, input.playerId, permit.turn_count + 1),
    ]);
    updated = results[0]?.results?.[0] as { turn_count: number } | undefined;
  } else {
    updated = await actionUpdate.first<{ turn_count: number }>();
  }

  if (!updated) {
    // A competing action may have committed after the SELECT. Return only persisted state.
    const latest = await env.DB.prepare(`SELECT
        permit.event_key, cycle.event_key AS cycle_event_key,
        permit.cycle_id, permit.encounter_key, permit.player_hp, permit.player_mana,
        permit.enemy_hp, permit.battle_status, permit.turn_count
      FROM battle_permits AS permit
      LEFT JOIN world_event_cycles AS cycle ON cycle.id = permit.cycle_id
      WHERE permit.id = ? AND permit.player_id = ?
        AND julianday(cycle.opens_at) <= julianday(permit.started_at)
        AND julianday(permit.started_at) < julianday(cycle.closes_at)`)
      .bind(input.permitId, input.playerId)
      .first<BattleActionPermitRow>();
    if (latest && (latest.event_key !== 'underpass' || latest.cycle_event_key !== 'underpass' || latest.encounter_key !== TUNNEL_MAW.id)) {
      return fail(request, env, 'Unsupported battle permit.', 409);
    }
    if (latest && isValidBattlePermitState(latest)) {
      return json(request, env, {
        error: 'Battle state changed; synchronized from the latest authoritative state.',
        battleState: {
          permitId: input.permitId,
          status: latest.battle_status,
          playerHp: latest.player_hp,
          playerMana: playerManaForSnapshot(latest),
          enemyHp: latest.enemy_hp,
          turnCount: latest.turn_count,
        },
      }, 409);
    }
    return fail(request, env, 'Battle state changed; retry from the latest authoritative state.', 409);
  }


  return json(request, env, {
    permitId: input.permitId,
    status,
    playerHp,
    playerMana,
    enemyHp,
    turnCount: updated.turn_count,
  });
}

async function handleCompleteBattle(request: Request, env: Env): Promise<Response> {
  const input = await body<{ playerId?: string; permitId?: string }>(request);
  if (!input.playerId || !input.permitId) return fail(request, env, 'playerId and permitId are required');

  type ReceiptRow = {
    cycle_id: string; encounter_key: string; reward_state: 'pending' | 'claiming' | 'awarded';
    reward_clear_number: number | null; reward_xp: number | null; reward_currency: number | null;
    reward_tier: 'full' | 'reduced' | null;
  };
  type ValidatedReceiptRow = BattlePermitStateRow & ReceiptRow & {
    permit_id: string;
    event_key: string;
    cycle_event_key: string | null;
    permit_started_in_cycle: number;
    cycle_clear_count: number | null;
    duplicate_clear_count: number;
    reward_level: number | null;
    reward_remaining_xp: number | null;
    completed_at: string | null;
    reward_claim_token: string | null;
    reward_claimed_at: string | null;
    history_id: string | null;
    history_result: string | null;
    history_encounter_key: string | null;
    history_player_level: number | null;
    history_xp_awarded: number | null;
    history_currency_awarded: number | null;
  };
  const loadReceipt = async () => env.DB.prepare(`SELECT permit.id AS permit_id, permit.event_key, permit.cycle_id, permit.encounter_key,
      permit.player_hp, permit.player_mana, permit.enemy_hp, permit.battle_status, permit.turn_count,
      permit.reward_state, permit.reward_clear_number, permit.reward_xp, permit.reward_currency, permit.reward_tier,
      permit.reward_level, permit.reward_remaining_xp, permit.completed_at,
      permit.reward_claim_token, permit.reward_claimed_at,
      cycle.event_key AS cycle_event_key,
      CASE WHEN julianday(cycle.opens_at) <= julianday(permit.started_at)
        AND julianday(permit.started_at) < julianday(cycle.closes_at)
        THEN 1 ELSE 0 END AS permit_started_in_cycle,
      clears.full_reward_clears AS cycle_clear_count,
      (SELECT COUNT(*) FROM battle_permits AS other
        WHERE other.player_id = permit.player_id
          AND other.event_key = permit.event_key
          AND other.cycle_id = permit.cycle_id
          AND other.event_key = 'underpass'
          AND other.encounter_key = '${TUNNEL_MAW.id}'
          AND EXISTS (SELECT 1 FROM world_event_cycles AS other_cycle
            WHERE other_cycle.id = other.cycle_id AND other_cycle.event_key = 'underpass')
          AND other.id <> permit.id
          AND other.reward_clear_number = permit.reward_clear_number
      ) AS duplicate_clear_count,
      history.id AS history_id, history.result AS history_result,
      history.encounter_key AS history_encounter_key,
      history.player_level AS history_player_level,
      history.xp_awarded AS history_xp_awarded,
      history.currency_awarded AS history_currency_awarded
    FROM battle_permits AS permit
    LEFT JOIN world_event_cycles AS cycle ON cycle.id = permit.cycle_id
    LEFT JOIN world_event_clears AS clears
      ON clears.player_id = permit.player_id
      AND clears.event_key = permit.event_key
      AND clears.cycle_id = permit.cycle_id
    LEFT JOIN battle_history AS history
      ON history.id = (permit.id || ':victory') AND history.player_id = permit.player_id
    WHERE permit.id = ? AND permit.player_id = ?`)
    .bind(input.permitId, input.playerId).first<ValidatedReceiptRow>();
  const receipt = await loadReceipt();
  if (!receipt) return fail(request, env, 'Battle is not an authoritative victory.', 409);
  // An awarded receipt is replayable even if its old combat snapshot later becomes
  // corrupt, but its independent reward audit must still be internally consistent.
  const isValidAwardedReceipt = (row: ValidatedReceiptRow): boolean => {
    const clearNumber = row.reward_clear_number;
    const rewardXp = row.reward_xp;
    const rewardCurrency = row.reward_currency;
    const rewardLevel = row.reward_level;
    const remainingXp = row.reward_remaining_xp;
    // A receipt's sequence number must have actually been reached by this player's
    // persisted clear counter for the same event cycle; canonical reward values alone
    // cannot legitimize a forged, far-future clear number.
    if (!isSafeIntegerBetween(clearNumber, 1, Number.MAX_SAFE_INTEGER)) return false;
    if (!isSafeIntegerBetween(row.cycle_clear_count, clearNumber, Number.MAX_SAFE_INTEGER)) return false;
    // A clear number is a per-player, per-event-cycle sequence slot; two permits may never share it.
    if (!isSafeIntegerBetween(row.duplicate_clear_count, 0, 0)) return false;
    if (row.reward_state !== 'awarded'
      || !isSafeIntegerBetween(rewardXp, 0, Number.MAX_SAFE_INTEGER)
      || !isSafeIntegerBetween(rewardCurrency, 0, Number.MAX_SAFE_INTEGER)
      || !isSafeIntegerBetween(rewardLevel, 1, Number.MAX_SAFE_INTEGER)
      || !isSafeIntegerBetween(xpNeededForLevel(rewardLevel), 1, Number.MAX_SAFE_INTEGER)
      || !isSafeIntegerBetween(remainingXp, 0, Number.MAX_SAFE_INTEGER)
      || remainingXp >= xpNeededForLevel(rewardLevel)
      || (row.reward_tier !== 'full' && row.reward_tier !== 'reduced')
      || typeof row.completed_at !== 'string' || row.completed_at.trim().length === 0
      || typeof row.reward_claim_token !== 'string' || row.reward_claim_token.trim().length === 0
      || typeof row.reward_claimed_at !== 'string' || row.reward_claimed_at.trim().length === 0
      || row.history_id !== `${row.permit_id}:victory`
      || row.history_result !== 'victory'
      || row.history_encounter_key !== row.encounter_key
      || row.history_player_level !== rewardLevel
      || row.history_xp_awarded !== rewardXp
      || row.history_currency_awarded !== rewardCurrency) return false;

    const canonicalReward = underpassRewardForClear(clearNumber);
    return rewardXp === canonicalReward.xp
      && rewardCurrency === canonicalReward.currency
      && row.reward_tier === canonicalReward.tier;
  };
  // The permit and its referenced cycle must both belong to the supported event.
  // D1 stores event_key and cycle_id separately, so reject inconsistent rows rather than
  // allowing a Tunnel Maw victory attached to another event's cycle to inherit rewards.
  if (receipt.event_key !== 'underpass' || receipt.cycle_event_key !== 'underpass'
    || receipt.encounter_key !== TUNNEL_MAW.id) {
    return fail(request, env, 'Unsupported battle permit.', 409);
  }

  // Validate current inventory before replaying an awarded receipt or attempting
  // settlement. Legacy rows are rejected, never silently truncated or rewritten.
  await inventorySnapshotItemCount(env.DB, input.playerId);

  const respond = async (row: ReceiptRow) => {
    const player = await loadPlayer(env.DB, input.playerId!);
    const cycle = await env.DB.prepare(`SELECT id, event_key, opens_at, closes_at FROM world_event_cycles WHERE id = ?`)
      .bind(row.cycle_id).first<CycleRow>();
    const event = cycle ? await worldSnapshot(env.DB, input.playerId!, cycle) : await worldSnapshot(env.DB, input.playerId!);
    const full = row.reward_tier === 'full';
    return json(request, env, { player, reward: {
      xp: row.reward_xp ?? 0, currency: row.reward_currency ?? 0,
      items: full ? ['underpass-scrap'] : [], furniture: full ? ['tunnel-trophy'] : [],
      tier: row.reward_tier ?? 'reduced',
    }, worldEvent: event });
  };
  if (receipt.reward_state === 'awarded') {
    if (!isValidAwardedReceipt(receipt)) return fail(request, env, 'Battle reward receipt is invalid.', 409);
    // The independently audited awarded receipt is the recovery authority for an
    // already-settled reward, even if a later write corrupts its combat snapshot.
    return respond(receipt);
  }
  if (receipt.permit_started_in_cycle !== 1) {
    return fail(request, env, 'Battle permit was not issued during its event cycle.', 409);
  }
  if (receipt.battle_status !== 'victory') {
    return fail(request, env, 'Battle is not an authoritative victory.', 409);
  }
  if (!isValidBattlePermitState(receipt)) return fail(request, env, 'Battle state is invalid.', 409);

  const token = crypto.randomUUID();
  // The token-scoped cleanup also covers an ambiguous failure while acquiring
  // the lease: if the UPDATE committed but its response failed, release only
  // this token. If it did not commit, the cleanup is a harmless no-op.
  const releaseClaim = async (resetUnawardedClear = false) => {
    const resetClear = resetUnawardedClear ? ', reward_clear_number = NULL' : '';
    try {
      await env.DB.prepare(`UPDATE battle_permits SET reward_state = 'pending',
          reward_claim_token = NULL, reward_claimed_at = NULL${resetClear}
        WHERE id = ? AND player_id = ? AND reward_state = 'claiming' AND reward_claim_token = ?`)
        .bind(input.permitId, input.playerId, token).run();
    } catch {
      // Do not hide the original failure. A later retry can reclaim a stale lease.
    }
  };
  try {
    // Permit expiry blocks new actions, not settlement of a valid Worker-resolved
    // victory. The read above requires a consistent terminal victory; active or
    // corrupt permits cannot reach this claim path.
    const claim = await env.DB.prepare(`UPDATE battle_permits
    SET reward_state = 'claiming', reward_claim_token = ?, reward_claimed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND player_id = ? AND event_key = 'underpass'
      AND encounter_key = ?
      AND EXISTS (SELECT 1 FROM world_event_cycles
        WHERE id = battle_permits.cycle_id AND event_key = 'underpass'
          AND julianday(opens_at) <= julianday(battle_permits.started_at)
          AND julianday(battle_permits.started_at) < julianday(closes_at))
      AND battle_status = 'victory' AND (
      (reward_state = 'pending' AND completed_at IS NULL)
      OR (reward_state = 'claiming' AND reward_claimed_at < datetime('now', '-60 seconds'))
    ) RETURNING cycle_id, encounter_key, reward_clear_number`)
    .bind(token, input.permitId, input.playerId, TUNNEL_MAW.id)
    .first<{ cycle_id: string; encounter_key: string; reward_clear_number: number | null }>();
    if (!claim) return fail(request, env, 'Battle reward is already being claimed, or the permit expired.', 409);

  const hadReservedClearNumber = claim.reward_clear_number !== null;
  if (claim.reward_clear_number === null) {
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO world_event_clears
        (player_id, event_key, cycle_id, full_reward_clears) VALUES (?, 'underpass', ?, 0)`)
        .bind(input.playerId, claim.cycle_id),
      // Never allocate a sequence slot if the persisted counter already trails
      // a previously reserved receipt for this player and cycle.
      env.DB.prepare(`UPDATE battle_permits SET reward_clear_number = (
          SELECT full_reward_clears + 1 FROM world_event_clears
          WHERE player_id = ? AND event_key = 'underpass' AND cycle_id = ?
        ) WHERE id = ? AND player_id = ? AND reward_state = 'claiming'
          AND reward_claim_token = ? AND reward_clear_number IS NULL
          AND typeof((SELECT full_reward_clears FROM world_event_clears
            WHERE player_id = ? AND event_key = 'underpass' AND cycle_id = ?)) = 'integer'
          AND (SELECT full_reward_clears FROM world_event_clears
            WHERE player_id = ? AND event_key = 'underpass' AND cycle_id = ?)
            BETWEEN 0 AND ${Number.MAX_SAFE_INTEGER - 1}
          AND (SELECT full_reward_clears FROM world_event_clears
            WHERE player_id = ? AND event_key = 'underpass' AND cycle_id = ?) >= COALESCE((
              SELECT MAX(other.reward_clear_number) FROM battle_permits AS other
              WHERE other.player_id = ? AND other.event_key = 'underpass'
                AND other.cycle_id = ? AND other.encounter_key = ?
                AND other.id <> ? AND other.reward_clear_number IS NOT NULL
                AND EXISTS (SELECT 1 FROM world_event_cycles AS other_cycle
                  WHERE other_cycle.id = other.cycle_id AND other_cycle.event_key = 'underpass')
            ), 0)`)
        .bind(input.playerId, claim.cycle_id, input.permitId, input.playerId, token,
          input.playerId, claim.cycle_id,
          input.playerId, claim.cycle_id,
          input.playerId, claim.cycle_id,
          input.playerId, claim.cycle_id, TUNNEL_MAW.id, input.permitId),
      env.DB.prepare(`UPDATE world_event_clears SET full_reward_clears = (
          SELECT reward_clear_number FROM battle_permits WHERE id = ? AND player_id = ?
        ) WHERE player_id = ? AND event_key = 'underpass' AND cycle_id = ?
          AND full_reward_clears < (SELECT reward_clear_number FROM battle_permits WHERE id = ? AND player_id = ?)`)
        .bind(input.permitId, input.playerId, input.playerId, claim.cycle_id, input.permitId, input.playerId),
    ]);
  }

  const owned = await env.DB.prepare(`SELECT permit.cycle_id, permit.encounter_key, permit.reward_clear_number,
      clears.full_reward_clears AS cycle_clear_count,
      (SELECT COUNT(*) FROM battle_permits AS other
        WHERE other.player_id = permit.player_id
          AND other.event_key = permit.event_key
          AND other.cycle_id = permit.cycle_id
          AND other.event_key = 'underpass'
          AND other.encounter_key = ?
          AND EXISTS (SELECT 1 FROM world_event_cycles AS other_cycle
            WHERE other_cycle.id = other.cycle_id AND other_cycle.event_key = 'underpass')
          AND other.id <> permit.id
          AND other.reward_clear_number = permit.reward_clear_number
      ) AS duplicate_clear_count
    FROM battle_permits AS permit
    LEFT JOIN world_event_clears AS clears
      ON clears.player_id = permit.player_id
      AND clears.event_key = permit.event_key
      AND clears.cycle_id = permit.cycle_id
    WHERE permit.id = ? AND permit.player_id = ? AND permit.reward_state = 'claiming'
      AND permit.reward_claim_token = ?`)
    .bind(TUNNEL_MAW.id, input.permitId, input.playerId, token)
    .first<{ cycle_id: string; encounter_key: string; reward_clear_number: number | null;
      cycle_clear_count: number | null; duplicate_clear_count: number }>();
  if (!owned?.reward_clear_number
    || !isSafeIntegerBetween(owned.reward_clear_number, 1, Number.MAX_SAFE_INTEGER)
    || !isSafeIntegerBetween(owned.cycle_clear_count, owned.reward_clear_number, Number.MAX_SAFE_INTEGER)
    || !isSafeIntegerBetween(owned.duplicate_clear_count, 0, 0)) {
    await releaseClaim(!hadReservedClearNumber && typeof owned?.reward_clear_number === 'number');
    return fail(request, env, 'Unable to assign authoritative reward clear.', 409);
  }

  const reward = underpassRewardForClear(owned.reward_clear_number);
  const inventoryCount = await inventorySnapshotItemCount(env.DB, input.playerId);
  if (reward.tier === 'full' && inventoryCount >= MAX_INVENTORY_SNAPSHOT_ITEMS) {
    await releaseClaim();
    return fail(request, env, 'Player inventory is at its supported snapshot limit.', 409);
  }
  const owns = `EXISTS (SELECT 1 FROM battle_permits WHERE id = ? AND player_id = ?
    AND reward_state = 'claiming' AND reward_claim_token = ?)`;
  const applied = `EXISTS (SELECT 1 FROM characters WHERE player_id = ?
    AND last_reward_claim_token = ?)`;
  // Capacity is checked on the first character CAS. Once that CAS applies, the
  // remaining reward writes run atomically in the same D1 batch under the token guard.
  const inventoryCapacity = reward.tier === 'full'
    ? ` AND (SELECT COALESCE(SUM(quantity), 0) FROM player_inventory
        WHERE player_id = ? AND item_type <> 'furniture') < ${MAX_INVENTORY_SNAPSHOT_ITEMS}`
    : '';
  const settlementGuard = `${owns}${inventoryCapacity}`;
  const guard = `${owns} AND ${applied}`;
  const inventoryCapacityBinds = reward.tier === 'full' ? [input.playerId] : [];

  // Other permits may award the same character after our snapshot. Retry
  // a failed compare-and-swap with fresh progression rather than losing XP.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const character = await env.DB.prepare(`SELECT level, xp, currency, degen_key FROM characters WHERE player_id = ?`)
      .bind(input.playerId).first<CharacterRow>();
    if (!character) {
      await releaseClaim();
      return fail(request, env, 'Player character not found.', 404);
    }
    // Reject corrupt progression before the shared math can persist an impossible level/XP
    // pair or create an awarded receipt that cannot pass its own replay audit. Keep the
    // already-reserved clear slot on the permit so a repaired character can retry it.
    if (!isValidProgressionState(character.level, character.xp)
      || !isSafeIntegerBetween(character.currency, 0, Number.MAX_SAFE_INTEGER)
      || !isSafeIntegerBetween(character.currency + reward.currency, 0, Number.MAX_SAFE_INTEGER)) {
      await releaseClaim();
      return fail(request, env, 'Player progression state is invalid.', 409);
    }
    const progression = advanceLevel(character.level, character.xp, reward.xp);
    if (!isValidProgressionState(progression.level, progression.xp)) {
      await releaseClaim();
      return fail(request, env, 'Player progression state is invalid.', 409);
    }
    const writes: D1PreparedStatement[] = [
      env.DB.prepare(`UPDATE characters SET level = ?, xp = ?, currency = currency + ?,
          last_reward_claim_token = ?, updated_at = CURRENT_TIMESTAMP
        WHERE player_id = ? AND level = ? AND xp = ? AND ${settlementGuard}`)
        .bind(progression.level, progression.xp, reward.currency, token, input.playerId,
          character.level, character.xp, input.permitId, input.playerId, token, ...inventoryCapacityBinds),
      // A pre-existing victory marker must fail the whole D1 transaction.
      env.DB.prepare(`INSERT INTO battle_history
        (id, player_id, encounter_key, result, player_level, xp_awarded, currency_awarded)
        SELECT ?, ?, ?, 'victory', ?, ?, ? WHERE ${guard}`)
        .bind(`${input.permitId}:victory`, input.playerId, owned.encounter_key,
          progression.level, reward.xp, reward.currency, input.permitId, input.playerId,
          token, input.playerId, token),
      env.DB.prepare(`INSERT OR IGNORE INTO defeated_bosses (player_id, boss_key)
        SELECT ?, ? WHERE ${guard}`)
        .bind(input.playerId, owned.encounter_key, input.permitId, input.playerId,
          token, input.playerId, token),
    ];
    if (reward.tier === 'full') {
      writes.push(
        env.DB.prepare(`INSERT INTO player_inventory (id, player_id, item_key, item_type, quantity)
          SELECT ?, ?, 'underpass-scrap', 'item', 1 WHERE ${guard}
          ON CONFLICT(id) DO UPDATE SET quantity = quantity + 1`)
          .bind(`${input.playerId}:item:underpass-scrap`, input.playerId, input.permitId,
            input.playerId, token, input.playerId, token),
        env.DB.prepare(`INSERT OR IGNORE INTO player_inventory (id, player_id, item_key, item_type, quantity)
          SELECT ?, ?, 'tunnel-trophy', 'furniture', 1 WHERE ${guard}`)
          .bind(`${input.playerId}:furniture:tunnel-trophy`, input.playerId, input.permitId,
            input.playerId, token, input.playerId, token),
      );
    }
    writes.push(env.DB.prepare(`UPDATE battle_permits SET reward_state = 'awarded',
        completed_at = CURRENT_TIMESTAMP, reward_xp = ?, reward_currency = ?,
        reward_tier = ?, reward_level = ?, reward_remaining_xp = ?
      WHERE id = ? AND player_id = ? AND reward_state = 'claiming'
        AND reward_claim_token = ? AND ${applied}`)
      .bind(reward.xp, reward.currency, reward.tier, progression.level, progression.xp,
        input.permitId, input.playerId, token, input.playerId, token));

    // All award statements are one atomic D1 batch. A stale character
    // snapshot changes zero rows and the token gate blocks every later write.
    await env.DB.batch(writes);
    // Validate the complete persisted receipt before returning a reward on this
    // request too; the idempotent retry path is not the only response path.
    const settledReceipt = await loadReceipt();
    if (settledReceipt?.reward_state === 'awarded') {
      if (!isValidAwardedReceipt(settledReceipt)) {
        return fail(request, env, 'Battle reward receipt is invalid.', 409);
      }
      return respond(settledReceipt);
    }
    if (settledReceipt?.reward_state !== 'claiming' || settledReceipt.reward_claim_token !== token) {
      await releaseClaim();
      return fail(request, env, 'Reward claim changed; retry.', 409);
    }
    if (reward.tier === 'full'
      && await inventorySnapshotItemCount(env.DB, input.playerId) >= MAX_INVENTORY_SNAPSHOT_ITEMS) {
      await releaseClaim();
      return fail(request, env, 'Player inventory is at its supported snapshot limit.', 409);
    }
  }

  // Release only this token after bounded contention; retain its reserved
  // clear number for a later retry, even if the permit has since expired.
  await releaseClaim();
  return fail(request, env, 'Concurrent reward updates; retry completion.', 409);
  } catch (error) {
    await releaseClaim();
    throw error;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    const url = new URL(request.url);

    try {
      if (request.method === 'GET' && url.pathname === '/api/health') return json(request, env, { ok: true, service: 'degen-api' });
      if (request.method === 'POST' && url.pathname === '/api/player/bootstrap') return await handleBootstrap(request, env);
      if (request.method === 'PUT' && url.pathname === '/api/player/housing') return await handleHousing(request, env);
      if (request.method === 'GET' && url.pathname === '/api/world/underpass') {
        const playerId = url.searchParams.get('playerId');
        if (!playerId) return fail(request, env, 'playerId is required');
        const snapshot = await worldSnapshot(env.DB, playerId);
        return json(request, env, snapshot);
      }
      if (request.method === 'POST' && url.pathname === '/api/battle/start') return await handleStartBattle(request, env);
      if (request.method === 'POST' && url.pathname === '/api/battle/action') return await handleBattleAction(request, env);
      if (request.method === 'POST' && url.pathname === '/api/battle/complete') return await handleCompleteBattle(request, env);
      return fail(request, env, 'Not found', 404);
    } catch (error) {
      if (error instanceof InventoryIntegrityError) return fail(request, env, error.message, 409);
      console.error(error);
      return fail(request, env, error instanceof Error ? error.message : 'Internal server error', 500);
    }
  },
} satisfies ExportedHandler<Env>;
