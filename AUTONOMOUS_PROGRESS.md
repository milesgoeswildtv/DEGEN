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

## Optional Worker turn-precondition continuation — 2026-10-08
- Authority check: main `33e7477961d2a6ab7b79bf52d78a93901e19f658`; feature branch `automation/degen/battle-turn-client-v01` (PUSHED only, not PR/merged/live).
- This branch now includes `worker/index.ts` opt-in `expectedTurnCount` validation, CAS against the submitted turn, and Worker-owned `battleState` in 409 conflict responses. Existing clients without the field still work during the client-first rollout; mandatory enforcement is NOT enabled yet.
- Added `tests/worker-battle-turn-precondition.test.ts` covering sequential replay, concurrent actions, Mana, zero-cost abilities, killing-blow/defeat recovery, expired/invalid permits, and legacy compatibility. Client `src/app/AppController.ts`, `src/app/api.ts`, `src/game/combat/engine.ts`, and `tests/battle-client-recovery.test.ts` remain part of this coherent slice.
- Degen-only Mana: COMPLETE/MERGED on main; no monster Mana or automatic reversion. Reward idempotency/recoverability: MERGED on main; atomic defeat/history reliability remains a separate pushed branch awaiting PR/merge.
- QA: source-level verification confirmed the new Worker guard and test file on the remote feature branch; full `npm test`, `npm run build`, `npm run check:worker`, CI on this exact head, and live Worker/D1 tests are still REQUIRED and must not be claimed as passed.
- Deployment/schema: no D1 migration, deployment config, remote D1 write, or production deploy in this slice. Existing D1 bindings/migrations remain unchanged; migration-before-Worker ordering stays in place.
- Delivery blocker: draft PR creation rejected twice, and branch-specific CI-trigger update rejected twice. No Miles design blocker.
- Best next task: obtain full CI and real local Wrangler/D1 QA on this branch, deliver a reviewed PR, deploy compatible client first, then enforce mandatory turn preconditions in a separate Worker rollout.

### Replay QA / local D1 harness — 2026-10-08
- Branch `automation/degen/battle-turn-client-v01` now contains `tests/worker-d1-turn-replay.test.ts` for real local Wrangler/D1 HTTP coverage; PUSHED, not yet executed in real Wrangler.
- LOCAL reconstructed-source SQLite/VM QA passed 22/22 cases, including 64 concurrent same-turn requests, 100 sequential retries, zero-Mana free ability, terminal recovery, invalid expected counts, and legacy clients. An initial local test-fixture adapter error was corrected; not a production failure.
- `npm test`, `npm run build`, `npm run check:worker`, and full CI on this exact branch head remain REQUIRED. CI trigger and PR creation were each rejected twice. No production deploy, migration, or D1 write.
- Mana/reward authority remain merged on main; atomic defeat reliability is a separate unmerged branch. Best next task: reviewed PR and full CI/local Wrangler, then client-first deployment and later mandatory Worker enforcement.

### Extended Worker/D1 integration coverage — 2026-10-08
- Additional PUSHED test commits cover full/reduced Underpass reward tiers, level-up and duplicate completion receipts, and concurrent killing-blow/completion races in `tests/worker-d1-turn-replay.test.ts`. Real Wrangler/D1 execution remains PENDING.
- LOCAL reconstructed-source QA: 22/22 Worker/Mana, 16/16 client/compatibility, 16/16 replay stress passed, plus isolated TypeScript validation. Removing the turn precondition intentionally failed the replay regression; restoring it passed. These are not full-repository CI.
- Branch remains PUSHED only, without PR/merge/deployment. Legacy requests still permit sequential replay until mandatory enforcement follows the compatible client rollout. No schema, migration, config, or remote D1 changes.
- Next: PR, full CI with actual local Wrangler/D1, build and Worker dry-run, review integration with atomic-defeat branch, client-first deployment, then mandatory server enforcement.

### Forced CAS interleaving regression — 2026-10-08
- PUSHED `tests/worker-battle-turn-precondition.test.ts` deterministic hook that mutates the authoritative permit between SELECT and CAS; stale action must return 409 with freshly re-read HP/Mana/enemy HP/turnCount and must not apply a second action.
- LOCAL reconstructed-source test suite with exact main schema/migrations/shared rules: 23/23 passed. Separate reconstructed atomic+optional-turn integration: 25/25 passed. Neither replaces full CI or real Wrangler/D1.
- Latest current branch must still pass `npm test`, `npm run build`, `npm run check:worker`; PR creation remains blocked and no merge/deploy/D1 mutation occurred.

