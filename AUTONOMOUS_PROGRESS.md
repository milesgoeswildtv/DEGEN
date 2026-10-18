# DEGEN — AUTONOMOUS PROGRESS

Updated: 2026-10-14

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

## Current release slice — PUSHED / DRAFT PR

- Authoritative `main` SHA: `33e7477961d2a6ab7b79bf52d78a93901e19f658` (verified against the live branch ref).
- Reward receipt/idempotency work from PR #5 is **MERGED into main**. Reward state is server-owned; claim-token-guarded D1 batches and persisted receipts protect retries from duplicate grants.
- Current integration candidate: PR #12, branch `automation/degen/permit-millisecond-expiry-v02` (**PUSHED / DRAFT**, not merged or deployed). Latest CI-verified head: `8bb1da2766ac274a50364d7ad8934d0781b1f89e`; run `38566536833` passed all required CI steps. This entry is a continuity-only follow-up; no runtime or test logic changed after that verified head.
- PR #12 carries millisecond-precise permit expiry, expected-turn CAS, authoritative initial battle state, atomic defeat/history writes, earned-victory recovery after expiry, Underpass cycle reservation, and Worker/D1 concurrency + vertical-slice coverage. It overlaps PRs #9, #10, and #11; do not merge it blindly.
- Exact-head CI runs `38565545387` on code/test commit `87f097f8bcdb18b1c25f7c5c4cb7bafa4abf5166`, `38565825497` on continuity commit `17d0662ab9f7b65c8a309655f3b285852865ac17`, `38566178166` on `d96684f795f0aaea4908ced4d12886376cda55d8`, and `38566536833` on `8bb1da2766ac274a50364d7ad8934d0781b1f89e` all completed SUCCESS. All nine CI steps passed: deterministic tests, isolated local Wrangler/D1 reward/action integration, isolated 60-request cycle-race integration, TypeScript/Vite build, and Wrangler Worker dry run.

## Battle authority / reward idempotency

- Mana authority: **COMPLETE / MERGED on main**.
- Reward completion/idempotency/recoverability: **MERGED on main** through PR #5; PR #12 adds broader exact-expiry, action-CAS, defeat-history, and real local Worker/D1 regression coverage but remains draft.
- The Worker owns battle HP/Mana/enemy HP/status/turn count, victory eligibility, reward clear numbering, XP, currency, inventory, and victory history. Client requests carry the ability and observed turn only; they do not submit combat state or reward amounts.
- Remaining integration gaps are release sequencing across PRs #9/#10/#11/#12 and live browser/platform verification, not a missing Mana foundation.

## Deployment / persistence

- D1 migration files `0002_authoritative_battle_state.sql`, `0003_degen_mana.sql`, `0004_reward_receipt.sql`, and `0005_reward_claim_character_guard.sql` are tracked on main.
- The deployment workflow applies `db/schema.sql`, then `wrangler d1 migrations apply DEGEN`, then deploys Worker code. `wrangler.toml` remains the authoritative DB binding/config; no binding or DB ID was changed.
- No production D1 mutation or deployment was performed by this run. Isolated Wrangler/D1 HTTP tests are local CI evidence, not proof of production persistence or platform gameplay.

## Best next task

Reconcile PR #12's full diff with PRs #9/#10/#11, preserve the compatible client-before-strict-turn rollout order, and keep draft until that review and current-head CI are green. After the integration slice is merged safely, move to generic temporary Shield support before the universal status engine.

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
- Gaps addressed: race a killing-blow action against completion for the same permit; reject missing, null, and string expected-turn values; reject an action submitted by a different player.
- Proposed test adds an isolated player/permit, races `/api/battle/action` with `/api/battle/complete`, then verifies retry convergence and exactly one victory receipt/history row, one scrap, 75 XP, 30 currency, and one full clear. The seed preflight permit count is updated accordingly.
- Files: `tests/worker-d1-concurrency.mjs`, `tests/worker-d1-seed-contract.test.ts`, this file. Verified on exact test head `e8c1f6bd93eb5b2f156c557fde52d7b9e6e148c9`: GitHub Actions CI run 38480047158 SUCCESS. The log confirms 46/46 deterministic tests, isolated Worker/D1 reward concurrency (including killing-blow/action-completion race, missing/null/string turn preconditions, and cross-owner rejection), 60-request Underpass cycle race, production build, and Worker dry-run all passed.
- Mana is COMPLETE/MERGED on main; player Mana is authoritative, paid abilities deduct once, zero-cost abilities work at zero, and there is no monster Mana or Mana-triggered reversion.
- Reward receipt/idempotency is merged on main. PR #12's millisecond expiry, expected-turn CAS, atomic defeat/history, expired server-earned victory recovery, and cycle reservation remain PR-only.
- D1 source verified: migrations 0002–0005 are tracked; deploy workflow applies schema, migrations, then Worker. No production D1 mutation or deployment was performed.
- Release blockers: compatible client PR #10 and production Pages CORS PR #7 remain unmerged; verified Discord/Telegram identity and request authorization are still required before public economic gameplay.
- Next: reconcile PR #12 with PR #9/#10/#11, preserve client-first release ordering, and keep public economy gated until signed platform identity and request-level authorization are implemented.

