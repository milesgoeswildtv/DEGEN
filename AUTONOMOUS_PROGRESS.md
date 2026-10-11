# DEGEN — AUTONOMOUS PROGRESS

Updated: 2026-10-08

## Authoritative runtime
- Repository: `milesgoeswildtv/DEGEN`
- Integration branch: `main`
- Authoritative main SHA at this run: `2df79a123a022212721634c048147d8bf935566a`.
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

## Current slice — PUSHED / PR
- PR #5: `automation/degen/reward-authority-v22` -> `main`.
- Reward lifecycle is persisted as pending/claiming/awarded with a 60-second stale-claim lease.
- Fresh claims require an unexpired server-resolved victory; recovery reuses the persisted clear number.
- Award writes are claim-token guarded and batched; victory history uses permit ID deterministically; awarded retries replay the persisted receipt.
- `db/migrations/0004_reward_receipt.sql` is tracked; no production D1 migration has been executed from this branch.
- Permit expiry hardening is now folded into PR #5 by fast-forward: all three authoritative checks use `datetime(expires_at) > CURRENT_TIMESTAMP`.
- `tests/reward-authority.test.ts` covers migration defaults, expired/non-victory rejection, duplicate live-claim rejection, stale-claim recovery, preserved clear number, and terminal awarded receipts; Node 22 SQLite rows are normalized before deep equality.
- Current PR head before this continuity commit: `55d1152373d6602696593a39d26fda7793fa10a8`.
- CI status: fresh PR-head CI is required after folding the expiry commits into PR #5. Do not merge until `npm test`, `npm run build`, and `npm run check:worker` are green.

## Battle authority / reward idempotency
- Mana authority: COMPLETE / MERGED on main.
- Reward recoverability/idempotency: PUSHED / PR, not merged or live.
- Permit expiry format regression: fixed on PR branch, awaiting fresh CI.
- Remaining coverage priority: concurrent action/completion attempts, duplicate completion at endpoint level, invalid permits, and full/reduced clear + level-up integration.

## Deployment / persistence
- No production D1 mutation or deployment was performed by this slice.
- `deploy-worker.yml` applies D1 schema, then tracked migrations, then deploys Worker code.
- `wrangler.toml` remains the source of truth for the existing D1 binding/config; no deployment config was changed.

## Best next task
Wait for and inspect fresh PR #5 CI. If green, review the complete PR diff and merge only if authority/idempotency invariants remain intact. If CI fails, fix the smallest failing regression on the same branch. After reward authority is merged, add endpoint-level concurrency/duplicate-completion integration coverage before generic Shield work.

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

## 2026-10-11 — Millisecond-precise permit expiry (feature branch)
- Authoritative main SHA: `33e7477961d2a6ab7b79bf52d78a93901e19f658`; branch `automation/degen/permit-millisecond-expiry-v02` (draft PR pending).
- Changed `worker/index.ts` and added `tests/permit-expiry-precision.test.ts`; corrected exactly three action lookup, action CAS, and fresh reward-claim guards from whole-second SQLite comparison to `julianday(expires_at) > julianday('now')`.
- Existing reserved clear recovery remains allowed after permit expiry; no change to rewards, balance, event closure semantics, player Mana, monster definitions, D1 schema, or migrations.
- LOCAL test: 3/3 targeted SQLite precision contract tests pass (3,000 boundary assertions plus offset and invalid timestamps). Full repository npm tests, build, Worker validation, and isolated Worker/D1 CI are required on this branch; not yet claimed.
- Mana is already merged on main and unchanged. Worker battle authority and reward idempotency remain in place. D1 migration assumptions unchanged; no production deployment or D1 mutation.
- Release blocker: signed Discord/Telegram authentication and per-request ownership; PR #10 client-first rollout must precede PR #9 strict turn enforcement.
- Best next task: obtain exact-head CI and isolated Worker/D1 verification of permit boundaries; review this draft PR without deploying.

## 2026-10-11 — Permit branch delivery state correction
- Code commit `df0d1d68bfff82baa0f9c54bc6433385ac045e45` is PUSHED to `automation/degen/permit-millisecond-expiry-v02` from main `33e7477961d2a6ab7b79bf52d78a93901e19f658`.
- **NO PR CREATED**: two supported GitHub PR-creation attempts were rejected after verifying the branch head. Do not claim a PR, merge, or CI success; the CI workflow triggers only for `main` pushes and PRs.
- Local precision tests 3/3 PASS. Full `npm test`, `npm run build`, `npm run check:worker`, isolated Worker/D1 and release verification remain pending.
- No production D1 migration, Worker deployment, or change to Mana/battle balance. Best next task: open a reviewed PR when repository PR creation is authorized/available and run exact-head CI.

## 2026-10-11 — Permit integration expansion (feature branch, NOT merged/live)
- Authoritative main: `33e7477961d2a6ab7b79bf52d78a93901e19f658`; current branch: `automation/degen/permit-millisecond-expiry-v02`, PR creation blocked by two independent attempts.
- Changed `tests/worker-d1-concurrency.mjs` to exercise real Worker HTTP Mana rejection, paid and free actions, zero-Mana killing blow, terminal defeat, expired/invalid permits, duplicate completion, four concurrent actions with single CAS, and a legitimately issued permit spanning event closure. Original 4-permit full/reduced reward and level-up coverage preserved.
- No Worker runtime, D1 schema, migrations, balance, or production configuration changed. Mana foundation remains MERGED on main; reward idempotency remains main, with post-expiry earned-victory recoverability still a PR #9 policy gap.
- LOCAL/STAGED QA: exact test file Node syntax PASS; migrated main D1 schema + migrations seed PASS (13 permits, valid pre-closure start time, integrity ok, foreign keys ok); 41/41 local model/contract tests PASS. Full npm test/build/check:worker and actual Wrangler/D1 HTTP run NOT verified; require fresh CI.
- D1 binding and tracked migrations unchanged. No production D1 mutation or deployment. Signed Discord/Telegram identity remains a release blocker.
- Best next task: open this branch as draft PR, run exact-head CI with isolated Worker/D1 integration, then reconcile earned-victory reward recovery in PR #9 behind PR #10 client-first release.

