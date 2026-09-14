PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS platform_identities (
  platform TEXT NOT NULL CHECK (platform IN ('discord', 'telegram')),
  platform_user_id TEXT NOT NULL,
  player_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  linked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (platform, platform_user_id),
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS characters (
  player_id TEXT PRIMARY KEY,
  level INTEGER NOT NULL DEFAULT 1,
  xp INTEGER NOT NULL DEFAULT 0,
  currency INTEGER NOT NULL DEFAULT 0,
  degen_key TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS player_inventory (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  item_type TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  acquired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_inventory_player ON player_inventory(player_id);

CREATE TABLE IF NOT EXISTS unlocked_locations (
  player_id TEXT NOT NULL,
  location_key TEXT NOT NULL,
  unlocked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (player_id, location_key),
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS housing_placements (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  furniture_key TEXT NOT NULL,
  grid_x INTEGER NOT NULL,
  grid_y INTEGER NOT NULL,
  rotation INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (player_id, grid_x, grid_y),
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_housing_player ON housing_placements(player_id);

CREATE TABLE IF NOT EXISTS defeated_bosses (
  player_id TEXT NOT NULL,
  boss_key TEXT NOT NULL,
  first_defeated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (player_id, boss_key),
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS battle_history (
  id TEXT PRIMARY KEY,
  player_id TEXT NOT NULL,
  encounter_key TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('victory', 'defeat')),
  player_level INTEGER NOT NULL,
  xp_awarded INTEGER NOT NULL DEFAULT 0,
  currency_awarded INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_battle_history_player ON battle_history(player_id, completed_at DESC);
