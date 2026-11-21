import express from "express";
import path from "node:path";
import {
  HOST,
  PORT,
  SITE_ROOT,
  SESSION_COOKIE,
  SESSION_TTL_DAYS,
  SESSION_REFRESH_BELOW_MS,
  COOKIE_SECURE,
  PASSWORD_MIN,
  PASSWORD_MAX,
  NAME_MIN,
  NAME_MAX,
  HISTORY_LIMIT,
  CONTINUE_LIMIT,
  ZOKO_EMBED_ORIGIN,
  ZOKO_DEFAULT_SOURCE,
  ZOKO_DEFAULT_TRACK,
  ZOKO_DEFAULT_COLOR,
} from "./config.js";
import { db } from "./db.js";
import { buildEmbedUrl, ZOKO_SOURCES, ZOKO_TRACKS } from "./zoko.js";
import { checkDubAvailability } from "./dub-check.js";
import {
  AniListBusyError,
  searchAniList,
  SEARCH_PAGE_SIZE,
  browseAniList,
  getLiveTitle,
  getAiringSchedule,
} from "./anilist.js";
import {
  ApiError,
  badRequest,
  unauthorized,
  notFound,
  conflict,
  nowIso,
  addMs,
  randomToken,
  hashPassword,
  verifyPassword,
  burnPasswordCheck,
  normalizeEmail,
  cleanText,
  parseCookies,
  toInt,
  userView,
  titleView,
} from "./utils.js";

const app = express();

// Body parser
app.use(express.json());

// Cookie parsing middleware
app.use((req, res, next) => {
  req.cookies = parseCookies(req.headers.cookie);
  next();
});

// Session helpers
function setSessionCookie(res, token, expiresAt) {
  const expires = new Date(expiresAt).toUTCString();
  const flags = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expires}`,
  ];
  if (COOKIE_SECURE) flags.push("Secure");
  res.setHeader("Set-Cookie", flags.join("; "));
}

function clearSessionCookie(res) {
  const flags = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
  ];
  if (COOKIE_SECURE) flags.push("Secure");
  res.setHeader("Set-Cookie", flags.join("; "));
}

// Authentication & Session Middleware
app.use((req, res, next) => {
  const token = req.cookies[SESSION_COOKIE];
  req.user = null;
  req.session = null;

  if (!token) return next();

  try {
    const session = db
      .prepare(`
        SELECT s.id, s.user_id, s.expires_at,
               u.id as u_id, u.email, u.name, u.avatar_tone, u.created_at, u.updated_at
        FROM sessions s
        JOIN users u ON s.user_id = u.id
        WHERE s.id = ?
      `)
      .get(token);

    if (!session) {
      clearSessionCookie(res);
      return next();
    }

    const expiresTime = Date.parse(session.expires_at);
    if (Date.now() > expiresTime) {
      db.prepare("DELETE FROM sessions WHERE id = ?").run(token);
      clearSessionCookie(res);
      return next();
    }

    req.session = { id: session.id, userId: session.user_id, expiresAt: session.expires_at };
    req.user = {
      id: session.u_id,
      email: session.email,
      name: session.name,
      avatarTone: session.avatar_tone,
      createdAt: session.created_at,
      updatedAt: session.updated_at,
    };

    // Auto-refresh session if close to expiry
    if (expiresTime - Date.now() < SESSION_REFRESH_BELOW_MS) {
      const newExpires = addMs(nowIso(), SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
      db.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run(newExpires, token);
      setSessionCookie(res, token, newExpires);
    }
  } catch (err) {
    console.error("Session lookup error:", err);
  }

  next();
});

function requireAuth(req, res, next) {
  if (!req.user) {
    throw unauthorized("Please sign in to access this feature.");
  }
  next();
}

/* ==========================================================================
   AUTH ROUTES
   ========================================================================== */

app.post("/api/auth/register", async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const name = cleanText(req.body.name);

    if (!email || !/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) {
      throw badRequest("A valid email address is required.");
    }
    if (!name || name.length < NAME_MIN || name.length > NAME_MAX) {
      throw badRequest(`Display name must be between ${NAME_MIN} and ${NAME_MAX} characters.`);
    }
    if (!password || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      throw badRequest(`Password must be between ${PASSWORD_MIN} and ${PASSWORD_MAX} characters.`);
    }

    const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
    if (existing) {
      throw conflict("EMAIL_IN_USE", "An account with this email already exists.");
    }

    const passwordHash = await hashPassword(password);
    const now = nowIso();
    const avatarTone = Math.floor(Math.random() * 6) + 1;

    const result = db.prepare(`
      INSERT INTO users (email, password_hash, name, avatar_tone, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(email, passwordHash, name, avatarTone, now, now);

    const user = {
      id: result.lastInsertRowid,
      email,
      name,
      avatar_tone: avatarTone,
      created_at: now,
      updated_at: now,
    };

    // Create session
    const token = randomToken(32);
    const expiresAt = addMs(now, SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
    db.prepare(`
      INSERT INTO sessions (id, user_id, expires_at, created_at, ip, user_agent)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(token, user.id, expiresAt, now, req.ip || "", req.headers["user-agent"] || "");

    setSessionCookie(res, token, expiresAt);
    res.status(201).json({ ok: true, user: userView(user) });
  } catch (err) {
    next(err);
  }
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = typeof req.body.password === "string" ? req.body.password : "";

    if (!email || !password) {
      throw badRequest("Email and password are required.");
    }

    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user) {
      await burnPasswordCheck(password);
      throw unauthorized("Invalid email or password.");
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      throw unauthorized("Invalid email or password.");
    }

    const now = nowIso();
    const token = randomToken(32);
    const expiresAt = addMs(now, SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

    db.prepare(`
      INSERT INTO sessions (id, user_id, expires_at, created_at, ip, user_agent)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(token, user.id, expiresAt, now, req.ip || "", req.headers["user-agent"] || "");

    setSessionCookie(res, token, expiresAt);
    res.json({ ok: true, user: userView(user) });
  } catch (err) {
    next(err);
  }
});

