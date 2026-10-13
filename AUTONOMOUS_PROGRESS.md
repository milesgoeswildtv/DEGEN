# DEGEN — AUTONOMOUS PROGRESS

Updated: 2026-10-13

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


## 2026-10-12 — Same-permit completion race + shared combat math verification (PR #12)

- Authoritative main SHA: `33e7477961d2a6ab7b79bf52d78a93901e19f658`.
- Active branch / PR: `automation/degen/permit-millisecond-expiry-v02`, draft PR #12. Code/test head `bbedb59b9015b3d2b03f166f1773fd3f9ec5d28c`; continuity-only update follows.
- Changed this run: `tests/worker-d1-concurrency.mjs`. Added two simultaneous completion requests against the same server-earned victory and required a successful receipt path while retaining replay/economy assertions that catch duplicate grants. The isolated Worker/D1 harness now also calculates nine expected turns through the shared TypeScript resolver and compares the real Worker HTTP result (status, HP, Mana, enemy HP, turn count) against it.
- Exact-head GitHub Actions CI run `38208867879` passed on code/test head `bbedb59`: deterministic `npm test`, isolated local Wrangler/D1 HTTP integration, `npm run build`, and `npm run check:worker`. This is isolated CI evidence, not production D1, live deployment, or mobile verification.
- Mana: COMPLETE / MERGED on main. `DegenDefinition.maxMana`, `AbilityDefinition.manaCost`, shared deterministic turn math, persisted `player_mana`, authoritative rejection/deduction, zero-cost at 0 Mana, cost UI/disable logic, and no-reversion/no-monster-Mana rules are present on main. Migration `0003_degen_mana.sql` is tracked.
- Battle authority / reward idempotency: reward receipt/claim authority is merged on main; PR #12 adds coverage only and remains draft/unmerged. PR #9 still contains stricter expected-turn enforcement and earned-victory recovery; PR #10 contains the compatible client rollout. Preserve PR #10 client-first order before PR #9 strict-turn enforcement, and reconcile overlapping Worker/tests across PR #9/#12 rather than merging blindly.
- D1/deploy assumptions verified from repo: Wrangler binding `DB`, database `DEGEN`, migrations `0002`–`0005`; deploy workflow applies schema and tracked migrations before Worker code. No remote D1 mutation, production Worker deployment, or deployment-config change occurred.
- Blockers: signed Discord/Telegram authentication and per-request ownership are still required before public economic gameplay; live Pages/Worker CORS/connectivity is not verified. No new Miles design decision is needed for this test-only slice.
- Best next task: reconcile PR #12's permit/Mana/closed-cycle integration coverage with PR #9's recovery/turn-CAS Worker behavior after verifying PR #10 client compatibility; rerun exact-head CI and preserve the frontend-first release gate.


## 2026-10-12 — Recover server-recorded victory after permit expiry (PR #12)
- Authoritative main SHA: `33e7477961d2a6ab7b79bf52d78a93901e19f658`; continuing existing branch `automation/degen/permit-millisecond-expiry-v02`, PR #12 (draft). Parent head before this change: `1cb627e1064b099ffb9d9944272a078dd89016ee`.
- Scoped fix: reward completion now permits a pending claim whenever `battle_status='victory'` was already persisted by the Worker, even if the permit subsequently expires. Expiry checks remain strict for active actions and the action compare-and-set; client-submitted victory is still ignored. Awarded receipts remain terminal and replayable.
- Regression coverage updated in `tests/reward-authority.test.ts`, `tests/permit-expiry-precision.test.ts`, `tests/worker-d1-concurrency.mjs`, and `tests/worker-d1-seed-contract.test.ts`; integration seed distinguishes expired-active rejection from an expired, legally-entered server-recorded victory with no reserved clear. Duplicate recovery must replay one receipt and one cycle clear.
- Degen Mana remains COMPLETE/MERGED on main. No monster Mana, zero-Mana reversion, balance changes, D1 schema/migration edits, remote D1 writes, or deployments. Existing `DB`/DEGEN binding and migrations 0002–0005 unchanged.
- Battle authority: action expiry/CAS and server-owned victory remain enforced; reward recovery is not a permit-only grant. Idempotency continues through the persisted claim/receipt state. PR #10 client-first compatibility still precedes PR #9 mandatory-turn enforcement.
- QA status at edit time: deterministic tests passed 27/27 on exact head, but isolated Worker/D1 HTTP integration failed on fixture contamination (expired-victory reward changed integration-player XP from expected 50 to actual 125). Full CI is not green; build and Worker validation were skipped.
- Blockers: signed Discord/Telegram authentication, per-request account ownership, and verified production Pages/Worker connectivity remain public-release gates. No new Miles design decision is needed.
- Best next task: inspect the new exact-head CI and isolated Worker/D1 results, fix any regression, then reconcile PR #12 with PR #9/#10 without violating frontend-first release order. Status: local patch prepared; branch update/CI pending.


