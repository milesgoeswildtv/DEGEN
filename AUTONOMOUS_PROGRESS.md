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
