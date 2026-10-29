# DEGEN

Persistent RPG built for a shared core with Discord Activity and Telegram Mini App adapters.

## Locked product rules

- Combat is **Degen-only**. Entering any battle means the player manifests as their Degen for the entire encounter.
- Universal Stability/Break is retired. The current combat foundation is HP + Degen-only Mana + bespoke abilities. Mana depletion never causes reversion. Shield and status systems are later slices.
- Server-backed Underpass battles validate every action on the Worker before victory rewards can be claimed; a battle permit alone is not sufficient.
- Human/normal form exists outside battle only.
- NPCs never have Degens. Only real players do.
- The city is navigated through a clickable city map → district → location hierarchy, not a seamless open world.
- Housing is a core pillar: players decorate their own place and, later, can visit other players' homes.
- Everyday progression is solo-first. Multiplayer is reserved for co-op dungeons, bosses, events, and help requests.
- Discord and Telegram are platform shells around one shared game/account model.

## First vertical slice

`City Map -> District -> Location -> (Home | Underpass -> Degen Battle -> XP/Loot) -> Home`

The first slice intentionally uses a placeholder TEST_DEGEN so combat, persistence, routing, and housing can be built independently of final Degen character design.

## City navigation foundation

The current map derives its districts and destinations only from `WORLD_LOCATIONS`: Residential (Home) and Central (Downtown, Underpass). The mobile-first isometric SVG map supports touch drag, pinch zoom, bounded zoom controls, reset, and keyboard navigation. Selecting a district exposes only its defined locations; Downtown is a navigable scene whose activities are explicitly marked in development. Home remains available from the persistent bottom navigation.

The city geometry is temporary technical art scaffolding, not final city-design canon. This slice adds no districts, NPCs, monster content, lore, activities, or economy rules.

## Run locally

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Project shape

```text
src/
  app/        navigation and client state
  data/       world and placeholder content definitions
  domain/     shared game types
  game/       Phaser battle layer and combat engine
  platform/   Discord / Telegram / browser adapters
  ui/         map, housing, location, and battle shell

db/
  schema.sql  initial persistent data model for Cloudflare D1
```

Browser storage holds client-side identity and recovery metadata; the Cloudflare Worker and D1 own server-backed progression, battle permits/state, rewards, inventory, and housing persistence. Offline preview state cannot issue production permits or rewards.


## Battle-authority migration

The Worker deployment workflow now applies tracked D1 migrations automatically before deploying the Worker. To apply them manually:

```bash
npm run db:migrate
```

The Worker persists authoritative player HP/Mana, enemy HP, battle status, and turn count on each permit. `/api/battle/complete` grants rewards only when that persisted battle state is already a server-resolved victory.
