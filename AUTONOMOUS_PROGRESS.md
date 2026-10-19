# DEGEN — AUTONOMOUS PROGRESS

Updated: 2026-10-19

## Authoritative runtime
- Repository: `milesgoeswildtv/DEGEN`
- Integration branch: `main`
- Authoritative main SHA at this run: `33e7477961d2a6ab7b79bf52d78a93901e19f658`.
- Stack: TypeScript + Vite + Phaser + DOM/CSS; Cloudflare Worker + D1.
- Core vertical slice: Map -> Home -> Underpass -> Battle -> Loot -> Home.

## Locked product / engineering constraints
- Combat is Degen-only; NPCs never have Degens.
- Stability/Break is retired and must not return.
- Monsters never use Mana or a renamed universal resource.
- Glitchrat LEAK is Degen-specific and unavailable to monsters.
- World navigation is map/location based, not open-world traversal.
- Server owns persistent progression, rewards, world events, permits, housing, and other economic truth.

## Completed production milestones
- Stability/Break removed from prototype combat engine, types, data, and battle UI.
- Underpass combat actions are server-validated through `POST /api/battle/action`.
- Battle permits persist authoritative player HP, enemy HP, battle status, turn count, and Degen Mana.
- `/api/battle/complete` requires a server-resolved victory before granting rewards.
- Degen-only Mana foundation is merged on `main`: Degen max Mana and ability costs are shared across client/Worker rules; unaffordable actions reject without advancing state; successful paid abilities deduct once; zero-cost abilities remain usable at 0 Mana; monsters have no Mana field; 0 Mana does not revert the Degen.
- D1 migration for authoritative battle Mana/state is tracked and deploy ordering applies schema + migrations before Worker code.
- Client and Worker share one deterministic turn resolver.

## Historical PR #5 slice — merged on 2026-10-08
- PR #5: `automation/degen/reward-authority-v22` -> `main`.
- Reward lifecycle is persisted as pending/claiming/awarded with a 60-second stale-claim lease.
- Fresh claims require an unexpired server-resolved victory; recovery reuses the persisted clear number.
- Award writes are claim-token guarded and batched; victory history uses permit ID deterministically; awarded retries replay the persisted receipt.
- `db/migrations/0004_reward_receipt.sql` is tracked; no production D1 migration has been executed from this branch.
- Permit expiry hardening is now folded into PR #5 by fast-forward: all three authoritative checks use `datetime(expires_at) > CURRENT_TIMESTAMP`.
- `tests/reward-authority.test.ts` covers migration defaults, expired/non-victory rejection, duplicate live-claim rejection, stale-claim recovery, preserved clear number, and terminal awarded receipts; Node 22 SQLite rows are normalized before deep equality.
- Historical PR head before merge: `55d1152373d6602696593a39d26fda7793fa10a8`; PR #5 later merged into main at `33e7477961d2a6ab7b79bf52d78a93901e19f658`.
- CI status at the time: fresh PR-head CI was required; the merge SHA later passed Actions CI run `37736582203` on 2026-10-08.

## Battle authority / reward idempotency
- Mana authority: COMPLETE / MERGED on main.
- Reward recoverability/idempotency: MERGED on main through PR #5; no live production verification was performed in this run.
- Permit expiry format regression: fixed before merge; broader endpoint-level concurrency coverage remains pending.
- Remaining coverage priority: concurrent action/completion attempts, duplicate completion at endpoint level, invalid permits, and full/reduced clear + level-up integration.

## Deployment / persistence
- No production D1 mutation or deployment was performed by this slice.
- `deploy-worker.yml` applies D1 schema, then tracked migrations, then deploys Worker code.
- `wrangler.toml` remains the source of truth for the existing D1 binding/config; no deployment config was changed.

## Best next task
Deliver the active-permit Mana backfill as a focused PR with malformed-expiry and migration-before-Worker deployment regressions. After exact-head CI is green, implement and test the authoritative battle-start snapshot contract before Shield/status work.

