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

### Client/Worker Mana 409 contract regression (PUSHED / no PR)
- Added `tests/battle-client-recovery.test.ts` case matching PR #9's real unaffordable-action response shape: HTTP 409 with authoritative `battleState`. Client must synchronize Degen Mana to zero while leaving turn count, player HP, enemy HP, and battle status unchanged. No client-side damage or reward.
- Full repository CI still pending a client-first PR; no live Worker/D1 assertion from this branch. No D1 or deployment changes. Next task remains client-first PR + full CI before Worker enforcement.

### Reward receipt / world refresh ordering (PUSHED / no PR)
- Fixed a real asynchronous state race: an older world-event fetch could overwrite the authoritative cycle/clear count returned by successful `/api/battle/complete`. `queueRewardCompletion` now invalidates in-flight world refresh generations before applying the Worker reward receipt.
- Added one regression to `tests/world-sync-authority.test.ts`; narrow local controller fixture reproduced 6/7 pass before the fix and 7/7 pass after. Full repo/Worker CI still unverified for client-first branch.
- No change to reward amount, Degen Mana, D1, migration, authentication, or deployment. Main `33e7477961d2a6ab7b79bf52d78a93901e19f658` unchanged; PR #9 still green/draft/unmerged. Next task: reviewed client-first PR + CI and live frontend-first QA.

### 2026-10-09 — Underpass double-entry guard (PUSH TARGET)
- Authority: main `33e7477961d2a6ab7b79bf52d78a93901e19f658`; branch `automation/degen/battle-client-first-v01` at parent `e028f9801c7a4bd60f600eb54a92ed1605fd2c5d`. Mana COMPLETE/MERGED on main; reward receipts/idempotency MERGED; atomic defeat/mandatory expected-turn enforcement in green but unmerged draft PR #9.
- Changed `src/app/AppController.ts`: prevent concurrent Underpass permit starts with an in-flight guard and release it in `finally`; preserve already-issued permit if event closes during request. Changed `tests/world-sync-authority.test.ts`: three regressions for rapid duplicate tap, failed request retry, and event closure. No gameplay rebalance or monster Mana.
- No D1 schema/migration or deployment config changes. Existing D1 binding and tracked migrations are unchanged; workflow migrates before Worker deployment. No production D1 write or deployment.
- QA: targeted controller fixture previously passed 10/10 with this guard; exact pushed branch still requires independent `npm test`, `npm run build`, `npm run check:worker`, real Worker/D1 and mobile QA. Do not claim merged/live.
- Public economy blocker: platform-verified Discord/Telegram login and request-level authorization. Best next task: open draft client-first PR, obtain full CI and verify compatible frontend deployment before PR #9 Worker enforcement.

## 2026-10-09 — Malformed Underpass permit guard (PUSHED / no PR)
- Authoritative main SHA: `33e7477961d2a6ab7b79bf52d78a93901e19f658`. Feature branch: `automation/degen/battle-client-first-v01`; scoped commits `c92056c0692b4292dc06bf7c4c4bf5d36bfb9d85` (source) and `31ca8ba691b388e10ae5957a39e2b1101d02df04` (tests). Client-first PR creation rejected after a branch/permission re-read and independent retry. Nothing merged or deployed.
- Files: `src/app/AppController.ts` rejects missing/empty permit IDs before mounting battle and clears invalid permit state; `tests/world-sync-authority.test.ts` adds malformed-permit recovery plus 1000-tap, missing-permit, and stale-button regressions; this progress note.
- Evidence: exact GitHub-fetched `enterUnderpass` method reproduced bad navigation on `{}` and candidate guard corrected it. Reconstructed controller fixture passed 20/20; original negative control failed the new case (19/20). Full `npm test`, `npm run build`, `npm run check:worker`, isolated Worker/D1 and mobile/browser QA are NOT verified on this feature head; independent CI is unavailable until a PR exists.
- Mana: COMPLETE/MERGED on main; no monster Mana or automatic reversion. Reward idempotency/recoverability: MERGED on main. Draft PR #9 still carries mandatory turn validation and atomic defeat work; compatible client must be live before Worker enforcement.
- D1/migrations: no schema, migration, binding or deploy config changes in this slice. `wrangler.toml` is source of truth; tracked migrations precede Worker deployment. Production D1 untouched.
- Miles blockers: verified Discord/Telegram identity, server-owned sessions and per-request authorization before public economic gameplay. No new gameplay canon required.
- Best next task: obtain a draft client-first PR, run full CI and actual local Worker/D1 + mobile QA, deploy compatible frontend first, then review PR #9.


