# DEGEN — AUTONOMOUS PROGRESS

Updated: 2026-10-05

## Authoritative runtime
- Repository: `milesgoeswildtv/DEGEN`
- Integration branch: `main`
- Stack: TypeScript + Vite + Phaser + DOM/CSS; Cloudflare Worker + D1
- Core vertical slice: Map -> Home -> Underpass -> Battle -> Loot -> Home

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
- Battle permits persist authoritative player HP, enemy HP, battle status, and turn count.
- `/api/battle/complete` requires a server-resolved victory before granting rewards.
- D1 migration for authoritative battle state is tracked and applied before Worker deployment.
- Client and Worker share one deterministic turn resolver.

## Current slice
Branch: `sidekick/degen-mana-foundation-v01`

Goal:
- add authoritative Degen-only Mana to the shared combat model
- persist current Degen Mana on server-owned battle permits
- reject paid abilities when Mana is insufficient without consuming a turn
- expose Mana and ability costs in the battle UI
- keep monsters completely free of Mana/resource fields

## Known remaining authority work
- Add stronger integration coverage for invalid/expired permits, duplicate completion, and concurrent completion attempts.
- Harden reward completion so a transient database failure after permit claim cannot strand an otherwise valid victory.
- Keep reward grants idempotent and auditable as more encounters are added.

## Next gameplay systems
After the Degen Mana slice is green and deployed:
1. generic Shield support
2. universal status engine
3. data-driven approved monster definitions/loadouts
4. replace prototype Tunnel Maw / TEST_DEGEN flow with approved production combat content incrementally

## Highest-value next task
Finish and merge the Degen-only Mana authority slice. Then choose between recoverable/idempotent reward claiming and the generic Shield foundation based on current production risk.


## 2026-10-06 reward-authority production slice
- Authoritative starting main: `2df79a123a022212721634c048147d8bf935566a`.
- Active branch: `automation/degen/reward-authority-v22`.
- Pushed migration `db/migrations/0004_reward_receipt.sql` at `e3defb1de4159d238cbf9603ce0dad3c662ee45c`.
- Pushed Worker consumer at `e2042be2a565c349898afd5cee0aa6128416316d`.
- Reward lifecycle is persisted as pending/claiming/awarded with a 60-second stale-claim lease.
- Fresh claims still require an unexpired server-resolved victory; recovery reuses the persisted clear number.
- Award writes are claim-token guarded and batched; victory history uses the permit ID deterministically; awarded retries replay the persisted receipt.
- No production D1 migration or deployment has been performed from this branch.
- Stability/Break audit: no stale state in the inspected engine/types/test data. Monster definitions still have no Mana/resource field.
- Battle-authority status: implementation pushed; PR CI/build/Worker dry-run and D1-compatible authority regression coverage remain before merge.
- Best next task: run PR checks, fix any compile/dry-run failures, then cover duplicate/expired/full-vs-reduced/stale-claim completion.