app.post("/api/auth/logout", (req, res) => {
  if (req.session) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(req.session.id);
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/auth/me", (req, res) => {
  if (!req.user) {
    return res.json({ ok: true, user: null });
  }

  const watchlistCount = db
    .prepare("SELECT COUNT(*) as count FROM watchlist WHERE user_id = ?")
    .get(req.user.id).count;

  const continueCount = db
    .prepare("SELECT COUNT(*) as count FROM watch_progress WHERE user_id = ?")
    .get(req.user.id).count;

  res.json({
    ok: true,
    user: userView(req.user),
    stats: {
      watchlistCount,
      continueCount,
    },
  });
});

/* ==========================================================================
   CATALOG & TITLES ROUTES
   ========================================================================== */

/* Per-title DUB counts come from the persisted per-episode probe results
   (dub_checks) — the same probe the watch page uses. Only CONFIRMED dubs
   (available = 1) are counted; failed/unknown probes never inflate it. This
   is what every badge/list/detail page displays, so they all agree. */
const dubCountStmt = db.prepare(
  "SELECT COUNT(*) AS c FROM dub_checks WHERE title_slug = ? AND available = 1"
);
const dubCountsAllStmt = db.prepare(
  "SELECT title_slug, COUNT(*) AS c FROM dub_checks WHERE available = 1 GROUP BY title_slug"
);
/* Per-episode rows for ONE title. The watch page seeds its per-episode dub
   cache from these on load so the track pill is correct on the first frame of
   a COLD episode (no fresh probe needed). Same table as the DUB count above —
   no new probe, no new source of truth. NULL = probe failed / unknown and is
   deliberately omitted (the client stays conservative: Sub until proven). */
const dubEpisodesStmt = db.prepare(
  "SELECT ep_num, available FROM dub_checks WHERE title_slug = ? AND available IS NOT NULL ORDER BY ep_num ASC"
);
function withDubCount(view) {
  if (!view) return view;
  view.dubCount = dubCountStmt.get(view.slug).c;
  return view;
}
const upsertDubCheck = db.prepare(`
  INSERT INTO dub_checks (title_slug, ep_num, available, reason, checked_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(title_slug, ep_num) DO UPDATE SET
    available = excluded.available,
    reason = excluded.reason,
    checked_at = excluded.checked_at
`);
function persistDubCheck(slug, epNum, result) {
  const available = result.available === true ? 1 : result.available === false ? 0 : null;
  upsertDubCheck.run(slug, epNum, available, result.reason || null, nowIso());
}

