# Ani Verse (Zoro UI × Aizen Animation Hybrid) ⚡

A high-performance anime streaming web application fusing **Zoro.to's iconic layout and dark aesthetic** with **Aizen-Verse's cinematic motion and cybernetic animation design**. Powered strictly and exclusively by the **ZokoAnime 1080p Embed Player**.

---

## 🏗️ Repository Architecture

```
Aniverse/
├── .gitignore                  # Ignores node_modules, .env, *.db-shm, *.db-wal
├── README.md                   # Project documentation & runbook
├── ani-verse/                  # Static Frontend
│   ├── index.html              # Home: Hero spotlight, Trending Top 10, 4-column blocks
│   ├── browse.html             # Catalog: Search, genre filter chips, card grid
│   ├── genres.html             # Genres: 12 interactive shelves with kanji glyphs
│   ├── schedule.html           # Schedule: 7-day Tokyo JST broadcast timetable
│   ├── watch.html              # Watch: ZokoAnime embed player, episodes grid, comments
│   ├── css/
│   │   ├── zoro-aizen.css      # Consolidated master stylesheet
│   │   └── zoko-player.css     # Embed player styles (wrap, spinner, overlay, toasts)
│   ├── js/
│   │   └── zoro-aizen.js       # Master frontend controller (single source of truth: inline player & continue watching)
│   └── img/                    # High-res posters, banners, and icons
└── server/                     # Backend API & Database
    ├── package.json            # Node.js manifest with test, seed, dev, start scripts
    ├── package-lock.json       # Locked dependency tree (better-sqlite3 v12, express v5)
    ├── data/
    │   └── aniverse.db         # SQLite database
    ├── src/
    │   ├── catalog.js          # Curated anime catalog with accurate MAL IDs
    │   ├── config.js           # Server configuration & environment variables
    │   ├── db.js               # SQLite schema, tables, and migration runner
    │   ├── index.js            # Express REST API & static file server
    │   ├── seed.js             # Database seeder
    │   ├── utils.js            # Password hashing, tokens, view transformers
    │   └── zoko.js             # Server-side ZokoAnime embed URL builder
    └── test/
        ├── smoke.js            # Unit tests for buildEmbedUrl
        └── e2e.js              # Integration tests for /api/player/config & /api/stream
```

---

## 🎬 Streaming Engine: ZokoAnime Embed Only
Streaming in this application is handled **exclusively** by the official [ZokoAnime](https://zokoanime.video/docs) embed player. No third-party video element, external scrapers, or alternate players are used.

### Embed URL Specification
```
https://zokoanime.video/stream/{source}/{id}/{episode}/{track}?color=cae962&autoplay=1|0&autoskip=1|0&autonext=1|0[&t=<seconds>]
```
- `source`: `"mal"` | `"anilist"`
- `id`: Numeric MyAnimeList or AniList ID (never hardcoded fallbacks)
- `episode`: Numeric episode number
- `track`: `"sub"` | `"hsub"` | `"dub"`
- Query parameters (only 5 exist):
  - `?color=<hex>`: Zoro lime accent (`cae962`)
  - `?autoplay=1|0`: Automatic playback
  - `?autoskip=1|0`: Auto-skips intro and outro
  - `?autonext=1|0`: Auto-next readiness
  - `?t=<seconds>`: Resumes playback from saved position

### Bidirectional postMessage Protocol
- Target origin check: Every message sent and received strictly verifies `event.origin === "https://zokoanime.video"` and `channel: "zokoanime"`.
- Events received: `ready`, `play`, `pause`, `time`, `watching-log`, `skipped`, `ended`, `error`, `fullscreen`.
- Commands sent: `play`, `pause`, `seek {time}` (absolute seconds), `autoplay {on}`, `autoskip {on}`, `autonext {on}`, `fullscreen {active}`.

### Player Implementation
The player and progress tracking are implemented directly inside `ani-verse/js/zoro-aizen.js` as the single source of truth:
- **Watch Page Player UI** (`initWatchPage`): Track switcher (`sub`/`hsub`/`dub`), Autoplay / Auto-skip / Auto-next live toggles, episode navigation, parent-driven auto-next on `ended`, server-backed resume from `savedPositionSec` via `?t=`, toast notifications, error/retry overlay, and keyboard shortcuts (`Space`, `F`, `←`/`→`).
- **Continue Watching Rail** (`initContinueWatchingRail`): Server-backed rail on the home page querying `GET /api/progress/continue`, displaying anime poster, episode number, progress bar, and direct resume link. Hidden for guest users or when no watch progress exists.

Behaviour notes:
- Episode and track changes only swap the iframe `src` — the page never reloads.
- Toggles send the matching `postMessage` command *and* update the URL params used for the next episode load, then persist to `localStorage`.
- Progress is stored per anime + episode (5s throttle) and resumed with `?t=` when the saved position sits between 30s and 95% of the runtime.
- The iframe is never given a `sandbox` attribute (the player refuses to run sandboxed) and always keeps `allow="fullscreen; autoplay"`.
- Anime ids come from the catalog (`malId` / `anilistId`); the "Switch Anime MAL ID" button stores a per-anime override instead of guessing ids.

---

## ⚙️ Environment Variables

The server works out of the box with sensible defaults, or can be configured via environment variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4000` | Port for Express HTTP server |
| `HOST` | `127.0.0.1` | Host address to bind |
| `NODE_ENV` | `development` | Environment (`development` / `production`) |
| `ZOKO_EMBED_ORIGIN` | `https://zokoanime.video` | Official ZokoAnime embed origin |
| `ZOKO_DEFAULT_SOURCE` | `mal` | Default anime metadata source (`mal` or `anilist`) |
| `ZOKO_DEFAULT_TRACK` | `sub` | Default audio track (`sub`, `hsub`, `dub`) |
| `ZOKO_DEFAULT_COLOR` | `cae962` | Player controls highlight color |
| `DATA_DIR` | `<SERVER_ROOT>/data` | Directory containing SQLite database |
| `DB_PATH` | `<DATA_DIR>/aniverse.db` | Path to SQLite database file |

---

## 🚀 Quick Start

### 1. Prerequisites
- **Node.js**: v20 LTS, v22, or v24 (powered by `better-sqlite3` v12 with prebuilt binaries)
- **npm**: v9 or higher

### 2. Installation & Setup
```bash
# Navigate to the server directory
cd server

# Install dependencies cleanly
npm install

# Seed the database (populates anime catalog, episodes, and demo user)
npm run seed
```

### 3. Run Automated Tests
```bash
npm test
```
Runs both `test/smoke.js` (10 unit checks) and `test/e2e.js` (6 integration tests).

### 4. Start the Application
```bash
npm start
```
For auto-reloading during development:
```bash
npm run dev
```

Visit the application in your browser:
👉 **[http://localhost:4000](http://localhost:4000)**

---

## 👤 Demo User Account
- **Email**: `demo@aniverse.io`
- **Password**: `password123`
*(Or click "Quick Fill Demo Account" inside the Sign In modal).*