### Battle start Mana integration — 2026-10-08
- PUSHED addition to `tests/worker-d1-turn-replay.test.ts`: seeds an open Underpass cycle, calls real Worker `GET /api/world/underpass` and `POST /api/battle/start`, then verifies first action uses server-initialized 12 Mana/120 HP/92 enemy HP (after Crack: 8 Mana, 110 HP, 57 enemy HP). Test has NOT run under real Wrangler/D1 yet.
- No runtime balance/schema change. Full CI and PR remain pending; local reconstructed-source CAS tests passed 23/23.

### CI-verified battle turn continuation (2026-10-08)
- Main: 33e7477961d2a6ab7b79bf52d78a93901e19f658. Branch: automation/degen/battle-turn-client-v01 at cd307e93ea928c61facd30c7abd909377475d4ee (PUSHED, not merged/live; no PR).
- New tests/worker-d1-turn-replay.mjs and CI workflow gate: actual local Wrangler/D1 expected-turn replay, Degen Mana, free action, victory, defeat, duplicate completion.
- CI 37860471584 SUCCESS: 45 tests, local D1 reward + turn-replay harnesses, build, Worker dry-run.
- Mana and reward authority MERGED on main; atomic defeat separate green branch. No monster Mana/reversion, no remote D1/deploy, tracked migrations unchanged.
- Blockers: PR creation safety rejection; unverified platform identity. No Miles design blocker.
- Best next task: PR review, reconcile atomic/client Worker changes, deploy client first, then require turn preconditions.

### Final local D1 battle-start verification — 2026-10-08
- Main: 33e7477961d2a6ab7b79bf52d78a93901e19f658; branch head 6d6857971c4b3a84f8a20f82549a716ad42cac90 before this note. PUSHED, no PR/merge/live.
- tests/worker-d1-turn-replay.mjs now verifies real Worker GET world event -> POST battle start -> server-initialized 12 Mana/120 HP/92 enemy HP -> Crack turn (8 Mana, 110 HP, 57 enemy HP), plus D1 persistence after Worker stop. Existing replay/reward cases remain.
- CI 37860877938 SUCCESS: 45 tests, local Wrangler/D1 reward and battle integration, npm run build, npm run check:worker. No remote D1 or mobile proof.
- Mana merged; no monster Mana/reversion. Reward authority merged; atomic defeat separate green branch. Migrations and D1 binding unchanged. PR creation and platform authentication remain blockers; no Miles design blocker.
- Best next task: reviewed PR delivery, reconcile atomic/client Worker changes, deploy client before mandatory expected-turn enforcement.

## Integrated battle authority — 2026-10-08 EDT (PUSHED; CI pending)
- Main SHA: `33e7477961d2a6ab7b79bf52d78a93901e19f658`. Branch `automation/degen/battle-turn-client-v01`, integrated head `f41464cd9b93aea146cd85354d8e52a8f510ef92`; no PR/merge/deploy.
- Changes: `worker/index.ts` now commits terminal defeat turn CAS and deterministic defeat history atomically, preserving optional expected-turn validation, conflict snapshots, exact Degen Mana, and no monster Mana. Imported `tests/worker-defeat-atomic.test.ts` and `tests/worker-d1-defeat-atomic.mjs`; updated `.github/workflows/ci.yml` to gate the real local Worker/D1 defeat test.
- QA: existing atomic and client-first branch CI green separately. Fresh combined-head CI run `37879795313` queued at time of note; not yet claimed passing. Run `npm test`, `node tests/worker-d1-defeat-atomic.mjs`, `node tests/worker-d1-turn-replay.mjs`, `npm run build`, `npm run check:worker`.
- Mana: COMPLETE/MERGED on main; no reversion at 0 Mana, zero-cost abilities remain usable. No balance or D1 schema changes.
- Reward authority: merged receipt/idempotency baseline unchanged. Earned-victory expiry recovery separate branch `automation/degen/earned-victory-recovery-v01` head `4c4abcdbbe4b31ac8229f11a0cf64ef195dea001`, CI green, unmerged.
- D1: existing `wrangler.toml` binding and migrations 0002–0005 remain authoritative; schema/migrations run before Worker deploy. No production D1 writes.
- Blockers: GitHub draft PR creation rejected after independent retry; client expected-turn enforcement remains optional until compatible client rollout; Discord/Telegram identity bootstrap still trusts client identifiers.
- Best next task: inspect combined CI, fix any failing Worker/D1 regression, deliver draft PR for review, then reconcile earned-victory branch on top without losing defeat/turn protections.