app.get("/api/titles", (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
  const genre = typeof req.query.genre === "string" ? req.query.genre.trim().toLowerCase() : "";
  const sort = req.query.sort || "newest";
  const limit = Math.min(Math.max(toInt(req.query.limit, 24), 1), 100);
  const offset = Math.max(toInt(req.query.offset, 0), 0);

  let whereClauses = [];
  let params = [];

  if (q) {
    /* Search matches REAL titles only (english/romaji/native). The fictional
       placeholder names live in old_title and must NOT match (searching
       "Ronin" used to return One Piece). Synopsis/tagline are not titles. */
    whereClauses.push(
      "(LOWER(name) LIKE ? OR LOWER(real_title) LIKE ? OR LOWER(romaji_title) LIKE ? OR LOWER(native_title) LIKE ?)"
    );
    const pattern = `%${q}%`;
    params.push(pattern, pattern, pattern, pattern);
  }

  if (genre && genre !== "all") {
    whereClauses.push("LOWER(genres) LIKE ?");
    params.push(`%${genre}%`);
  }

  const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(" AND ")}` : "";

  let orderSql = "ORDER BY year DESC, slug ASC";
  if (sort === "oldest") orderSql = "ORDER BY year ASC, slug ASC";
  if (sort === "az") orderSql = "ORDER BY name ASC";

  const totalCount = db
    .prepare(`SELECT COUNT(*) as count FROM titles ${whereSql}`)
    .get(...params).count;

  const rows = db
    .prepare(`SELECT * FROM titles ${whereSql} ${orderSql} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);

  const dubCounts = {};
  for (const r of dubCountsAllStmt.all()) dubCounts[r.title_slug] = r.c;

  res.json({
    ok: true,
    total: totalCount,
    limit,
    offset,
    titles: rows.map((r) => {
      const view = titleView(r);
      view.dubCount = dubCounts[r.slug] || 0;
      return view;
    }),
  });
});

app.get("/api/genres", (req, res) => {
  const rows = db.prepare("SELECT genres FROM titles").all();
  const counts = {};
  for (const row of rows) {
    if (!row.genres) continue;
    const list = row.genres.split(",").map((g) => g.trim().toLowerCase()).filter(Boolean);
    for (const g of list) {
      counts[g] = (counts[g] || 0) + 1;
    }
  }
  res.json({
    ok: true,
    totalTitles: rows.length,
    counts,
  });
});

app.get("/api/titles/:slug", (req, res) => {
  const { slug } = req.params;
  const row = db.prepare("SELECT * FROM titles WHERE slug = ?").get(slug);
  if (!row) throw notFound("Title not found.");

  const episodes = db
    .prepare("SELECT ep_num, title, duration_sec, video_url FROM episodes WHERE title_slug = ? ORDER BY ep_num ASC")
    .all(slug);

  let userState = null;
  if (req.user) {
    const inWatchlist = !!db
      .prepare("SELECT 1 FROM watchlist WHERE user_id = ? AND title_slug = ?")
      .get(req.user.id, slug);

    const progress = db
      .prepare(`
        SELECT episode_num, position_sec, duration_sec, updated_at
        FROM watch_progress
        WHERE user_id = ? AND title_slug = ?
        ORDER BY updated_at DESC LIMIT 1
      `)
      .get(req.user.id, slug);

    userState = {
      inWatchlist,
      lastProgress: progress || null,
    };
  }

  const dubRows = dubEpisodesStmt.all(slug);

  res.json({
    ok: true,
    title: withDubCount(titleView(row)),
    episodes,
    /* Seed data for the watch page's per-episode dub cache (probe-backed). */
    dubEpisodes: dubRows.filter((r) => r.available === 1).map((r) => r.ep_num),
    noDubEpisodes: dubRows.filter((r) => r.available === 0).map((r) => r.ep_num),
    userState,
  });
});

app.get("/api/titles/:slug/episodes/:ep", (req, res) => {
  const { slug } = req.params;
  const epNum = toInt(req.params.ep, 1);

  const title = db.prepare("SELECT * FROM titles WHERE slug = ?").get(slug);
  if (!title) throw notFound("Title not found.");

  const episode = db
    .prepare("SELECT * FROM episodes WHERE title_slug = ? AND ep_num = ?")
    .get(slug, epNum);

  if (!episode) throw notFound(`Episode ${epNum} not found.`);

  const prevEp = db
    .prepare("SELECT ep_num FROM episodes WHERE title_slug = ? AND ep_num < ? ORDER BY ep_num DESC LIMIT 1")
    .get(slug, epNum);

  const nextEp = db
    .prepare("SELECT ep_num FROM episodes WHERE title_slug = ? AND ep_num > ? ORDER BY ep_num ASC LIMIT 1")
    .get(slug, epNum);

  let progress = null;
  if (req.user) {
    progress = db
      .prepare("SELECT position_sec, duration_sec FROM watch_progress WHERE user_id = ? AND title_slug = ? AND episode_num = ?")
      .get(req.user.id, slug, epNum);
  }

  res.json({
    ok: true,
    title: titleView(title),
    episode: {
      epNum: episode.ep_num,
      title: episode.title,
      durationSec: episode.duration_sec,
      videoUrl: episode.video_url,
      prevEp: prevEp ? prevEp.ep_num : null,
      nextEp: nextEp ? nextEp.ep_num : null,
      savedPositionSec: progress ? progress.position_sec : 0,
    },
  });
});

