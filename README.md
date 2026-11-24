# AniFlick (Zoro UI × Aizen Animation Hybrid) ⚡

A high-performance anime streaming web application fusing **Zoro.to's iconic layout and dark aesthetic** with **Aizen-Verse's cinematic motion and cybernetic animation design**. Powered strictly and exclusively by the **ZokoAnime 1080p Embed Player**.

---

## 🏗️ Repository Architecture

```
Aniverse/
├── .gitignore                  # Ignores node_modules, .env, *.db-shm, *.db-wal
├── README.md                   # Project documentation & runbook
├── ani-verse/                  # Static Frontend
│   ├── index.html              # Home: Hero spotlight, Trending Top 10, 3-column blocks, live AniList rails
│   ├── browse.html             # Browse: LIVE AniList catalog, genre/format/status/sort/year filters
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
    │   ├── anilist.js            # AniList GraphQL proxy: caching, adult filter, is18plus flag
    │   ├── catalog.js          # Curated anime catalog with accurate MAL IDs
    │   ├── config.js           # Server configuration & environment variables
    │   ├── db.js               # SQLite schema, tables, and migration runner
    │   ├── index.js            # Express REST API & static file server
    │   ├── seed.js             # Database seeder
    │   ├── utils.js            # Password hashing, tokens, view transformers
    │   └── zoko.js             # Server-side ZokoAnime embed URL builder
    └── test/
        ├── smoke.js            # Unit tests for buildEmbedUrl (11 checks)
        ├── e2e.js              # Integration tests: config, stream, search, dub gate, episode titles, live catalog (20 tests)
        ├── setup-db.js         # Self-seeding TEMP database + offline enrichment (fresh-clone safe)
        ├── make-fixture.mjs    # Regenerates the metadata fixture from the live DB
        └── fixtures/
            └── enriched-metadata.json  # Offline snapshot of real titles + episode names
```

---

## 🌍 Live Catalog: AniList (full world catalog)

The curated 18-title catalog stays the site's core (full dub badges, real episode
names, watch progress). Around it, the **entire AniList catalog (~20,000 titles)**
is available through a server-side proxy — the browser never calls AniList directly.

| Endpoint | Purpose |
|---|---|
| `GET /api/search?q=&page=` | Live search. Returns `local` (curated matches) **and** `results` (live matches), deduped by MAL id |
| `GET /api/browse?sort=&genre=&format=&status=&year=&page=` | One flexible list endpoint over the whole catalog (12 per page) |
| `GET /api/live/:anilistId` | One title (1 h cache). Adult/unknown ids answer `404 {error:"not_available"}` |
| `GET /api/airing?page=` | Episodes aired in the last 7 days, newest first (24 per page, 10 min cache) |

**Content rules (enforced server-side on every endpoint):**
- `isAdult: false` is added to every AniList query, and adult media are filtered
  again on the way out — **hentai never reaches the site** (search, browse, airing,
  direct links). Titles whose own name/description names the content are screened
  too, because AniList does not flag every hentai entry.
- `is18plus` is a **separate** rule: a title whose genres include `Ecchi` stays
  visible and is tagged **18+** on cards, detail and watch pages. The UI only
  renders the badge from this server-computed flag.
- When AniList is down, rate-limited or slow, the endpoints answer
  `502 {error:"search_busy"}` and the UI shows *"Service is busy — try again in a
  moment."* — the local catalog keeps rendering (Browse falls back to the
  18-title library with a *"Showing your library"* notice).

**Live pages:** `detail.html?live=<anilistId>` and `watch.html?live=<anilistId>&ep=<n>`
reuse the existing layouts. Live titles are never written to the database: no
catalog import, no dub rows, no watchlist entries. Their episode list comes from
the **aired** episode count (an airing title stops at `nextAiringEpisode - 1`),
their dub availability is **unknown** (Sub and Dub both stay enabled), and their
resume progress lives under the `live-<anilistId>` localStorage namespace so it
never collides with the catalog slugs.


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
| `ANILIST_URL` | `https://graphql.anilist.co` | AniList GraphQL endpoint (override for tests/offline) |
| `DATA_DIR` | `<SERVER_ROOT>/data` | Directory containing SQLite database |
| `DB_PATH` | `<DATA_DIR>/aniverse.db` | Path to SQLite database file |

### 📧 Email setup (password reset + social set-password)

Forgot-password and the set-password email for new social accounts send via
SMTP (Nodemailer). Mail is **optional**: the app runs fine without it, and
until SMTP is configured the forgot-password endpoint still answers its
generic message — it just sends nothing and stores no token (and logs
nothing about the request).