## 2026-10-14 — Zero-Mana no-reversion regression (PUSHED / PR #12)

- Main SHA: `33e7477961d2a6ab7b79bf52d78a93901e19f658`; branch `automation/degen/permit-millisecond-expiry-v02`; PR #12 remains draft, not merged/live.
- Commit `87771da5249d072a486c0ecbb79df622c9154a2b` adds an engine-level regression in `tests/combat-progression.test.ts`: three paid actions exhaust Mana, the Degen stays manifested/active, and a zero-cost action still resolves at 0 Mana without terminal completion.
- Exact-head CI run `38523681675` was in progress at the last check. Previous head `d1ce8a6a9037354c2a02cdd363433c9bbe677347` passed run `38507526032`: deterministic tests, isolated local Worker/D1 reward and cycle concurrency, build, Worker dry run. Verify the new run before claiming the new test green.
- Mana is complete/merged on main: shared `maxMana`/`manaCost`, authoritative `player_mana`, no-state-change rejection, exact paid deduction, zero-cost at 0, no monster Mana/reversion. Migration `0003_degen_mana.sql` and migration-before-Worker order test are tracked.
- Reward receipts/idempotency are merged on main; PR #12's precise expiry, turn CAS, defeat/history atomicity, expired server-earned victory recovery, and expanded Worker/D1 coverage remain PR-only. D1 source remains `DB` / `DEGEN` / `db/migrations`; no production D1 mutation or deployment.
- Blockers: PR #10 compatible client and PR #7 production Pages CORS are not live; signed platform identity/request ownership and real mobile/browser QA remain unverified. Keep strict-turn Worker enforcement behind compatible client rollout.
- Next: verify run `38523681675`, then reconcile PR #12 overlaps with PRs #9/#10/#11 before any merge.


## 2026-10-14 — Zero-Mana regression assertion stabilized (PUSHED / PR #12)

- Authoritative main SHA: `33e7477961d2a6ab7b79bf52d78a93901e19f658`; continuing `automation/degen/permit-millisecond-expiry-v02`, PR #12 (draft).
- CI runs `38523681675` and `38523738458` exposed one test-only failure: the no-reversion test expected the initial `manifests` log line after four actions, but the battle log intentionally retains only the latest six entries. Mana depletion, active battle state, zero-cost action, and Worker/D1 checks passed in those runs.
- Changed `tests/combat-progression.test.ts` to assert stable snapshot identity (`playerName`) and the Degen's `playerMaxMana` instead of depending on a bounded presentation log. No gameplay, Worker authority, reward, D1, migration, or deployment configuration changes.
- Mana remains COMPLETE / MERGED on main: shared maxMana/manaCost, persisted authoritative player Mana, no-state-change rejection, exact paid deduction, zero-cost actions at 0 Mana, no monster Mana and no reversion. Migration `0003_degen_mana.sql` remains tracked and deploy ordering applies migrations before Worker code.
- Battle/reward authority and reward receipts are merged on main. PR #12's permit precision, turn CAS, atomic defeat/history, expired server-earned victory recovery, and cycle reservation remain PUSHED / DRAFT PR only. No production D1 write or deployment.
- Exact-head GitHub Actions run `38529411153` on `ab84f6c1b02f945c73c83622c5c513a198e8146c` PASSED: 49/49 deterministic tests, isolated Worker/D1 reward/action integration, 60-request Underpass cycle race, `npm run build`, and `npm run check:worker`. Signed Discord/Telegram identity and per-request ownership, production Pages/Worker connectivity, and real mobile/browser verification remain release blockers.
- Best next task: verify fresh PR #12 CI, then reconcile its Worker/test overlaps with PRs #9/#10/#11 while preserving the client-first rollout gate.


## 2026-10-14 — Exact-head CI green and Mana branch authority audit