## 2026-10-12 — Isolate expired-victory recovery fixture (PR #12)
- Authoritative main SHA: `33e7477961d2a6ab7b79bf52d78a93901e19f658`; continuing `automation/degen/permit-millisecond-expiry-v02`, PR #12 (draft). Parent head inspected before this correction: `e796167691d9a3bd6c0ff83e3d9012b11a6b978c`.
- Exact-head CI run `38273193002`: `npm test` passed 27/27; isolated Wrangler/D1 HTTP harness failed at `tests/worker-d1-concurrency.mjs:206` because the newly recovered expired victory awarded 75 XP to the same integration player used by later level-up assertions (125 actual vs 50 expected). Build and Worker dry-run were skipped.
- Corrective test-only change: seed a separate `expired-player` character and use it for both the expired-active rejection and expired-server-victory recovery/replay. This preserves the recovery assertions while isolating XP/currency from the four-permit progression baseline. Production Worker/reward behavior is unchanged.
- Mana remains COMPLETE/MERGED on main; no monster Mana or zero-Mana reversion. No D1 schema/migration, binding, deployment config, remote DB operation, or deployment changed. Reward recovery still requires Worker-recorded victory; client victory and permit possession alone do not grant rewards.
- Fixture-isolation correction PUSHED to PR #12 in commit `9b3dc7d95db01f089f16a4a2e68a46d9b4378394`. Exact-head CI run `38278847097` is GREEN: 27/27 deterministic tests, isolated Wrangler/D1 HTTP reward/concurrency integration, production build, and Worker dry-run all passed. This remains draft / PR-only, not merged or deployed. PR #10 client-first compatibility must precede PR #9 strict-turn enforcement.
- Remaining release blockers: signed Discord/Telegram identity, per-request ownership enforcement, and verified production Pages/Worker connectivity/CORS. No new Miles design decision required.
- Best next task: reconcile PR #12's exact-expiry/recovery changes with PR #9's strict expected-turn and earned-victory recovery semantics, preserve PR #10's client-first release order, then rerun full CI on the reconciled feature branch. Do not merge or deploy this overlapping draft by itself.


## 2026-10-13 — Client receipt identity regression (PR #12, pushed branch)
- Authoritative main SHA: `33e7477961d2a6ab7b79bf52d78a93901e19f658`; continuing `automation/degen/permit-millisecond-expiry-v02`, draft PR #12.
- Inspected exact-head CI run `38333003888`: the deterministic test step failed before integration/build/Worker checks ran. Source review found the client now correctly requires `result.player.id === playerId`, while the recovery test mock returned a player object without an id.
- Changed `tests/client-reward-recovery.test.ts`: both successful Worker-receipt fixtures now include the expected player id; added a regression proving a mismatched account receipt cannot overwrite progression or clear the pending permit retry.
- QA: no local repository checkout is available in this runtime (GitHub DNS resolution failed); exact-head CI must verify the correction. New CI result is pending, not claimed green.
- Mana: COMPLETE / MERGED on main; `maxMana`, `manaCost`, shared deterministic math, authoritative persisted `player_mana`, rejection without state advance, exact deduction, zero-cost use at zero Mana, and no monster Mana/no reversion are already present. Tracked migration `0003_degen_mana.sql` runs through the existing migration-before-Worker workflow.
- Battle authority/rewards: server-recorded victory remains the only reward basis; persisted reward receipts/claim tokens and stale-claim recovery are in place on main. PR #12 contains permit precision, earned-victory recovery, D1 integration coverage, and now overlapping client-first work; reconcile its overlap with PRs #9–#11 before merge.
- D1 assumptions: `wrangler.toml` remains authoritative (`DB` / `DEGEN`); tracked migrations 0002–0005 apply before Worker deploy. No remote D1 mutation, deployment, or config change.
- Blocker: signed Discord/Telegram identity and per-request ownership remain required before public economic gameplay; production Pages/Worker connectivity/CORS and real mobile verification are not proven.
- Best next task: run fresh exact-head CI, fix any remaining failing test on this branch, then reconcile the overlapping Worker/client PRs in frontend-first release order.


