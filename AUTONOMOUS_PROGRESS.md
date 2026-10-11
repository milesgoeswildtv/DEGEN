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

## 2026-10-11 — Housing saves fail closed (PR #8 feature branch)
- Main SHA `33e7477961d2a6ab7b79bf52d78a93901e19f658`; PR #8 branch `automation/degen/housing-reliability-v01`, draft/unmerged.
- Changed `worker/index.ts`, added `worker/housingQuantityGuard.ts`, `tests/housingQuantityGuard.test.ts`, and updated this progress log.
- Server-owned inventory quantity and placement geometry are checked before D1 DELETE/INSERT; missing/malformed layouts reject rather than silently clear rooms; explicit empty layout remains valid.
- LOCAL evidence: 31/31 source-extracted migrated SQLite handler/pure-validator tests passed on the candidate; committed deterministic regression suite requires fresh CI. No visual UI changes.
- Mana foundation already merged on main, unchanged. Battle authority and reward idempotency unchanged; D1 schema/migrations unchanged. No production D1 operation or Worker deployment.
- Public release remains blocked by platform-signed identity and per-request ownership; this validation is NOT authentication. PR #10 frontend-first and PR #9 turn enforcement ordering remains unchanged.
- Best next task: require exact-head PR #8 CI, Worker/D1 integration, and housing reload/mobile verification before merge.

## 2026-10-11 — PR #8 housing test harness reconciliation
- PR #8 Worker now imports `validateHousingPlacements`; existing VM-extracted handler tests must inject that helper into their sandbox rather than strip the import and silently test a ReferenceError.
- Updated legacy housing tests to expect fail-closed 400 for overquantity/duplicate layouts and preservation of the prior saved layout. Explicit empty-room and valid two-copy saves remain accepted.
- Prior PR #8 CI `38125445102` failed 4 tests because the old harness omitted the new import and expected partial acceptance; fresh CI required on this commit. No production deployment or D1 changes.
- Main, Mana, battle authority, reward idempotency, migrations, and platform release gates unchanged. Next: require green CI, then isolated real Worker/D1 housing HTTP test.

## 2026-10-11 — Isolated Worker/D1 housing HTTP release gate (PR #8)
- Extended `tests/worker-d1-concurrency.mjs` to exercise actual local Wrangler Worker/D1 HTTP housing PUT and bootstrap reload: valid furniture, overquantity, spoofed inventory, duplicate cells, missing placements, and explicit empty room.
- The harness uses isolated scratch D1 state and never production. Existing reward concurrency checks remain intact. CI must prove this branch head; no new schema, migration, Mana, or gameplay rules.
- Previous CI `38125445102` failure was a test-harness mismatch; reconciled in `da031f21...`. This addition requires fresh exact-head CI.
- Best next task: confirm isolated HTTP and full CI green, then review PR #8 alongside platform authorization and housing mobile UX before merge.

## 2026-10-11 — D1 housing transaction rollback regression (PR #8)
- Extended isolated Worker/D1 HTTP harness with two-player global placement-ID collision. A failed D1 batch must preserve both the original player's previous room and the other player's placement; explicit empty-room save still follows.
- Prior exact-head PR #8 CI `38125559664` passed 39/39 and real housing HTTP. Fresh CI required for this additional rollback assertion. No production DB or schema change.
- Mana, reward authority, platform-auth blockers and release order unchanged. Next: verify new CI and preserve both PR #8 and PR #10 harness tests at merge.

## 2026-10-11 — In-flight housing edits vs authoritative reward snapshots (feature branch)
- Authoritative main: `33e7477961d2a6ab7b79bf52d78a93901e19f658`; PR #8 branch `automation/degen/housing-reliability-v01`. LOCAL/STAGED until the commit/ref is verified.
- Changed `src/app/state.ts`, `tests/housing-save-order.test.ts`: preserve only same-account pending housing placements when an older server reward receipt arrives during an in-flight housing save. Server inventory, currency, XP, level, and other economic state remain authoritative; after the save settles, subsequent server snapshots win.
- Targeted regressions: delayed reward snapshot while save pending; cross-account isolation; existing rapid-edit save ordering. Require exact-head CI, `npm test`, `npm run build`, `npm run check:worker`, and isolated Worker/D1 before merging. No visual/UI changes.
- Degen Mana: COMPLETE/MERGED on main; no monster Mana or forced reversion. Reward authority/idempotency: MERGED on main; PR #9 recovery and mandatory turns remain draft. Tracked D1 migrations 0002–0005 precede Worker deployment; no DB/schema/config changes in this slice.
- Public-release blockers: signed Discord/Telegram identity and per-request ownership; live Pages/Worker verification; PR #10 frontend-first before PR #9 Worker enforcement. No new Miles design blocker.
- Best next task: verify CI for this housing fix and PR #8 real Worker/D1 housing tests, then review release integration without merging/deploying directly.

### Delivery verification — 2026-10-11 (PUSHED / PR #8 / CI GREEN)
- Source/test/progress commit `63cfa7f19aa10eede64a2914a0f8acc7d12d696e` is confirmed on `automation/degen/housing-reliability-v01` and attached to draft PR #8; `main` remains `33e7477961d2a6ab7b79bf52d78a93901e19f658`.
- GitHub Actions [run 38160385464](https://github.com/milesgoeswildtv/DEGEN/actions/runs/38160385464) is GREEN at that exact source head: `npm test` **41/41**, isolated Wrangler Worker/D1 HTTP housing/reward integration, `npm run build`, and `npm run check:worker` all passed. New tests #24 and #25 verify delayed housing-save reward snapshot preservation and cross-account isolation.
- No live browser/mobile verification, production Worker deployment, production D1 mutation, or main merge. No schema, migration, secrets, or config changes. PR #8 remains draft/unmerged. Existing Mana/reward authority on main unchanged; signed platform identity and request ownership still block public economy.
- Best next task: review PR #8 alongside PR #10's client-first release and resolve any source overlap; verify mobile housing reload and production API auth before reviewed integration. Avoid introducing a naive housing PUT timeout without server-side ordering because an aborted request may still commit after a newer save.

### Additional housing save queue hardening — 2026-10-11 (PR #8)
- Found a cross-account queue collision: one global pending slot could drop a second account's unsaved layout when the first account edited again before the in-flight PUT completed.
- Changed `src/app/state.ts` to coalesce pending housing snapshots per player ID while serializing actual PUTs; added deterministic two-account A→B→A regression to `tests/housing-save-order.test.ts`. Does not add a gameplay state store or alter server ownership; no migrations/config/balance changes.
- Require exact-head CI before marking this latest commit GREEN. Prior head `2fbf7fa87b1460db60e34a3694ddd43b7df1e183` passed run `38160567989` (41/41 + isolated Worker/D1 + build/Worker check). Main unchanged `33e7477961d2a6ab7b79bf52d78a93901e19f658`.
- Mana complete/merged; reward receipts merged; PR #9 turn enforcement unmerged; public identity and live release blockers unchanged. Best next task: inspect latest CI and reconcile PR #8 with PR #10 before any release.