## 2026-10-09 — Stale Underpass navigation guard (LOCAL QA / PUSH TARGET)
- Authoritative main: `33e7477961d2a6ab7b79bf52d78a93901e19f658`. Existing branch: `automation/degen/battle-client-first-v01`; source head before this change: `0e3df8548fa11974c65f38bbcd713be5c826d33c`. Client-first PR creation rejected twice; do not claim PR delivery.
- Fix: only initiate Underpass entry from the Underpass route; invalidate in-flight permit navigation after any intervening route change (including Home then back). Keep legally issued permits enterable across event closure if the player did not navigate away.
- Files: `src/app/AppController.ts`, `tests/world-sync-authority.test.ts`, `AUTONOMOUS_PROGRESS.md`.
- QA: isolated exact-method Node test harness passed 23/23; negative control failed the three newly added navigation regressions. Full `npm test`, `npm run build`, `npm run check:worker`, browser/mobile, and actual Worker/D1 not run in this environment (GitHub DNS unavailable).
- Mana COMPLETE/MERGED on main; no monster Mana or forced reversion. Reward idempotency/recovery MERGED; PR #9 atomic defeat/turn enforcement draft and unmerged.
- D1 migrations 0002–0005 tracked and deploy workflow applies schema/migrations before Worker. No D1/config changes and no remote deployment.
- Public economy blocker: verified platform auth/authorization. Next task: obtain client-first PR and independent CI; verify frontend-first deployment before PR #9 Worker enforcement.

## 2026-10-09 — Underpass account-switch permit guard (PUSH TARGET)
- Main authority: `33e7477961d2a6ab7b79bf52d78a93901e19f658`. Feature branch `automation/degen/battle-client-first-v01` at parent `776dca22cadbf62d2be7d5c69c21ac64c6e64a24`; draft PR #10 now opened, full CI pending at time of edit.
- Fix: capture issuing player before Underpass request, install permit only after checking route, navigation generation, player identity, and valid permit ID. Legally issued permits remain valid across event closure. No gameplay/economy changes.
- Changed `src/app/AppController.ts`, `tests/world-sync-authority.test.ts`, this log. Mana COMPLETE/MERGED; reward idempotency MERGED; PR #9 strict turn validation unmerged. No D1/config/deployment edits.
- Required follow-up: full PR CI, Worker/D1, mobile QA, and platform-authenticated sessions before public economy. Client-first frontend must be live before strict Worker PR #9.

## 2026-10-09 — Account-bound reward receipts (PUSH TARGET)
- Main authority: `33e7477961d2a6ab7b79bf52d78a93901e19f658`; draft PR #10 `automation/degen/battle-client-first-v01` parent `f58a020904f8157254570a08a1f460ec093e01da`.
- Files: `src/app/AppController.ts`, `tests/world-sync-authority.test.ts`, this log. Bind pending reward storage, completion, and world-event refresh to issuing player; prevent late A receipts overwriting B; rerender Home on verified receipt. Server remains sole authority for XP/currency/loot.
- Four new regression tests. Full CI, actual Worker/D1, build, Wrangler and mobile QA required on pushed commit; do not claim before results.
- Degen Mana COMPLETE/MERGED on main; monsters have no Mana or reversion. Reward idempotency MERGED; late killing-blow recovery and PR #9 strict-turn/atomic-defeat remain pending.
- No D1/config changes; tracked migrations precede Worker deploy. No production D1 mutation.
- Public economy blocker: verified Discord/Telegram sessions and per-request authorization. Next: green CI, finish late-action recovery, deploy client before PR #9 Worker enforcement.

