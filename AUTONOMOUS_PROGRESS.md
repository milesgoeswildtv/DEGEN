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


## Underpass cycle CAS — 2026-10-09 (PUSHED / CI PENDING)
- Main: `33e7477961d2a6ab7b79bf52d78a93901e19f658`; feature branch `automation/degen/underpass-cycle-cas-v01`; code/test head `c807c0a5b60f328441080540719cc0d0caaf2104`, no PR or deployment.
- Files: `worker/index.ts` conditionally inserts an Underpass cycle with atomic SQLite INSERT/RETURNING; concurrent losers reload the existing cycle. `tests/underpass-cycle-race.test.ts` executes SQL extracted from Worker source, testing stale concurrent reads, rollover, fractional expiry and other event types. `.github/workflows/ci.yml` temporarily gates feature-branch pushes.
- QA: equivalent local SQLite tests 4/4 PASS; full CI run `37884407278` pending at time of writing. No claim of live Worker or remote D1 verification.
- Mana COMPLETE/MERGED on main, Degen-only, no depletion reversion; reward idempotency/battle authority unchanged by this world-event fix. Existing D1 binding/migrations unchanged, no schema or production DB changes.
- Blockers: combined-combat draft PR creation rejected after independent retry; Discord/Telegram authenticated identity still required before public economy. An intermediate incomplete-tree CI commit was corrected by fast-forward restoration; verify final head only.
- Next: verify exact-head CI, fix any regression, obtain reviewed PR; continue platform authentication and combat PR delivery.


## 2026-10-14 — Underpass cycle reservation and integration evidence

- Authoritative main SHA: `33e7477961d2a6ab7b79bf52d78a93901e19f658`.
- Current delivery: PR #11, branch `automation/degen/underpass-cycle-cas-v01`, code head `237585befbdf3204a37167e3923d30fa3f03bdc8`; open draft, not merged or live.
- Scoped files: `worker/index.ts` reserves the active Underpass cycle with a conditional SQLite `INSERT ... SELECT ... WHERE NOT EXISTS ... RETURNING`; concurrent losers reload the winning cycle. Added source-extracted SQL tests, a 60-request isolated Wrangler/D1 HTTP race test, and a CI gate for that integration test.
- Exact code-head CI run `38109013799` succeeded: deterministic tests, isolated Worker/D1 reward concurrency, isolated Worker/D1 cycle concurrency, Vite/TypeScript build, and Wrangler Worker dry run. This documentation-only follow-up still needs exact-head CI before the PR is marked ready.
- Mana remains COMPLETE / MERGED on main: Degen-only max Mana/costs, authoritative persisted player Mana, rejection without state advance, exact paid deduction, zero-cost use at zero, and no reversion or monster Mana. Reward receipt/idempotency is also merged on main; PR #12 holds broader permit/action/completion integration work but overlaps the client-first and strict-turn branches.
- D1 assumptions: existing `DB` binding and `DEGEN` database in `wrangler.toml`; tracked migrations 0002–0005 run after schema application and before Worker deployment. This slice adds no migration, performs no remote D1 write, and does not claim a production deployment.
- Miles blocker unchanged: signed Discord/Telegram identity and per-request ownership remain required before public economic gameplay; live Pages/Worker behavior is not verified.
- Best next task: review and sequence PR #10's compatible client before PR #9's strict expected-turn enforcement, then reconcile overlapping integration tests rather than merging cumulative PR #12 blindly.


