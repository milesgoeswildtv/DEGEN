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


## Production continuation — 2026-10-08 (latest)
- **Authoritative main:** `33e7477961d2a6ab7b79bf52d78a93901e19f658`. No direct writes to main.
- **Mana:** COMPLETE / MERGED. `DegenDefinition.maxMana`, `AbilityDefinition.manaCost`, shared turn resolution, Worker-owned permit Mana, zero-cost ability behavior, unaffordable rejection, and 0-Mana no-reversion remain unchanged. Monsters have no Mana.
- **Reward authority:** PR #5 MERGED on main; receipt state, claim-token guards, D1 integration harness and migrations 0004/0005 are in main. No new reward-economy changes this run.
- **PUSHED / PR #7:** `automation/degen/cloudflare-pages-origin-v01` head `8d0644f4e2d0811672fbf972cb05b0d819b0c44b`. Production Pages CORS origin plus 3 config regression tests. CI `37786096716` SUCCESS. Draft, not merged/deployed.
- **PUSHED / PR #8 (this branch):** `automation/degen/housing-reliability-v01` head before this progress commit `e153db65dce51ca6ce401833add2180bd1c8e861`. Changed `worker/index.ts`, `src/app/state.ts`, and added `tests/housing-bootstrap-seed.test.ts`, `tests/housing-save-order.test.ts`. New players seed a starter bed only once; an intentionally empty room survives bootstrap; serialized/coalesced saves prevent out-of-order housing writes. CI `37786346034` SUCCESS (repository npm tests, local Worker/D1 harness, build, Worker dry-run). Draft, not merged/deployed.
- **PUSHED / PR #6:** `automation/degen/city-navigation-v01` head `98cba204a3b3b34f7ea7e699cd015823d751a138`. Added tappable isometric district location pins, mobile viewport resize observer lifecycle and reset, plus deterministic tests. CI for this new head pending; visual art remains a noncanonical technical scaffold. No live mobile/Safari/Telegram verification.
- **D1 assumptions:** Existing `wrangler.toml` DB binding is authoritative. Migrations 0002–0005 are tracked; deploy workflow applies schema then migrations before Worker code. No remote D1 writes, schema changes, or production deployment this run.
- **QA evidence:** PR #7 and #8 full GitHub CI success as cited. City new head awaits full CI and running-app/mobile visual QA; local fixture evidence from earlier handoff is not live proof. Container cannot clone GitHub (DNS unavailable); GitHub Actions is the actual full-repo validation.
- **Miles blockers:** No new design decisions needed. Merge/deployment remains a review gate; do not represent draft PRs as live.
- **One best next task:** Inspect fresh PR #6 CI, fix any failing city regression, and verify its actual mobile navigation/interaction before review/merge. After that, review PR #7 and #8 for safe merge/deployment sequencing.


### Follow-up QA and branch handoff — 2026-10-08
- Main remains `33e7477961d2a6ab7b79bf52d78a93901e19f658`; no direct main writes, merges, or production Worker/D1 deployments.
- PR #6 city head `98cba204a3b3b34f7ea7e699cd015823d751a138`: CI `37786640200` SUCCESS, 36/36 Node tests, isolated Worker/D1 harness, Vite build, Worker dry-run; Cloudflare Pages preview deployed successfully. Mobile Safari/Telegram and actual running-app interaction are still **not** verified; the city remains scaffold art.
- PR #7 CORS head `8c56f56b56e47d81a510d45fe8b1df925b1f5163`: 6 CORS config/real Worker OPTIONS tests, CI `37786864015` SUCCESS, 24/24 Node tests, Worker/D1 harness, build, Worker dry-run. Production Pages origin exact-match; no wildcard or preview origins. Draft/unmerged.
- PR #8 housing head before this follow-up `c08d20de958b591c6826a68253f64cf20e288bba`: CI `37786727353` SUCCESS, 27/27 Node tests, Worker/D1 harness, build, Worker dry-run. Draft/unmerged.
- **PUSHED BRANCH ONLY (no PR):** `automation/degen/battle-action-integration-v01` commit `90256385bafbb97d6c2ca14230f9ec57ce648723`, adds `tests/worker-battle-action.test.ts` with 12 direct Worker/SQLite authority cases for Mana, permits, concurrent CAS, victory/defeat, and event closure. PR creation was rejected twice; no full CI exists for this new branch. Preserve it and retry normal PR delivery later, without creating a duplicate branch.
- GitHub PR-body updates and ready-for-review mutations were rejected; existing draft PR metadata may lag verified code. No repeated write attempts should bypass these safety restrictions.
- Mana foundation and reward idempotency remain merged on main. D1 schema and tracked migrations 0002–0005 unchanged; deploy ordering schema → migrations → Worker verified in workflow.
- Best next task: deliver the battle-action test branch through a reviewed PR when mutation permission allows, then obtain CI; separately perform real mobile/Telegram QA of PR #6 before accepting city visuals or merging.

### Housing quantity authority — 2026-10-08
- Main `33e7477961d2a6ab7b79bf52d78a93901e19f658`; branch `automation/degen/housing-reliability-v01` at `170c5bcf297c68e15a9b8db50c31a64cb1ef2850`; draft PR #8, PUSHED/CI GREEN, not merged/live.
- Changed `worker/index.ts`: cap housing placements by server-owned furniture quantities; filter duplicate cells and instance IDs while retaining valid placements. Changed `tests/housing-bootstrap-seed.test.ts`: 3 new SQLite regressions.
- CI `37849775897`: `npm test` 30/30, local Worker/D1 reward integration, `npm run build`, `npm run check:worker` all PASS. Real mobile housing QA pending.
- Degen-only Mana/reward authority merged on main; no monster Mana/reversion. Atomic defeat and client-first recovery remain separate green feature branches; server replay and platform identity remain unresolved.
- No schema/config/migration change; D1 tracked 0002–0005, no remote writes. PR #8 description update rejected twice; no Miles design blocker.
- Best next task: review PR #8 furniture placement semantics and verify mobile reload; obtain approval before merge.