## 2026-10-09 — Client-first CI repair and detached battle victory recovery (PUSH TARGET)
- Authoritative main: `33e7477961d2a6ab7b79bf52d78a93901e19f658`. Draft PR #10 branch `automation/degen/battle-client-first-v01` at parent `59d49deb8bcce4048a1717e910d3c709c32a2fc0`; no merge or production deploy.
- Prior test-only commit `59d49deb8bcce4048a1717e910d3c709c32a2fc0` corrected two mocked reward receipts to include the actual player ID. Exact CI run `38017193007` PASSED deterministic tests, isolated Worker/D1 integration, Vite build, and Worker validation.
- This follow-up changes `src/app/AppController.ts` and `tests/world-sync-authority.test.ts`: preserve only Worker-confirmed victories after an in-flight battle action becomes detached; bind pending completion to original account; reject mismatched permit and nonterminal results; clear detached stale permit on new entry. Adds seven deterministic regressions.
- Degen Mana COMPLETE/MERGED on main; no monster Mana or forced reversion. Reward receipt idempotency MERGED; PR #9 strict turn/atomic defeat draft/unmerged. No DB/config/deployment changes; migrations 0002–0005 tracked before Worker deploy.
- Fresh CI on this new commit required before release. Browser/mobile with real Worker and signed Discord/Telegram authentication + per-request authorization remain blockers for public economy.
- Best next task: verify fresh PR #10 full CI and real Worker-backed mobile behavior; reconcile PR #9 terminal-expiry recovery, then deploy compatible frontend before Worker enforcement.

## 2026-10-09 — Client-first verified QA (PUSHED / PR #10)
- Main `33e7477961d2a6ab7b79bf52d78a93901e19f658`; PR #10 `automation/degen/battle-client-first-v01` at `adc51252682bfc6d256b24df6f486e0f12fad5f3`, draft/unmerged. PR #9 draft/unmerged.
- Implementation: account-bound detached-victory recovery and stale-permit guard in `src/app/AppController.ts`; seven new tests in `tests/world-sync-authority.test.ts`; two account-identity fixture corrections in `tests/client-reward-recovery.test.ts`.
- GitHub CI `38017300270`: 55/55 tests, isolated Worker/D1 reward concurrency, `npm run build`, `npm run check:worker` all PASS. Cloudflare Pages preview check `114110389026` SUCCESS, not live mobile or Worker-backed browser proof.
- Degen Mana COMPLETE/MERGED; no monster Mana or forced reversion. Reward receipt idempotency MERGED; PR #9 turn/defeat work pending. Local-only terminal-expiry recovery patch remains unpushed; 16/16 SQLite models pass, real Worker/D1 unverified.
- D1 migrations 0002–0005 tracked; schema/migrations precede Worker deployment. No production D1 mutation, Worker deploy, main merge, or config change.
- Blockers: production Pages CORS, real browser/mobile verification, signed platform identity and per-request authorization before public economy.
- Next: review PR #10 and verify compatible frontend first; then reconcile PR #9 terminal-state recovery and Worker enforcement.

