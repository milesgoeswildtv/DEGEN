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


## Latest verified run — 2026-10-19 (Mana backfill continuation)

- Authoritative `main` SHA: `33e7477961d2a6ab7b79bf52d78a93901e19f658`.
- Continued `automation/degen/mana-active-permit-backfill-v01` from pre-continuity head `e78f13386eeb6f43e198eee999f37004178e70b1`, directly based on current main.
- **PUSHED / branch only:** migration `0007_backfill_active_battle_mana.sql`, `tests/mana-migration.test.ts`, `tests/mana-deploy-order.test.ts`. No PR was opened in this run; no merge, deployment, or production D1 mutation occurred.
- Targeted isolated Node 22 + SQLite fixture: **3/3 PASS** for eligible active-permit backfill, preserving existing Mana, rejecting expired/malformed expiry and incomplete/terminal/completed states, allowing valid permits through cycle closure, idempotent rerun, and schema → migrations → Worker ordering. This was an isolated fixture copied from fetched repository source, not full repository CI.
- Full `npm test`, `npm run build`, and `npm run check:worker` were not run: a complete checkout/dependency tree was unavailable. No exact-head CI was triggered because this branch has no PR.
- Mana core remains merged on main; migration 0007 is branch-only and unapplied in production. The value 12 is prototype scaffolding, not final balance canon. No monster Mana or zero-Mana reversion was added.
- Battle authority/reward receipts remain Worker-owned; reward idempotency is merged through PR #5, but live D1 behavior is unverified. Main's battle-start response still omits the initial authoritative snapshot; PR #12 has an unmerged implementation/test to reconcile after this slice.
- D1 source of truth verified: binding `DB`, database `DEGEN`, migration directory `db/migrations`; deployment applies schema, migrations, then Worker.
- Miles blocker: none on canon. PR creation remains pending; no PR status should be inferred.
- **Best next task:** open the focused backfill draft PR through a supported GitHub path, require exact-head CI, then review/reconcile PR #12's authoritative battle-start snapshot before Shield/status work.

## Latest verified run — 2026-10-19 (Mana backfill + authority audit)
- Authoritative `main` SHA: `33e7477961d2a6ab7b79bf52d78a93901e19f658`.
- Active continuation branch: `automation/degen/mana-active-permit-backfill-v01`, head `5a37d307e458b4721edc5ceebbe03f7eb9b4d451`, 11 commits ahead / 0 behind main. The older `sidekick/degen-mana-foundation-v01` remains 11 ahead / 22 behind and diverged; do not merge it over current main.
- Scoped branch diff remains: `db/migrations/0007_backfill_active_battle_mana.sql`, `tests/mana-migration.test.ts`, `tests/mana-deploy-order.test.ts`, and this continuity log. Backfill repairs only NULL Mana on unexpired, active permits with positive persisted HP and enemy HP; it preserves existing Mana and ignores terminal/completed/incomplete/expired/malformed permits. Closed Underpass cycle does not invalidate a legal in-flight permit.
- Targeted isolated Node 22 / SQLite QA in this run: **3/3 PASS** (eligible-only backfill; idempotent rerun and closed-cycle preservation; schema → tracked migrations → Worker deployment ordering). This was a copied local fixture, not full repository CI.
- Full `npm test`, `npm run build`, and `npm run check:worker` were **not run locally** because the runtime has no checkout and DNS prevents cloning GitHub. Current main CI is green on `33e7477` from run `37736582203` (2026-10-08). PR #12's broad draft head `8117d977a95bb6e4ba7e64b25b0f99041b7a8614` has a green CI run `39181705876` (2026-10-19), including deterministic tests, Worker/D1 concurrency harnesses, web build, Chromium mobile Worker/D1 vertical slice, and Worker dry-run; that PR changes 34 files and is not a focused merge candidate.
- Two attempts to open a focused draft PR from this branch were blocked by the GitHub connector's safety checks. Fresh branch/PR/file state was re-read between attempts; no PR was created and no repository or deployment settings were changed. The branch diff remains intact for later PR delivery.
- Mana core remains merged on main: shared Degen-only costs, authoritative action resolution, zero-cost usability, no monster Mana, no zero-Mana reversion. Remaining gap: `POST /api/battle/start` persists authoritative initial HP/Mana but main's response omits the initial snapshot, so the client initializes from local prototype values; PR #12 has a tested implementation of this contract but is too broad to merge wholesale.
- Battle authority/reward idempotency remain Worker-owned and merged through PR #5; endpoint-level concurrency/recovery work remains under draft review. D1 source of truth verified: `DB` binding, database `DEGEN`, `db/migrations`; deployment workflow applies schema, then tracked migrations, then Worker. Migration 0007 is branch-only and has not been applied to production. No Worker deploy or production D1 mutation occurred in this run.
- Miles blocker: none on gameplay canon. Delivery blocker: connector safety checks rejected PR creation; no speculative workaround was used.
- **Best next task:** retry focused PR delivery for this preserved backfill branch through a supported GitHub write path; after that PR is reviewable, port only the tested authoritative battle-start snapshot contract into a small separate change before any Shield/status work.



## 2026-10-19 — Mana backfill scope hardening (PUSHED / PR pending)
- Authoritative main SHA: `33e7477961d2a6ab7b79bf52d78a93901e19f658`.
- Active continuation: `automation/degen/mana-active-permit-backfill-v01`; previous head `91dfdedb05f1b03bcde95290cfb3088b7afb8761`; scoped migration/test commit `1509b816fc407c9848a9ec78583a7eab980e561e` pushed. Branch remains 12 commits ahead and 0 behind main before this continuity update.
- Changed `db/migrations/0007_backfill_active_battle_mana.sql` to limit the one-time prototype backfill to legacy `underpass` / `tunnel-maw` permits, in addition to existing active-state, live HP/enemy HP, incomplete, NULL Mana, and unexpired checks. This avoids assigning TEST_DEGEN's scaffolding value to unrelated event or encounter types. A legal issued permit remains eligible after its Underpass cycle closes.
- Changed `tests/mana-migration.test.ts` to vary event/encounter keys and assert unrelated event and future encounter permits remain untouched, while preserving existing Mana and the closed-cycle case.
- Targeted test source was updated, but exact branch CI is still pending; do not claim the repository test suite passed from this edit alone. Full local `npm test`, `npm run build`, and `npm run check:worker` remain unavailable without a checkout/dependency tree.
- Mana core remains MERGED on main. Migration 0007 remains branch-only/unapplied; no production D1 mutation or Worker deployment. D1 binding `DB`, database `DEGEN`, and migrations directory `db/migrations` were re-read from `wrangler.toml`; deploy workflow applies schema, tracked migrations, then Worker.
- Battle authority and reward receipts remain Worker-owned on main. The authoritative initial battle-start snapshot is still absent from main; PR #12 contains a broader, green-CI draft implementation but overlaps other battle reliability branches and must not be merged wholesale.
- Migration sequencing note: draft PR #14 also proposes `0006_player_sessions.sql`. Resolve that numbering/order dependency before merging this 0007 PR; PR #14 is not production authentication and must not be treated as such.
- No Miles canon blocker. Delivery status: code/test commit PUSHED; focused PR and exact-head CI pending. One earlier contents-API write was rejected; after re-reading branch/file SHA and push permission, the scoped changes were successfully committed via normal Git blob/tree/commit/ref operations. No force push or protected-main write.
- Best next task: open a focused draft PR for this backfill, obtain exact-head CI, then reconcile migration numbering with PR #14 and port only PR #12's tested initial battle snapshot into a separate narrow change.
