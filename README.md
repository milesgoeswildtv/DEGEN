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


## Battle-authority migration

The Worker deployment workflow now applies tracked D1 migrations automatically before deploying the Worker. To apply them manually:

```bash
npm run db:migrate
```

The Worker persists authoritative player HP, enemy HP, battle status, and turn count on each permit. `/api/battle/complete` grants rewards only when that persisted battle state is already a server-resolved victory.

## Server-backed platform authentication

When `VITE_API_BASE` is configured, DEGEN runs in server-authoritative mode and does not fall back to a browser-chosen player identity.

- **Telegram Mini App:** set the Worker secret `TELEGRAM_BOT_TOKEN`. The client sends raw `Telegram.WebApp.initData`; the Worker verifies its HMAC, age, and fields before it selects or creates the account. Client-supplied `playerId`, provider ID, and display name are not account authority.
- **Discord Activity:** set Worker `DISCORD_CLIENT_ID` and secret `DISCORD_CLIENT_SECRET`; set the matching public build variable `VITE_DISCORD_CLIENT_ID`. The Worker issues a short-lived one-use OAuth state, exchanges the authorization code server-side, and checks the Discord application ID and `identify` scope before binding the provider user. `DISCORD_REDIRECT_URI` is optional and must match the Discord OAuth configuration if your setup requires it.
- Configure Worker secrets with `wrangler secret put TELEGRAM_BOT_TOKEN`, `wrangler secret put DISCORD_CLIENT_SECRET`, and `wrangler secret put DISCORD_CLIENT_ID` (or use the appropriate non-secret Worker variable for the client ID). Configure `VITE_API_BASE` and `VITE_DISCORD_CLIENT_ID` in the frontend build environment. Never put the bot token or Discord client secret in Vite variables.
- Verified bootstrap returns a short-lived bearer session. Only the SHA-256 session-token digest is stored in D1; housing, world, battle-action, and reward-completion routes resolve the player from the bearer session and ignore caller-selected player IDs. Logout revokes the session.
- Apply the tracked `db/migrations/0007_player_sessions.sql` migration through the existing schema → migrations → Worker deployment workflow. No production migration or deployment is performed by this repository change.
- Migration 0007 adds a nullable `verified_at` marker to existing provider bindings. Rows created by pre-auth builds remain unverified because those builds accepted caller-supplied provider IDs. A signed identity that collides with one of those legacy rows receives HTTP 409; DEGEN preserves the row and existing progress instead of automatically trusting, reassigning, deleting, or merging it. Account recovery/linking for those legacy collisions requires a separately approved policy.

Browser preview remains available only when `VITE_API_BASE` is unset. A configured Worker with no valid Telegram/Discord identity fails closed.