## 2026-10-09 — Invalid-permit HTTP integration (PUSHED / PR #10)
- Main `33e7477961d2a6ab7b79bf52d78a93901e19f658`; draft PR #10 branch `automation/degen/battle-client-first-v01` implementation head `86e1b3853d2307847457672d0c894760b44e2d6c`, unmerged.
- `tests/worker-d1-concurrency.mjs` now checks invalid, expired-active, wrong-account action permits and non-victory completion rejection against isolated local Worker/D1.
- Exact GitHub CI `38017661280` PASS: 55 deterministic tests, real local Worker/D1 concurrency/replay, `npm run build`, `npm run check:worker`. Cloudflare Pages preview is static proof only.
- Mana COMPLETE/MERGED, no monster Mana or reversion. Reward receipts/idempotency MERGED; PR #9 turn enforcement/atomic defeat still draft. Migrations 0002–0005 run before Worker; no production DB/deploy/config changes.
- Blockers: reviewed frontend-first release and real Worker-backed mobile QA; Pages origin CORS; signed Discord/Telegram sessions and request-level authorization for public economy.
- Next: verify frontend first, then reconcile PR #9 and its terminal-expiry recovery with actual Worker/D1 tests.

## 2026-10-10 — Client startup and reward request liveness (FEATURE BRANCH / CI PENDING)
- Authority: main `33e7477961d2a6ab7b79bf52d78a93901e19f658`; existing draft PR #10 `automation/degen/battle-client-first-v01`, parent `7672f777d0a1b8f481dd40f57f4e9af130ae9674`.
- Scope: `src/app/api.ts` 15s bootstrap and 20s reward-completion AbortController deadlines; `src/app/AppController.ts` renders Map/Home and starts account-bound pending reward recovery before asynchronous world refresh. No new game canon, Mana changes, D1 migration or deployment configuration changes.
- QA: prior isolated portable Node/SQLite and Chromium mock checks passed in handoff; fresh GitHub CI, full npm test/build/check:worker, and actual Worker/D1/browser proof required on new commit.
- Mana: complete on main; monsters have no Mana and zero Mana does not revert. Reward settlement remains Worker-owned and replay/idempotency remain in force. PR #9 strict Worker turn/CAS recovery draft/unmerged.
- D1: tracked migrations 0002–0005 precede Worker deployment; current wrangler.toml binding is source of truth; no remote D1 mutation.
- Public blocker: signed Discord/Telegram authentication and per-request authorization. Next: run full CI and real Worker-backed browser QA on this PR before PR #9 enforcement.


