// Isolated local Wrangler Worker + D1 regression. Never uses --remote.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';

test('real local Worker/D1 guards expected turns and preserves Mana and rewards', { timeout: 120_000 }, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const wrangler = resolve(root, 'node_modules/.bin/wrangler');
  const scratch = mkdtempSync(join(tmpdir(), 'degen-turn-replay-'));
  const persist = join(scratch, 'd1');
  const origin = 'http://127.0.0.1:8794';
  const env = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' };
  let worker: ReturnType<typeof spawn> | undefined;
  let logs = '';

  const cli = (args: string[]): string => {
    const r = spawnSync(wrangler, args, { cwd: root, env, encoding: 'utf8', timeout: 90_000 });
    if (r.error || r.status !== 0) throw Error(`wrangler ${args.join(' ')} failed: ${r.error ?? ''}\n${r.stdout}\n${r.stderr}`);
    return r.stdout;
  };
  const request = async (path: string, data: Record<string, unknown>) => {
    const r = await fetch(origin + path, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ playerId: 'qa-player', ...data }),
      signal: AbortSignal.timeout(15_000),
    });
    return { status: r.status, data: await r.json() as Record<string, any> };
  };
  const act = (permitId: string, abilityId: string, expectedTurnCount?: number) =>
    request('/api/battle/action', { permitId, abilityId, ...(expectedTurnCount === undefined ? {} : { expectedTurnCount }) });
  const complete = (permitId: string) => request('/api/battle/complete', { permitId });

  try {
    cli(['d1', 'execute', 'DEGEN', '--local', `--persist-to=${persist}`, '--file=db/schema.sql']);
    cli(['d1', 'migrations', 'apply', 'DEGEN', '--local', `--persist-to=${persist}`]);
    const seed = join(scratch, 'seed.sql');
    writeFileSync(seed, `
      INSERT INTO players(id,display_name) VALUES('qa-player','QA');
      INSERT INTO characters(player_id,level,xp,currency,degen_key)
        VALUES('qa-player',1,0,0,'test-degen');
      INSERT INTO world_event_cycles(id,event_key,opens_at,closes_at)
        VALUES('old-cycle','underpass',datetime('now','-4 hours'),datetime('now','-2 hours'));
      INSERT INTO world_event_cycles(id,event_key,opens_at,closes_at)
        VALUES('open-cycle','underpass',
          strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute'),
          strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 minutes'));
      INSERT INTO battle_permits(id,player_id,event_key,cycle_id,encounter_key,expires_at,
        battle_status,player_hp,player_mana,enemy_hp,turn_count)
      VALUES
        ('active','qa-player','underpass','old-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',120,12,92,0),
        ('concurrent','qa-player','underpass','old-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',120,12,92,0),
        ('zero','qa-player','underpass','old-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',120,0,92,0),
        ('defeat','qa-player','underpass','old-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',1,12,92,0),
        ('expired','qa-player','underpass','old-cycle','tunnel-maw',datetime('now','-20 minutes'),'active',120,12,92,0),
        ('legacy','qa-player','underpass','old-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',120,12,92,0),
        ('full-2','qa-player','underpass','old-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',5,4,20,0),
        ('full-3','qa-player','underpass','old-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',5,4,20,0),
        ('reduced-4','qa-player','underpass','old-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',5,4,20,0),
        ('race','qa-player','underpass','old-cycle','tunnel-maw',datetime('now','+20 minutes'),'active',5,4,20,0);
    `);
    cli(['d1', 'execute', 'DEGEN', '--local', `--persist-to=${persist}`, `--file=${seed}`]);

    worker = spawn(wrangler, ['dev', '--local', `--persist-to=${persist}`, '--ip=127.0.0.1', '--port=8794'], {
      cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [worker.stdout, worker.stderr]) {
      stream.on('data', (data) => { logs = (logs + data.toString()).slice(-10000); });
    }
    let ready = false;
    for (let i = 0; i < 80; i++) {
      if (worker.exitCode !== null) throw Error('Worker exited: ' + logs);
      try {
        const r = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(600) });
        if (r.ok && (await r.json() as {ok:boolean}).ok) { ready = true; break; }
      } catch { /* wait for local Worker startup */ }
      await sleep(250);
    }
    assert.ok(ready, 'Local Worker did not start: ' + logs);

    // Exercise the real start endpoint rather than trusting seeded client Mana.
    const worldResponse = await fetch(origin + '/api/world/underpass?playerId=qa-player');
    assert.equal(worldResponse.status, 200);
    const world = await worldResponse.json() as Record<string, any>;
    assert.equal(world.phase, 'open');
    assert.equal(world.cycleId, 'open-cycle');
    const started = await request('/api/battle/start', {
      eventKey: 'underpass', cycleId: world.cycleId, encounterKey: 'tunnel-maw',
    });
    assert.equal(started.status, 200);
    assert.equal(started.data.cycleId, 'open-cycle');
    const firstStartedAction = await act(started.data.permitId as string, 'crack', 0);
    assert.equal(firstStartedAction.status, 200);
    assert.equal(firstStartedAction.data.playerMana, 8);
    assert.equal(firstStartedAction.data.playerHp, 110);
    assert.equal(firstStartedAction.data.enemyHp, 57);
    assert.equal(firstStartedAction.data.turnCount, 1);

    assert.equal((await act('active', 'crack', 0)).data.playerMana, 8);
    for (let i = 0; i < 20; i++) {
      const replay = await act('active', 'crack', 0);
      assert.equal(replay.status, 409);
      assert.equal(replay.data.battleState.turnCount, 1);
      assert.equal(replay.data.battleState.playerMana, 8);
    }
    assert.equal((await act('active', 'crack', 1)).data.playerMana, 4);
    const victory = await act('active', 'crack', 2);
    assert.equal(victory.status, 200);
    assert.equal(victory.data.status, 'victory');
    assert.equal(victory.data.playerMana, 0);
    const recovered = await act('active', 'crack', 2);
    assert.equal(recovered.status, 409);
    assert.equal(recovered.data.battleState.status, 'victory');
    assert.equal((await complete('active')).status, 200);
    const receipt = await complete('active');
    assert.equal(receipt.status, 200);
    assert.equal(receipt.data.player.currency, 30);
    assert.equal(receipt.data.player.xp, 75);
    // Reward tier, duplicate completion, and level-up remain Worker-owned.
    for (const [permitId, tier, currency, level, xp] of [
      ['full-2', 'full', 60, 2, 50],
      ['full-3', 'full', 90, 2, 125],
      ['reduced-4', 'reduced', 93, 2, 135],
    ] as const) {
      const killingBlow = await act(permitId, 'crack', 0);
      assert.equal(killingBlow.status, 200);
      assert.equal(killingBlow.data.status, 'victory');
      const completed = await complete(permitId);
      assert.equal(completed.status, 200);
      assert.equal(completed.data.reward.tier, tier);
      assert.equal(completed.data.player.currency, currency);
      assert.equal(completed.data.player.level, level);
      assert.equal(completed.data.player.xp, xp);
      const repeated = await complete(permitId);
      assert.equal(repeated.status, 200);
      assert.equal(repeated.data.player.currency, currency);
      assert.equal(repeated.data.player.xp, xp);
    }

    // A completion racing a legitimate killing blow cannot award on permit possession.
    const [raceAction, raceClaim] = await Promise.all([
      act('race', 'crack', 0), complete('race'),
    ]);
    assert.equal(raceAction.status, 200);
    assert.equal(raceAction.data.status, 'victory');
    assert.ok([200, 409].includes(raceClaim.status));
    const raceReceipt = await complete('race');
    assert.equal(raceReceipt.status, 200);
    assert.equal(raceReceipt.data.reward.tier, 'reduced');
    assert.equal(raceReceipt.data.player.currency, 96);
    assert.equal(raceReceipt.data.player.level, 2);
    assert.equal(raceReceipt.data.player.xp, 145);

    assert.equal((await act('zero', 'crack', 0)).status, 409);
    const free = await act('zero', 'slash', 0);
    assert.equal(free.status, 200);
    assert.equal(free.data.playerMana, 0);

    const concurrent = await Promise.all(Array.from({ length: 16 }, () => act('concurrent', 'crack', 0)));
    assert.equal(concurrent.filter((r) => r.status === 200).length, 1);
    assert.equal(concurrent.filter((r) => r.status === 409).length, 15);

    assert.equal((await act('defeat', 'slash', 0)).data.status, 'defeat');
    const defeatReplay = await act('defeat', 'slash', 0);
    assert.equal(defeatReplay.status, 409);
    assert.equal(defeatReplay.data.battleState.status, 'defeat');
    assert.equal((await complete('defeat')).status, 409);

    const expired = await act('expired', 'crack', 0);
    assert.equal(expired.status, 409);
    assert.equal(expired.data.battleState, undefined);
    assert.equal((await act('missing', 'crack', 0)).status, 409);

    // Legacy clients must supply a turn precondition before taking an action.
    assert.equal((await act('legacy', 'slash')).status, 400);
    assert.equal((await act('legacy', 'slash')).status, 400);
  } finally {
    if (worker && worker.exitCode === null) {
      worker.kill('SIGTERM');
      await Promise.race([new Promise<void>((done) => worker!.once('exit', () => done())), sleep(2000)]);
      if (worker.exitCode === null) worker.kill('SIGKILL');
    }
    rmSync(scratch, { recursive: true, force: true });
  }
});