### Integrated battle-authority CI — VERIFIED 2026-10-08 EDT
- Head `b47bf5f0856bd1f692785864980561fc26c22ac6` (PUSHED feature branch only; not PR/merged/live). `tests/worker-battle-turn-precondition.test.ts` now models D1.batch with a real SQLite transaction and per-statement RETURNING rows, preserving race injection and rollback.
- GitHub Actions run `37879858086` SUCCESS on this exact head: **55/55 Node tests**, isolated Worker/D1 reward concurrency, local Worker/D1 turn replay, local Worker/D1 atomic defeat expiry/rollback/retry, `npm run build`, and `npm run check:worker` all green.
- Earlier intermediate heads failed because the isolated SQLite adapter lacked `DB.batch`; this is fixed on the green head. No production deployment, migration, or live D1 mutation.
- Main remains `33e7477961d2a6ab7b79bf52d78a93901e19f658`; Mana complete/merged and player-only; rewards server-owned. Earned-victory expiry recovery is separate and green, not yet integrated. PR creation rejected after independent retry.
- Best next task: reviewed PR delivery for this combined branch, then reconcile earned-victory reward recovery and retest all authority paths. Authenticated platform identity remains the public-economy blocker.

## Complete combat reliability integration — 2026-10-08 EDT (PUSHED / CI GREEN, NOT MERGED)
- Authoritative main SHA: `33e7477961d2a6ab7b79bf52d78a93901e19f658`. Feature branch `automation/degen/battle-turn-client-v01`, runtime/test head `0dd7dd970b972f333eb4a3491cbb00a572f11797`.
- Changed this integration: `worker/index.ts` combines optional expected-turn CAS, authoritative conflict recovery, atomic terminal defeat/history, and earned-victory expiry recovery; `tests/worker-battle-turn-precondition.test.ts` transactional SQLite adapter; imported `tests/worker-defeat-atomic.test.ts`, `tests/worker-d1-defeat-atomic.mjs`, `tests/reward-authority.test.ts`, and `tests/worker-d1-concurrency.mjs`; `.github/workflows/ci.yml` gates both turn-replay and atomic-defeat real local Worker/D1 suites.
- **Verified GitHub Actions CI run `37880096422` SUCCESS on exact runtime/test head:** 55/55 Node tests; local Worker/D1 earned-victory after permit expiry, concurrent claims/replay/reward tiers/level-up; local Worker/D1 turn CAS, Mana and persisted state; local Worker/D1 atomic defeat expiry, paid/free rollback/retry/no rewards; `npm run build` and `npm run check:worker` green.
- Mana: COMPLETE/MERGED on main. Exact player-only Mana, free action at 0 Mana, no monster Mana and no reversion; prototype costs unchanged. No D1 schema, migration, reward balance, or framework changes.
- Reward authority: merged receipt/idempotency baseline retained; earned victory after permit expiry now integrated on this feature branch, **not merged/live**. No production D1 mutations or deployments. Tracked D1 migrations 0002–0005 remain applied before Worker deploy, existing binding unchanged.
- Blockers: draft PR creation rejected twice for combined branch and twice for standalone earned branch; no PR. Mandatory expected-turn enforcement awaits compatible client deployment. Discord/Telegram identity bootstrap remains unauthenticated and can reassign identities; block public economy. Underpass cycle-generation race remains unfixed.
- Best next task: obtain reviewed PR delivery of this green combined branch, verify exact final head CI, and fix authenticated platform identity before public economic gameplay. Do not merge/deploy without review.

## 2026-10-09 — mandatory turn precondition hardening (feature branch)
- Authority: main `33e7477961d2a6ab7b79bf52d78a93901e19f658`; branch `automation/degen/battle-turn-client-v01` at `b529d5f05e81031745a391fccfe1f7f1efb8eb9a` before this change; draft PR #9.
- Scope: `worker/index.ts` rejects absent, null, negative or invalid `expectedTurnCount` with HTTP 400; stale but well-formed turns remain HTTP 409 with authoritative snapshot. Removed fallback CAS values that allowed old clients to issue additional actions on retry. `tests/worker-d1-turn-replay.mjs` adds real HTTP negative controls.
- Mana: merged on main; server persists player Mana; zero-cost actions remain available at 0 Mana; no monster Mana or automatic reversion. No balance change.
- Reward authority: PR #9 atomic defeat/reward recovery preserved. Client already sends `expectedTurnCount`; older clients omitting it must update before battle actions work.
- Migration: existing tracked 0002–0005; no new migration, config, remote D1 operation, or deployment in this change. Workflow migrates before Worker deployment.
- QA: pending fresh feature-head GitHub CI and real local Worker/D1 test after commit. No local repository clone available in this execution environment.
- Miles blocker: public economy requires verified Discord/Telegram authentication and request-level authorization; unrelated staged auth changes are not merged.
- Next: verify CI at exact new head and review PR #9 before merging; keep public economy gated.
- Status: planned GitHub object commit; not MERGED/LIVE.