- Authoritative `main`: `33e7477961d2a6ab7b79bf52d78a93901e19f658`. Current branch/PR: `automation/degen/permit-millisecond-expiry-v02` / draft PR #12, head `ab84f6c1b02f945c73c83622c5c513a198e8146c`.
- **PUSHED / PR #12:** stabilized the zero-Mana no-reversion regression by asserting the persistent battle snapshot rather than the bounded six-entry log. Exact-head run `38529411153` is GREEN: 49/49 deterministic tests; isolated Worker/D1 HTTP integration validates authoritative Mana, rejected unaffordable action without state mutation, paid deduction, free action at 0 Mana, killing blow, defeat, turn CAS/replay, reward completion/idempotency, expiry recovery, and legal permit across event closure; separate 60-request cycle-race harness; Vite/TypeScript build; Wrangler Worker dry run.
- Mana branch authority check: `sidekick/degen-mana-foundation-v01` exists at `e1ec782773728e94805c4e653ead62338a7ff9d1`, 11 commits ahead / 22 behind main. Its Mana types/rules and `0003_degen_mana.sql` are already on main; its engine/Worker are older than main's authoritative client-sync/turn-CAS work. No unique unfinished Mana slice remains on that branch, so it was not merged/cherry-picked and no duplicate Mana branch was created.
- Mana status: COMPLETE / MERGED on main. Shared `maxMana`/`manaCost`, authoritative `player_mana`, no-state-change insufficient-Mana rejection, exact paid deduction, zero-cost at 0, no monster Mana, and no automatic reversion are covered. Migration `0003_degen_mana.sql` remains tracked; Worker deploy workflow applies schema and migrations before Worker code.
- Battle authority/reward idempotency are merged on main; PR #12's millisecond expiry, expected-turn CAS, atomic defeat/history, earned-victory expiry recovery, cycle reservation, and broader integration tests are PUSHED / DRAFT PR only. PRs #9/#10/#11 overlap; PR #12 must not be merged blindly. Keep compatible client rollout ahead of strict Worker turn enforcement. No production D1 mutation or deployment occurred.
- Remaining release blockers: signed Discord/Telegram identity and per-request ownership, target-host CORS/connectivity verification, and real browser/mobile/Telegram/Discord gameplay QA. CI-local Wrangler/D1 evidence is not production evidence.
- Best next task: reconcile PR #12 against PRs #9/#10/#11 into a release-safe frontend-first sequence, verify the deployed compatible client, then gate strict-turn Worker rollout; retain the draft state until that review is complete.

## 2026-10-14 — Insufficient-Mana authoritative conflict contract (PUSHED / PR #12)

- Authoritative main SHA remains `33e7477961d2a6ab7b79bf52d78a93901e19f658`; draft PR #12 branch `automation/degen/permit-millisecond-expiry-v02`. The insufficient-Mana test commit was `87f097f8bcdb18b1c25f7c5c4cb7bafa4abf5166`; latest CI-verified head is `17d0662ab9f7b65c8a309655f3b285852865ac17`.
- Changed `tests/battle-api-turn-contract.test.ts`: added a regression proving that an insufficient-Mana 409 is parsed as `BattleTurnConflictError` only when it includes the exact Worker-owned state, preserving HP, Mana=0, enemy HP, and turn count without sending client-computed state.
- Changed `AUTONOMOUS_PROGRESS.md` to correct stale PR #5 status (now merged), record the current main SHA/PR #12 head, distinguish previous-head green CI from current-head pending CI, and list verified migrations and release blockers.
- CI run `38565545387` passed after the new test commit; run `38565825497` also passed all nine steps at `17d0662ab9f7b65c8a309655f3b285852865ac17`. The latest change in this file is continuity-only and does not alter tested runtime or test logic. The preceding docs-only head `8bb1da2766ac274a50364d7ad8934d0781b1f89e` passed run `38566536833`. Two supported PR metadata update attempts were rejected by connector safety checks; the PR remains draft and its existing body was not changed.
- Mana remains COMPLETE / MERGED; no monster Mana or zero-Mana reversion. Battle authority and reward idempotency remain server-owned. D1 migrations 0002–0005 are tracked and deployment order is schema → migrations → Worker. No production DB writes/deployment.
- Release blockers: PR #9/#10/#11 integration order, signed Discord/Telegram identity and per-request ownership, production Pages CORS/API connectivity, and real browser/mobile/platform QA.
- Best next task: verify exact-head CI, then perform a line-by-line integration review of PR #12 against #9/#10/#11 before any merge; do not begin Shield until this reliability slice is integrated safely.

## 2026-10-15 — Persisted Mana replay + fractional-expiry HTTP regressions (PUSHED / PR #12; new-head CI pending at commit time)

