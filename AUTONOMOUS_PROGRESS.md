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

## 2026-10-09 — Client-first battle compatibility (PUSHED, no PR)
- Authoritative main `33e7477961d2a6ab7b79bf52d78a93901e19f658`; branch `automation/degen/battle-client-first-v01` created from exact main. Source client changes extracted from combat PR #9, no competing rules.
- Changed `src/app/AppController.ts`, `src/app/api.ts`, `src/game/combat/engine.ts`, `tests/battle-client-recovery.test.ts`: send `expectedTurnCount`, recover stale Worker state, avoid duplicate client Mana damage and rewards.
- Same client files pass in PR #9 CI at `b5b5526c9f0f245cec04524e551351ccf7d370c8` (runs 37967744093/37967739698). This branch has NO independent CI because PR creation was rejected twice and push CI only targets main/PR.
- Mana COMPLETE/MERGED on main; reward receipt/idempotency MERGED; atomic defeat and earned-victory recovery remain PR #9 only.
- No D1/schema/config changes. Deployment migrations tracked before Worker; no production D1 or deployment operation.
- Miles blocker: authenticated Discord/Telegram identity and economic-route authorization before public gameplay. Client-first release must precede mandatory Worker turn enforcement.
- Best next task: open client-first PR when permitted, verify CI and deployed client behavior, then review/merge PR #9 only after compatible clients are live.

### Client-first legacy Worker HTTP compatibility (STAGED/PUSH TARGET)
- Added a seeded active permit and real local Worker/D1 action in `tests/worker-d1-concurrency.mjs` with `expectedTurnCount: 0`, verifying existing permissive Worker accepts the future client request and returns turn 1 / Mana 8. Requires independent PR CI; no deployed verification.

## 2026-10-09 — Server-world fail-closed regression (PUSHED / no PR)
- Main authority: `33e7477961d2a6ab7b79bf52d78a93901e19f658`. Branch: `automation/degen/battle-client-first-v01`, from main. Client-first PR creation rejected twice; no PR, merge or deployment.
- Fix: `src/app/AppController.ts` no longer substitutes an untrusted local preview cycle when an enabled Worker world-event request fails. Previously open server state is cleared, so the entry control cannot advertise a fake open event. Preview remains available only when the backend is intentionally disabled.
- Tests: `tests/world-sync-authority.test.ts` adds four controller-level cases for failure, previously open state, preview-only mode, and successful server sync. A narrow local fixture reproduced 2/4 failures before the fix and 4/4 passes afterward; full-repository CI and browser QA on this branch remain unverified.
- Degen Mana remains COMPLETE / MERGED on main; no monster Mana or reversion. Reward idempotency/recoverability is merged on main. PR #9 is green but draft/unmerged, and must not deploy Worker turn enforcement ahead of the compatible frontend.
- D1/migration: no schema/config edits in this slice; tracked migrations still precede Worker deployment. Production D1 untouched. Authentication/authorization is a public-economy blocker.
- Best next task: obtain client-first PR/CI, verify the new test against full source and local Worker/D1, then stage frontend-first rollout before PR #9 Worker enforcement.

### Follow-up: overlapping world-event request ordering (PUSHED / no PR)
- Source: `src/app/AppController.ts` now ignores older success/failure responses after a newer world-event refresh begins, preserving the latest server result or fail-closed state. No new persistent state, D1 schema, gameplay rules, or economics.
- Added two deferred-request ordering regressions to `tests/world-sync-authority.test.ts`. Narrow local controller fixture: 4/6 passed before generation guard; 6/6 passed afterward. Full repository/Worker CI not independently run on client-first branch.
- Main remains `33e7477961d2a6ab7b79bf52d78a93901e19f658`; PR #9 green/draft/unmerged; frontend-first deployment prerequisite unchanged. Production D1 untouched.
