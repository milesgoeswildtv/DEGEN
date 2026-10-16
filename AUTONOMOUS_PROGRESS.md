# DEGEN — AUTONOMOUS PROGRESS

Updated: 2026-10-16

## Authoritative runtime
- Repository: `milesgoeswildtv/DEGEN`; protected integration branch: `main`.
- Authoritative main SHA: `33e7477961d2a6ab7b79bf52d78a93901e19f658`.
- Stack: TypeScript + Vite + Phaser + DOM/CSS; Cloudflare Worker + D1.
- Core vertical slice: Map -> Home -> Underpass -> Degen-only Battle -> server-owned Loot/XP -> Home.

## Locked canon and completed gameplay foundation
- Stability/Break is retired. Combat is Degen-only; NPCs never have Degens.
- Degen-only Mana is COMPLETE / MERGED on main: `maxMana`, ability `manaCost`, server-owned permit Mana, authoritative action results, pure rejection of unaffordable abilities, exact paid deduction, free actions at 0 Mana, and no Mana-triggered reversion.
- Monsters have no Mana or universal equivalent resource. Prototype Mana values are scaffolding, not final balance.
- Main contains Worker-resolved battle state and idempotent/recoverable reward receipts. Rewards/economy remain server-owned.
- Reward lifecycle hardening and migrations `0004_reward_receipt.sql` / `0005_reward_claim_character_guard.sql` are merged on main.
- Endpoint-level integration expansion is PUSHED / PR #10 (draft, unmerged); its latest observed CI run `38910917930` completed successfully on branch head `4d0fff55db1284de1369a012e08465701c3a7f8b`. This is branch CI, not a merge or production proof.

## Current slice — PUSHED / PR #14 (DRAFT, UNMERGED)
- Branch: `automation/degen/verified-session-store-v01`.
- Scope: `db/migrations/0006_player_sessions.sql`, `worker/auth/sessionStore.ts`, and new `tests/player-session-store.test.ts`.
- Session helper stores only SHA-256 token digests, issues bounded-lifetime opaque bearer tokens, resolves only unexpired/unrevoked sessions, and supports idempotent revocation. It is NOT wired into Worker routes; do not treat it as production authentication.
- Test commit: `0e824e51a7d6900f628415d9b4fe9839f7c0521b`; exact CI-green branch head before this progress refresh: `844b38400468b780f23a03433e4389b2c3763208`.
- LOCAL targeted evidence: 6/6 session-store tests PASS in an isolated Node 22.16.0 + SQLite fixture using the exact helper, migration, and test source.
- GitHub Actions CI run `38977378910` PASS on exact head `844b38400468b780f23a03433e4389b2c3763208`: `npm test` (including the six new session tests), isolated local Worker/D1 reward-concurrency HTTP integration, `npm run build`, and `npm run check:worker` all succeeded.
- Cloudflare Pages preview check `117230090011` SUCCESS for the static preview build only; this is not a production deployment or Worker-backed browser proof.
- Full-repository local execution was unavailable because `github.com` DNS resolution failed; full-suite evidence is from GitHub Actions, not a local checkout.

## Battle authority, reward reliability, and D1 assumptions
- Worker owns player/enemy HP, Degen Mana, battle status, turn count, victory validation, reward tier, XP, currency, inventory, and reward receipt state.
- Main includes reward idempotency/recovery; PR #10 adds real isolated Worker/D1 HTTP coverage for invalid/expired permits, same-turn replay, concurrent actions/completions, event closure, full/reduced clears, level-up math, and expired-victory recovery.
- PR #9, #11, and #12 remain open drafts; reconcile overlapping Worker changes rather than deploying stricter expected-turn enforcement before compatible client rollout.
- Main's `wrangler.toml` is the D1 binding/config source of truth. `deploy-worker.yml` applies `db/schema.sql` and tracked migrations before Worker deploy.
- Migration `0006_player_sessions.sql` exists only on PR #14. It has NOT been merged or applied to production. No production D1 mutation, Worker deployment, or Pages deployment occurred in this run.

## Release/security blockers
- PR #14 is a storage/helper slice only: no Telegram/Discord identity verification, session issuance route, bearer authorization middleware, or per-player route ownership is wired.
- PR #13's Telegram initData verifier remains separate and unintegrated; Discord verification still needs an approved verified identity path.
- Current Worker bootstrap accepts caller-supplied player identifiers/platform identity. Do not expose public economic gameplay until verified platform provisioning and per-request ownership are enforced.
- Live Pages-to-Worker requests and embedded Telegram/Discord gameplay were not verified in this run.

## Best next task
Integrate verified platform identity and hashed-session primitives into a narrow Worker authentication slice, with fail-closed per-request player ownership tests. Preserve browser preview mode without allowing unauthenticated server-backed economic actions; do not deploy or apply migrations until reviewed and explicitly released.

## Historical record

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
