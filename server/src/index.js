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
  COMMENT_NAME_MAX,
  COMMENT_TEXT_MAX,
  COMMENT_RATE_LIMIT_MS,
  LOGIN_MAX_ATTEMPTS,
  LOGIN_WINDOW_MS,
  REGISTER_MAX_ATTEMPTS,
  REGISTER_WINDOW_MS,
  FORGOT_PASSWORD_MAX_ATTEMPTS,
  FORGOT_PASSWORD_WINDOW_MS,
  RESET_PASSWORD_MAX_ATTEMPTS,
  RESET_PASSWORD_WINDOW_MS,
  TRUST_PROXY,
  HISTORY_LIMIT,
  HISTORY_PER_USER_CAP,
  CONTINUE_LIMIT,
  PROGRESS_MAX_ATTEMPTS,
  PROGRESS_WINDOW_MS,
  COVER_MAX_ATTEMPTS,
  COVER_WINDOW_MS,
  ANIME_GG_MAX_ATTEMPTS,
  ANIME_GG_WINDOW_MS,
  DUB_CHECK_MAX_ATTEMPTS,
  DUB_CHECK_WINDOW_MS,
  HINDI_MAX_ATTEMPTS,
  HINDI_WINDOW_MS,
  ZOKO_EMBED_ORIGIN,
  ZOKO_DEFAULT_SOURCE,
  ZOKO_DEFAULT_TRACK,
  ZOKO_DEFAULT_COLOR,
} from "./config.js";
import { db } from "./db.js";
import { resolveSlug } from "./catalog.js";
import { buildEmbedUrl, ZOKO_SOURCES, ZOKO_TRACKS } from "./zoko.js";
import { checkDubAvailability } from "./dub-check.js";
import { resolveAnimegg } from "./animegg.js";
import { createRateLimiter } from "./ratelimit.js";
import { mountOAuthRoutes } from "./oauth.js";
import { isPlaceholderEmail } from "./oauth-providers.js";
import { isMailConfigured, sendPasswordEmail } from "./mailer.js";
import {
  createResetToken,
  findValidResetToken,
  invalidateUserTokens,
  resetLink,
  applyPasswordReset,
} from "./password-reset.js";
import {
  AniListBusyError,
  searchAniList,
  SEARCH_PAGE_SIZE,
  browseAniList,
  withRealYearTotal,
  getLiveTitle,
  getAiringSchedule,
  azAniList,
  AZ_PAGE_SIZE,
  normalizeAzLetter,
  getAniListGenres,
  browseViewFormat,
  canonicalFormat,
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
  escapeHtml,
  tooManyRequests,
  parseCookies,
  toInt,
  userView,
  titleView,
} from "./utils.js";
import { getTurnstileSiteKey, verifyTurnstile } from "./turnstile.js";
import { renderDetailHtml } from "./seo.js";
import { resolveTmdbInfo } from "./tmdb.js";
import { checkVidstream3Availability, withHindiAvailability } from "./hindi.js";

const app = express();

/* Behind Caddy the peer is the proxy; trust X-Forwarded-For only when the
   operator explicitly enables it (see config.TRUST_PROXY).
   SECURITY (audit C1): trust exactly ONE hop (Caddy), never `true`. With
   `trust proxy: true` Express uses the LEFTMOST X-Forwarded-For entry, which
   the client controls — Caddy appends the real IP but never strips a
   client-supplied one, so any attacker could spoof req.ip and bypass every
   IP-based rate limit. `1` makes Express use the LAST entry (the one Caddy
   appended) and ignore client-supplied entries. */
app.set("trust proxy", TRUST_PROXY ? 1 : false);

const CSP_HEADER = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data: https://s4.anilist.co",
  "frame-src 'self' https://zokoanime.video https://embed.animetvplus.site https://challenges.cloudflare.com https://blakiteapi.xyz",
  "frame-ancestors 'self'",
  "connect-src 'self' https://zokoanime.video",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/* Security & default Cache-Control headers for all responses (Caddy copies
   upstream headers verbatim, so set once here). X-Content-Type-Options is
   set in-app (not only in Caddy) so the app is safe without the proxy too
   (audit C4-cover). */
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", CSP_HEADER);
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.path.startsWith("/api/") || req.path.startsWith("/auth/")) {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  }
  next();
});

/* Client IP for the rate limits. req.ip already honours X-Forwarded-For when
   trust proxy is on; normalise the IPv6-mapped loopback forms so one client
   cannot split its quota across ::1 / ::ffff:127.0.0.1. */
function clientIp(req) {
  const raw = req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
  return String(raw).replace(/^::ffff:/i, "").replace(/^\[|\]$/g, "");
}

/* In-memory throttles. A restart clears them — fine for abuse control. */
const loginIpLimiter = createRateLimiter({ max: LOGIN_MAX_ATTEMPTS, windowMs: LOGIN_WINDOW_MS });
const loginAccountLimiter = createRateLimiter({ max: LOGIN_MAX_ATTEMPTS, windowMs: LOGIN_WINDOW_MS });
const registerLimiter = createRateLimiter({ max: REGISTER_MAX_ATTEMPTS, windowMs: REGISTER_WINDOW_MS });
const commentLimiter = createRateLimiter({ max: 1, windowMs: COMMENT_RATE_LIMIT_MS });
/* Forgot-password is limited per IP AND per email address (whichever trips
   first); the reset endpoint is limited per IP. */
const forgotPasswordIpLimiter = createRateLimiter({ max: FORGOT_PASSWORD_MAX_ATTEMPTS, windowMs: FORGOT_PASSWORD_WINDOW_MS });
const forgotPasswordEmailLimiter = createRateLimiter({ max: FORGOT_PASSWORD_MAX_ATTEMPTS, windowMs: FORGOT_PASSWORD_WINDOW_MS });
const resetPasswordLimiter = createRateLimiter({ max: RESET_PASSWORD_MAX_ATTEMPTS, windowMs: RESET_PASSWORD_WINDOW_MS });
/* Per-user progress sync + expensive unauthenticated probe/proxy routes
   (audit D2, C4-cover, hunter C). Generous caps — normal use stays far below. */
