/// <reference types="@cloudflare/workers-types" />

import { TEST_DEGEN, TUNNEL_MAW } from '../src/data/combatPrototype';
import { canUseAbility, resolveCombatTurn } from '../src/game/combat/rules';
import { UNDERPASS_FULL_REWARD_LIMIT, advanceLevel, underpassRewardForClear } from '../src/game/progression';

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

async function ensurePlayer(db: D1Database, playerId: string, displayName: string): Promise<void> {
  await db.batch([
    db.prepare(`INSERT INTO players (id, display_name) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, updated_at = CURRENT_TIMESTAMP`).bind(playerId, displayName.slice(0, 32)),
    // Seed the starter bed only on initial character creation. An empty room
    // on subsequent bootstraps is a valid saved layout, not missing data.
    db.prepare(`INSERT OR IGNORE INTO housing_placements (id, player_id, furniture_key, grid_x, grid_y, rotation)
      SELECT ?, ?, 'starter-bed', 1, 1, 0
      WHERE NOT EXISTS (SELECT 1 FROM characters WHERE player_id = ?)`).bind(`${playerId}:starter-bed-placed`, playerId, playerId),
    db.prepare(`INSERT OR IGNORE INTO characters (player_id, level, xp, currency, degen_key) VALUES (?, 1, 0, 0, 'test-degen')`).bind(playerId),
    ...STARTER_LOCATIONS.map((location) => db.prepare(`INSERT OR IGNORE INTO unlocked_locations (player_id, location_key) VALUES (?, ?)`).bind(playerId, location)),
    ...STARTER_FURNITURE.map((item) => db.prepare(`INSERT OR IGNORE INTO player_inventory (id, player_id, item_key, item_type, quantity) VALUES (?, ?, ?, 'furniture', 1)`).bind(`${playerId}:furniture:${item}`, playerId, item)),
  ]);

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
  const inventory = await env.DB.prepare(`SELECT item_key, quantity FROM player_inventory
    WHERE player_id = ? AND item_type = 'furniture'`).bind(input.playerId)
    .all<{ item_key: string; quantity: number }>();
  const remaining = new Map<string, number>();
  for (const row of inventory.results) {
    remaining.set(row.item_key, (remaining.get(row.item_key) ?? 0) + Math.max(0, row.quantity));
  }
  const occupied = new Set<string>();
  const instanceIds = new Set<string>();
  const placements: NonNullable<NonNullable<typeof input.housing>['placements']> = [];
  for (const item of input.housing.placements ?? []) {
    if (typeof item.instanceId !== 'string' || !item.instanceId
      || !Number.isInteger(item.x) || !Number.isInteger(item.y)
      || item.x < 0 || item.x > 7 || item.y < 0 || item.y > 5) continue;
    const cell = `${item.x}:${item.y}`;
    const available = remaining.get(item.furnitureId) ?? 0;
    if (available <= 0 || occupied.has(cell) || instanceIds.has(item.instanceId)) continue;
    remaining.set(item.furnitureId, available - 1);
    occupied.add(cell);
    instanceIds.add(item.instanceId);
    placements.push(item);
  }
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM housing_placements WHERE player_id = ?`).bind(input.playerId),
    ...placements.map((item) => env.DB.prepare(`INSERT INTO housing_placements (id, player_id, furniture_key, grid_x, grid_y, rotation) VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(item.instanceId, input.playerId, item.furnitureId, item.x, item.y, item.rotation ?? 0)),
  ]);
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

async function handleStartBattle(request: Request, env: Env): Promise<Response> {
  const input = await body<{ playerId?: string; eventKey?: string; cycleId?: string; encounterKey?: string }>(request);
  if (!input.playerId || input.eventKey !== 'underpass' || !input.cycleId || input.encounterKey !== TUNNEL_MAW.id) {
    return fail(request, env, 'Invalid battle start request');
  }

  const cycle = await ensureUnderpassCycle(env.DB);
  if (cycle.id !== input.cycleId || phaseFor(cycle) !== 'open') return fail(request, env, 'The Underpass is sealed.', 409);

  const permitId = crypto.randomUUID();
  const expiresAt = iso(Date.now() + 20 * 60_000);
  await env.DB.prepare(`INSERT INTO battle_permits (
      id, player_id, event_key, cycle_id, encounter_key, expires_at,
      player_hp, player_mana, enemy_hp, battle_status, turn_count
    ) VALUES (?, ?, 'underpass', ?, ?, ?, ?, ?, ?, 'active', 0)`)
    .bind(permitId, input.playerId, cycle.id, TUNNEL_MAW.id, expiresAt, TEST_DEGEN.maxHp, TEST_DEGEN.maxMana, TUNNEL_MAW.maxHp).run();

  return json(request, env, {
    permitId,
    eventKey: 'underpass',
    cycleId: cycle.id,
    encounterKey: TUNNEL_MAW.id,
    expiresAt,
  });
}