/* ==========================================================================
   LIVE CATALOG (AniList) ROUTES
   The browser never talks to AniList directly — everything goes through these
   server-side endpoints. Every AniList query excludes adult titles, and every
   title object carries the server-computed `is18plus` flag (Ecchi genre).
   ========================================================================== */

/* The 18 curated catalog titles, indexed by MAL id and AniList id. This is
   the dedupe key that keeps a live AniList result and its catalog twin from
   showing up twice. Rebuilt per request — 18 rows, cheaper than a cache. */
function catalogIndex() {
  const rows = db.prepare("SELECT * FROM titles").all();
  const byMal = new Map();
  const byAnilist = new Map();
  for (const row of rows) {
    if (row.mal_id != null) byMal.set(Number(row.mal_id), row);
    if (row.anilist_id != null) byAnilist.set(Number(row.anilist_id), row);
  }
  /* Probe-backed DUB counts by slug, so a live result that IS a catalog
     title carries the SAME dub number as its spotlight/detail cards. */
  const dubBySlug = new Map();
  for (const r of dubCountsAllStmt.all()) dubBySlug.set(r.title_slug, r.c);
  return { rows, byMal, byAnilist, dubBySlug };
}

/* Find the catalog row that owns this live title (MAL id first, AniList id
   as the fallback — the two catalogs disagree on some ids). */
function catalogRowFor(live, index) {
  if (!live) return null;
  if (live.malId != null && index.byMal.has(live.malId)) return index.byMal.get(live.malId);
  if (live.anilistId != null && index.byAnilist.has(live.anilistId)) return index.byAnilist.get(live.anilistId);
  return null;
}

/* Attach the catalog slug (when this live title IS a catalog title) so the UI
   can link to the richer catalog detail page instead of the live one. The
   catalog twin's PROBE-BACKED dub count travels with it too, so a live card
   shows the same DUB number as the spotlight/detail/catalog cards. A pure
   live title has no row and never gets a DUB badge — its dub availability is
   unknown and must not be invented. */
function withCatalogSlug(live, index) {
  if (!live) return live;
  const row = catalogRowFor(live, index);
  if (row) {
    live.catalogSlug = row.slug;
    live.dubCount = index.dubBySlug.get(row.slug) || 0;
    /* ONE source of truth for the SUB count. AniList leaves `episodes` null
       for long-running / still-airing titles (One Piece, the current
       seasons), which used to leave a bare "SUB" badge with no number. The
       catalog twin's curated episode count fills that gap, so the same title
       shows the same number on every surface (Browse, search, detail and
       More Like This). */
    if (live.episodes == null && row.episodes != null) {
      live.episodes = Number(row.episodes);
    }
  }
  return live;
}

/* Local catalog matches for a search query — the SAME matching rules as
   GET /api/titles?q= (real titles only, never the old placeholder names). */
function localSearchRows(q) {
  const pattern = `%${String(q).toLowerCase()}%`;
  return db
    .prepare(`
      SELECT * FROM titles
      WHERE LOWER(name) LIKE ? OR LOWER(real_title) LIKE ?
         OR LOWER(romaji_title) LIKE ? OR LOWER(native_title) LIKE ?
      ORDER BY year DESC, slug ASC
    `)
    .all(pattern, pattern, pattern, pattern);
}

/* AniList is down / rate-limited / slow: HTTP 502 {error:"search_busy"}.
   The UI shows "Service is busy — try again in a moment." and the local
   catalog keeps rendering. Never a stack trace, never a crash. */
function busyResponse(res) {
  return res.status(502).json({ ok: false, error: "search_busy" });
}

/* GET /api/search?q=<query>&page=<n>
   LOCAL catalog matches first ("On Aniverse"), AniList results below
   ("More results"). An AniList result that IS a catalog title (same MAL id)
   is shown ONLY as the catalog entry — never twice. */