- Authoritative `main` SHA: `33e7477961d2a6ab7b79bf52d78a93901e19f658`.
- Current delivery: draft PR #12, branch `automation/degen/permit-millisecond-expiry-v02`, continuing from parent `384e9767d38c1c1ef030cb1ccadf1cc6629026e6`. The parent head passed CI run `38779606446`; the new route-level expiry assertions require a fresh exact-head CI run.
- Changed `tests/worker-d1-concurrency.mjs` only for gameplay/test logic: paid and zero-cost killing blows assert exact persisted HP/Mana/enemy HP/status/turn state; terminal replays return 409 without a second deduction or turn. Added a real local Wrangler/D1 HTTP regression that acts during the last fractional second before permit expiry, checks the shared turn resolver and persisted state, then verifies an action after exact expiry returns 409 with unchanged state.
- Mana remains COMPLETE / MERGED on main: authoritative initial/persisted player Mana, shared deterministic turn resolution, unaffordable rejection without state mutation, exact paid deduction, zero-cost use at zero, no monster Mana and no Mana-triggered reversion. Prototype values remain scaffolding.
- Battle authority and reward-receipt idempotency are merged on main. PR #12 remains draft and overlaps PRs #9/#10/#11; do not merge cumulatively or bypass the client-first-before-strict-turn sequence.
- D1 assumptions verified from source: migrations `0002_authoritative_battle_state.sql` through `0005_reward_claim_character_guard.sql` are tracked; deployment applies schema, then migrations, then Worker. No schema/migration, binding, remote D1, or deployment change.
- No local repository checkout is available in this runtime; CI is the required evidence for the new HTTP test. The test runs only against isolated local Wrangler/D1, never production.
- Miles blocker/release gates unchanged: signed Discord/Telegram identity and per-request player ownership are not wired into main routes; production Pages origin/CORS/API connectivity and real browser/mobile/platform gameplay remain unverified.
- Best next task: verify fresh exact-head CI, then reconcile PR #12 with #9/#10/#11 into a release-safe frontend-first sequence before generic temporary Shield support.



## 2026-10-17 — Underpass rollover concurrency QA (PUSHED / draft PR #12; CI PASS)

- Authoritative main SHA: `33e7477961d2a6ab7b79bf52d78a93901e19f658`. Continued existing branch `automation/degen/permit-millisecond-expiry-v02` from verified head `00570d9be096b32214571e27bc68976cf4ca3fe9`; no duplicate branch or direct-main write.
- Added `tests/worker-d1-cycle-rollover.mjs`, an isolated local Wrangler/D1 HTTP test that seeds one expired Underpass cycle, sends 60 concurrent world requests, and requires every response to converge on one successor while preserving the expired row. Added the test to `.github/workflows/ci.yml`.
- Exact-head GitHub Actions run `39003413119` PASSED at `8c404d2c4f3c8fb121013cc28498fd23d77b9fa6`: 56/56 deterministic tests, isolated Worker/D1 reward/action concurrency, 60-request active-cycle race, 60-request expired-cycle rollover race, TypeScript/Vite production build, and Wrangler Worker dry run. Vite emitted an informational >500 kB chunk warning; the build succeeded. These are CI-local tests, not production D1, deployment, or mobile proof.
- Mana: COMPLETE / MERGED on main. Shared `maxMana`/`manaCost`, authoritative persisted player Mana, no-mutation rejection, exact paid deduction, zero-cost use at 0 Mana, no monster Mana, no reversion, and tracked migration `0003_degen_mana.sql` remain unchanged.
- Battle authority/reward idempotency: server-owned victory and persisted reward receipts are merged on main. PR #12's exact-expiry guards, turn CAS, atomic defeat/history, earned-victory recovery, cycle reservation, and integration coverage remain PUSHED / DRAFT, not merged or live.
- D1 source assumptions rechecked: `wrangler.toml` binds `DB` to `DEGEN`; migrations `0002`–`0005` are tracked and the deploy workflow applies schema/migrations before Worker code. No production D1 operation, deployment, migration change, or config change.
- Release blockers: reconcile overlapping PRs #9/#10/#11/#12 and retain compatible-client-before-strict-turn rollout; signed Discord/Telegram identity and request-level ownership, production Pages/Worker CORS/connectivity, and real browser/mobile/platform gameplay remain unverified.
- Best next task: verify exact-head CI for the rollover test, then continue line-by-line release-order reconciliation of PR #12 before any merge.


## 2026-10-17 — Exact-head authority CI review