## 2026-10-13 — Authoritative battle presentation tests (PR #12)

- Authoritative main SHA: `33e7477961d2a6ab7b79bf52d78a93901e19f658`. Continuing the existing `automation/degen/permit-millisecond-expiry-v02` branch / draft PR #12; no duplicate feature branch created.
- Added `tests/battle-authoritative-presentation.test.ts` with five deterministic cases: apply Worker HP/Mana/enemy HP once; ignore duplicate responses; sync to a skipped authoritative turn and reject stale rollback; keep a Degen manifested at 0 Mana; and handle authoritative killing blow/defeat without supplying client-computed rewards.
- Refactored `src/game/combat/engine.ts` constructor parameter properties to explicit fields and made the shared rules import explicit as `./rules.ts`; `tsconfig.json` enables `allowImportingTsExtensions` under existing `noEmit`. This makes the actual presentation engine testable under Node 22's native TypeScript stripping without changing combat math.
- Exact-head CI run `38352501843` passed on code head `4687c6c6cc9cf6bf3c4578dd9f215a8929a20fca`: deterministic tests, isolated local Wrangler/D1 reward/action concurrency, isolated 60-request Underpass cycle race, Vite/TypeScript build, and Worker dry-run all green. This is CI-local D1 evidence, not production D1 or deployment evidence.
- Mana remains COMPLETE / MERGED on main: shared `maxMana`/`manaCost`, authoritative persisted `player_mana`, no-state-change insufficient-Mana rejection, exact paid deduction, zero-cost use at zero Mana, and no monster Mana/no automatic reversion. Tracked migration `0003_degen_mana.sql` remains in the existing migration-before-Worker deployment path.
- Battle/reward authority and persisted receipts are merged on main. PR #12 remains DRAFT / PUSHED, not merged or live. It overlaps PR #9's strict-turn/defeat work, PR #10's broader client-first hardening, and PR #11's cycle reservation fix; keep the frontend-first release order (PR #10 before strict-turn enforcement) and reconcile overlaps before merging.
- D1 assumptions rechecked: `wrangler.toml` still defines binding `DB`, database `DEGEN`, and `db/migrations`; deploy workflow applies schema and migrations before Worker. No remote D1 write, production Worker deploy, migration execution, or deployment-config change in this run.
- Remaining release blocker: signed Discord/Telegram identity and per-request player ownership are not yet enforced by the Worker. Live production Pages/Worker connectivity and real mobile QA remain unverified.
- Best next task: reconcile the overlapping PR #12 permit/recovery/cycle tests with PRs #9/#10/#11, preserve PR #10 client compatibility before PR #9 strict-turn enforcement, then rerun exact-head CI before deciding merge readiness.


## 2026-10-13 — Worker/D1 vertical slice and Mana UI QA (PR #12)

- Main SHA: `33e7477961d2a6ab7b79bf52d78a93901e19f658`; code head validated: `217451b18423539b54c1c322ec04c492ae15b32e`.
- Added five authoritative battle-presentation tests and `tests/mana-ui.test.ts` for Mana labels, affordability, zero-cost availability, and terminal disabling.
- Extended isolated Wrangler/D1 HTTP integration through bootstrap -> server world snapshot -> battle permit -> three Worker-resolved paid turns -> authoritative reward receipt. Existing cases cover insufficient-Mana rejection without state mutation, zero-cost action at 0 Mana, duplicate/concurrent completion, full/reduced clears, expiry recovery, and legal closed-cycle permits.
- Exact-head CI run `38353024738` GREEN: 40/40 deterministic tests, Worker/D1 reward/action integration, 60-request cycle-race harness, web build, and Worker validation passed. This is isolated local D1 evidence only, not production D1/deployment proof.
- PR #12 `AppController.ts`, `api.ts`, and `styles.css` match PR #10 byte-for-byte. PR #12 does not include PR #9 strict-turn/atomic-defeat Worker changes; it includes PR #11 cycle reservation. Keep the frontend-first release order and reconcile distinct browser/release coverage before merge.
- Mana is COMPLETE / MERGED on main; migration `0003_degen_mana.sql` remains tracked in the migration-before-Worker workflow. No monster Mana or 0-Mana reversion. No remote D1 writes or production deploy.
- PR #12 remains PUSHED / DRAFT, not merged/live. Preview deployment was reported by the deploy bot, but browser access to the preview failed; no visual/mobile QA is claimed.
- Remaining release blocker: signed Discord/Telegram identity and per-request player ownership are not enforced by the Worker.
- Best next task: combine PR #12's Worker/D1 harness with PR #10's browser/release tests, then reconcile PR #9 strict-turn/defeat behavior and rerun full exact-head CI before merge.