## 2026-10-10 — Underpass request liveness (PUSHED / PR #10; CI PENDING)
- Authoritative main SHA: \`33e7477961d2a6ab7b79bf52d78a93901e19f658\`; feature branch \`automation/degen/battle-client-first-v01\`, PR #10, prior API implementation commit \`cfe25de7e80fd2f08aa076fac41211dd26788a8d\`. Main unchanged; no merge/live deployment.
- Files changed: \`src/app/api.ts\` bounds world-event polling to 15 seconds and battle permit issuance to 20 seconds with per-request AbortController and finally timer cleanup. \`tests/world-entry-request-deadlines.test.ts\` covers aborts, Worker-only responses, independent signals, and cleanup. This log updated for continuity.
- QA: local exact-blob source fixture passed 4/4 targeted tests. Prior portable world/entry suite passed 12/12, but that is isolated evidence, not new GitHub CI. Run \`npm test\`, \`npm run build\`, \`npm run check:worker\`, and Worker/D1 integration on this branch. Actual Worker-backed browser/mobile remains unverified.
- Mana status: COMPLETE/MERGED on main; only Degens own Mana, zero Mana never forces reversion. Reward idempotency/recoverability: MERGED on main, with client account-bound receipt recovery in PR #10; PR #9 strict turn enforcement/atomic defeat remains draft and unmerged.
- D1: current \`wrangler.toml\` binding is authoritative; tracked schema and migrations precede Worker deploy. No D1 schema change or remote DB operation this run.
- Blockers: signed Discord/Telegram platform identity and request-level authorization for public economy; production Pages CORS (PR #7); actual Worker-backed frontend validation. Do not deploy optional battle-action timeout until strict Worker expected-turn enforcement is live.
- Best next task: inspect fresh PR #10 CI and run real local Vite + Wrangler/D1 browser vertical slice; then reconcile PR #9 without losing PR #10's account isolation and fail-closed world navigation.


## 2026-10-10 — Underpass entry failure recovery (PUSHED / PR #10; fresh CI pending)
- Main authority: \`33e7477961d2a6ab7b79bf52d78a93901e19f658\`; feature branch PR #10 parent \`406356c2ce114912306b2d62814fbf09b068aa5a\`. Previous API deadline commit and 4 new deterministic tests passed CI \`38080378713\`: 61/61, isolated Worker/D1, Vite build, Wrangler dry run.
- Files: \`src/app/AppController.ts\` fails closed on rejected permit, releases the entry lock without awaiting a potentially stalled world refresh, and asynchronously rerenders after authoritative world recovery. Account/navigation generation guards prevent a late rejection from affecting another player or route. \`tests/world-sync-authority.test.ts\` adds actual-controller regressions for delayed refresh and account switching; this log updated.
- QA: 4/4 local extracted controller regression tests passed (including a negative control of the original blocked lock). Fresh full CI and actual Worker-backed browser QA required for this new change; no claim of live verification.
- Mana: COMPLETE/MERGED, Degen-only; no monster Mana or forced reversion. Rewards: Worker-owned idempotent settlement merged on main; PR #9 strict turn enforcement still unmerged. No schema/config/remote D1 changes. Tracked migrations run before Worker deployment.
- Release gates: PR #10 frontend verified first, production Pages CORS, platform-signed Discord/Telegram authentication with per-request authorization. Do not add action deadline before PR #9 strict turn enforcement is live.
- Next: inspect fresh PR #10 CI, verify local Vite + Wrangler/D1 full browser slice, and reconcile PR #9 without regressing client account isolation.

## 2026-10-10 — Underpass real HTTP authority regression (PUSHED / PR #10 / CI GREEN)
- Authority: `main` `33e7477961d2a6ab7b79bf52d78a93901e19f658`; PR #10 `automation/degen/battle-client-first-v01` head `13929e50de13fd9a9238817ff52bd734ce28ea50`, draft/unmerged.
- Task/files: `tests/worker-d1-concurrency.mjs` now exercises real isolated Wrangler/D1 HTTP bootstrap -> authoritative world -> permit -> paid Mana turns -> legal battle across event closure -> victory -> idempotent reward replay -> zero-Mana rejection/free action. New entry after closure rejects. Added eight concurrent same-permit completions and killing-blow/completion race with single reduced reward.
- Commits: `ab78d60`, `242ebbc` (syntax fix), `9fe0aec` (closure), `4af046e` (same-permit race), `13929e5` (action/completion race). No runtime, combat balance, migration, config or production DB changes.
- QA: GitHub Actions CI `38089115804` SUCCESS on exact `13929e5` head: 63/63 Node tests, isolated real Wrangler/D1 HTTP integration, TypeScript/Vite build, Worker dry-run. Cloudflare Pages check is static preview only. Actual frontend/browser/mobile Worker-backed QA remains unverified (local Chromium navigation blocked by environment).
- Mana: COMPLETE/MERGED on main; Degen-only, exact cost, free ability at 0, no monster Mana or depletion reversion. Reward idempotency/recoverability: MERGED on main, now further HTTP-tested. PR #9 strict expected-turn enforcement/atomic defeat remains draft/unmerged; compatible client must be live first.
- D1: current `wrangler.toml` is source of truth. `db/schema.sql` and tracked migrations `0002`–`0005` apply to ephemeral local D1 before tests; deployment workflow migrates before Worker. No production D1 mutation or deploy this run.
- Miles blocker: signed Discord/Telegram identity and request-level ownership before public economy; PR #7 production Pages CORS and real browser/Worker verification still outstanding.
- One best next task: verify PR #10 frontend with real local Vite + Wrangler/D1 browser or approved nonproduction environment; then stage frontend-first release and reconcile PR #9 without losing PR #10 account isolation.
