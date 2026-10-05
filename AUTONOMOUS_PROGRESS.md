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