### Additional deterministic D1 integration-seed gate — 2026-10-11
- PUSHED `tests/worker-d1-seed-contract.test.ts` at Git blob `a8007e1e12c56422178b3f488c348341956ca516` on the existing permit feature branch.
- Verifies 13 seeded permits and two cycles against tracked main D1 schema/migrations, empty foreign-key violations, SQLite integrity, a legally entered pre-closure battle whose permit remains unexpired, and authoritative Mana/victory fixture states.
- LOCAL: 3/3 new seed tests PASS plus 21/21 adapted combat/expiry/reward model tests PASS. Actual Wrangler/D1 HTTP, full npm test/build/check:worker and exact-head CI remain pending because no PR could be created.
- Mana complete/merged on main, no monster Mana/reversion; reward authority unchanged. No deployment, remote D1 operation, migration or configuration change. Best next task remains draft PR + fresh exact-head CI.

## 2026-10-11 — Exact-head permit CI VERIFIED (feature branch only)
- Authoritative main: `33e7477961d2a6ab7b79bf52d78a93901e19f658`; feature branch `automation/degen/permit-millisecond-expiry-v02` at runtime/test/CI-trigger commit `0eb558f21d001c7b2b8db846763ebc034328bc24`.
- Added a **temporary branch-specific push trigger** to `.github/workflows/ci.yml` to obtain real CI despite blocked PR creation; remove this extra branch trigger during reviewed integration/merge. No deployment workflow, D1 binding, migration or production config changed.
- **GitHub Actions run `38137059245` SUCCESS:** 24/24 deterministic tests, actual isolated local Wrangler/D1 HTTP reward/Mana/defeat/concurrent-action/closed-cycle-quota integration, TypeScript/Vite build, and `npm run check:worker` all green. The Worker/D1 log explicitly reports the legal closed-cycle permit and reward isolation pass.
- Degen-only Mana remains COMPLETE/MERGED on main; monsters have no Mana and 0 Mana never reverts Degen. Reward authority remains server-owned; earned-victory recovery after expiry is in draft PR #9 and must be preserved.
- PR creation was rejected twice; branch is PUSHED with exact-head CI, **no PR/merge/live deployment**. Production Pages/Worker CORS and signed Discord/Telegram authorization remain release blockers.
- D1 tracked migrations 0002–0005 remain unchanged and deploy before Worker; no production D1 writes.
- Best next task: open draft PR for this now-CI-green permit branch, reconcile its precision fix with PR #9's earned-victory recovery, and remove temporary CI branch trigger before merge. PR #10 compatible frontend must deploy before PR #9 strict Worker turn enforcement.

## 2026-10-11 — Permit precision draft PR opened and CI verified
- Authoritative `main`: `33e7477961d2a6ab7b79bf52d78a93901e19f658`. Existing `automation/degen/permit-millisecond-expiry-v02` branch now has draft PR #12; prior head `e641c3d70b1edeb5e973c3a32904d3f12fa26c43`.
- Scope: no gameplay rebalance or new schema. Prior Worker millisecond expiry correction, deterministic Mana/permit tests, and isolated Worker/D1 regression remain on PR #12. Removed temporary push-branch CI trigger after opening the draft PR; CI now uses the standard pull_request event.
- QA: exact-head PR #12 run `38152031993` SUCCESS at `e641c3d`: deterministic tests, isolated Worker/D1 reward integration, `npm run build`, `npm run check:worker`. Local standalone SQLite recovery/expiry models 9/9 PASS; not a substitute for Wrangler/D1 HTTP.
- Mana: COMPLETE/MERGED on main; no monster Mana or automatic reversion. Reward authority and completion stay server-owned. D1 `DB` binding, tracked migrations 0002–0005, and migration-before-Worker deploy unchanged; no production D1 write or deployment.
- Integration caution: PR #9 overlaps on permit checks and tests and preserves earned-victory reward recovery. PR #10 compatible client must deploy before PR #9 mandatory-turn enforcement. Do not merge duplicate changes without review.
- Miles blocker: signed Discord/Telegram authentication and per-request ownership remain missing; live Pages/Worker connectivity/CORS unverified.
- Best next task: inspect fresh PR #12 CI, reconcile PR #9 overlap, preserve release order; no direct main write.
- Status: PUSHED / DRAFT PR; not MERGED/LIVE.

## 2026-10-11 — Permit HTTP harness strict-turn compatibility (PR #12)
- Main `33e7477961d2a6ab7b79bf52d78a93901e19f658`; PR #12 branch `automation/degen/permit-millisecond-expiry-v02` draft/unmerged.
- `tests/worker-d1-concurrency.mjs` now includes `expectedTurnCount` on all action requests, with turn 1 on both valid follow-up actions; `tests/worker-d1-seed-contract.test.ts` guards the contract. PR #12's Worker ignores the extra field, but PR #9's strict-turn Worker requires it. No gameplay, Worker, D1, migration, or config changes.
- Require exact-head CI and isolated Worker/D1; do not claim merged/live. Degen Mana merged on main; no monster Mana or reversion. Earned-victory recovery/strict turn CAS still PR #9. Signed platform auth and live Pages/Worker remain public-release blockers.
- Best next task: reconcile PR #12's unique permit/Mana/closure tests into PR #9 Worker semantics after PR #10 compatible frontend rollout.