## Latest verified run — 2026-10-08
- Main SHA: `2df79a123a022212721634c048147d8bf935566a`.
- PR #5 / `automation/degen/reward-authority-v22` head: `997c2e9280afc15faae20120ee27855f0e3d7c59` (PUSHED/PR, draft, not merged or live).
- Changed: added `tests/reward-concurrency.test.ts` for two-permit stale snapshot CAS, revoked-token guard, duplicate prevention, and history-marker rollback; SQLite model, not real Cloudflare D1/HTTP.
- Prior commit `efb88e9acb30b84f4dd2bb71107fa585b2a5ed0c` passed CI `37713559172`: npm test, npm run build, npm run check:worker. Fresh CI on new head pending; no local clone due DNS resolution failure.
- Mana remains COMPLETE/MERGED on main; monster Mana absent and zero Mana never reverts Degen.
- Reward idempotency/recoverability is PR-only; cross-permit CAS and token-guarded batch now covered by modeled regression. Real concurrent Worker/D1 requests still unverified.
- Tracked migrations `0004_reward_receipt.sql` and `0005_reward_claim_character_guard.sql`; deploy workflow applies migrations before Worker. No remote D1 change or deployment performed.
- Previous PR draft-to-ready mutation was rejected; no new design blocker from Miles.
- Best next task: isolate real Worker/D1, issue overlapping legitimate completion requests, verify both rewards and duplicate suppression, then inspect fresh CI and review PR before merge.


## Integration harness QA — 2026-10-08
- Main `2df79a123a022212721634c048147d8bf935566a`; PR #5 head `252e8224c7ba3d6e135845fa52db4430a7841215` remains draft, unmerged, not deployed.
- CI `37718852315` green but did not run `tests/worker-d1-concurrency.mjs`.
- LOCAL ONLY: isolated harness fix (remove unsupported Wrangler migrations `--yes`) and CI invocation prepared as patch, not pushed. Local SQLite reservation/CAS and migration model checks passed; actual Worker/D1 integration unverified.
- Reward migrations 0004/0005 tracked, no production D1 changes. Mana merged, no monster Mana or reversion.
- Best next task: land the harness and CI correction on the same branch, run Worker/D1 integration and update this file with observed results.


## Latest verified run — 2026-10-19 (Mana active-permit backfill continuation)
- Authoritative `main`: `33e7477961d2a6ab7b79bf52d78a93901e19f658`; active branch `automation/degen/mana-active-permit-backfill-v01` started at `fd7ca19d9c72e4886262c9811425b05bc3751e49`, 7 commits ahead / 0 behind, with no PR at start.
- Sidekick Mana branch remains 11 ahead / 22 behind and diverged. Its older client/Worker/runtime changes were inspected but not merged; current main is the source of truth.
- Scoped changes prepared for this branch: malformed-expiry rejection in `tests/mana-migration.test.ts`; new `tests/mana-deploy-order.test.ts`; continuity corrections in this file. Migration `0007_backfill_active_battle_mana.sql` remains unchanged.
- Targeted local Node 22 / SQLite fixture passed 3/3: eligible active-permit backfill with malformed expiry excluded; preserve valid encounters across event closure and idempotent rerun; schema → tracked migrations → Worker deployment ordering. These are isolated fixtures, not full repository CI.
- Full `npm test`, `npm run build`, and `npm run check:worker` were not run in this runtime because a complete checkout/dependency tree is unavailable. No PR-head CI exists yet.
- Mana rules are merged on main; migration 0007 is branch-only and has not been applied to production. D1 source of truth remains binding `DB`, database `DEGEN`, migration directory `db/migrations`; deployment workflow applies base schema, then tracked migrations, then Worker code. No production D1 mutation or deployment.
- Battle authority remains Worker-owned; reward receipt/idempotency merged through PR #5, but endpoint-level concurrent action/completion coverage and battle-start authoritative snapshot are still gaps. No Miles design blocker.
- Best next task: open a focused draft PR for the backfill and require exact-head CI; then finish the authoritative battle-start snapshot before Shield/status complexity.