## 2026-10-14 — Concurrent Underpass rollover follow-up (PUSHED / PR; CI GREEN)
- Authoritative main SHA: `33e7477961d2a6ab7b79bf52d78a93901e19f658`.
- Current delivery: PR #11, branch `automation/degen/underpass-cycle-cas-v01`, exact tested head `c5de4d0694390295eec5833f3a29affbf9694eac`; open draft, not merged or live.
- Files changed in this follow-up: `.github/workflows/ci.yml` adds the rollover harness to the CI gate; `tests/worker-d1-cycle-rollover.mjs` seeds an expired Underpass cycle in isolated local D1, sends 60 simultaneous Worker HTTP world requests, and asserts every response converges on one successor with exactly two historical rows and one active cycle; this file records the verified outcome.
- Exact-head GitHub Actions CI run `38625346808` succeeded on 2026-10-14: deterministic tests, isolated local Worker/D1 reward concurrency, initial cycle-creation race, expired-cycle rollover race, TypeScript/Vite production build, and Wrangler Worker dry run all PASS.
- Mana remains COMPLETE / MERGED on main: Degen-only max Mana/costs, authoritative persisted player Mana, unaffordable-action rejection without turn advance, exact paid deduction, zero-cost use at zero, and no monster Mana or depletion reversion.
- Battle authority and reward receipt/idempotency remain merged on main. This follow-up changes no combat, reward, or economic runtime code.
- D1 assumptions: existing `DB` binding, `DEGEN` database, and tracked migrations 0002–0005 remain unchanged; the harness uses Wrangler local persistence only. No remote D1 write or deployment.
- Miles blocker: signed Discord/Telegram identity and per-request ownership remain required before public economic gameplay; deployed Pages/Worker browser behavior remains unverified.
- Best next task: review PR #10's client-first compatibility and its exact-head CI, then sequence PR #9's strict expected-turn enforcement only after the compatible frontend release gates are satisfied. Do not merge overlapping PR #12 cumulatively without reconciling its differing expiry/recovery expectations.

## Latest verified run — 2026-10-23 (Mana integrated; Underpass cycle-race continuation)

- Authoritative main is now `299a1f9a97b4f74e8b37e2bb7e3eea52cb28b399`: PR #15 was squash-merged after exact-head CI run `39918929462` passed on `3b020b2a1c2eb5113567d692046f49ba7b4a3d56` (45/45 tests, isolated local Worker/D1 concurrency/replay harness, Vite build, Wrangler Worker dry-run).
- Mana rollout is MERGED on main: Worker battle start returns the same initial HP/Mana/enemy/turn state it persists; client validates initial and successful action snapshots; expected-turn preconditions prevent stale replay; migration `0006_backfill_active_battle_mana.sql` backfills only eligible, active, unexpired legacy Underpass permits with complete live HP state and null Mana.
- Migration sequence rechecked against live branch paths: Mana `0006`, session store PR #14 `0007_player_sessions.sql`, Shield branch `0008_degen_shield.sql`. Do not merge broad PR #12 independently because it overlaps the already-merged Mana backfill and client/Worker files.
- Continuing the existing coherent Underpass cycle-CAS PR #11 on `automation/degen/underpass-cycle-cas-v01`; this branch is 12 commits ahead and one commit behind the new main. Its intended diff is limited to atomic cycle reservation in `worker/index.ts`, focused cycle-race/rollover tests, CI harness steps, and this continuity record. No duplicate branch created.
- D1 source of truth remains `wrangler.toml`: binding `DB`, database `DEGEN`, migration directory `db/migrations`; deploy workflow order remains schema → tracked migrations → Worker. The merge is expected to trigger the Worker deployment workflow because it changes Worker and D1 files, but the available Actions connector exposes only PR-triggered runs, so the push-triggered production deployment result is NOT YET VERIFIED. Do not claim LIVE until the deployment run is inspected.
- Reward receipts/claim recovery remain merged from PR #5. Current next reliability slice is the atomic Underpass cycle reservation/rollover race, followed by endpoint-level duplicate completion/concurrent action-completion integration coverage.
- Public economic release still requires signed Discord/Telegram identity verification and per-request player ownership; caller-supplied `playerId` is not authenticated identity.
- Best next task: refresh PR #11 CI against current main; review its atomic insert/read-winner behavior and 60-request D1 cycle/rollover harness; merge only if exact-head checks pass, then verify the production deployment through a run-status surface that includes push-triggered workflows.
