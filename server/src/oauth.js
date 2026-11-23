/* HiAnime-style social logins: Google, Discord, MyAnimeList (MAL), AniList.
   OAuth 2.0 authorization-code flow. Every provider is configured purely
   from environment variables — a provider with no credentials is DISABLED:
   its /auth/<provider> route serves a clear error page and its button is
   hidden (the frontend asks GET /api/auth/providers what is enabled).

   Security notes:
   - `state` is a random token stored SERVER-side in the attempts map and
     consumed (single-use) on callback — never a client cookie.
   - PKCE (S256) is used for MAL (required by MAL) and Google; the
     code_verifier lives only in the server-side attempts map.
   - Tokens are never logged and never appear in a URL after the callback.
   - A social login creates the SAME session (same cookie, same TTL) as a
     local login, through the createSession function index.js injects.
   - Account linking matches by email (same email = same account) and
     NEVER overwrites an existing local password_hash. Providers that
     don't return an email (MAL, AniList, sometimes Discord) get a
     clearly-fake placeholder in the .invalid TLD (RFC 2606 — never a
     real address); the account is keyed to its provider identity.
*/
import { db } from "./db.js";
import { createRateLimiter } from "./ratelimit.js";
import { nowIso, randomToken, normalizeEmail } from "./utils.js";
import {
  providerConfig,
  enabledProviders,
  buildRedirectUri,
  pkceChallenge,
  placeholderEmail,
  cleanSocialName,
} from "./oauth-providers.js";

export const OAUTH_ATTEMPT_TTL_MS = 10 * 60 * 1000;
const OAUTH_FETCH_TIMEOUT_MS = 15000;

/* ==========================================================================
   ACCOUNT LINKING
   ========================================================================== */

/* Find-or-create the local account for a social profile. Order:
   1. Existing linked identity (provider + provider user id) → that user.
   2. Email match → link the provider to that account (password untouched).
   3. Otherwise create a new user (NULL password_hash — social-only).
   Returns the full user row. Never overwrites password_hash. */
