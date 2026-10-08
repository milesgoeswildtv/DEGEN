# DEGEN

Persistent RPG built for a shared core with Discord Activity and Telegram Mini App adapters.

## Locked product rules

- Combat is **Degen-only**. Entering any battle means the player manifests as their Degen for the entire encounter.
- Universal Stability/Break is retired. The prototype combat foundation is HP + abilities now, with Mana/status/Shield systems layered in as their finalized rules land.
- Server-backed Underpass battles validate every action on the Worker before victory rewards can be claimed; a battle permit alone is not sufficient.
- Human/normal form exists outside battle only.
- NPCs never have Degens. Only real players do.
- The city is navigated through a clickable map and location screens, not a seamless open world.
- Housing is a core pillar: players decorate their own place and, later, can visit other players' homes.
- Everyday progression is solo-first. Multiplayer is reserved for co-op dungeons, bosses, events, and help requests.
- Discord and Telegram are platform shells around one shared game/account model.

## First vertical slice

`Map -> Central district -> Underpass -> Battle -> XP/Loot -> Home`

The city interface groups the existing Residential (Home) and Central (Downtown, Underpass) destinations into a clickable district map. Downtown is a navigable scene with future activities clearly marked as unavailable; it does not introduce new lore or gameplay systems. Home remains available from the bottom navigation.\n\nThe first slice intentionally uses a placeholder TEST_DEGEN so combat, persistence, routing, and housing can be built independently of final Degen character design.

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


## Battle-authority migration

The Worker deployment workflow now applies tracked D1 migrations automatically before deploying the Worker. To apply them manually:

```bash
npm run db:migrate
```

The Worker persists authoritative player HP, enemy HP, battle status, and turn count on each permit. `/api/battle/complete` grants rewards only when that persisted battle state is already a server-resolved victory.