## 2026-10-09 — PR #9 deterministic CI fixture repair (feature branch)
- Authoritative main: `33e7477961d2a6ab7b79bf52d78a93901e19f658`. Existing draft PR #9 branch `automation/degen/battle-turn-client-v01`, previous head `fe3b8b939c2b243326870086366c2247ebd3577e`.
- Scope: mandatory `expectedTurnCount` numeric type guard in `worker/index.ts`; update precondition and atomic-defeat test request helpers; update local Worker/D1 legacy-client expectations to 400. No combat balance, reward calculation, schema, deployment config, or runtime behavior change beyond explicit type guard.
- Prior CI on `fe3b8b939c2b243326870086366c2247ebd3577e`: 33/55 Node tests passed; 22 failed due outdated test fixtures. New-head CI must verify `npm test`, local Worker/D1 concurrency/replay/defeat, `npm run build`, and `npm run check:worker`; no live/mobile proof.
- Degen-only Mana: COMPLETE/MERGED on main; player-only, paid ability deducted once, free abilities usable at 0, no reversion. Reward receipt/idempotency: MERGED on main; PR #9 atomic defeat/earned-victory recovery unmerged.
- D1: existing `wrangler.toml` binding; tracked migrations 0002–0005 applied before Worker deploy. No production D1 write or deployment.
- Miles blocker: platform-authenticated account identity and request-level authorization required before public economy.
- Best next task: inspect exact-head PR #9 CI, repair any remaining failures, then review PR diff and deploy compatibility in safe order; do not merge until green.
- Status: this note accompanies proposed feature-branch repair; not merged/live.

## 2026-10-09 — PR #9 Worker/D1 fixture follow-up (feature branch)
- Main SHA: `33e7477961d2a6ab7b79bf52d78a93901e19f658`; branch `automation/degen/battle-turn-client-v01`, PR #9 draft.
- Changed two isolated Worker/D1 integration fixtures to submit `expectedTurnCount: 0` for server-seeded turn-zero permits; no gameplay/economy/schema changes.
- Prior CI on `3774b0c2`: deterministic 55/55 PASS; Worker/D1 concurrency FAIL 400 at action fixture; later jobs skipped. Exact new-head CI required to verify Worker/D1 concurrency, replay, atomic defeat, web build, Worker check.
- Mana COMPLETE/MERGED on main; reward receipt/idempotency MERGED; atomic defeat and earned-victory recovery PR-only.
- D1 schema/migrations remain tracked; no remote D1 operations or deployments in this run.
- Miles blocker: public economic routes still need authenticated platform sessions; client-first deployment required for mandatory turn preconditions.
- Best next task: inspect new-head CI, fix any real regression on same branch, then review PR #9 before merge.

## 2026-10-09 — Green CI / client-first dependency
- Main `33e7477961d2a6ab7b79bf52d78a93901e19f658`; PR #9 `b5b5526c9f0f245cec04524e551351ccf7d370c8` PUSHED/draft, unmerged.
- Changed: two local Worker/D1 fixtures now pass `expectedTurnCount: 0`; no gameplay, DB, or config changes.
- CI runs 37967744093 and 37967739698 SUCCESS: 55 Node tests, Worker/D1 reward concurrency, turn replay, atomic defeat, web build, Worker check. No mobile/live proof.
- Mana COMPLETE/MERGED on main; reward receipt/idempotency MERGED; atomic defeat/earned victory PR-only.
- D1 binding/config unchanged; tracked migrations applied before Worker; no production D1 operations.
- Client-first branch `automation/degen/battle-client-first-v01` PUSHED at `cf9c99763380f1f06b33a9b9ec68f04d26d4140c`, PR creation blocked twice. Client must deploy before mandatory Worker enforcement.
- Miles blocker: verified Discord/Telegram sessions and economic-route authorization before public play.
- Next: deliver client-first PR, verify browser requests/CI, then review PR #9 deployment order.