app.get("/api/search", async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const page = Math.max(toInt(req.query.page, 1), 1);
    const index = catalogIndex();

    if (!q) {
      return res.json({
        ok: true,
        query: "",
        local: [],
        results: [],
        pageInfo: { total: 0, currentPage: 1, lastPage: 1, hasNextPage: false },
      });
    }

    const live = await searchAniList(q);

    /* Catalog entries for this query: the text matches, PLUS any catalog
       title that the live results revealed (same MAL id) — that title is
       shown once, under "On Aniverse", and dropped from the live list.
       The twin check runs over the WHOLE snapshot, so a catalog title is
       never shown twice and never appears on two different pages. */
    const localRows = localSearchRows(q);
    const localBySlug = new Map();
    for (const row of localRows) localBySlug.set(row.slug, row);

    const allResults = [];
    for (const item of live.items) {
      const row = catalogRowFor(item, index);
      if (row) {
        if (!localBySlug.has(row.slug)) {
          localBySlug.set(row.slug, row);
          localRows.push(row);
        }
        continue; // dedupe: the catalog entry represents this title
      }
      allResults.push(item);
    }

    /* One stable result set for the whole query: every page is a slice of
       it, so the total never changes and no page repeats another page. */
    const total = allResults.length;
    const lastPage = Math.max(1, Math.ceil(total / SEARCH_PAGE_SIZE));
    const safePage = Math.min(page, lastPage);
    const start = (safePage - 1) * SEARCH_PAGE_SIZE;
    const results = allResults.slice(start, start + SEARCH_PAGE_SIZE);

    /* The curated shelf ("On Aniverse") belongs to the FIRST page only —
       repeating it on every page would show the same titles twice. */
    const local = safePage === 1 ? localRows.slice(0, 12).map((row) => withDubCount(titleView(row))) : [];

    res.json({
      ok: true,
      query: q,
      page: safePage,
      local,
      results,
      pageInfo: {
        total,
        currentPage: safePage,
        lastPage,
        hasNextPage: safePage < lastPage,
      },
    });
  } catch (err) {
    if (err instanceof AniListBusyError) return busyResponse(res);
    next(err);
  }
});

/* GET /api/browse?sort=&genre=&format=&status=&year=&page=
   One flexible list endpoint over the whole AniList catalog. */
app.get("/api/browse", async (req, res, next) => {
  try {
    const index = catalogIndex();
    const live = await browseAniList({
      sort: req.query.sort,
      genre: req.query.genre,
      format: req.query.format,
      status: req.query.status,
      year: req.query.year,
      page: req.query.page,
    });
    res.json({
      ok: true,
      page: Math.max(toInt(req.query.page, 1), 1),
      results: live.results.map((item) => withCatalogSlug(item, index)),
      pageInfo: live.pageInfo,
    });
  } catch (err) {
    if (err instanceof AniListBusyError) return busyResponse(res);
    next(err);
  }
});

/* GET /api/live/:anilistId — one live title (1h cache). An adult title
   resolves to null here and answers 404 {error:"not_available"}, so it
   cannot be opened even by direct link. */
app.get("/api/live/:anilistId", async (req, res, next) => {
  try {
    const id = toInt(req.params.anilistId, null);
    if (id == null || id <= 0) {
      return res.status(404).json({ ok: false, error: "not_available" });
    }
    const title = await getLiveTitle(id);
    if (!title) {
      return res.status(404).json({ ok: false, error: "not_available" });
    }
    const index = catalogIndex();
    res.json({ ok: true, title: withCatalogSlug(title, index) });
  } catch (err) {
    if (err instanceof AniListBusyError) return busyResponse(res);
    next(err);
  }
});

/* GET /api/airing?page=<n> — episodes aired in the last 7 days, newest
   first (10-minute cache). Adult media are skipped server-side. */
app.get("/api/airing", async (req, res, next) => {
  try {
    const index = catalogIndex();
    const live = await getAiringSchedule(toInt(req.query.page, 1));
    res.json({
      ok: true,
      page: Math.max(toInt(req.query.page, 1), 1),
      results: live.results.map((row) => ({
        airingAt: row.airingAt,
        episode: row.episode,
        media: withCatalogSlug(row.media, index),
      })),
      pageInfo: live.pageInfo,
    });
  } catch (err) {
    if (err instanceof AniListBusyError) return busyResponse(res);
    next(err);
  }
});

