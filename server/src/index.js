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

app.get("/api/titles", (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim().toLowerCase() : "";
  const genre = typeof req.query.genre === "string" ? req.query.genre.trim().toLowerCase() : "";
  const sort = req.query.sort || "newest";
  const limit = Math.min(Math.max(toInt(req.query.limit, 24), 1), 100);
  const offset = Math.max(toInt(req.query.offset, 0), 0);

  let whereClauses = [];
  let params = [];

  if (q) {
    whereClauses.push(
      "(LOWER(name) LIKE ? OR LOWER(synopsis) LIKE ? OR LOWER(tagline) LIKE ? OR LOWER(real_title) LIKE ? OR LOWER(romaji_title) LIKE ? OR LOWER(native_title) LIKE ? OR LOWER(old_title) LIKE ?)"
    );
    const pattern = `%${q}%`;
    params.push(pattern, pattern, pattern, pattern, pattern, pattern, pattern);
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

  res.json({
    ok: true,
    total: totalCount,
    limit,
    offset,
    titles: rows.map(titleView),
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

  res.json({
    ok: true,
    title: titleView(row),
    episodes,
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
    items: rows.map((r) => ({
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
