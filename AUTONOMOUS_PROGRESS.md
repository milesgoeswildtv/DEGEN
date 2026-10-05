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
Branch: `automation/degen/recoverable-reward-claim-v2`

Goal:
- make authoritative victory reward claiming recoverable and auditable
- prevent simultaneous duplicate claims with a server-owned lease
- preserve server-resolved victory and permit-expiry semantics
- add durable reward receipt fields for idempotent replay

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
Complete the recoverable/idempotent reward-claim Worker implementation and integration tests on this branch; do not merge the migration alone.
