import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DATA_DIR, DB_PATH } from "./config.js";

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export const db = new Database(DB_PATH);

// Pragmas for performance and data integrity
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("synchronous = NORMAL");

export function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS titles (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      year INTEGER,
      episodes INTEGER,
      runtime_min INTEGER,
      genres TEXT,
      tone INTEGER DEFAULT 1,
      studio TEXT,
      tagline TEXT,
      synopsis TEXT,
      mal_id INTEGER DEFAULT 21,
      anilist_id INTEGER DEFAULT 21,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title_slug TEXT NOT NULL,
      ep_num INTEGER NOT NULL,
      title TEXT NOT NULL,
      duration_sec INTEGER DEFAULT 1440,
      video_url TEXT,
      thumbnail_url TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(title_slug, ep_num),
      FOREIGN KEY (title_slug) REFERENCES titles(slug) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_episodes_slug_ep ON episodes(title_slug, ep_num);

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      avatar_tone INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      ip TEXT,
      user_agent TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS watchlist (
      user_id INTEGER NOT NULL,
      title_slug TEXT NOT NULL,
      added_at TEXT NOT NULL,
      PRIMARY KEY (user_id, title_slug),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (title_slug) REFERENCES titles(slug) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS watch_progress (
      user_id INTEGER NOT NULL,
      title_slug TEXT NOT NULL,
      episode_num INTEGER NOT NULL,
      position_sec INTEGER NOT NULL,
      duration_sec INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, title_slug, episode_num),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (title_slug) REFERENCES titles(slug) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_progress_user ON watch_progress(user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title_slug TEXT NOT NULL,
      episode_num INTEGER NOT NULL,
      position_sec INTEGER NOT NULL,
      completed INTEGER DEFAULT 0,
      watched_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (title_slug) REFERENCES titles(slug) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_history_user ON history(user_id, watched_at DESC);

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title_slug TEXT NOT NULL,
      episode_num INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (title_slug) REFERENCES titles(slug) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_comments_target ON comments(title_slug, episode_num, created_at DESC);
  `);

  try {
    db.exec("ALTER TABLE titles ADD COLUMN mal_id INTEGER DEFAULT 21;");
  } catch (e) {}

  try {
    db.exec("ALTER TABLE titles ADD COLUMN anilist_id INTEGER DEFAULT 21;");
  } catch (e) {}
}

// Auto-initialize schema on load
initSchema();