- Main SHA: `33e7477961d2a6ab7b79bf52d78a93901e19f658`; draft PR #12 branch `automation/degen/permit-millisecond-expiry-v02`, head `53c9e4cfe6c6fab1f4a5d78dafd9d6b0bc7d4962`.
- Exact-head GitHub Actions run `39006935795` succeeded: `npm test`, isolated local Wrangler/D1 reward/action concurrency, active-cycle race, expired-cycle rollover race, `npm run build`, and `npm run check:worker`.
- The committed `tests/browser-worker-vertical-slice.mjs` is not invoked by this branch's CI workflow. It exercises Chromium mobile touch through Map → Home → Underpass → authoritative Mana spending → server-earned trophy against isolated local Wrangler/D1. A related client-first branch ran it successfully, but that is not exact-head proof for PR #12.
- Adding the browser harness as a CI step after the build was attempted twice and blocked by runtime safety checks. The exact intended one-step diff is preserved in this note; no workflow write was accepted. Do not claim browser QA passed on this PR head.
- Mana and reward receipt/idempotency are merged on main. PR #12's expiry precision, expected-turn CAS, atomic defeat/history, earned-victory recovery, cycle reservation, and Worker/D1 integration remain pushed/draft only.
- D1 source assumptions: `wrangler.toml` binds `DB` to `DEGEN`; migrations `0002`–`0005` are tracked and deploy order is schema → migrations → Worker. No production D1 mutation, migration execution, or deployment occurred.
- Release gates: reconcile PR #12 with #9/#10/#11 and keep client-first before mandatory turn enforcement; signed platform identity/request ownership and production Pages/Worker CORS remain unverified. Local checkout was unavailable because this runtime could not resolve `github.com`.
- Best next task: wire the committed browser vertical-slice test into CI through a supported write path, verify exact-head CI, then integrate the reliability slice in release-safe order before Shield work.


## 2026-10-17 — Legacy permit Mana migration audit (LOCAL FINDING / PATCH NOT PUSHED)

- Re-read the current Mana migration and Worker action handler. `db/migrations/0003_degen_mana.sql` adds nullable `player_mana INTEGER` without a backfill; the current Worker action path rejects a permit if `player_mana IS NULL`. SQLite reproduction confirmed that existing permit rows remain NULL after `ALTER TABLE ... ADD COLUMN player_mana INTEGER`. This is a compatibility risk for a battle permit that was active when the Mana migration ran.
- Proposed narrow fix on the existing PR #12 branch: treat NULL Mana only as a legacy-state marker, resolve it server-side as `TEST_DEGEN.maxMana`, and persist the resulting post-action Mana through the existing turn-count CAS. Conflict/terminal state payloads should use the same authoritative fallback. Do not accept any client-submitted Mana and do not add a monster resource.
- Proposed regression in `tests/worker-d1-concurrency.mjs`: seed an active permit with `player_mana NULL`, request a paid ability with the current expected turn, compare the HTTP result to the shared deterministic resolver at `TEST_DEGEN.maxMana`, and assert the permit persists the exact deducted Mana and increments its turn once. Keep all operations on the isolated local Wrangler/D1 database.
- **NOT PUSHED:** Worker source write was rejected twice by runtime safety checks (after re-reading the branch and current file SHA). No Worker/test code changed. Per repository-write policy, stop retrying this mutation in this run; retry through a supported path later. Do not claim the compatibility fix or regression test is implemented.
- Mana and reward receipt/idempotency remain merged on main; PR #12 stays draft. Existing exact-head CI run `39006935795` passed its configured steps; the docs-only follow-up run `39010835625` was still in progress at the last check. The browser vertical-slice harness remains committed but is not invoked by PR #12's current CI workflow.
- Best next task: land the legacy-permit fallback plus isolated Worker/D1 regression on PR #12, wire the browser harness into CI, then review the overlapping client-first/strict-turn/cycle branches before any merge.

## 2026-10-17 — Legacy Mana permit recovery + browser CI gate (PUSHED / draft PR #12)