async function handleBattleAction(request: Request, env: Env): Promise<Response> {
  const input = await body<{ playerId?: string; permitId?: string; abilityId?: string }>(request);
  if (!input.playerId || !input.permitId || !input.abilityId) {
    return fail(request, env, 'playerId, permitId, and abilityId are required');
  }

  const ability = TEST_DEGEN.abilities.find((candidate) => candidate.id === input.abilityId);
  if (!ability) return fail(request, env, 'Unknown ability.', 400);

  const permit = await env.DB.prepare(`SELECT
      cycle_id, encounter_key, player_hp, player_mana, enemy_hp, battle_status, turn_count
    FROM battle_permits
    WHERE id = ? AND player_id = ? AND completed_at IS NULL AND datetime(expires_at) > CURRENT_TIMESTAMP`)
    .bind(input.permitId, input.playerId)
    .first<BattlePermitStateRow>();

  if (!permit) return fail(request, env, 'Battle permit is invalid, expired, or already completed.', 409);
  if (permit.encounter_key !== TUNNEL_MAW.id) return fail(request, env, 'Unsupported encounter.', 409);
  if (permit.battle_status !== 'active') return fail(request, env, `Battle is already ${permit.battle_status}.`, 409);
  if (permit.player_hp === null || permit.player_mana === null || permit.enemy_hp === null) {
    return fail(request, env, 'Battle state is unavailable.', 409);
  }
  if (!canUseAbility(permit.player_mana, ability)) {
    return fail(request, env, 'Not enough Mana for that ability.', 409);
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

  const updated = await env.DB.prepare(`UPDATE battle_permits
    SET player_hp = ?, player_mana = ?, enemy_hp = ?, battle_status = ?, turn_count = turn_count + 1
    WHERE id = ? AND player_id = ? AND completed_at IS NULL AND battle_status = 'active'
      AND datetime(expires_at) > CURRENT_TIMESTAMP AND turn_count = ?
    RETURNING turn_count`)
    .bind(playerHp, playerMana, enemyHp, status, input.permitId, input.playerId, permit.turn_count)
    .first<{ turn_count: number }>();

  if (!updated) return fail(request, env, 'Battle state changed; retry from the latest authoritative state.', 409);

  if (status === 'defeat') {
    const character = await env.DB.prepare(`SELECT level FROM characters WHERE player_id = ?`)
      .bind(input.playerId).first<{ level: number }>();
    if (character) {
      await env.DB.prepare(`INSERT INTO battle_history (
        id, player_id, encounter_key, result, player_level, xp_awarded, currency_awarded
      ) VALUES (?, ?, ?, 'defeat', ?, 0, 0)`)
        .bind(crypto.randomUUID(), input.playerId, TUNNEL_MAW.id, character.level).run();
    }
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
  const receipt = await env.DB.prepare(`SELECT cycle_id, encounter_key, reward_state, reward_clear_number,
      reward_xp, reward_currency, reward_tier
    FROM battle_permits WHERE id = ? AND player_id = ? AND battle_status = 'victory'`)
    .bind(input.permitId, input.playerId).first<ReceiptRow>();
  if (!receipt) return fail(request, env, 'Battle is not an authoritative victory.', 409);

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
  if (receipt.reward_state === 'awarded') return respond(receipt);

  const token = crypto.randomUUID();
  const claim = await env.DB.prepare(`UPDATE battle_permits
    SET reward_state = 'claiming', reward_claim_token = ?, reward_claimed_at = CURRENT_TIMESTAMP
    WHERE id = ? AND player_id = ? AND battle_status = 'victory' AND (
      (reward_state = 'pending' AND completed_at IS NULL AND (datetime(expires_at) > CURRENT_TIMESTAMP OR reward_clear_number IS NOT NULL))
      OR (reward_state = 'claiming' AND reward_claimed_at < datetime('now', '-60 seconds'))
    ) RETURNING cycle_id, encounter_key, reward_clear_number`)
    .bind(token, input.permitId, input.playerId)
    .first<{ cycle_id: string; encounter_key: string; reward_clear_number: number | null }>();
  if (!claim) return fail(request, env, 'Battle reward is already being claimed, or the permit expired.', 409);

  if (claim.reward_clear_number === null) {
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO world_event_clears
        (player_id, event_key, cycle_id, full_reward_clears) VALUES (?, 'underpass', ?, 0)`)
        .bind(input.playerId, claim.cycle_id),
      env.DB.prepare(`UPDATE battle_permits SET reward_clear_number = (
          SELECT full_reward_clears + 1 FROM world_event_clears
          WHERE player_id = ? AND event_key = 'underpass' AND cycle_id = ?
        ) WHERE id = ? AND player_id = ? AND reward_state = 'claiming'
          AND reward_claim_token = ? AND reward_clear_number IS NULL`)
        .bind(input.playerId, claim.cycle_id, input.permitId, input.playerId, token),
      env.DB.prepare(`UPDATE world_event_clears SET full_reward_clears = (
          SELECT reward_clear_number FROM battle_permits WHERE id = ? AND player_id = ?
        ) WHERE player_id = ? AND event_key = 'underpass' AND cycle_id = ?
          AND full_reward_clears < (SELECT reward_clear_number FROM battle_permits WHERE id = ? AND player_id = ?)`)
        .bind(input.permitId, input.playerId, input.playerId, claim.cycle_id, input.permitId, input.playerId),
    ]);
  }

  const owned = await env.DB.prepare(`SELECT cycle_id, encounter_key, reward_clear_number FROM battle_permits
    WHERE id = ? AND player_id = ? AND reward_state = 'claiming' AND reward_claim_token = ?`)
    .bind(input.permitId, input.playerId, token)
    .first<{ cycle_id: string; encounter_key: string; reward_clear_number: number | null }>();
  if (!owned?.reward_clear_number) return fail(request, env, 'Unable to assign authoritative reward clear.', 409);

const reward = underpassRewardForClear(owned.reward_clear_number);
  const owns = `EXISTS (SELECT 1 FROM battle_permits WHERE id = ? AND player_id = ?
    AND reward_state = 'claiming' AND reward_claim_token = ?)`;
  const applied = `EXISTS (SELECT 1 FROM characters WHERE player_id = ?
    AND last_reward_claim_token = ?)`;
  const guard = `${owns} AND ${applied}`;

  // Other permits may award the same character after our snapshot. Retry
  // a failed compare-and-swap with fresh progression rather than losing XP.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const character = await env.DB.prepare(`SELECT level, xp, currency, degen_key FROM characters WHERE player_id = ?`)
      .bind(input.playerId).first<CharacterRow>();
    if (!character) return fail(request, env, 'Player character not found.', 404);
    const progression = advanceLevel(character.level, character.xp, reward.xp);
    const writes: D1PreparedStatement[] = [
      env.DB.prepare(`UPDATE characters SET level = ?, xp = ?, currency = currency + ?,
          last_reward_claim_token = ?, updated_at = CURRENT_TIMESTAMP
        WHERE player_id = ? AND level = ? AND xp = ? AND ${owns}`)
        .bind(progression.level, progression.xp, reward.currency, token, input.playerId,
          character.level, character.xp, input.permitId, input.playerId, token),
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
    const awarded = await env.DB.prepare(`SELECT cycle_id, encounter_key, reward_state,
        reward_clear_number, reward_xp, reward_currency, reward_tier, reward_claim_token
      FROM battle_permits WHERE id = ? AND player_id = ?`)
      .bind(input.permitId, input.playerId)
      .first<ReceiptRow & { reward_claim_token: string | null }>();
    if (awarded?.reward_state === 'awarded') return respond(awarded);
    if (awarded?.reward_state !== 'claiming' || awarded.reward_claim_token !== token) {
      return fail(request, env, 'Reward claim changed; retry.', 409);
    }
  }

  // Release only this token after bounded contention; retain its reserved
  // clear number for a later retry, even if the permit has since expired.
  await env.DB.prepare(`UPDATE battle_permits SET reward_state = 'pending',
      reward_claim_token = NULL, reward_claimed_at = NULL
    WHERE id = ? AND player_id = ? AND reward_state = 'claiming' AND reward_claim_token = ?`)
    .bind(input.permitId, input.playerId, token).run();
  return fail(request, env, 'Concurrent reward updates; retry completion.', 409);
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
      if (request.method === 'POST' && url.pathname === '/api/battle/action') return handleBattleAction(request, env);
      if (request.method === 'POST' && url.pathname === '/api/battle/complete') return handleCompleteBattle(request, env);
      return fail(request, env, 'Not found', 404);
    } catch (error) {
      console.error(error);
      return fail(request, env, error instanceof Error ? error.message : 'Internal server error', 500);
    }
  },
} satisfies ExportedHandler<Env>;