| Variable | Default | Description |
|---|---|---|
| `SMTP_HOST` | — | SMTP server hostname (required for mail to send) |
| `SMTP_PORT` | `587` | SMTP port |
| `SMTP_SECURE` | `false` | `"true"` for implicit TLS (port 465) |
| `SMTP_USER` | — | SMTP username (optional — some relays need none) |
| `SMTP_PASS` | — | SMTP password |
| `MAIL_FROM` | — | Sender address shown in the inbox (required for mail to send) |

Privacy notes: only the SHA-256 hash of a reset token is stored (never the
raw token); tokens are single-use (reset links 1 hour, set-password links
24 hours); a password change deletes all of the user's tokens and sessions;
the forgot-password response is identical for registered and unregistered
emails; no email address or token is ever written to a log line.

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
Runs `test/smoke.js` (11 unit checks) and `test/e2e.js` (62 integration tests) — **73 tests, all passing on a fresh clone with no manual steps**.

The E2E suite is fully self-contained: `test/setup-db.js` creates a **temporary database** (never touches `data/aniverse.db`), seeds the catalog, and enriches it offline from `test/fixtures/enriched-metadata.json` (a snapshot of the real titles + real per-title episode names). No network access, no `npm run seed`, and no metadata fetches are needed before `npm test`. The temporary database is deleted on exit.

> Regenerate the fixture after catalog/metadata changes: `node test/make-fixture.mjs` (reads the enriched live database).

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

### 5. Live database with real metadata (optional, needs network)
A fresh `npm run seed` populates **fictional placeholder names** and generic `Episode N` titles. To enrich the live database with real anime titles and real per-title episode names:
```bash
npm run seed                          # catalog + episodes + demo user
node scripts/fetch-metadata.mjs       # real titles/synopses/posters (AniList)
node scripts/fetch-episode-titles.mjs # real episode titles per title (Kitsu)
```
This enrichment is only for the running app — the test suite does not depend on it.

---

## 👤 Demo User Account

A demo account (`Akihiro`) is seeded automatically — but **only in
development and test environments** (`NODE_ENV !== "production"`). It never
exists on the production site, and its credentials are not published here.
To sign in locally, register your own account or check the seed in
`server/src/seed.js`.

---

## 🚢 Production Notes

AniFlick is a **personal / demo project**. The video players are **unofficial
third-party embeds** (ZokoAnime, animeTVplus, MegaPlay); the site stores no
video files and makes no claim about them. Titles, posters and episode names
come from AniList; the site is not affiliated with AniList or with any player
provider. Licensed under MIT — see [LICENSE](./LICENSE) (Copyright 2026
faijaleaqbal).

### Required environment variables
| Variable | Default | Notes |
|---|---|---|
| `PORT` | `4000` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` only behind a reverse proxy. |
| `DATA_DIR` | `<server>/data` | Directory holding `aniverse.db`. Must be writable. |

`DB_PATH` overrides the database file inside `DATA_DIR`. Optional: `NODE_ENV`,
`COOKIE_SECURE`, `ANIVERSE_TRUST_PROXY`, `ZOKO_*`, `ANILIST_URL` (see the
environment table above).

> **Behind a reverse proxy:** set `ANIVERSE_TRUST_PROXY=true` so `req.ip` is
> read from `X-Forwarded-For`. Without it every visitor shares the proxy's
> address and the login/comment rate limits effectively become global.

### Run
```bash
cd server
npm install
npm run seed          # catalog + demo user (first run only)
npm start             # http://127.0.0.1:4000
```

### systemd unit (sketch)
```ini
[Unit]
Description=AniFlick API
After=network.target

[Service]
WorkingDirectory=/opt/aniverse/server
Environment=NODE_ENV=production
Environment=PORT=4000
Environment=HOST=127.0.0.1
Environment=DATA_DIR=/var/lib/aniverse
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
User=aniverse

[Install]
WantedBy=multi-user.target
```

### Caddy (sketch)
```caddy
aniversetesting.duckdns.org {
    reverse_proxy 127.0.0.1:4000
}
```
Caddy terminates TLS and sets `X-Forwarded-For`; run the app with
`ANIVERSE_TRUST_PROXY=true` (and `COOKIE_SECURE=true`) behind it.

### Tests
`npm test` runs `test/smoke.js` (11 checks) and `test/e2e.js` (62 integration
tests) — 73 total, all offline (AniList is mocked; the live database is never
touched).