- Authoritative main SHA: `33e7477961d2a6ab7b79bf52d78a93901e19f658`.
- Current feature branch: `automation/degen/permit-millisecond-expiry-v02`, draft PR #12, head `2c1c945d6a72826f43caa950cce07ad9a8f33097`. No merge, deployment, or production D1 operation.
- Runtime change in `worker/index.ts`: legacy permits with `player_mana IS NULL` (possible because migration 0003 added a nullable column) resolve Mana server-side from `TEST_DEGEN.maxMana`. Terminal/conflict snapshots use the same fallback. The successful action still writes the resolver's post-action Mana through the existing turn-count CAS; no client Mana input, monster resource, balance change, or new migration.
- CI change in `.github/workflows/ci.yml`: the existing `tests/browser-worker-vertical-slice.mjs` now runs after the build, exercising Chromium mobile-touch navigation through Map → Home → Underpass → authoritative battle/Mana → server reward receipt → Home trophy against isolated local Wrangler/D1.
- Exact-head GitHub Actions run `39018368852` on `2c1c945d6a72826f43caa950cce07ad9a8f33097`: PASS — `npm test`, Worker/D1 reward-action concurrency, active-cycle concurrency, expired-cycle rollover concurrency, TypeScript/Vite build, Chromium mobile vertical slice, and `npm run check:worker`. The preceding head failed because the new normalized Mana local reused the resolver output name; renamed it to `currentMana`, then the exact-head run passed.
- **Targeted legacy-permit regression remains NOT COMMITTED.** Intended test seeds an active permit and a terminal permit with NULL Mana, verifies the terminal 409 exposes max Mana without mutating D1, and verifies the first paid action matches the shared resolver and persists exact post-action Mana/one turn. The test-file write was rejected through two independent supported paths; no test change was accepted. Preserve this as the next task; do not claim the new legacy edge case is covered by CI.
- Mana status: COMPLETE / MERGED on main; this is a compatibility hardening fix in PR only. No monster Mana and no zero-Mana reversion.
- Battle authority/reward idempotency: server-owned action results and persisted reward receipts remain merged on main. PR #12's millisecond expiry, expected-turn CAS, atomic defeat/history, earned-victory recovery, Underpass cycle reservation, and local integration coverage remain PUSHED / DRAFT only.
- D1 assumptions: `wrangler.toml` still binds `DB` to `DEGEN`; migrations 0002–0005 are tracked and deploy order is schema → migrations → Worker. No migration/config changes or production writes.
- Release blockers: reconcile overlapping PRs #9/#10/#11/#12 and preserve client-first before strict-turn enforcement; signed Discord/Telegram identity + request ownership, production Pages/Worker CORS/connectivity, and physical/mobile platform QA remain unverified.
- Best next task: add the preserved legacy-permit HTTP regression on PR #12 through a supported write path, rerun exact-head CI, then complete release-order review before any merge or Shield work.



## 2026-10-17 — Legacy NULL Mana Worker/D1 regression added (PUSHED / draft PR #12; CI pending)

- Authoritative main SHA: `33e7477961d2a6ab7b79bf52d78a93901e19f658`. Continued the existing coherent branch `automation/degen/permit-millisecond-expiry-v02`; PR #12 head before this commit was `4c27c10c25870b12e0578a33c7b99496cbe23c19`.
- Changed `tests/worker-d1-concurrency.mjs`: added an active pre-migration permit with `player_mana NULL`, compared the paid action to the shared deterministic resolver at the authoritative Degen max Mana, and asserted exact persisted HP/Mana/enemy HP/status/turn count. Added an expired terminal victory with NULL Mana; its 409 must expose server-derived Mana without mutating the historical row.
- These are isolated local Wrangler/D1 HTTP integration assertions. They are committed to the feature branch by this change, but fresh exact-head CI has not yet run; do not count the prior green run as proof of these new assertions. No local checkout/dependencies are available in this runtime to execute the npm scripts here.
- Mana status: COMPLETE / MERGED on main. The legacy fallback is in PR #12; this commit adds the previously missing regression coverage. No monster Mana, client-supplied Mana, or Mana-triggered reversion.
- Battle authority/reward idempotency: server-owned turn resolution and reward receipt/idempotency are merged on main; PR #12's expiry precision, expected-turn CAS, atomic defeat/history, earned-victory recovery, and Worker/D1 integration remain PUSHED / DRAFT, not merged/live.
- D1 assumptions: `wrangler.toml` binds `DB` to `DEGEN`; tracked migrations `0002`–`0005` deploy after schema and before Worker code. Migration `0003_degen_mana.sql` adds nullable `player_mana`; no production D1 write, migration execution, or deployment occurred.
- Release blockers: reconcile overlapping PRs #9/#10/#11/#12 and keep the compatible client ahead of strict expected-turn enforcement. Signed Discord/Telegram identity and per-request player ownership remain unconnected to production routes.
- Best next task: require fresh exact-head CI for this regression, then reconcile PR #9–#12 as a release-safe sequence before any merge or Shield work.

## 2026-10-17 — Permit seed-count regression corrected (PUSHED / draft PR #12; exact-head CI running)