/* GET /api/cover?url=<absolute https AniList image URL>
   Same-origin image proxy for live posters/banners: the browser cannot load
   AniList's CDN cross-site, so the site fetches the bytes itself and serves
   them from its own origin. Only AniList image hosts are allowed — this is
   not an open proxy. */
const COVER_PROXY_HOSTS = new Set(["s4.anilist.co"]);
const COVER_PROXY_MAX_BYTES = 8 * 1024 * 1024;
app.get("/api/cover", async (req, res, next) => {
  try {
    let target;
    try {
      target = new URL(String(req.query.url || ""));
    } catch {
      return res.status(400).json({ ok: false, error: "bad_url" });
    }
    if (target.protocol !== "https:" || !COVER_PROXY_HOSTS.has(target.hostname)) {
      return res.status(400).json({ ok: false, error: "bad_url" });
    }

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    let upstream;
    try {
      upstream = await fetch(target, {
        signal: ctl.signal,
        headers: { Accept: "image/*", "User-Agent": "AniVerse/1.0 (poster proxy)" },
      });
    } catch {
      return res.status(502).json({ ok: false, error: "cover_unavailable" });
    } finally {
      clearTimeout(timer);
    }
    if (!upstream.ok) {
      return res.status(upstream.status).json({ ok: false, error: "cover_unavailable" });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > COVER_PROXY_MAX_BYTES) {
      return res.status(413).json({ ok: false, error: "cover_too_large" });
    }
    res.set("Content-Type", upstream.headers.get("content-type") || "image/jpeg");
    res.set("Cache-Control", "public, max-age=86400");
    res.send(buf);
  } catch (err) {
    next(err);
  }
});

