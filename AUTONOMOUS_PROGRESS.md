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
- Current integration candidate: PR #12, branch `automation/degen/permit-millisecond-expiry-v02` (**PUSHED / DRAFT**, not merged or deployed). Latest CI-verified head: `17d0662ab9f7b65c8a309655f3b285852865ac17`; the current follow-up is continuity documentation only.
- PR #12 carries millisecond-precise permit expiry, expected-turn CAS, authoritative initial battle state, atomic defeat/history writes, earned-victory recovery after expiry, Underpass cycle reservation, and Worker/D1 concurrency + vertical-slice coverage. It overlaps PRs #9, #10, and #11; do not merge it blindly.
- Exact-head CI runs `38565545387` on code/test commit `87f097f8bcdb18b1c25f7c5c4cb7bafa4abf5166` and `38565825497` on continuity commit `17d0662ab9f7b65c8a309655f3b285852865ac17` both completed SUCCESS. All nine CI steps passed: deterministic tests, isolated local Wrangler/D1 reward/action integration, isolated 60-request cycle-race integration, TypeScript/Vite build, and Wrangler Worker dry run.

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
- CI run `38565545387` passed after the new test commit; run `38565825497` also passed all nine steps at `17d0662ab9f7b65c8a309655f3b285852865ac17`. The latest change in this file is continuity-only and does not alter tested runtime or test logic.
- Mana remains COMPLETE / MERGED; no monster Mana or zero-Mana reversion. Battle authority and reward idempotency remain server-owned. D1 migrations 0002–0005 are tracked and deployment order is schema → migrations → Worker. No production DB writes/deployment.
- Release blockers: PR #9/#10/#11 integration order, signed Discord/Telegram identity and per-request ownership, production Pages CORS/API connectivity, and real browser/mobile/platform QA.
- Best next task: verify exact-head CI, then perform a line-by-line integration review of PR #12 against #9/#10/#11 before any merge; do not begin Shield until this reliability slice is integrated safely.