const progressLimiter = createRateLimiter({ max: PROGRESS_MAX_ATTEMPTS, windowMs: PROGRESS_WINDOW_MS });
const coverLimiter = createRateLimiter({ max: COVER_MAX_ATTEMPTS, windowMs: COVER_WINDOW_MS });
const animeggLimiter = createRateLimiter({ max: ANIME_GG_MAX_ATTEMPTS, windowMs: ANIME_GG_WINDOW_MS });
const dubCheckLimiter = createRateLimiter({ max: DUB_CHECK_MAX_ATTEMPTS, windowMs: DUB_CHECK_WINDOW_MS });
const hindiLimiter = createRateLimiter({ max: HINDI_MAX_ATTEMPTS, windowMs: HINDI_WINDOW_MS });

// Body parser (default to {} for non-JSON requests so routes never 500 on req.body.*)
app.use(express.json());
app.use((req, res, next) => {
  if (req.body == null || typeof req.body !== "object") {
    req.body = {};
  }
  next();
});

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

/* One session-creation path for local AND social login: same token shape,
   same 30-day TTL, same cookie. (Extracted from the identical blocks that
   register/login used to carry inline.) */
function createUserSession(req, res, userId) {
  const now = nowIso();
  const token = randomToken(32);
  const expiresAt = addMs(now, SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  db.prepare(`
    INSERT INTO sessions (id, user_id, expires_at, created_at, ip, user_agent)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(token, userId, expiresAt, now, req.ip || "", req.headers["user-agent"] || "");
  setSessionCookie(res, token, expiresAt);
  return { token, expiresAt };
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
        SELECT s.id, s.user_id, s.expires_at, s.created_at,
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

    // Auto-refresh session if close to expiry — but NEVER beyond the absolute
    // lifetime cap (created_at + SESSION_TTL_DAYS), so an actively-used
    // session still eventually expires instead of living forever (audit C3).
    if (expiresTime - Date.now() < SESSION_REFRESH_BELOW_MS) {
      const absoluteMax = Date.parse(session.created_at) + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
      if (absoluteMax <= Date.now()) {
        db.prepare("DELETE FROM sessions WHERE id = ?").run(token);
        clearSessionCookie(res);
        return next();
      }
      const wanted = Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
      const newExpires = new Date(Math.min(wanted, absoluteMax)).toISOString();
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

app.get("/api/auth/turnstile-key", (req, res) => {
  const siteKey = getTurnstileSiteKey();
  if (!siteKey) {
    return res.json({ enabled: false });
  }
  res.json({ enabled: true, siteKey });
});

app.post("/api/auth/register", async (req, res, next) => {
  try {
    const ip = clientIp(req);
    await verifyTurnstile({
      token: req.body && req.body["cf-turnstile-response"],
      remoteip: ip,
    });

    /* 5 registration attempts per IP per hour — counted before any work so
       a flood cannot burn password hashing. */
    const rl = registerLimiter.check(`ip:${ip}`);
    if (!rl.allowed) {
      throw tooManyRequests(
        "Too many accounts created from this address. Please try again later.",
        Math.ceil(rl.retryAfterMs / 1000)
      );
    }

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
      /* Generic response (audit C4): no EMAIL_IN_USE code, no session — the
         caller cannot tell from the body whether the address was already
         registered. (The 201-vs-200 status still differs from a fresh
         registration; fully closing that needs dropping auto-sign-in.) */
      return res.status(200).json({
        ok: true,
        message: "An account with this email already exists. Please sign in instead.",
      });
    }
    /* Placeholder .invalid addresses belong to social accounts with no email
       (audit C9): they must never be registrable locally, or the victim's
       first social login breaks on a UNIQUE conflict. */
    if (isPlaceholderEmail(email)) {
      throw badRequest("That email address can't be used to register.");
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

    // Create session (same path as local login and OAuth)
    createUserSession(req, res, user.id);
    res.status(201).json({ ok: true, user: userView(user) });
  } catch (err) {
    next(err);
  }
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const ip = clientIp(req);
    await verifyTurnstile({
      token: req.body && req.body["cf-turnstile-response"],
      remoteip: ip,
    });

    /* 5 attempts per 15 minutes, per IP AND per account — whichever trips
       first. The per-IP limiter counts every attempt up front (flood
       protection). The per-ACCOUNT limiter counts only FAILURES (audit C5):
       it is checked after the credential check, so a correct password always
       works even while the account bucket is tripped — otherwise anyone
       could lock any account out for 15 minutes with 5 Turnstile solves. */
    const email = normalizeEmail(req.body.email);
    const ipCheck = loginIpLimiter.check(`ip:${ip}`);
    if (!ipCheck.allowed) {
      throw tooManyRequests(
        "Too many sign-in attempts. Please wait a few minutes and try again.",
        Math.ceil(ipCheck.retryAfterMs / 1000)
      );
    }

    const password = typeof req.body.password === "string" ? req.body.password : "";

    if (!email || !password) {
      throw badRequest("Email and password are required.");
    }

    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    if (!user) {
      await burnPasswordCheck(password);
      recordLoginFailure(email);
      throw unauthorized("Invalid email or password.");
    }

    const valid = await verifyPassword(password, user.password_hash);
    if (!valid) {
      recordLoginFailure(email);
      throw unauthorized("Invalid email or password.");
    }

    /* Success clears the per-ACCOUNT counter (the IP counter is left alone:
       one household behind a proxy must not be locked out because one member
       mistyped, but a correct password always earns a fresh set of tries). */
    loginAccountLimiter.reset(`acct:${email}`);

    createUserSession(req, res, user.id);
    res.json({ ok: true, user: userView(user) });
  } catch (err) {
    next(err);
  }
});

/* Count one failed sign-in against the per-account bucket; throw 429 once
   the bucket is tripped. Called only for failures, so a correct password
   is never blocked by a tripped bucket (audit C5). */
function recordLoginFailure(email) {
  const acctCheck = loginAccountLimiter.check(`acct:${email}`);
  if (!acctCheck.allowed) {
    throw tooManyRequests(
      "Too many sign-in attempts. Please wait a few minutes and try again.",
      Math.ceil(acctCheck.retryAfterMs / 1000)
    );
  }
}

app.post("/api/auth/logout", (req, res) => {
  if (req.session) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(req.session.id);
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

/* Log out everywhere else (audit C3): deletes all of the user's sessions
   except the current one, so a stolen token can be evicted in-app. */
app.post("/api/auth/logout-all", requireAuth, (req, res) => {
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(req.user.id, req.session.id);
  res.json({ ok: true });
});

/* Change password while signed in (audit C8): requires the current password,
   sets the new hash, and logs the account out everywhere else. Social-only
   accounts (NULL password_hash) have no local password to change — they use
   the emailed reset link instead. */
app.post("/api/auth/change-password", requireAuth, async (req, res, next) => {
  try {
    const currentPassword = typeof req.body.currentPassword === "string" ? req.body.currentPassword : "";
    const newPassword = typeof req.body.newPassword === "string" ? req.body.newPassword : "";
    if (!newPassword || newPassword.length < PASSWORD_MIN || newPassword.length > PASSWORD_MAX) {
      throw badRequest(`Password must be between ${PASSWORD_MIN} and ${PASSWORD_MAX} characters.`);
    }
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
    if (!user || !user.password_hash) {
      throw badRequest("Your account has no local password to change. Use the reset link instead.");
    }
    const valid = await verifyPassword(currentPassword, user.password_hash);
    if (!valid) {
      throw unauthorized("Your current password is incorrect.");
    }
    const passwordHash = await hashPassword(newPassword);
    db.transaction(() => {
      db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(
        passwordHash,
        nowIso(),
        req.user.id
      );
      db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(req.user.id, req.session.id);
    })();
    res.json({ ok: true, message: "Your password has been changed." });
  } catch (err) {
    next(err);
  }
});

/* ==========================================================================
   PASSWORD RESET (magic-link email)
   Privacy is the whole point of this flow:
   - The forgot-password response is IDENTICAL whether or not the email is
     registered — same status, same body. An attacker learns nothing from
     the response. (The per-IP / per-email rate limit also caps how many
     probes anyone can make in an hour.)
   - No email address or token ever appears in a log line (see mailer.js).
   - Only the token HASH is stored; the raw token exists only in the email.
   - A reset also works for social-only accounts (NULL password_hash): the
     same link lets them SET a password. The response never says which
     case applied.
   ========================================================================== */

/* The one generic message the forgot-password endpoint ever returns. */
const FORGOT_PASSWORD_MESSAGE = "If an account exists for that email, a reset link has been sent.";

app.post("/api/auth/forgot-password", async (req, res, next) => {
  try {
    /* 5 requests per hour per IP AND per email address — counted before
       any work, so a flood cannot burn token creation or mail sends. The
       limiter keys on the SUBMITTED email string, so it behaves the same
       for registered and unregistered addresses (no leak). */
    const email = normalizeEmail(req.body.email);
    const ip = clientIp(req);
    const ipCheck = forgotPasswordIpLimiter.check(`ip:${ip}`);
    const emailCheck = forgotPasswordEmailLimiter.check(`email:${email}`);
    if (!ipCheck.allowed || !emailCheck.allowed) {
      const retryMs = Math.max(ipCheck.retryAfterMs, emailCheck.retryAfterMs);
      throw tooManyRequests(
        "Too many password reset requests. Please try again later.",
        Math.ceil(retryMs / 1000)
      );
    }

    /* Only a registered account with a REAL email gets a token + mail.
       Placeholder .invalid addresses (MAL/AniList accounts with no email)
       have nowhere to send to. When mail is unconfigured, no token is
       created at all — there is nothing to send, so nothing is stored. */
    const user = email
      ? db.prepare("SELECT id, email FROM users WHERE email = ?").get(email)
      : null;
    if (user && !isPlaceholderEmail(user.email) && isMailConfigured()) {
      /* One live reset link at a time: a new request revokes the previous
         link before minting a fresh one (audit D5). */
      invalidateUserTokens(user.id);
      const rawToken = createResetToken(user.id, "reset");
      /* Awaited (not fire-and-forget) so a transport failure is logged
         before the response — the response itself stays generic either
         way, and sendPasswordEmail never throws for mail failures. */
      await sendPasswordEmail({ to: user.email, link: resetLink(rawToken), purpose: "reset" });
    }
    res.json({ ok: true, message: FORGOT_PASSWORD_MESSAGE });
  } catch (err) {
    next(err);
  }
});

app.post("/api/auth/reset-password", async (req, res, next) => {
  try {
    const ip = clientIp(req);
    const rl = resetPasswordLimiter.check(`ip:${ip}`);
    if (!rl.allowed) {
      throw tooManyRequests(
        "Too many password reset attempts. Please try again later.",
        Math.ceil(rl.retryAfterMs / 1000)
      );
    }

    const token = typeof req.body.token === "string" ? req.body.token : "";
    const newPassword = typeof req.body.newPassword === "string" ? req.body.newPassword : "";

    /* The password rules match registration exactly (same message), so a
       bad password is a validation error, not a token-state leak. */
    if (!newPassword || newPassword.length < PASSWORD_MIN || newPassword.length > PASSWORD_MAX) {
      throw badRequest(`Password must be between ${PASSWORD_MIN} and ${PASSWORD_MAX} characters.`);
    }

    /* ONE generic failure for every token problem — unknown, expired, or
       already used are indistinguishable by design. */
    const tokenRow = findValidResetToken(token);
    if (!tokenRow) {
      throw badRequest("This password link is invalid or has expired.");
    }

    /* The hash is computed BEFORE the transaction (scrypt is async;
       better-sqlite3 transactions are sync). The transaction sets the new
       password, marks this token used, deletes every other token for the
       user, and deletes all of the user's sessions. */
    const passwordHash = await hashPassword(newPassword);
    applyPasswordReset({ tokenId: tokenRow.id, userId: tokenRow.user_id, passwordHash });
    res.json({ ok: true, message: "Your password has been set. You can now sign in." });
  } catch (err) {
    next(err);
  }
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

/* HiAnime-style social logins (Google / Discord / MAL / AniList):
   GET /api/auth/providers (which are enabled), GET /auth/<provider> and
   GET /auth/<provider>/callback. Providers without credentials stay
   disabled and hidden. Social logins create sessions through the same
   createUserSession as local login. */
mountOAuthRoutes(app, { createSession: createUserSession });

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

app.get("/api/genres", async (req, res, next) => {
  try {
    const rows = db.prepare("SELECT genres FROM titles").all();
    const counts = {};
    for (const row of rows) {
      if (!row.genres) continue;
      const list = row.genres.split(",").map((g) => g.trim().toLowerCase()).filter(Boolean);
      for (const g of list) {
        counts[g] = (counts[g] || 0) + 1;
      }
    }
    /* The FULL AniList genre list (cached 24 h). A failure degrades to the
       known genres inside getAniListGenres — this route never 502s and never
       invents a genre. */
    const allGenres = await getAniListGenres();
    res.json({
      ok: true,
      totalTitles: rows.length,
      counts,
      allGenres,
    });
  } catch (err) {
    next(err);
  }
});

app.get("/api/titles/:slug", (req, res) => {
  const slug = resolveSlug(req.params.slug);
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
  const slug = resolveSlug(req.params.slug);
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
    if (live.tmdbId == null) {
      Object.assign(
        live,
        resolveTmdbInfo({
          anilistId: row.anilist_id != null ? Number(row.anilist_id) : null,
          malId: row.mal_id != null ? Number(row.mal_id) : null,
          kind: row.kind,
          preferMal: true,
        })
      );
    }
  }
  Object.assign(live, withHindiAvailability(live));
  if (Array.isArray(live.recommendations)) {
    live.recommendations = live.recommendations.map((rec) =>
      rec ? { ...rec, ...withHindiAvailability(rec) } : rec
    );
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
   LOCAL catalog matches first ("On AniFlick"), AniList results below
   ("More results"). An AniList result that IS a catalog title (same MAL id)
   is dropped from the LIVE list (never a duplicate live row) but still
   appears in the results grid, marked with its catalog slug — so a search
   for a catalog title surfaces that exact season, not only its sequels. */
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
       shown once, under "On AniFlick", and dropped from the live list.
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
        /* The twin ALSO stays in the results grid, in its proper place.
           Dedupe keeps it out of the LIVE list (no second live row for the
           same AniList id), but the grid still shows the catalog title —
           otherwise searching a catalog title surfaces only its other
           seasons/movies and never the season the catalog actually has.
           It carries the catalog slug + probe-backed dub count so the grid
           card agrees with the curated card. */
        allResults.push(withCatalogSlug(item, index));
        continue;
      }
      allResults.push(withCatalogSlug(item, index));
    }

    /* One stable result set for the whole query: every page is a slice of
       it, so the total never changes and no page repeats another page. */
    const total = allResults.length;
    const lastPage = Math.max(1, Math.ceil(total / SEARCH_PAGE_SIZE));
    const safePage = Math.min(page, lastPage);
    const start = (safePage - 1) * SEARCH_PAGE_SIZE;
    const results = allResults.slice(start, start + SEARCH_PAGE_SIZE);

    /* The curated shelf ("On AniFlick") belongs to the FIRST page only —
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

/* GET /api/browse?view=dubbed — the DUBBED shelf.
   Only curated catalog titles with a VERIFIED dub (dub_checks rows with
   available = 1) belong here. Live AniList titles have NO dub data at all —
   AniList knows nothing about dubs — so listing one as "dubbed" would invent
   availability. This view therefore reads the catalog, never AniList, and it
   keeps working while AniList is down. Filters / sorts / pagination behave
   like every other browse view. */
const DUBBED_PAGE_SIZE = 12;

function catalogDubBrowse(query = {}) {
  const genre = String(query.genre || "").trim().toLowerCase();
  const yearRaw = Number(query.year);
  const year = Number.isFinite(yearRaw) && yearRaw > 1800 && yearRaw < 2200 ? Math.floor(yearRaw) : null;
  const format = canonicalFormat(query.format);
  const sortKey = String(query.sort || "trending").toLowerCase();
  const page = Math.max(toInt(query.page, 1), 1);

  const where = [];
  const params = [];
  if (genre) { where.push("LOWER(t.genres) LIKE ?"); params.push(`%${genre}%`); }
  if (year) { where.push("t.year = ?"); params.push(year); }
  /* The catalog's `kind` is "Film" for movies and "Series" for everything
     else, so only a MOVIE preset maps cleanly onto it. */
  if (format === "MOVIE") where.push("LOWER(t.kind) = 'film'");
  else if (format) where.push("LOWER(t.kind) <> 'film'");
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const orderSql = {
    newest: "t.year DESC, t.slug ASC",
    az: "t.name ASC",
    name: "t.name ASC",
    episodes: "t.episodes DESC, t.slug ASC",
    top: "t.score DESC, t.year DESC, t.slug ASC",
    popular: "t.score DESC, t.year DESC, t.slug ASC",
  }[sortKey] || "t.year DESC, t.slug ASC";

  const total = db
    .prepare(`SELECT COUNT(DISTINCT t.slug) AS c FROM titles t JOIN dub_checks d ON d.title_slug = t.slug AND d.available = 1 ${whereSql}`)
    .get(...params).c;
  const rows = db
    .prepare(`
      SELECT t.*, COUNT(d.ep_num) AS dub_count
      FROM titles t
      JOIN dub_checks d ON d.title_slug = t.slug AND d.available = 1
      ${whereSql}
      GROUP BY t.slug
      ORDER BY ${orderSql}
      LIMIT ? OFFSET ?
    `)
    .all(...params, DUBBED_PAGE_SIZE, (page - 1) * DUBBED_PAGE_SIZE);

  return {
    ok: true,
    page,
    view: "dubbed",
    results: rows.map((row) => ({ ...titleView(row), dubCount: row.dub_count })),
    pageInfo: {
      total,
      currentPage: page,
      lastPage: Math.max(1, Math.ceil(total / DUBBED_PAGE_SIZE)),
      hasNextPage: page * DUBBED_PAGE_SIZE < total,
    },
  };
}

/* GET /api/browse?sort=&genre=&format=&status=&year=&page=
   One flexible list endpoint over the whole AniList catalog. */
app.get("/api/browse", async (req, res, next) => {
  try {
    const index = catalogIndex();
    const view = String(req.query.view || "").toLowerCase();

    /* The dubbed shelf is catalog-only (see catalogDubBrowse). */
    if (view === "dubbed") {
      return res.json(catalogDubBrowse(req.query));
    }

    /* A type view (?view=movie|ona|special|tv) is a format preset. It wins
       over a ?format= param so ?view=movie can never silently mean "TV". */
    const viewFormat = browseViewFormat(view);
    const browseArgs = {
      sort: req.query.sort,
      genre: req.query.genre,
      format: viewFormat || req.query.format,
      status: req.query.status,
      year: req.query.year,
      tags: req.query.tags,
      season: req.query.season,
      minScore: req.query.minScore,
      maxScore: req.query.maxScore,
      startAfter: req.query.startAfter,
      startBefore: req.query.startBefore,
      perPage: req.query.perPage,
      page: req.query.page,
    };
    const live = await browseAniList(browseArgs);
    /* AniList caps a multi-page total at 5,000 for ANY filter, so a year view
       would show "5,000+ titles" / "Page 1 of 416+" no matter how small the
       year. Count the year's titles server-side and replace pageInfo. The grid
       results, sort and page size are untouched; a non-year view or a failed
       count keeps AniList's own pageInfo. */
    const pageInfo = await withRealYearTotal(live.pageInfo, browseArgs);
    res.json({
      ok: true,
      page: Math.max(toInt(req.query.page, 1), 1),
      results: live.results.map((item) => withCatalogSlug(item, index)),
      pageInfo,
    });
  } catch (err) {
    if (err instanceof AniListBusyError) return busyResponse(res);
    next(err);
  }
});

/* GET /api/az?letter=<A-Z|0-9|all>&page=<n>
   A-Z index over the live catalog. AniList has no prefix search, so a letter
   is served from a SEARCH_MATCH snapshot (10 pages x 50, 30-min cache,
   in-flight dedup) filtered server-side to romaji/english prefix matches; a
   letter whose search snapshot comes back EMPTY falls back to TITLE_ROMAJI
   paging (A-Z only). A snapshot that hit the fetch cap is flagged `capped` —
   the total is a FLOOR and the UI must label it with a "+". letter=all is the
   plain TITLE_ROMAJI browse (the A-Z "All" view uses /api/browse?sort=az). */
app.get("/api/az", async (req, res, next) => {
  try {
    const letter = normalizeAzLetter(req.query.letter);
    if (!letter) {
      return res.status(400).json({ ok: false, error: "bad_letter" });
    }
    const page = Math.max(toInt(req.query.page, 1), 1);
    const index = catalogIndex();

    if (letter === "all") {
      const live = await browseAniList({ sort: "az", page });
      const pageInfo = await withRealYearTotal(live.pageInfo, { sort: "az", page });
      return res.json({
        ok: true,
        letter: "all",
        page: Math.max(toInt(req.query.page, 1), 1),
        results: live.results.map((item) => withCatalogSlug(item, index)),
        pageInfo,
      });
    }

    const snap = await azAniList(letter);
    const total = snap.total;
    const lastPage = Math.max(1, Math.ceil(total / AZ_PAGE_SIZE));
    const safePage = Math.min(page, lastPage);
    const start = (safePage - 1) * AZ_PAGE_SIZE;
    res.json({
      ok: true,
      letter,
      page: safePage,
      results: snap.items.slice(start, start + AZ_PAGE_SIZE).map((item) => withCatalogSlug(item, index)),
      pageInfo: {
        total,
        currentPage: safePage,
        lastPage,
        hasNextPage: safePage < lastPage,
        capped: !!snap.capped,
      },
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
    /* Unauthenticated image proxy: per-IP cap (each call costs an upstream
       fetch of up to 8 MB). */
    const rl = coverLimiter.check(`ip:${clientIp(req)}`);
    if (!rl.allowed) {
      return res.status(429).json({ ok: false, error: "rate_limited" });
    }

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
        headers: { Accept: "image/*", "User-Agent": "AniFlick/1.0 (poster proxy)" },
      });
    } catch {
      return res.status(502).json({ ok: false, error: "cover_unavailable" });
    } finally {
      clearTimeout(timer);
    }
    if (!upstream.ok) {
      return res.status(upstream.status).json({ ok: false, error: "cover_unavailable" });
    }
    /* fetch() follows redirects: re-validate the FINAL host (audit C4-cover),
       so a redirect off the allowlisted host cannot smuggle content in. */
    let finalUrl;
    try {
      finalUrl = new URL(upstream.url);
    } catch {
      return res.status(502).json({ ok: false, error: "cover_unavailable" });
    }
    if (finalUrl.protocol !== "https:" || !COVER_PROXY_HOSTS.has(finalUrl.hostname)) {
      return res.status(502).json({ ok: false, error: "cover_unavailable" });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.length > COVER_PROXY_MAX_BYTES) {
      return res.status(413).json({ ok: false, error: "cover_too_large" });
    }
    /* Never serve the upstream Content-Type verbatim (audit C4-cover): an
       image proxy must only ever serve images. A text/html or SVG response
       from the upstream would otherwise render as AniFlick-origin content. */
    const upstreamCt = (upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!/^(image\/jpeg|image\/png|image\/gif|image\/webp|image\/avif)$/.test(upstreamCt)) {
      return res.status(502).json({ ok: false, error: "cover_unavailable" });
    }
    res.set("Content-Type", upstreamCt);
    res.set("Cache-Control", "public, max-age=86400");
    res.send(buf);
  } catch (err) {
    next(err);
  }
});

app.get("/api/stream/:slug/:ep", (req, res) => {
  const slug = resolveSlug(req.params.slug);
  const epNum = toInt(req.params.ep, 1);
  const title = db.prepare("SELECT * FROM titles WHERE slug = ?").get(slug);
  if (!title) throw notFound("Title not found.");
  /* Episode-range validation (fix #11, 23 Nov audit): ep 9999 used to
     return 200 with a dead Zoko URL. The check is against the title's own
     declared episode count — NOT the episodes table, which is missing rows
     for Harlock (0 rows, 1 episode), so a row check would false-404 a real
     episode. A null count skips the upper check rather than breaking. */
  if (!Number.isInteger(epNum) || epNum < 1 || (title.episodes != null && epNum > title.episodes)) {
    throw notFound(`Episode ${epNum} not found.`);
  }

  const source = String(req.query.source || ZOKO_DEFAULT_SOURCE).toLowerCase();
  /* Validate the source up front (audit, hunter C): an unknown source used to
     throw inside buildEmbedUrl and answer 500 instead of 400. */
  if (!ZOKO_SOURCES.includes(source)) {
    return res.status(400).json({ ok: false, error: "Unsupported source." });
  }
  /* Query ids only override the catalog ids when they are valid positive
     numbers; garbage (e.g. mal_id=abc) used to shadow the catalog id with
     null and answer 400 for a real title. */
  const malIdParam = req.query.mal_id != null ? toInt(req.query.mal_id, null) : null;
  const anilistIdParam = req.query.anilist_id != null ? toInt(req.query.anilist_id, null) : null;
  const malId = malIdParam != null && malIdParam > 0 ? malIdParam : (title.mal_id || null);
  const anilistId = anilistIdParam != null && anilistIdParam > 0 ? anilistIdParam : (title.anilist_id || null);
  const animeId = source === "anilist" ? anilistId : malId;

  if (!animeId) {
    return res.status(400).json({
      ok: false,
      error: "No MAL/AniList id mapped for this title.",
    });
  }
  /* Only a 3-8 digit hex colour is accepted; anything else falls back to the
     default instead of being passed through verbatim. */
  const colorRaw = String(req.query.color || ZOKO_DEFAULT_COLOR).replace(/^#/, "");
  const color = /^[0-9a-fA-F]{3,8}$/.test(colorRaw) ? colorRaw : ZOKO_DEFAULT_COLOR;
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
    /* Each probe costs ~8 upstream fetches; per-IP cap (audit, hunter C). */
    const rl = dubCheckLimiter.check(`ip:${clientIp(req)}`);
    if (!rl.allowed) {
      return res.status(429).json({ ok: false, error: "rate_limited" });
    }
    const slug = resolveSlug(req.params.slug);
    const epNum = toInt(req.params.ep, 1);
    const title = db.prepare("SELECT mal_id, episodes FROM titles WHERE slug = ?").get(slug);
    if (!title) throw notFound("Title not found.");
    /* Same range validation as /api/stream (fix #11): without it a probe
       for a nonexistent episode would persist a bogus dub_checks row. */
    if (!Number.isInteger(epNum) || epNum < 1 || (title.episodes != null && epNum > title.episodes)) {
      throw notFound(`Episode ${epNum} not found.`);
    }
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
   ANIMEGG FALLBACK (Anivexa-API proxy)
   ========================================================================== */

/* animegg is the 4th, manual-only fallback player. The browser CANNOT reach
   the self-hosted Anivexa instance (127.0.0.1:4100 on the production box), so
   the server proxies: one cheap availability check + one LIVE /watch call
   per request. Stream URLs carry a rotating `?for=` token and are NEVER
   cached or persisted; the availability list (which episodes the provider
   has) IS cached server-side, so repeated episode loads stay cheap.

   Availability + LIVE stream resolution: the watch page calls this on every
   episode — once in the background to decide whether the animegg pill is
   offered, and once for real when the viewer picks the player. Each call
   costs one cached /episodes check plus one LIVE /watch, so the URL is
   always fresh. */
app.get("/api/animegg/:anilistId/:ep", async (req, res, next) => {
  try {
    /* A live /watch call per request; per-IP cap (audit, hunter C). */
    const rl = animeggLimiter.check(`ip:${clientIp(req)}`);
    if (!rl.allowed) {
      return res.status(429).json({ ok: false, error: "rate_limited" });
    }
    const anilistId = toInt(req.params.anilistId, null);
    const epNum = toInt(req.params.ep, null);
    if (anilistId == null || anilistId <= 0 || epNum == null || epNum <= 0) {
      return res.status(400).json({ ok: false, error: "A numeric AniList id and episode number are required." });
    }
    const result = await resolveAnimegg(anilistId, epNum);
    return res.json({ ok: true, ...result });
  } catch (err) {
    /* Anivexa unreachable must degrade to "not available", never a 500. */
    return res.json({
      ok: true,
      anilistId: toInt(req.params.anilistId, 0),
      ep: toInt(req.params.ep, 0),
      available: false,
      embedUrl: null,
      url: null,
      reason: "unavailable",
    });
  }
});

/* Slug-keyed availability, for the catalog titles whose AniList id lives in
   the DB (same resolution /api/stream uses). */
app.get("/api/animegg/by-slug/:slug/:ep", async (req, res, next) => {
  try {
    const rl = animeggLimiter.check(`ip:${clientIp(req)}`);
    if (!rl.allowed) {
      return res.status(429).json({ ok: false, error: "rate_limited" });
    }
    const epNum = toInt(req.params.ep, null);
    const slug = resolveSlug(req.params.slug);
    const title = db.prepare("SELECT anilist_id FROM titles WHERE slug = ?").get(slug);
    if (!title) throw notFound("Title not found.");
    if (!title.anilist_id) {
      return res.json({
        ok: true,
        slug,
        ep: epNum,
        available: false,
        embedUrl: null,
        url: null,
        reason: "no-anilist-id",
      });
    }
    const result = await resolveAnimegg(title.anilist_id, epNum == null ? 1 : epNum);
    return res.json({ ok: true, slug, ...result });
  } catch (err) {
    if (err instanceof ApiError) return next(err);
    return res.json({
      ok: true,
      slug,
      ep: toInt(req.params.ep, 0),
      available: false,
      embedUrl: null,
      url: null,
      reason: "unavailable",
    });
  }
});

/* ==========================================================================
   HINDI PLAYER (Vidstream-3 / blakiteapi.xyz)
   ========================================================================== */

function parseHindiQuery(query = {}) {
  const tmdbId = toInt(query.tmdbId, null);
  const season = query.season != null && query.season !== "" ? toInt(query.season, null) : 1;
  const episode = query.episode != null && query.episode !== "" ? toInt(query.episode, null) : 1;
  if (tmdbId == null || tmdbId <= 0 || season == null || season <= 0 || episode == null || episode <= 0) {
    return null;
  }
  return { tmdbId, season, episode };
}

app.get("/api/hindi/vidstream3", async (req, res, next) => {
  try {
    const rl = hindiLimiter.check(`ip:${clientIp(req)}`);
    if (!rl.allowed) {
      return res.status(429).json({ ok: false, error: "rate_limited" });
    }
    const parsed = parseHindiQuery(req.query);
    if (!parsed) {
      return res.status(400).json({ ok: false, error: "Valid positive numeric tmdbId, season, and episode are required." });
    }
    const result = await checkVidstream3Availability(parsed);
    return res.json(result);
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
  const slug = resolveSlug(req.params.slug);
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
  const slug = resolveSlug(req.params.slug);
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
             t.name as title_name, t.kind, t.tone, t.mal_id, t.anilist_id, e.title as episode_title,
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
      ...withHindiAvailability(
        resolveTmdbInfo({
          anilistId: r.anilist_id != null ? Number(r.anilist_id) : null,
          malId: r.mal_id != null ? Number(r.mal_id) : null,
          kind: r.kind,
          preferMal: true,
        })
      ),
    })),
  });
});

app.post("/api/progress", requireAuth, (req, res) => {
  const { slug, episode, positionSec, durationSec } = req.body;
  if (!slug || episode == null || positionSec == null) {
    throw badRequest("Missing required playback progress fields.");
  }

  /* Per-user rate limit (audit D2): the player syncs ~every 5 s; 60/min is
     generous for seeking bursts and stops a scripted flood. */
  const rl = progressLimiter.check(`user:${req.user.id}`);
  if (!rl.allowed) {
    throw tooManyRequests(
      "Too many progress updates. Please wait a moment.",
      Math.ceil(rl.retryAfterMs / 1000)
    );
  }

  /* Validate the slug and episode range (audit C3): an unvalidated slug used
     to throw a 500 (FK constraint) and episode 99999 persisted a phantom
     history row. */
  const resolvedSlug = resolveSlug(slug);
  const title = db.prepare("SELECT slug, episodes FROM titles WHERE slug = ?").get(resolvedSlug);
  if (!title) throw notFound("Title not found.");
  const epNum = toInt(episode, 1);
  if (!Number.isInteger(epNum) || epNum < 1 || (title.episodes != null && epNum > title.episodes)) {
    throw badRequest(`Episode ${epNum} not found.`);
  }

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
  `).run(req.user.id, resolvedSlug, epNum, pos, dur, now);

  /* History (audit D2): a row on EVERY 5 s sync grew the table without bound
     (~288 rows/episode) while HISTORY_PER_USER_CAP sat unused. Insert only
     when this episode has no recent row with the same completion state, and
     prune to the cap after every insert. */
  const isCompleted = dur > 0 && pos / dur >= 0.9 ? 1 : 0;
  const last = db
    .prepare(`
      SELECT completed, watched_at FROM history
      WHERE user_id = ? AND title_slug = ? AND episode_num = ?
      ORDER BY watched_at DESC LIMIT 1
    `)
    .get(req.user.id, resolvedSlug, epNum);
  const recentSame =
    last &&
    last.completed === isCompleted &&
    Date.now() - Date.parse(last.watched_at) < 10 * 60 * 1000;
  if (!recentSame) {
    db.prepare(`
      INSERT INTO history (user_id, title_slug, episode_num, position_sec, completed, watched_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(req.user.id, resolvedSlug, epNum, pos, isCompleted, now);
    db.prepare(`
      DELETE FROM history WHERE user_id = ? AND id NOT IN (
        SELECT id FROM history WHERE user_id = ?
        ORDER BY watched_at DESC, id DESC LIMIT ?
      )
    `).run(req.user.id, req.user.id, HISTORY_PER_USER_CAP);
  }

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

/* One comment as the API serves it. Names and bodies are escaped HERE, at the
   API boundary, so no executable markup can leave the server even if a client
   later inserts the JSON with innerHTML. `is_guest` lets the UI badge guest
   posts. The browser still inserts the decoded text with textContent (never
   innerHTML) — two independent layers. */
function commentView(row) {
  const name = row.user_id != null
    ? (row.user_name || "User")
    : (row.guest_name || "Guest");
  return {
    id: row.id,
    content: escapeHtml(row.content),
    created_at: row.created_at,
    user_name: escapeHtml(name),
    avatar_tone: row.user_id != null ? row.avatar_tone : null,
    is_guest: row.user_id == null,
  };
}

app.get("/api/comments/:slug/:ep", (req, res) => {
  const { slug } = req.params;
  const epNum = toInt(req.params.ep, 1);

  const rows = db
    .prepare(`
      SELECT c.id, c.content, c.created_at, c.user_id, c.guest_name,
             u.name as user_name, u.avatar_tone
      FROM comments c
      LEFT JOIN users u ON c.user_id = u.id
      WHERE c.title_slug = ? AND c.episode_num = ?
      ORDER BY c.created_at DESC
      LIMIT 50
    `)
    .all(slug, epNum);

  res.json({ ok: true, comments: rows.map(commentView) });
});

/* Guest comments (Phase 3b): no account needed. A signed-in user's name is
   their account name; a guest supplies a display name (required, max 40).
   Both are rate-limited to one post per IP per 30 seconds. */
app.post("/api/comments/:slug/:ep", (req, res) => {
  const { slug } = req.params;
  const epNum = toInt(req.params.ep, 1);

  const ip = clientIp(req);
  const rl = commentLimiter.check(`ip:${ip}`);
  if (!rl.allowed) {
    throw tooManyRequests(
      "You're posting comments too quickly. Please wait a moment before commenting again.",
      Math.ceil(rl.retryAfterMs / 1000)
    );
  }

  /* Validate the slug and episode range (audit C3): an unvalidated slug used
     to throw a 500 (FK constraint) instead of a clean 404. */
  const resolvedSlug = resolveSlug(slug);
  const title = db.prepare("SELECT slug, episodes FROM titles WHERE slug = ?").get(resolvedSlug);
  if (!title) throw notFound("Title not found.");
  if (!Number.isInteger(epNum) || epNum < 1 || (title.episodes != null && epNum > title.episodes)) {
    throw badRequest(`Episode ${epNum} not found.`);
  }

  const content = cleanText(req.body.content);
  if (!content || content.length < 2 || content.length > COMMENT_TEXT_MAX) {
    throw badRequest(`Comment must be between 2 and ${COMMENT_TEXT_MAX} characters.`);
  }

  let userId = null;
  let guestName = null;
  let avatarTone = null;
  let authorName;

  if (req.user) {
    userId = req.user.id;
    authorName = req.user.name;
    avatarTone = req.user.avatarTone;
  } else {
    guestName = cleanText(req.body.name);
    if (!guestName || guestName.length > COMMENT_NAME_MAX) {
      throw badRequest(`Please enter a name (up to ${COMMENT_NAME_MAX} characters).`);
    }
    authorName = guestName;
  }

  const now = nowIso();
  const resInsert = db
    .prepare(`
      INSERT INTO comments (user_id, guest_name, title_slug, episode_num, content, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(userId, guestName, resolvedSlug, epNum, content, now);

  res.status(201).json({
    ok: true,
    comment: {
      id: resInsert.lastInsertRowid,
      content: escapeHtml(content),
      created_at: now,
      user_name: escapeHtml(authorName),
      avatar_tone: avatarTone,
      is_guest: userId == null,
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
    app: "AniFlick API",
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

/* Versioned assets (?v= cache-buster) are immutable (fix #5, 23 Nov audit):
   the version string IS the cache invalidation, so browsers never need to
   revalidate them. Done here, not in Caddy: Caddy's `header` runs before the
   reverse proxy copies upstream headers, so it ADDED a second Cache-Control
   instead of replacing the no-cache one (verified live — two headers, and
   no-cache wins). setHeaders has no access to the request, so this small
   middleware ahead of the static handler records the decision on res.locals. */
app.use((req, res, next) => {
  if (
    req.query.v != null &&
    (req.path.endsWith(".js") || req.path.endsWith(".css"))
  ) {
    res.locals.versionedAsset = true;
  }
  next();
});

app.get(["/detail", "/detail.html"], (req, res, next) => {
  const rawSlug =
    typeof req.query.slug === "string"
      ? req.query.slug.trim()
      : typeof req.query.id === "string"
        ? req.query.id.trim()
        : "";
  if (!rawSlug) return next();
  const slug = resolveSlug(rawSlug);
  const row = db.prepare("SELECT * FROM titles WHERE slug = ?").get(slug);
  if (!row) return next();
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  return res.type("html").send(renderDetailHtml(titleView(row)));
});

app.use(
  express.static(SITE_ROOT, {
    maxAge: STATIC_MAX_AGE_MS,
    etag: true,
    lastModified: true,
    setHeaders(res, filePath) {
      if (res.locals.versionedAsset || filePath.endsWith(".woff2")) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else if (
        filePath.endsWith(".html") ||
        filePath.endsWith(".js") ||
        filePath.endsWith(".css") ||
        filePath.endsWith(`${path.sep}robots.txt`) ||
        filePath.endsWith(`${path.sep}sitemap.xml`)
      ) {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      }
    },
  })
);

const NO_CACHE_FILE_OPTS = {
  cacheControl: false,
  headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
};

/* Named page routes (23 Nov): clean URLs — /home, /browse, /faq, … — with
   one explicit route per page instead of relying on the generic /:page
   fallback below. /home is new (the fallback can only serve /index);
   /watch and /detail serve their pages bare — the client script reads the
   query string (?live=…&ep=…), same as /watch.html does today. These sit
   after all /api/* routes and the static handler, so neither is affected. */
const NAMED_PAGES = {
  home: "index.html",
  browse: "browse.html",
  watch: "watch.html",
  detail: "detail.html",
  schedule: "schedule.html",
  genres: "genres.html",
  "az-list": "az-list.html",
  faq: "faq.html",
  privacy: "privacy.html",
  terms: "terms.html",
  dmca: "dmca.html",
  about: "about.html",
  contact: "contact.html",
  login: "login.html",
  /* Password-reset landing page (magic-link target). The token is NOT
     validated on GET — the page is static; the POST endpoint validates. */
  "reset-password": "reset-password.html",
};
for (const [name, file] of Object.entries(NAMED_PAGES)) {
  app.get(`/${name}`, (req, res) => {
    res.sendFile(path.join(SITE_ROOT, file), NO_CACHE_FILE_OPTS);
  });
}

// Pretty detail page URL: /anime/<slug> (server-rendered meta + JSON-LD + canonical)
app.get("/anime/:slug", (req, res, next) => {
  const slug = resolveSlug(req.params.slug);
  const row = db.prepare("SELECT * FROM titles WHERE slug = ?").get(slug);
  if (!row) return next();
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  return res.type("html").send(renderDetailHtml(titleView(row)));
});

// Fallback for HTML routing if requested without extension.
// SECURITY (audit, hunter C): confine the resolved path to SITE_ROOT.
// res.sendFile with no `root` option used to serve ANY *.html on disk
// (GET /..%2f..%2f...%2fsecret returned 200 for a file outside the web root).
app.get("/:page", (req, res, next) => {
  const pageFile = path.resolve(SITE_ROOT, `${req.params.page}.html`);
  if (!pageFile.startsWith(SITE_ROOT + path.sep)) return next();
  res.sendFile(pageFile, NO_CACHE_FILE_OPTS, (err) => {
    if (err) next();
  });
});

/* Final 404 (fix #10, 23 Nov audit): API paths get JSON, everything else
   gets the branded 404 page — previously Express's raw "Cannot GET ..."
   text. 404.html uses root-relative asset paths because it can be served
   for a URL at any depth. */
app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({
      ok: false,
      error: { code: "NOT_FOUND", message: "Not found." },
    });
  }
  res.status(404).sendFile(path.join(SITE_ROOT, "404.html"), NO_CACHE_FILE_OPTS);
});

/* ==========================================================================
   ERROR HANDLING
   ========================================================================== */

app.use((err, req, res, next) => {
  if (err instanceof ApiError) {
    if (err.retryAfter != null) {
      res.set("Retry-After", String(err.retryAfter));
    }
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

/* Expired sessions and expired reset tokens were never swept (audit D3/D5):
   the tables only grew. An hourly sweep removes them (token rows are deleted
   only after their 1h/24h expiry, so a live link is never revoked early).
   Runs once at startup and hourly; .unref() keeps it from holding the
   process (and the test suite) open. */
const SESSION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const sessionSweep = setInterval(() => {
  const now = nowIso();
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  db.prepare("DELETE FROM password_reset_tokens WHERE expires_at <= ?").run(now);
}, SESSION_SWEEP_INTERVAL_MS);
sessionSweep.unref();
db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso());
db.prepare("DELETE FROM password_reset_tokens WHERE expires_at <= ?").run(nowIso());

// Start Server
if (process.argv[1] && process.argv[1].endsWith("index.js")) {
  app.listen(PORT, HOST, () => {
    console.log(`AniFlick Server running at http://${HOST}:${PORT}`);
    console.log(`Serving frontend from: ${SITE_ROOT}`);
  });
}

export default app;