export function linkOrCreateAccount({ provider, providerUserId, email, name }) {
  const pid = String(providerUserId);
  const existing = db
    .prepare("SELECT user_id FROM linked_identities WHERE provider = ? AND provider_user_id = ?")
    .get(provider, pid);
  if (existing) {
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(existing.user_id);
    if (user) return user;
    /* Identity without a user (shouldn't happen — FK cascade — but be
       safe): drop the orphan and fall through to email/create. */
    db.prepare("DELETE FROM linked_identities WHERE provider = ? AND provider_user_id = ?").run(provider, pid);
  }

  const cleanEmail = email ? normalizeEmail(email) : "";
  const now = nowIso();
  const displayName = cleanSocialName(name);

  return db.transaction(() => {
    let user = null;
    if (cleanEmail) {
      user = db.prepare("SELECT * FROM users WHERE email = ?").get(cleanEmail);
    }
    if (!user) {
      const accountEmail = cleanEmail || placeholderEmail(provider, pid);
      const avatarTone = Math.floor(Math.random() * 6) + 1;
      const result = db
        .prepare(`
          INSERT INTO users (email, password_hash, name, avatar_tone, created_at, updated_at)
          VALUES (?, NULL, ?, ?, ?, ?)
        `)
        .run(accountEmail, displayName, avatarTone, now, now);
      user = db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid);
    }
    db.prepare(`
      INSERT OR IGNORE INTO linked_identities (user_id, provider, provider_user_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(user.id, provider, pid, now);
    return user;
  })();
}

/* ==========================================================================
   OAUTH FLOW
   ========================================================================== */

/* In-memory pending attempts: state -> { provider, codeVerifier, next,
   createdAt }. A restart loses pending attempts (the user just retries) —
   the same trade-off as the in-memory rate limiters. */
const attempts = new Map();

function sweepAttempts(now) {
  for (const [state, rec] of attempts) {
    if (rec.createdAt + OAUTH_ATTEMPT_TTL_MS <= now) attempts.delete(state);
  }
}

/* Client IP (same normalisation as index.js — duplicated here because
   importing it from index.js would be a circular import). */
function clientIp(req) {
  const raw = req.ip || (req.socket && req.socket.remoteAddress) || "unknown";
  return String(raw).replace(/^::ffff:/i, "").replace(/^\[|\]$/g, "");
}

const oauthLimiter = createRateLimiter({ max: 20, windowMs: 60 * 60 * 1000 });

/* A return path is only honoured when it is a same-site relative path —
   never an absolute URL (open-redirect protection). */
function safeNextPath(value) {
  if (typeof value !== "string") return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  return value.slice(0, 500);
}

/* Self-contained error page (no external assets — it must render even if
   the static pipeline is having a bad day). */
export function oauthErrorPage(title, message) {
  const esc = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} | AniFlick</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #0b0d12; color: #e5e7eb; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  .card { max-width: 420px; margin: 1rem; padding: 2rem; text-align: center;
          background: #161820; border: 1px solid #2a2e3a; border-radius: 16px; }
  h1 { margin: 0 0 0.75rem; font-size: 1.25rem; color: #cae962; }
  p { margin: 0 0 1.5rem; color: #9ca3af; line-height: 1.5; font-size: 0.95rem; }
  a { display: inline-block; padding: 0.7rem 1.5rem; border-radius: 8px; text-decoration: none;
      background: #cae962; color: #111; font-weight: 700; }
</style>
</head>
<body><div class="card"><h1>${esc(title)}</h1><p>${esc(message)}</p><a href="/">Back to AniFlick</a></div></body>
</html>`;
}

function sendOAuthError(res, status, title, message) {
  res.status(status).type("html").send(oauthErrorPage(title, message));
}

async function postForm(url, params) {
  const body = new URLSearchParams(params);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
    signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || typeof data !== "object") {
    throw new Error(`token exchange failed (HTTP ${res.status})`);
  }
  return data;
}

async function fetchProfile(cfg, accessToken) {
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
  if (cfg.id === "anilist") {
    /* AniList has no REST profile endpoint — the Viewer query is the way. */
    const res = await fetch(cfg.userinfoUrl, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "query { Viewer { id name } }" }),
      signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
    });
    const data = await res.json().catch(() => null);
    const viewer = data && data.data && data.data.Viewer;
    if (!res.ok || !viewer || viewer.id == null) {
      throw new Error(`AniList profile fetch failed (HTTP ${res.status})`);
    }
    return { providerUserId: String(viewer.id), email: null, name: viewer.name || "" };
  }

  const res = await fetch(cfg.userinfoUrl, {
    headers,
    signal: AbortSignal.timeout(OAUTH_FETCH_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || typeof data !== "object") {
    throw new Error(`${cfg.name} profile fetch failed (HTTP ${res.status})`);
  }

  if (cfg.id === "google") {
    if (data.sub == null) throw new Error("Google profile has no subject id");
    /* Only trust the email when Google says it is verified. */
    const email = data.email_verified === true ? data.email : null;
    return { providerUserId: String(data.sub), email: email || null, name: data.name || "" };
  }
  if (cfg.id === "discord") {
    if (data.id == null) throw new Error("Discord profile has no id");
    /* Discord only includes `email` when the address is verified and the
       email scope was granted; it may be null when hidden. */
    return {
      providerUserId: String(data.id),
      email: data.email || null,
      name: data.global_name || data.username || "",
    };
  }
  /* MAL: { id, name } — no email, ever. */
  if (data.id == null) throw new Error("MAL profile has no id");
  return { providerUserId: String(data.id), email: null, name: data.name || "" };
}

export function mountOAuthRoutes(app, { createSession }) {
  /* Which providers are live — the frontend renders buttons from this, so
     an unconfigured provider never shows a dead button. */
  app.get("/api/auth/providers", (req, res) => {
    res.json({ ok: true, providers: enabledProviders() });
  });

  app.get("/auth/:provider", (req, res, next) => {
    const cfg = providerConfig(req.params.provider);
    if (!cfg) return next(); /* Unknown provider → branded 404. */
    if (!cfg.enabled) {
      return sendOAuthError(
        res,
        503,
        `${cfg.name} sign-in isn't set up yet`,
        `Sign in with ${cfg.name} hasn't been configured on this site yet. Please use email sign-in for now, or try again later.`
      );
    }

    const ip = clientIp(req);
    const rl = oauthLimiter.check(`start:${ip}`);
    if (!rl.allowed) {
      return sendOAuthError(res, 429, "Too many sign-in attempts", "Please wait a while and try again.");
    }

    const state = randomToken(24);
    const codeVerifier = cfg.pkce ? randomToken(32) : null;
    sweepAttempts(Date.now());
    attempts.set(state, {
      provider: cfg.id,
      codeVerifier,
      next: safeNextPath(req.query.next),
      createdAt: Date.now(),
    });

    const params = new URLSearchParams({
      response_type: "code",
      client_id: cfg.clientId,
      redirect_uri: buildRedirectUri(cfg.id),
      state,
    });
    if (cfg.scope) params.set("scope", cfg.scope);
    if (cfg.pkce) {
      params.set("code_challenge", pkceChallenge(codeVerifier));
      params.set("code_challenge_method", "S256");
    }
    res.redirect(`${cfg.authorizeUrl}?${params.toString()}`);
  });

  app.get("/auth/:provider/callback", async (req, res, next) => {
    const cfg = providerConfig(req.params.provider);
    if (!cfg) return next(); /* Unknown provider → branded 404. */
    if (!cfg.enabled) {
      return sendOAuthError(
        res,
        503,
        `${cfg.name} sign-in isn't set up yet`,
        `Sign in with ${cfg.name} hasn't been configured on this site yet.`
      );
    }

    const ip = clientIp(req);
    const rl = oauthLimiter.check(`callback:${ip}`);
    if (!rl.allowed) {
      return sendOAuthError(res, 429, "Too many sign-in attempts", "Please wait a while and try again.");
    }

    /* The provider reports a denial (or an error) in the query string. */
    if (req.query.error) {
      return sendOAuthError(
        res,
        400,
        "Sign-in was cancelled",
        `The ${cfg.name} sign-in didn't complete. You can try again or use email sign-in instead.`
      );
    }

    const { code, state } = req.query;
    if (typeof code !== "string" || !code || typeof state !== "string" || !state) {
      return sendOAuthError(res, 400, "Sign-in link is incomplete", "The sign-in link is missing information. Please try signing in again.");
    }

    const attempt = attempts.get(state);
    attempts.delete(state); /* Single-use, whatever the outcome. */
    if (!attempt || attempt.provider !== cfg.id || attempt.createdAt + OAUTH_ATTEMPT_TTL_MS <= Date.now()) {
      return sendOAuthError(
        res,
        400,
        "Sign-in link expired",
        "This sign-in link expired or was already used. Please try signing in again."
      );
    }

    try {
      const tokenParams = {
        grant_type: "authorization_code",
        code,
        redirect_uri: buildRedirectUri(cfg.id),
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
      };
      if (cfg.pkce) tokenParams.code_verifier = attempt.codeVerifier;
      const tokenData = await postForm(cfg.tokenUrl, tokenParams);
      if (!tokenData.access_token) {
        throw new Error("token exchange returned no access token");
      }
      const profile = await fetchProfile(cfg, tokenData.access_token);
      const user = linkOrCreateAccount({ provider: cfg.id, ...profile });
      createSession(req, res, user.id);
      res.redirect(attempt.next || "/");
    } catch (err) {
      /* Log the cause without any token material — the message carries only
         the provider and the HTTP status. */
      console.error(`OAuth callback failed (${cfg.id}):`, err && err.message ? err.message : err);
      return sendOAuthError(
        res,
        502,
        `Couldn't sign in with ${cfg.name}`,
        `Something went wrong talking to ${cfg.name}. Please try again in a moment, or use email sign-in.`
      );
    }
  });
}
