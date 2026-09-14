# DEGEN

Persistent RPG built for a shared core with Discord Activity and Telegram Mini App adapters.

## Locked product rules

- Combat is **Degen-only**. Entering any battle means the player manifests as their Degen for the entire encounter.
- Human/normal form exists outside battle only.
- NPCs never have Degens. Only real players do.
- The city is navigated through a clickable map and location screens, not a seamless open world.
- Housing is a core pillar: players decorate their own place and, later, can visit other players' homes.
- Everyday progression is solo-first. Multiplayer is reserved for co-op dungeons, bosses, events, and help requests.
- Discord and Telegram are platform shells around one shared game/account model.

## First vertical slice

`Map -> Home -> Underpass -> Battle -> XP/Loot -> Home`

The first slice intentionally uses a placeholder TEST_DEGEN so combat, persistence, routing, and housing can be built independently of final Degen character design.

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

Local browser storage is used only for the prototype persistence adapter. Permanent progression will move behind the authoritative backend before production multiplayer/economy work begins.
