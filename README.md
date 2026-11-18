# Ani Verse (Zoro UI × Aizen Animation Hybrid) ⚡

A high-octane, production-ready anime streaming platform fusing **Zoro.to's layout & dark aesthetic** with **Aizen-Verse's cinematic motion and cybernetic animation engine**. Powered by **ZokoAnime 1080p cloud streaming embeds** and a lightweight Node.js + Express + SQLite backend.

---

## 🎨 Design Fusion & Highlights

### 1. Zoro.to Signature UI
- **Obsidian Header & Navigation**: Zoro brand icon, sticky glass header, instant search autocomplete, shuffle/random anime button, and user session pill.
- **Spotlight Hero Carousel**: `#1 Spotlight` badge, dynamic backdrops, duration, TV/Movie tags, green `SUB` and pink `DUB` badges, "Watch Now" and "+ Add to List" buttons.
- **Trending Top 10 Rail**: Horizontal scroll rail featuring massive stylized rank numerals (`01`, `02`, `03`...) and posters.
- **4-Column Section**: Ranked anime blocks for `Top Airing`, `Most Popular`, `Most Favorite`, and `Latest Completed`.
- **Card Grid & Rich Hover Tooltips**: Anime posters with SUB/DUB episode counters, play button hover effect, and dynamic tooltips showing score, synopsis, studio, and genres.
- **12 Curated Genre Shelves (`genres.html`)**: Interactive cards for Action, Fantasy, Supernatural, Romance, Drama, Sports, Comedy, Mecha, Horror, Music, Mystery, and Slice of Life with kanji watermarks.
- **Tokyo Broadcast Schedule (`schedule.html`)**: Real-time Japan Standard Time (JST) clock, 7-day day selector tabs with auto-today detection, simulcast timetable, and instant toast reminders.
- **Zoro Watch Page (`watch.html`)**:
  - Full theatre mode player with ZokoAnime 1080p streaming.
  - Multi-track switcher (`Sub`, `Hard-sub`, `Dub`).
  - Episode selector grid with range tabs (`001 - 012` ... `024`).
  - Next / Previous episode controls.
  - Community discussion and live comment posting.

### 2. Aizen-Verse Motion & Cybernetic Engine
- **Cinematic Shutter Intro**: Vertical split-screen intro (`shutterUp` and `shutterDown` easing), glitching `ANI_VERSE` logo with chromatic aberration, loading progress bar (`INITIALIZING RESOURCES...`), and Japanese kanji decor (`アニメ`, `起動`). Replayable anytime via the header replay button.
- **Glassmorphism**: Frosted glass panels with `backdrop-filter: blur(16px)` and subtle glowing borders.
- **Ambient Lighting Glow**: Soft radial aura lighting reflecting off the hero banner and video player.
- **Toast Notifications**: Kinetic spring alerts for watchlist actions, reminders, and comments.
- **Responsive Mobile Drawer**: Smooth slide-in navigation drawer for mobile screens.

---

## 🎬 ZokoAnime Embed Player

Streaming is powered by the **ZokoAnime Embed Engine** (iframe + bidirectional `postMessage` protocol). No heavy video player libraries or local media hosting required.

**Embed URL Format**:
```
https://zokoanime.video/stream/mal/{malId}/{episode}/{track}?color=cae962&autoplay=1&asi=1&autonext=1
```

- **Tracks**: `sub` (Soft Subtitles), `hsub` (Hard Subtitles), `dub` (English Dubbed).
- **Events Supported**:
  - `watching-log`: Live playback progress tracking (`currentTime`, `duration`), dynamically synced to the SQLite database.
  - `ended`: Fires automatically upon episode completion to auto-play the next episode.
  - `fullscreen`: Synchronized full-screen state on the player stage.
- **Custom MAL ID Switcher**: Easily test any anime from MyAnimeList with the built-in MAL ID prompt on the watch page.

---

## 📂 Project Architecture

```
Aniverse/
├── ani-verse/                  # Static Frontend
│   ├── index.html              # Home: Hero spotlight, Trending Top 10, 4-column blocks
│   ├── browse.html             # Catalog: Search, genre filter chips, card grid
│   ├── genres.html             # Genres: 12 interactive shelves with kanji glyphs
│   ├── schedule.html           # Schedule: 7-day JST broadcast timetable
│   ├── watch.html              # Watch: ZokoAnime embed player, episodes grid, comments
│   ├── css/
│   │   └── zoro-aizen.css      # Consolidated master stylesheet
│   ├── js/
│   │   └── zoro-aizen.js       # Consolidated master controller & player logic
│   └── img/                    # High-res posters, banners, and icons
├── server/                     # Backend API & Database
│   ├── data/
│   │   └── aniverse.db         # SQLite database
│   ├── src/
│   │   ├── catalog.js          # Curated 18 anime titles with accurate MAL IDs
│   │   ├── config.js           # Environment & Zoko configuration
│   │   ├── db.js               # SQLite schema & migration runner
│   │   ├── index.js            # Express REST API & static file server
│   │   ├── seed.js             # Database seeder (titles, episodes, demo user)
│   │   ├── utils.js            # Cryptography & helper functions
│   │   └── zoko.js             # Embed URL generator
│   └── package.json
└── README.md
```

---

## 🚀 Getting Started

### 1. Prerequisites
- **Node.js**: v18+ or v20+
- **npm**

### 2. Seed the Database
```bash
cd server
npm run seed
```
*Seeds 18 anime titles, 232 episodes, and creates a demo account (`demo@aniverse.io` / `password123`).*

### 3. Start the Server
```bash
npm start
```
Or for auto-reload during development:
```bash
npm run dev
```

Visit the application at:
👉 **[http://localhost:4000](http://localhost:4000)**

---

## 🔑 Demo Account
- **Email**: `demo@aniverse.io`
- **Password**: `password123`
*(Or click "Quick Fill Demo Account" in the Sign In modal).*