app.get("/api/stream/:slug/:ep", (req, res) => {
  const { slug } = req.params;
  const epNum = toInt(req.params.ep, 1);
  const title = db.prepare("SELECT * FROM titles WHERE slug = ?").get(slug);
  if (!title) throw notFound("Title not found.");

  const source = String(req.query.source || ZOKO_DEFAULT_SOURCE).toLowerCase();
  const malId = req.query.mal_id != null ? toInt(req.query.mal_id, null) : (title.mal_id || null);
  const anilistId = req.query.anilist_id != null ? toInt(req.query.anilist_id, null) : (title.anilist_id || null);
  const animeId = source === "anilist" ? anilistId : malId;

  if (!animeId) {
    return res.status(400).json({
      ok: false,
      error: "No MAL/AniList id mapped for this title.",
    });
  }
  const color = (req.query.color || ZOKO_DEFAULT_COLOR).replace(/^#/, "");
  const startTime = toInt(req.query.t, 0);

  const trackUrl = (track) =>
    buildEmbedUrl({
      origin: ZOKO_EMBED_ORIGIN,
      source,
      id: animeId,
      episode: epNum,
      track,
      color,
      autoplay: req.query.autoplay !== "0",
      autoskip: req.query.autoskip !== "0",
      autonext: req.query.autonext !== "0",
      startTime,
    });

  res.json({
    ok: true,
    slug,
    title: title.name,
    episode: epNum,
    source,
    malId,
    anilistId,
    streams: {
      zokoSub: trackUrl("sub"),
      zokoHsub: trackUrl("hsub"),
      zokoDub: trackUrl("dub"),
    },
  });
});

/* ==========================================================================
   DUB AVAILABILITY (ZokoAnime probe)
   ========================================================================== */

/* The embed serves a /dub URL for every title, but for some episodes the dub
   stream is byte-identical to sub (no real English dub exists). The watch page
   consults this before switching tracks so it can say so instead of silently
   playing Japanese. */
app.get("/api/dub-availability/:slug/:ep", async (req, res, next) => {
  try {
    const { slug } = req.params;
    const epNum = toInt(req.params.ep, 1);
    const title = db.prepare("SELECT mal_id FROM titles WHERE slug = ?").get(slug);
    if (!title) throw notFound("Title not found.");
    if (!title.mal_id) {
      persistDubCheck(slug, epNum, { available: false, reason: "no-mal-id" });
      return res.json({ ok: true, slug, ep: epNum, available: false, reason: "no-mal-id" });
    }
    const result = await checkDubAvailability(title.mal_id, epNum);
    /* Persist every probe so the per-title DUB count (dub_checks) stays in
       sync with what the watch page verifies episode by episode. */
    persistDubCheck(slug, epNum, result);
    res.json({ ok: true, slug, ep: epNum, ...result });
  } catch (err) {
    next(err);
  }
});

/* ==========================================================================
   PLAYER CONFIG ROUTE (ZokoAnime embed)
   ========================================================================== */

app.get("/api/player/config", (req, res) => {
  res.json({
    ok: true,
    embed: {
      origin: ZOKO_EMBED_ORIGIN,
      source: ZOKO_DEFAULT_SOURCE,
      defaultTrack: ZOKO_DEFAULT_TRACK,
      defaultColor: ZOKO_DEFAULT_COLOR,
      sources: ZOKO_SOURCES,
      tracks: ZOKO_TRACKS,
      autoplay: true,
      autoskip: true,
      autonext: true,
    },
  });
});

/* ==========================================================================
   WATCHLIST / MY LIST ROUTES
   ========================================================================== */

app.get("/api/watchlist", requireAuth, (req, res) => {
  const rows = db
    .prepare(`
      SELECT t.*, w.added_at
      FROM watchlist w
      JOIN titles t ON w.title_slug = t.slug
      WHERE w.user_id = ?
      ORDER BY w.added_at DESC
    `)
    .all(req.user.id);

  res.json({
    ok: true,
    items: rows.map((r) => withDubCount({
      ...titleView(r),
      addedAt: r.added_at,
    })),
  });
});

app.post("/api/watchlist/:slug", requireAuth, (req, res) => {
  const { slug } = req.params;
  const title = db.prepare("SELECT slug FROM titles WHERE slug = ?").get(slug);
  if (!title) throw notFound("Title not found.");

  const now = nowIso();
  db.prepare(`
    INSERT OR IGNORE INTO watchlist (user_id, title_slug, added_at)
    VALUES (?, ?, ?)
  `).run(req.user.id, slug, now);

  res.json({ ok: true, inWatchlist: true });
});

app.delete("/api/watchlist/:slug", requireAuth, (req, res) => {
  const { slug } = req.params;
  db.prepare("DELETE FROM watchlist WHERE user_id = ? AND title_slug = ?").run(req.user.id, slug);
  res.json({ ok: true, inWatchlist: false });
});

/* ==========================================================================
   WATCH PROGRESS & HISTORY ROUTES
   ========================================================================== */

app.get("/api/progress/continue", (req, res) => {
  if (!req.user) {
    return res.json({ ok: true, items: [] });
  }

  const rows = db
    .prepare(`
      SELECT p.title_slug, p.episode_num, p.position_sec, p.duration_sec, p.updated_at,
             t.name as title_name, t.kind, t.tone, e.title as episode_title,
             t.cover_local, t.cover_remote, t.banner_local, t.banner_remote
      FROM watch_progress p
      JOIN titles t ON p.title_slug = t.slug
      LEFT JOIN episodes e ON p.title_slug = e.title_slug AND p.episode_num = e.ep_num
      WHERE p.user_id = ?
      ORDER BY p.updated_at DESC
      LIMIT ?
    `)
    .all(req.user.id, CONTINUE_LIMIT);

  res.json({
    ok: true,
    items: rows.map((r) => ({
      slug: r.title_slug,
      titleName: r.title_name,
      kind: r.kind,
      tone: r.tone,
      episodeNum: r.episode_num,
      episodeTitle: r.episode_title || `Episode ${r.episode_num}`,
      positionSec: r.position_sec,
      durationSec: r.duration_sec,
      percent: Math.min(100, Math.round((r.position_sec / (r.duration_sec || 1)) * 100)),
      updatedAt: r.updated_at,
      cover: r.cover_local || r.cover_remote || null,
      banner: r.banner_local || r.banner_remote || null,
    })),
  });
});

app.post("/api/progress", requireAuth, (req, res) => {
  const { slug, episode, positionSec, durationSec } = req.body;
  if (!slug || episode == null || positionSec == null) {
    throw badRequest("Missing required playback progress fields.");
  }

  const epNum = toInt(episode, 1);
  const pos = Math.max(0, toInt(positionSec, 0));
  const dur = Math.max(pos, toInt(durationSec, 1440));
  const now = nowIso();

  // Upsert progress
  db.prepare(`
    INSERT INTO watch_progress (user_id, title_slug, episode_num, position_sec, duration_sec, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, title_slug, episode_num) DO UPDATE SET
      position_sec = excluded.position_sec,
      duration_sec = excluded.duration_sec,
      updated_at = excluded.updated_at
  `).run(req.user.id, slug, epNum, pos, dur, now);

  // Record history
  const isCompleted = dur > 0 && pos / dur >= 0.9 ? 1 : 0;
  db.prepare(`
    INSERT INTO history (user_id, title_slug, episode_num, position_sec, completed, watched_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(req.user.id, slug, epNum, pos, isCompleted, now);

  res.json({ ok: true });
});

app.get("/api/history", requireAuth, (req, res) => {
  const rows = db
    .prepare(`
      SELECT h.id, h.title_slug, h.episode_num, h.position_sec, h.completed, h.watched_at,
             t.name as title_name
      FROM history h
      JOIN titles t ON h.title_slug = t.slug
      WHERE h.user_id = ?
      ORDER BY h.watched_at DESC
      LIMIT ?
    `)
    .all(req.user.id, HISTORY_LIMIT);

  res.json({ ok: true, history: rows });
});

/* ==========================================================================
   COMMENTS / DISCUSSION ROUTES
   ========================================================================== */

app.get("/api/comments/:slug/:ep", (req, res) => {
  const { slug } = req.params;
  const epNum = toInt(req.params.ep, 1);

  const rows = db
    .prepare(`
      SELECT c.id, c.content, c.created_at, u.name as user_name, u.avatar_tone
      FROM comments c
      JOIN users u ON c.user_id = u.id
      WHERE c.title_slug = ? AND c.episode_num = ?
      ORDER BY c.created_at DESC
      LIMIT 50
    `)
    .all(slug, epNum);

  res.json({ ok: true, comments: rows });
});

app.post("/api/comments/:slug/:ep", requireAuth, (req, res) => {
  const { slug } = req.params;
  const epNum = toInt(req.params.ep, 1);
  const content = cleanText(req.body.content);

  if (!content || content.length < 2 || content.length > 500) {
    throw badRequest("Comment must be between 2 and 500 characters.");
  }

  const now = nowIso();
  const resInsert = db
    .prepare(`
      INSERT INTO comments (user_id, title_slug, episode_num, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(req.user.id, slug, epNum, content, now);

  res.status(201).json({
    ok: true,
    comment: {
      id: resInsert.lastInsertRowid,
      content,
      created_at: now,
      user_name: req.user.name,
      avatar_tone: req.user.avatarTone,
    },
  });
});

/* ==========================================================================
   HEALTH ROUTE
   ========================================================================== */

app.get("/api/health", (req, res) => {
  const titleCount = db.prepare("SELECT COUNT(*) as c FROM titles").get().c;
  const episodeCount = db.prepare("SELECT COUNT(*) as c FROM episodes").get().c;
  res.json({
    ok: true,
    app: "Ani Verse API",
    status: "healthy",
    titleCount,
    episodeCount,
    uptimeSec: Math.floor(process.uptime()),
  });
});

/* ==========================================================================
   STATIC SITE SERVING
   ========================================================================== */

/* The poster/banner assets are multi-hundred-KB. Re-downloading them on every
   navigation saturates the browser's 6 connections per origin and starves the
   API calls behind them, so they get a short shared cache. HTML is always
   revalidated so page markup never goes stale. */
const STATIC_MAX_AGE_MS = 5 * 60 * 1000;

app.use(
  express.static(SITE_ROOT, {
    maxAge: STATIC_MAX_AGE_MS,
    etag: true,
    lastModified: true,
    setHeaders(res, filePath) {
      if (filePath.endsWith(".html") || filePath.endsWith(".js") || filePath.endsWith(".css")) {
        res.setHeader("Cache-Control", "no-cache, must-revalidate");
      }
    },
  })
);

// Fallback for HTML routing if requested without extension
app.get("/:page", (req, res, next) => {
  const pageFile = path.join(SITE_ROOT, `${req.params.page}.html`);
  res.sendFile(pageFile, (err) => {
    if (err) next();
  });
});

/* ==========================================================================
   ERROR HANDLING
   ========================================================================== */

app.use((err, req, res, next) => {
  if (err instanceof ApiError) {
    return res.status(err.status).json({
      ok: false,
      error: {
        code: err.code,
        message: err.message,
        fields: err.fields,
      },
    });
  }

  console.error("Unhandled server error:", err);
  res.status(500).json({
    ok: false,
    error: {
      code: "INTERNAL_ERROR",
      message: "An internal server error occurred.",
    },
  });
});

// Start Server
if (process.argv[1] && process.argv[1].endsWith("index.js")) {
  app.listen(PORT, HOST, () => {
    console.log(`Ani Verse Server running at http://${HOST}:${PORT}`);
    console.log(`Serving frontend from: ${SITE_ROOT}`);
  });
}

export default app;
