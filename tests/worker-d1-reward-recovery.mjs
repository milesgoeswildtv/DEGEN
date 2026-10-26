// Real local Worker + D1 fault injection for recoverable victory rewards.
// This harness never uses --remote and never touches production data.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const wrangler = resolve(root, 'node_modules/.bin/wrangler');
const scratch = mkdtempSync(join(tmpdir(), 'degen-reward-recovery-'));
const persist = join(scratch, 'state');
const origin = 'http://127.0.0.1:8795';
const env = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' };
let worker;
let logs = '';

function cli(args) {
  const result = spawnSync(wrangler, args, { cwd: root, env, encoding: 'utf8', timeout: 120_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`wrangler ${args.join(' ')}: ${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}
function sql(query) {
  const raw = cli(['d1', 'execute', 'DEGEN', '--local', `--persist-to=${persist}`, '--json', `--command=${query}`]);
  const parsed = JSON.parse(raw);
  const row = Array.isArray(parsed) ? parsed[0] : parsed;
  return row?.results ?? row?.result?.[0]?.results ?? [];
}
async function start() {
  logs = '';
  worker = spawn(wrangler, ['dev', '--local', `--persist-to=${persist}`, '--ip=127.0.0.1', '--port=8795'],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [worker.stdout, worker.stderr]) {
    stream.on('data', data => { logs = (logs + data.toString()).slice(-12_000); });
  }
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (worker.exitCode !== null) throw new Error('Worker exited: ' + logs);
    try {
      const response = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(600) });
      if (response.ok && (await response.json()).ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error('Worker did not start: ' + logs);
}
async function stop() {
  if (!worker || worker.exitCode !== null) return;
  const child = worker;
  child.kill('SIGTERM');
  await Promise.race([new Promise(done => child.once('exit', done)), sleep(2_000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
  worker = undefined;
}
async function complete(permitId = 'permit-recovery') {
  const response = await fetch(origin + '/api/battle/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ playerId: 'qa-player', permitId }),
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await response.text();
  let body;
  try { body = raw ? JSON.parse(raw) : undefined; } catch { body = { raw: raw.slice(0, 300) }; }
  return { status: response.status, body };
}

try {
  cli(['d1', 'execute', 'DEGEN', '--local', `--persist-to=${persist}`, '--file=db/schema.sql']);
  cli(['d1', 'migrations', 'apply', 'DEGEN', '--local', `--persist-to=${persist}`]);
  const seed = join(scratch, 'seed.sql');
  writeFileSync(seed, `
    PRAGMA foreign_keys = ON;
    INSERT INTO players(id, display_name) VALUES ('qa-player', 'Reward Recovery QA');
    INSERT INTO characters(player_id, level, xp, currency, degen_key)
      VALUES ('qa-player', 1, 0, 0, 'test-degen');
    INSERT INTO world_event_cycles(id, event_key, opens_at, closes_at)
      VALUES
        ('qa-cycle', 'underpass', datetime('now', '-1 hour'), datetime('now', '+1 hour')),
        ('qa-legacy-cycle', 'underpass', datetime('now', '-1 hour'), datetime('now', '+1 hour'));
    INSERT INTO world_event_clears(player_id, event_key, cycle_id, full_reward_clears)
      VALUES ('qa-player', 'underpass', 'qa-legacy-cycle', 3);
    INSERT INTO battle_permits(
      id, player_id, event_key, cycle_id, encounter_key, expires_at,
      player_hp, player_mana, enemy_hp, battle_status, turn_count,
      reward_state, reward_claim_token, reward_claimed_at
    ) VALUES
      (
        'permit-recovery', 'qa-player', 'underpass', 'qa-cycle', 'tunnel-maw',
        datetime('now', '+20 minutes'), 90, 0, 0, 'victory', 1, 'pending', NULL, NULL
      ),
      (
        'permit-legacy-recovery', 'qa-player', 'underpass', 'qa-legacy-cycle', 'tunnel-maw',
        datetime('now', '-20 minutes'), 70, NULL, 0, 'victory', 3, 'pending', NULL, NULL
      ),
      (
        'permit-live-claim', 'qa-player', 'underpass', 'qa-cycle', 'tunnel-maw',
        datetime('now', '+20 minutes'), 90, 0, 0, 'victory', 1,
        'claiming', 'live-claim-token', CURRENT_TIMESTAMP
      ),
      (
        'permit-stale-claim', 'qa-player', 'underpass', 'qa-cycle', 'tunnel-maw',
        datetime('now', '+20 minutes'), 90, 0, 0, 'victory', 1,
        'claiming', 'abandoned-claim-token', datetime('now', '-2 minutes')
      ),
      (
        'permit-stale-race', 'qa-player', 'underpass', 'qa-cycle', 'tunnel-maw',
        datetime('now', '-20 minutes'), 90, 0, 0, 'victory', 1,
        'claiming', 'abandoned-race-token', datetime('now', '-2 minutes')
      ),
      (
        'permit-missing-claim-time', 'qa-player', 'underpass', 'qa-cycle', 'tunnel-maw',
        datetime('now', '+20 minutes'), 90, 0, 0, 'victory', 1,
        'claiming', 'missing-time-token', NULL
      );
  `);
  cli(['d1', 'execute', 'DEGEN', '--local', `--persist-to=${persist}`, `--file=${seed}`]);

  // Force the atomic award batch to fail after the clear number has been
  // reserved. The lease must be released without rolling back or duplicating
  // that reservation, so the next request can retry immediately.
  sql(`CREATE TRIGGER qa_fail_victory_receipt BEFORE INSERT ON battle_history
    WHEN NEW.id = 'permit-recovery:victory'
    BEGIN SELECT RAISE(ABORT, 'QA_TRANSIENT_REWARD_FAILURE'); END`);
  await start();
  const failed = await complete();
  assert.equal(failed.status, 500, 'injected reward transaction failure must be surfaced');
  await stop();

  assert.deepEqual(sql(`SELECT reward_state, reward_claim_token, reward_claimed_at,
      reward_clear_number, completed_at
    FROM battle_permits WHERE id = 'permit-recovery'`), [{
    reward_state: 'pending',
    reward_claim_token: null,
    reward_claimed_at: null,
    reward_clear_number: 1,
    completed_at: null,
  }], 'failed award should release only its own claim while retaining the reserved clear');
  assert.deepEqual(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`),
    [{ full_reward_clears: 1 }], 'retry must not consume a second reward slot');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history WHERE id = 'permit-recovery:victory'`)[0]?.n, 0);
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), [{
    level: 1, xp: 0, currency: 0, last_reward_claim_token: null,
  }], 'a failed D1 batch must not partially grant progression');

  // Simulate the permit expiring while the award service is recovering. Once
  // a clear number is reserved, the authoritative victory remains claimable.
  sql("UPDATE battle_permits SET expires_at = datetime('now', '-1 minute') WHERE id = 'permit-recovery'");
  assert.equal(sql("SELECT julianday(expires_at) < julianday('now') AS expired FROM battle_permits WHERE id = 'permit-recovery'")[0]?.expired, 1);
  sql('DROP TRIGGER qa_fail_victory_receipt');
  await start();
  const recovered = await complete();
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.ok(recovered.body?.reward, 'successful retry returns an authoritative reward receipt');
  const reward = recovered.body.reward;
  const characterAfterAward = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  const permitAfterAward = sql(`SELECT reward_state, reward_clear_number, reward_xp,
      reward_currency, reward_tier, completed_at
    FROM battle_permits WHERE id = 'permit-recovery'`);
  assert.equal(permitAfterAward[0]?.reward_state, 'awarded');
  assert.equal(permitAfterAward[0]?.reward_clear_number, 1);
  assert.equal(permitAfterAward[0]?.reward_xp, reward.xp);
  assert.equal(permitAfterAward[0]?.reward_currency, reward.currency);
  assert.ok(permitAfterAward[0]?.completed_at);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history WHERE id = 'permit-recovery:victory'`)[0]?.n, 1);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM defeated_bosses
    WHERE player_id = 'qa-player' AND boss_key = 'tunnel-maw'`)[0]?.n, 1);

  const duplicate = await complete();
  assert.equal(duplicate.status, 200, JSON.stringify(duplicate.body));
  assert.deepEqual(duplicate.body.reward, reward, 'duplicate completion returns the same stored receipt');
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), characterAfterAward,
    'duplicate completion must not change progression twice');
  assert.deepEqual(sql(`SELECT reward_state, reward_clear_number, reward_xp,
      reward_currency, reward_tier, completed_at
    FROM battle_permits WHERE id = 'permit-recovery'`), permitAfterAward);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history WHERE id = 'permit-recovery:victory'`)[0]?.n, 1);
  assert.equal(sql(`SELECT quantity FROM player_inventory
    WHERE player_id = 'qa-player' AND item_key = 'underpass-scrap' AND item_type = 'item'`)[0]?.quantity ?? 0,
    reward.items.includes('underpass-scrap') ? 1 : 0);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM player_inventory
    WHERE player_id = 'qa-player' AND item_key = 'tunnel-trophy' AND item_type = 'furniture'`)[0]?.n ?? 0,
    reward.furniture.includes('tunnel-trophy') ? 1 : 0);
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`)[0]?.full_reward_clears, 1);

  // A live claim lease must not be stolen by a concurrent completion attempt.
  const beforeLiveClaim = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  const liveClaim = await complete('permit-live-claim');
  assert.equal(liveClaim.status, 409, JSON.stringify(liveClaim.body));
  assert.equal(liveClaim.body?.error, 'Battle reward is already being claimed, or the permit expired.');
  assert.equal('reward' in (liveClaim.body ?? {}), false);
  const livePermitState = sql(`SELECT reward_state, reward_claim_token, reward_claimed_at,
      reward_clear_number, completed_at
    FROM battle_permits WHERE id = 'permit-live-claim'`);
  assert.equal(livePermitState[0]?.reward_state, 'claiming');
  assert.equal(livePermitState[0]?.reward_claim_token, 'live-claim-token');
  assert.ok(livePermitState[0]?.reward_claimed_at, 'the live claim must retain its lease timestamp');
  assert.equal(livePermitState[0]?.reward_clear_number, null);
  assert.equal(livePermitState[0]?.completed_at, null);
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), beforeLiveClaim,
    'a live claim lease must not mutate progression');
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`)[0]?.full_reward_clears, 1);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history WHERE id = 'permit-live-claim:victory'`)[0]?.n, 0);

  // A process that died while holding a claim must be recoverable after the 60-second lease.
  const staleClaim = await complete('permit-stale-claim');
  assert.equal(staleClaim.status, 200, JSON.stringify(staleClaim.body));
  assert.ok(staleClaim.body?.reward, 'stale claim recovery must return the authoritative receipt');
  const staleReward = staleClaim.body.reward;
  assert.equal(staleReward.tier, 'full', 'the second clear in this cycle remains full-tier');
  const stalePermitAfterAward = sql(`SELECT reward_state, reward_claim_token, reward_claimed_at,
      reward_clear_number, reward_xp, reward_currency, reward_tier, completed_at
    FROM battle_permits WHERE id = 'permit-stale-claim'`);
  assert.equal(stalePermitAfterAward[0]?.reward_state, 'awarded');
  assert.notEqual(stalePermitAfterAward[0]?.reward_claim_token, 'abandoned-claim-token',
    'recovery must replace the abandoned worker token');
  assert.ok(stalePermitAfterAward[0]?.reward_claimed_at);
  assert.equal(stalePermitAfterAward[0]?.reward_clear_number, 2);
  assert.equal(stalePermitAfterAward[0]?.reward_xp, staleReward.xp);
  assert.equal(stalePermitAfterAward[0]?.reward_currency, staleReward.currency);
  assert.equal(stalePermitAfterAward[0]?.reward_tier, staleReward.tier);
  assert.ok(stalePermitAfterAward[0]?.completed_at);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history WHERE id = 'permit-stale-claim:victory'`)[0]?.n, 1);
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`)[0]?.full_reward_clears, 2);
  const characterAfterStaleAward = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  const inventoryAfterStaleAward = sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`);

  // The abandoned worker's token-scoped cleanup is harmless after lease takeover.
  sql(`UPDATE battle_permits SET reward_state = 'pending', reward_claim_token = NULL, reward_claimed_at = NULL
    WHERE id = 'permit-stale-claim' AND player_id = 'qa-player'
      AND reward_state = 'claiming' AND reward_claim_token = 'abandoned-claim-token'`);
  assert.deepEqual(sql(`SELECT reward_state, reward_claim_token, reward_claimed_at,
      reward_clear_number, reward_xp, reward_currency, reward_tier, completed_at
    FROM battle_permits WHERE id = 'permit-stale-claim'`), stalePermitAfterAward,
    'an abandoned worker cannot release or reset the recovered/awarded claim');

  const staleDuplicate = await complete('permit-stale-claim');
  assert.equal(staleDuplicate.status, 200, JSON.stringify(staleDuplicate.body));
  assert.deepEqual(staleDuplicate.body.reward, staleReward);
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), characterAfterStaleAward,
    'duplicate completion after stale-lease recovery must not award progression twice');
  assert.deepEqual(sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`), inventoryAfterStaleAward);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history WHERE id = 'permit-stale-claim:victory'`)[0]?.n, 1);
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`)[0]?.full_reward_clears, 2);

  // Two callers racing to recover the same stale lease may settle once; a loser
  // can receive a conflict while the winner owns the fresh lease, then replay it.
  const beforeStaleRace = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  const inventoryBeforeStaleRace = sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`);
  assert.equal(sql(`SELECT julianday(expires_at) < julianday('now') AS expired
    FROM battle_permits WHERE id = 'permit-stale-race'`)[0]?.expired, 1,
    'the stale victory claim is already expired before recovery starts');
  const staleRaceResults = await Promise.all([
    complete('permit-stale-race'),
    complete('permit-stale-race'),
  ]);
  assert.ok(staleRaceResults.every(result => result.status === 200 || result.status === 409),
    JSON.stringify(staleRaceResults));
  assert.ok(staleRaceResults.some(result => result.status === 200),
    'at least one concurrent stale-lease claimant must settle or replay the receipt');
  for (const result of staleRaceResults.filter(result => result.status === 409)) {
    assert.equal(result.body?.error, 'Battle reward is already being claimed, or the permit expired.');
  }

  const staleRaceRetry = await complete('permit-stale-race');
  assert.equal(staleRaceRetry.status, 200, JSON.stringify(staleRaceRetry.body));
  assert.ok(staleRaceRetry.body?.reward);
  const staleRaceReward = staleRaceRetry.body.reward;
  assert.equal(staleRaceReward.tier, 'full', 'the third clear in this cycle remains full-tier');
  const staleRacePermit = sql(`SELECT reward_state, reward_claim_token, reward_clear_number,
      reward_xp, reward_currency, reward_tier, completed_at
    FROM battle_permits WHERE id = 'permit-stale-race'`);
  assert.equal(staleRacePermit[0]?.reward_state, 'awarded');
  assert.notEqual(staleRacePermit[0]?.reward_claim_token, 'abandoned-race-token');
  assert.equal(staleRacePermit[0]?.reward_clear_number, 3);
  assert.equal(staleRacePermit[0]?.reward_xp, staleRaceReward.xp);
  assert.equal(staleRacePermit[0]?.reward_currency, staleRaceReward.currency);
  assert.equal(staleRacePermit[0]?.reward_tier, staleRaceReward.tier);
  assert.ok(staleRacePermit[0]?.completed_at);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history WHERE id = 'permit-stale-race:victory'`)[0]?.n, 1);
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`)[0]?.full_reward_clears, 3);
  const characterAfterStaleRace = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  assert.equal(characterAfterStaleRace[0]?.currency,
    beforeStaleRace[0].currency + staleRaceReward.currency,
    'concurrent stale-lease recovery applies currency once');
  assert.equal(characterAfterStaleRace[0]?.last_reward_claim_token,
    staleRacePermit[0]?.reward_claim_token);
  const inventoryAfterStaleRace = sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`);
  const scrapBefore = inventoryBeforeStaleRace.find(row => row.item_key === 'underpass-scrap' && row.item_type === 'item')?.quantity ?? 0;
  const scrapAfter = inventoryAfterStaleRace.find(row => row.item_key === 'underpass-scrap' && row.item_type === 'item')?.quantity ?? 0;
  assert.equal(scrapAfter, scrapBefore + 1, 'concurrent stale-lease recovery adds one scrap');
  const staleRaceReplay = await complete('permit-stale-race');
  assert.equal(staleRaceReplay.status, 200, JSON.stringify(staleRaceReplay.body));
  assert.deepEqual(staleRaceReplay.body.reward, staleRaceReward);
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), characterAfterStaleRace);
  assert.deepEqual(sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`), inventoryAfterStaleRace);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history WHERE id = 'permit-stale-race:victory'`)[0]?.n, 1);
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`)[0]?.full_reward_clears, 3);

  // A claiming receipt without a lease timestamp is malformed. Fail closed:
  // do not treat NULL as stale, steal the token, reserve a clear, or grant rewards.
  const beforeMissingLeaseTimeCharacter = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  const beforeMissingLeaseTimeInventory = sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`);
  const beforeMissingLeaseTimeClearCount = sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`)[0]?.full_reward_clears ?? 0;
  const missingLeaseTime = await complete('permit-missing-claim-time');
  assert.equal(missingLeaseTime.status, 409, JSON.stringify(missingLeaseTime.body));
  assert.equal(missingLeaseTime.body?.error, 'Battle reward is already being claimed, or the permit expired.');
  assert.equal('reward' in (missingLeaseTime.body ?? {}), false);
  assert.equal('player' in (missingLeaseTime.body ?? {}), false);
  assert.deepEqual(sql(`SELECT reward_state, reward_claim_token, reward_claimed_at,
      reward_clear_number, completed_at
    FROM battle_permits WHERE id = 'permit-missing-claim-time'`), [{
    reward_state: 'claiming',
    reward_claim_token: 'missing-time-token',
    reward_claimed_at: null,
    reward_clear_number: null,
    completed_at: null,
  }], 'NULL lease timestamps must not be interpreted as expired leases');
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), beforeMissingLeaseTimeCharacter);
  assert.deepEqual(sql(`SELECT item_key, item_type, quantity FROM player_inventory
    WHERE player_id = 'qa-player' ORDER BY item_type, item_key`), beforeMissingLeaseTimeInventory,
    'malformed lease must not mutate inventory');
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-cycle'`)[0]?.full_reward_clears ?? 0,
    beforeMissingLeaseTimeClearCount, 'malformed lease must not reserve a reward clear');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id = 'permit-missing-claim-time:victory'`)[0]?.n ?? 0, 0);
  await stop();

  // Repeat the transient-failure recovery against a valid pre-Mana victory.
  // Its persisted Mana must remain NULL, the already-expired permit must remain
  // reward-eligible, and its pre-existing clear counter makes this a reduced-tier
  // award. This combines legacy-state compatibility with the failure-retry path.
  sql(`CREATE TRIGGER qa_fail_legacy_victory_receipt BEFORE INSERT ON battle_history
    WHEN NEW.id = 'permit-legacy-recovery:victory'
    BEGIN SELECT RAISE(ABORT, 'QA_TRANSIENT_LEGACY_REWARD_FAILURE'); END`);
  await start();
  const legacyFailed = await complete('permit-legacy-recovery');
  assert.equal(legacyFailed.status, 500, 'legacy terminal reward failure must be surfaced');
  await stop();

  assert.deepEqual(sql(`SELECT player_mana, reward_state, reward_claim_token, reward_claimed_at,
      reward_clear_number, completed_at
    FROM battle_permits WHERE id = 'permit-legacy-recovery'`), [{
    player_mana: null,
    reward_state: 'pending',
    reward_claim_token: null,
    reward_claimed_at: null,
    reward_clear_number: 4,
    completed_at: null,
  }], 'failed legacy settlement must release its claim without inventing Mana or losing the reserved slot');
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-legacy-cycle'`)[0]?.full_reward_clears, 4);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id = 'permit-legacy-recovery:victory'`)[0]?.n, 0);
  const legacyCharacterBefore = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);

  sql('DROP TRIGGER qa_fail_legacy_victory_receipt');
  await start();
  const legacyRecovered = await complete('permit-legacy-recovery');
  assert.equal(legacyRecovered.status, 200, JSON.stringify(legacyRecovered.body));
  assert.equal(legacyRecovered.body?.reward?.tier, 'reduced');
  const legacyReward = legacyRecovered.body.reward;
  const legacyPermitAfterAward = sql(`SELECT player_mana, reward_state, reward_clear_number,
      reward_xp, reward_currency, reward_tier, completed_at
    FROM battle_permits WHERE id = 'permit-legacy-recovery'`);
  assert.equal(legacyPermitAfterAward[0]?.player_mana, null,
    'legacy recovery must not persist a fabricated Mana value');
  assert.equal(legacyPermitAfterAward[0]?.reward_state, 'awarded');
  assert.equal(legacyPermitAfterAward[0]?.reward_clear_number, 4);
  assert.equal(legacyPermitAfterAward[0]?.reward_xp, legacyReward.xp);
  assert.equal(legacyPermitAfterAward[0]?.reward_currency, legacyReward.currency);
  assert.equal(legacyPermitAfterAward[0]?.reward_tier, 'reduced');
  assert.ok(legacyPermitAfterAward[0]?.completed_at);
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id = 'permit-legacy-recovery:victory'`)[0]?.n, 1);
  const legacyCharacterAfterAward = sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`);
  assert.notDeepEqual(legacyCharacterAfterAward, legacyCharacterBefore,
    'successful retry must grant the previously withheld reward');

  const legacyDuplicate = await complete('permit-legacy-recovery');
  assert.equal(legacyDuplicate.status, 200, JSON.stringify(legacyDuplicate.body));
  assert.deepEqual(legacyDuplicate.body.reward, legacyReward);
  assert.deepEqual(sql(`SELECT level, xp, currency, last_reward_claim_token
    FROM characters WHERE player_id = 'qa-player'`), legacyCharacterAfterAward,
    'legacy duplicate completion must not grant progression twice');
  assert.equal(sql(`SELECT COUNT(*) AS n FROM battle_history
    WHERE id = 'permit-legacy-recovery:victory'`)[0]?.n, 1);
  assert.equal(sql(`SELECT full_reward_clears FROM world_event_clears
    WHERE player_id = 'qa-player' AND event_key = 'underpass' AND cycle_id = 'qa-legacy-cycle'`)[0]?.full_reward_clears, 4);
  await stop();

  console.log('PASS local Worker/D1 normal and legacy reward recovery, live/stale claim leases, concurrent stale-lease takeover, expired victory settlement, stable receipts, and exactly-once rewards');
} finally {
  await stop();
  rmSync(scratch, { recursive: true, force: true });
}