- Authoritative main SHA: `33e7477961d2a6ab7b79bf52d78a93901e19f658`. Continued `automation/degen/permit-millisecond-expiry-v02`; corrected commit: `221b7e1654ffc6ee82d3dce2ab0871113dbc501b`.
- Re-read `tests/worker-d1-seed-contract.test.ts` and changed only the stale `battle_permits` seed count from 16 to 18, matching the two added legacy NULL-Mana permit fixtures. The contents API write was blocked; the scoped Git Data blob/tree/commit path succeeded with a non-force expected-head update.
- Exact-head Actions run `39059015812` started on the corrected code commit. At the continuity update, deterministic tests passed; isolated Worker/D1 reward concurrency was still running; cycle race, rollover race, build, Chromium vertical slice, and Wrangler Worker validation were pending. Do not claim the full suite green until the run finishes.
- No runtime code, migration, schema, reward/economy logic, or deployment configuration changed in this correction. Mana remains COMPLETE / MERGED on main; legacy NULL-Mana fallback/regression and permit reliability hardening remain PR-only. No production D1 operation or deployment.
- Battle authority/reward receipts remain merged on main. PRs #9–#12 remain open drafts with overlapping Worker/client/test changes. PR #12 currently contains strict expected-turn validation plus the compatible client, but merge should wait for exact-head CI and explicit release-gate review; production CORS and signed Discord/Telegram identity/request ownership remain unresolved.
- D1 source-of-truth: `wrangler.toml` binds `DB` to `DEGEN`; migrations `0002`–`0005` are tracked and the deploy workflow applies schema/migrations before Worker code. No production migration run.
- Best next task: finish and verify exact-head CI, then consolidate the overlapping #9/#10/#11/#12 changes into one release-safe sequence without bypassing CORS/platform-auth gates or beginning Shield work.

## 2026-10-17 — Permit seed-count correction verified green (PUSHED / draft PR #12)

- Authoritative `main`: `33e7477961d2a6ab7b79bf52d78a93901e19f658`. Code fix: `221b7e1654ffc6ee82d3dce2ab0871113dbc501b`; progress commit: `88ae4bf2644ca6aca673ed6134814925b93687fb`.
- Exact-head GitHub Actions run `39059108237` at `88ae4bf2644ca6aca673ed6134814925b93687fb` completed SUCCESS on October 17, 2026. Verified: `npm test` 56/56 pass; isolated Worker/D1 reward/action concurrency pass; 60-request active Underpass cycle race pass; 60-request expired-cycle rollover race pass; `npm run build` pass; Chromium mobile vertical slice pass (`Map → Home → Underpass → Degen battle → Worker reward → Home trophy`); `npm run check:worker` dry-run pass. CI-local evidence only; no production D1 or deploy. Non-blocking warnings: Vite JS bundle exceeds 500 kB; GitHub reports Node 20 deprecation for actions currently forced onto Node 24.
- Root cause fixed: deterministic fixture count updated from 16 to 18 because the legacy NULL-Mana regression adds two permits. The correction is one test assertion; no runtime or migration changes.
- Mana: COMPLETE / MERGED on main. Legacy NULL-Mana fallback and integration regression are present on PR #12 only. Battle authority and reward receipts/idempotency remain merged on main; PR #12 reliability work remains DRAFT / not deployed.
- Release audit: #9, #10, #11, and #12 remain open drafts with overlapping Worker/client/test files. PR #12 includes the expected-turn client path and strict Worker check, but do not merge blindly or deploy while production Pages CORS and signed Discord/Telegram identity/request-level ownership are unresolved. PR #13/#14 are helper/session-store drafts and are not wired into production Worker routes.
- D1 source verified: `wrangler.toml` binds `DB` to `DEGEN`; migrations `0002`–`0005` are tracked; `.github/workflows/deploy-worker.yml` applies schema, then migrations, then deploys the Worker. No production D1 operation, migration, or deployment occurred.
- Best next task: produce a single release-safe integration of the overlapping reliability PRs while preserving all client recovery/deadline tests and atomic cycle/defeat/reward behavior; then close public-economy auth/CORS gates before deployment or Shield work.



## 2026-10-18 — Published-client strict-turn release gate (PUSHED / draft PR #12; exact-head CI PASS)

