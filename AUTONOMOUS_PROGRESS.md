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

## 2026-10-16 — Shield foundation implementation (PUSHED branch; PR creation blocked)
- Authoritative `main` SHA: `33e7477961d2a6ab7b79bf52d78a93901e19f658`. Shield work is on `automation/degen/shield-foundation-v01`, commit `de9df44a44cc0e3247e785f98b2a9d75132e0969` (PUSHED; not merged or live). Two normal PR-creation attempts were rejected by runtime safety checks; no duplicate branch was created.
- Files changed: `src/domain/types.ts`, `src/game/combat/rules.ts`, `src/game/combat/engine.ts`, `src/ui/views.ts`, `worker/index.ts`, `db/migrations/0006_degen_shield.sql`, `tests/combat-progression.test.ts`, `tests/degen-shield-migration-deploy-order.test.ts`, `tests/worker-shield-integration.mjs`, `tests/browser-worker-vertical-slice.mjs`, `.github/workflows/ci.yml`.
- Shield behavior: optional bespoke `AbilityDefinition.shieldGain`; temporary player-owned Shield absorbs incoming retaliation before HP; unused Shield persists between turns and is consumed by damage. Battle start initializes Shield to zero. Worker loads and conditionally persists `player_shield` with the existing turn-count CAS and returns `playerShield` / `shieldAbsorbed`. No prototype ability, monster resource, or balance value was added.
- Tests added: deterministic Shield absorption and killing-blow tests; migration/deploy-order guard; isolated local Wrangler/D1 test for start-at-zero, Shield absorption, and persisted HP/Shield; CI now runs the mobile Chromium/Vite/Worker/D1 vertical slice and asserts the visible Shield label. These checks are pending CI because the draft PR could not be created.
- Mana: COMPLETE/MERGED on `main`, Degen-only; paid costs remain authoritative, free abilities work at 0, no monster Mana or depletion reversion. Reward receipt/idempotency remains merged on main.
- Separate client-first branch `automation/degen/battle-client-first-v01`, PR #10, now has test commit `9ae3c834795212d0379965102edc68782a9b9f01` PUSHED and CI run `38817891813` SUCCESS: 94/94 deterministic tests, isolated Worker/D1 HTTP integration, Vite build, Chromium browser vertical slice, and Worker validation passed. PR #10 remains draft/unmerged.
- D1: `0006_degen_shield.sql` is tracked on the Shield branch; `wrangler.toml` binding remains unchanged. Existing deployment workflow applies schema and migrations before Worker code. No production D1 operation, merge, or deployment.
- Battle authority/reward status: main retains server-owned battle state and idempotent reward receipts. PR #9 mandatory turn enforcement/atomic defeat remains unmerged; do not release it ahead of compatible client-first behavior. Signed Discord/Telegram identity and request-level authorization, production Pages CORS, and live embedded gameplay remain release blockers.
- Best next task: reopen the Shield PR through an available supported path, then inspect fresh CI and fix any deterministic, Worker/D1, build, or browser failures before review.
