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
// The dub-probe script and the API server write from separate processes;
// wait briefly for a write lock instead of throwing SQLITE_BUSY.
db.pragma("busy_timeout = 5000");

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
      created_at TEXT NOT NULL,
      old_title TEXT,
      real_title TEXT,
      romaji_title TEXT,
      native_title TEXT,
      score INTEGER,
      status TEXT,
      studios TEXT,
      anilist_genres TEXT,
      anilist_episodes INTEGER,
      cover_local TEXT,
      banner_local TEXT,
      cover_remote TEXT,
      banner_remote TEXT
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
      /* NULL for social-only accounts (Google/Discord/MAL/AniList) — they
         have no local password and can never log in with one
         (verifyPassword returns false for a NULL hash). Local accounts
         always have a hash. Older databases are migrated by
         migrateUsersForSocial() below. */
      password_hash TEXT,
      name TEXT NOT NULL,
      avatar_tone INTEGER DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    /* Social-login identities (HiAnime-style logins, Nov 2026). One row per
       linked provider account; a user can link several providers. The
       UNIQUE on (provider, provider_user_id) is what makes a returning
       social login find the same account. */
    CREATE TABLE IF NOT EXISTS linked_identities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      provider TEXT NOT NULL,
      provider_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(provider, provider_user_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_linked_identities_user ON linked_identities(user_id);

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
      /* NULL for a guest comment (Phase 3b) — the display name then lives in
         guest_name. A signed-in comment keeps its user_id. */
      user_id INTEGER,
      guest_name TEXT,
      title_slug TEXT NOT NULL,
      episode_num INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (title_slug) REFERENCES titles(slug) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_comments_target ON comments(title_slug, episode_num, created_at DESC);

    /* Persisted per-episode dub probe results (the SAME probe the watch page
       uses). available: 1 = real dub, 0 = dub is the sub file / absent,
       NULL = probe failed (unknown — never counted as a dub). The per-title
       DUB count shown anywhere in the UI is COUNT(available = 1) from here,
       never a copy of the episode count. */
    CREATE TABLE IF NOT EXISTS dub_checks (
      title_slug TEXT NOT NULL,
      ep_num INTEGER NOT NULL,
      available INTEGER,
      reason TEXT,
      checked_at TEXT NOT NULL,
      PRIMARY KEY (title_slug, ep_num),
      FOREIGN KEY (title_slug) REFERENCES titles(slug) ON DELETE CASCADE
    );
  `);

  try {
    db.exec("ALTER TABLE titles ADD COLUMN mal_id INTEGER DEFAULT 21;");
  } catch (e) {}

  try {
    db.exec("ALTER TABLE titles ADD COLUMN anilist_id INTEGER DEFAULT 21;");
  } catch (e) {}

  // Real-metadata columns (Phase 1). Added idempotently for existing databases.
  const metaColumns = [
    "old_title TEXT",
    "real_title TEXT",
    "romaji_title TEXT",
    "native_title TEXT",
    "score INTEGER",
    "status TEXT",
    "studios TEXT",
    "anilist_genres TEXT",
    "anilist_episodes INTEGER",
    "cover_local TEXT",
    "banner_local TEXT",
    "cover_remote TEXT",
    "banner_remote TEXT",
  ];
  for (const col of metaColumns) {
    try {
      db.exec(`ALTER TABLE titles ADD COLUMN ${col};`);
    } catch (e) {}
  }

  migrateCommentsForGuests();
  migrateUsersForSocial();
}

/* Social logins (Nov 2026) — older databases created `users` with
   password_hash NOT NULL, but social-only accounts have no password.
   SQLite cannot drop a NOT NULL in place, so the table is rebuilt once
   (data copied verbatim, ids preserved). The standard SQLite procedure:
   foreign keys OFF around the rebuild so the other tables' REFERENCES
   users(id) keep pointing at the (rebuilt) users table by name.
   Idempotent: a database that already has a nullable password_hash is
   left untouched. */
function migrateUsersForSocial() {
  const cols = db.prepare("PRAGMA table_info(users)").all();
  if (!cols.length) return;
  const hashCol = cols.find((c) => c.name === "password_hash");
  if (!hashCol || Number(hashCol.notnull) === 0) return;

  db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE users_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          email TEXT UNIQUE NOT NULL,
          password_hash TEXT,
          name TEXT NOT NULL,
          avatar_tone INTEGER DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);
      db.exec(`
        INSERT INTO users_new (id, email, password_hash, name, avatar_tone, created_at, updated_at)
        SELECT id, email, password_hash, name, avatar_tone, created_at, updated_at
        FROM users
      `);
      db.exec("DROP TABLE users");
      db.exec("ALTER TABLE users_new RENAME TO users");
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
  const violations = db.prepare("PRAGMA foreign_key_check").all();
  if (violations.length) {
    console.error("migrateUsersForSocial: foreign key violations after rebuild:", violations);
  }
}

/* Phase 3b — guest comments. Older databases created `comments` with
   user_id NOT NULL and no guest_name. SQLite cannot drop a NOT NULL or add
   a column with a default to an existing table in place, so the table is
   rebuilt once (data copied verbatim) and the index recreated. Idempotent:
   a database that already has the new shape is left untouched. */
function migrateCommentsForGuests() {
  const cols = db.prepare("PRAGMA table_info(comments)").all();
  if (!cols.length) return;
  const hasGuestName = cols.some((c) => c.name === "guest_name");
  const userIdCol = cols.find((c) => c.name === "user_id");
  if (hasGuestName && userIdCol && Number(userIdCol.notnull) === 0) return;

  db.transaction(() => {
    db.exec("ALTER TABLE comments RENAME TO comments_legacy");
    db.exec(`
      CREATE TABLE comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        guest_name TEXT,
        title_slug TEXT NOT NULL,
        episode_num INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (title_slug) REFERENCES titles(slug) ON DELETE CASCADE
      )
    `);
    db.exec(`
      INSERT INTO comments (id, user_id, title_slug, episode_num, content, created_at, guest_name)
      SELECT id, user_id, title_slug, episode_num, content, created_at, NULL
      FROM comments_legacy
    `);
    db.exec("DROP TABLE comments_legacy");
    db.exec("CREATE INDEX IF NOT EXISTS idx_comments_target ON comments(title_slug, episode_num, created_at DESC)");
  })();
}

// Auto-initialize schema on load
initSchema();