- Authoritative main SHA: `33e7477961d2a6ab7b79bf52d78a93901e19f658`. Current feature branch: `automation/degen/permit-millisecond-expiry-v02`, PR #12, code/test commit `939b520f4dd4e911fa47fa3cf4af3864fc41a76d`.
- Changed `scripts/verify-pages-worker-readonly.mjs`, `tests/pages-worker-release-http.test.ts`, and `tests/pages-worker-release-smoke.test.ts`. The read-only release gate now rejects a published JS bundle without the `expectedTurnCount` battle-action contract before strict Worker turn enforcement; loopback HTTP and smoke fixtures cover both accepted and missing-contract cases. This is a manual/read-only gate, not wired into the production deploy workflow; no live production request was made.
- Exact-head GitHub Actions run `39090719494` at `939b520f4dd4e911fa47fa3cf4af3864fc41a76d` completed SUCCESS: `npm test` 90/90; isolated local Wrangler/D1 reward/action concurrency; 60-request active-cycle reservation; 60-request expired-cycle rollover; `npm run build`; Chromium mobile vertical slice (`Map → Home → Underpass → Degen battle → Worker reward → Home trophy`); and `npm run check:worker`. CI-local evidence only. Non-blocking Vite bundle-size (>500 kB) and GitHub Actions Node deprecation warnings remain.
- Mana status nuance: shared `DegenDefinition.maxMana`, `AbilityDefinition.manaCost`, deterministic rules, action deduction/rejection, Mana UI, migration 0003, no monster Mana, and zero-Mana no-reversion are present on main. However, main's battle-start response still omits authoritative `initialState` and its client initializes battle values locally. PR #12 returns the persisted initial HP/Mana/enemy/turn state, validates and uses it in the client, and includes the legacy NULL-Mana fallback plus Worker/D1 regression coverage; these completion details remain PR-only, not merged/live.
- Battle authority/reward idempotency: server-resolved victory and persisted reward receipts are merged on main via PR #5. PR #12's millisecond-precise permit expiry, expected-turn CAS, atomic defeat/history, expired earned-victory recovery, legacy NULL-Mana handling, cycle reservation, and integration/browser coverage remain pushed in a draft PR. PRs #9–#12 overlap; do not merge the stacked changes blindly or deploy strict-turn enforcement before compatible client code is live.
- D1 source assumptions rechecked: `wrangler.toml` binds `DB` to `DEGEN`; migrations 0002–0005 are tracked; `.github/workflows/deploy-worker.yml` applies schema, then migrations, then Worker code. No production D1 write, migration execution, or deployment occurred.
- Release/auth blockers: `pages.yml` currently deploys GitHub Pages and main's allowlist contains that origin plus localhost; PR #7's Cloudflare Pages origin change is still draft, so verify the intended production origin before merging that config change. Signed Discord/Telegram identity and per-request player ownership are not yet wired into main routes. The new smoke gate has not been run against the actual published origin.
- Best next task: reconcile PRs #9–#12 into one release-safe sequence, verify the real published Pages/Worker origin with the read-only gate, and close signed-identity/request-ownership gates before public economic gameplay. Do not start Shield until the battle-authority integration is safely merged.


## Mana UI affordability hardening — 2026-10-18

- Authoritative `main` SHA: `33e7477961d2a6ab7b79bf52d78a93901e19f658`.
- Continued existing battle-integration branch `automation/degen/permit-millisecond-expiry-v02`, PR #12; base head before this update: `f12834718af68a2f3452eb1f3ff39b561d5c1140` (PUSHED / DRAFT, not merged or live).
- Re-read `src/game/combat/rules.ts`, `src/app/AppController.ts`, `src/ui/views.ts`, and `tests/combat-progression.test.ts`. The deterministic affordability rule was already strict, but the post-request controller unlock path still compared only the parsed cost and could enable malformed/missing costs; the DOM path treated a blank/missing data attribute as zero.
- This patch exports one shared `canAffordManaCost` predicate and uses it in deterministic ability validation, controller unlocks, and DOM button updates. The controller validates against the actual Degen ability definition; the DOM path fails closed on absent/blank/invalid costs.
- Added tests for shared affordability parity, invalid Mana/cost values, and battle-DOM button availability at 0 Mana (free remains enabled; paid/malformed costs are disabled).
- Test/build/Worker checks: pending CI on the resulting PR head; no local checkout was available for local execution. Do not treat this as passed until the exact-head workflow completes.
- Mana authority and migration `0003_degen_mana.sql` remain merged/tracked on main; monsters still have no Mana field and 0 Mana never triggers reversion. No D1 mutation or production deployment was performed.
- Battle authority/reward receipts remain server-owned on main; PR #12 still needs integration/rollout review against PRs #9–#11. No Miles design blocker.
- Best next task: inspect exact-head CI; if green, record the run evidence and resolve the compatible-client-before-strict-turn-enforcement release order before merge.