## 2026-10-13 — Strict battle-turn preconditions and atomic defeat history (PUSHED / PR; exact-head CI pending)

- Authoritative main SHA: `33e7477961d2a6ab7b79bf52d78a93901e19f658`. Continuing `automation/degen/permit-millisecond-expiry-v02` / draft PR #12 from parent `df303304a184c9b2a9779061a9c98a94fcab9b8f`; no duplicate branch or PR created.
- Worker action requests now require a nonnegative safe-integer `expectedTurnCount`. Stale turn requests return the current server-owned HP/Mana/enemy HP/status/turn snapshot and do not resolve another action. A lost terminal response can be recovered from the persisted victory/defeat state.
- Defeat state and the permit-scoped deterministic `battle_history` row are written in one D1 batch. The isolated integration harness adds invalid-turn no-mutation, stale replay no-mutation, initial response-vs-permit equality, and exactly-once defeat history/replay checks. A Worker start-handler test asserts authoritative HP/Mana initialization and absence of monster Mana.
- Exact-head CI: pending. Do not infer test success from the parent run.
- Mana remains COMPLETE / MERGED on main: shared `maxMana`/`manaCost`, authoritative persisted `player_mana`, rejection without state advance, exact paid deduction, zero-cost use at zero Mana, and no monster Mana/no reversion. Migration `0003_degen_mana.sql` remains tracked; deployment workflow applies schema then migrations before Worker deployment.
- Battle/reward authority: rewards still require Worker-recorded victory and persisted receipt/claim-token state; duplicate completion/reward protection remains in place. PR #12 remains DRAFT / not merged or live.
- D1 assumptions: `wrangler.toml` defines `DB` / `DEGEN` and `db/migrations`. No production D1 mutation, migration execution, Worker deploy, or deployment-config change.
- Release order: do not merge/deploy mandatory-turn enforcement until the compatible client-first rollout in PR #10 is deployed and verified. Signed Discord/Telegram identity and per-request player ownership, production Pages/Worker connectivity/CORS, and real mobile QA remain release blockers.
- Best next task: run exact-head CI; if green, review PR #12 with PR #9/#10/#11 for non-overlapping semantics and preserve frontend-first rollout ordering.

## 2026-10-14 — concurrent action/completion race coverage (PUSHED/PR pending)
- Main SHA: `33e7477961d2a6ab7b79bf52d78a93901e19f658`. Current task branch: `automation/degen/permit-millisecond-expiry-v02`, draft PR #12; previous head `ba5f69d041db5cb06aecc4c744331f2566a3bb50` passed CI run `38432233659`.
- Gap: existing isolated Worker/D1 coverage tested duplicate completion and concurrent actions separately, but not a killing-blow action racing completion for the same permit.
- Proposed test adds an isolated player/permit, races `/api/battle/action` with `/api/battle/complete`, then verifies retry convergence and exactly one victory receipt/history row, one scrap, 75 XP, 30 currency, and one full clear. The seed preflight permit count is updated accordingly.
- Files: `tests/worker-d1-concurrency.mjs`, `tests/worker-d1-seed-contract.test.ts`, this file. Verified after the commit: GitHub Actions CI run 38479558162 completed SUCCESS on exact head `edd939905a5f8957f0238ec268ff90ad4ec64a70`. The run log confirms 46/46 deterministic tests, isolated Worker/D1 reward concurrency including the new action/completion race, 60-request Underpass cycle race, production build, and Worker dry-run all passed.
- Mana is COMPLETE/MERGED on main; player Mana is authoritative, paid abilities deduct once, zero-cost abilities work at zero, and there is no monster Mana or Mana-triggered reversion.
- Reward receipt/idempotency is merged on main. PR #12's millisecond expiry, expected-turn CAS, atomic defeat/history, expired server-earned victory recovery, and cycle reservation remain PR-only.
- D1 source verified: migrations 0002–0005 are tracked; deploy workflow applies schema, migrations, then Worker. No production D1 mutation or deployment was performed.
- Release blockers: compatible client PR #10 and production Pages CORS PR #7 remain unmerged; verified Discord/Telegram identity and request authorization are still required before public economic gameplay.
- Next: run fresh full CI and isolated Wrangler/D1 integration on the new head; then reconcile PR #12 with PR #9/#10/#11 and preserve client-first release ordering.
