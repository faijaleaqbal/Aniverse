import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const SERVER_ROOT = path.resolve(here, "..");
export const SITE_ROOT = path.resolve(SERVER_ROOT, "..", "ani-verse");

export const NODE_ENV = process.env.NODE_ENV || "development";
export const IS_PROD = NODE_ENV === "production";

export const HOST = process.env.HOST || "127.0.0.1";
export const PORT = Number(process.env.PORT || 4000);

/* Public base URL of the site — used for OAuth redirect URIs
   (https://<base>/auth/<provider>/callback). Override with BASE_URL when the
   real domain replaces the DuckDNS test host; no code change needed. */
export const BASE_URL = (process.env.BASE_URL || "https://aniversetesting.duckdns.org").replace(/\/+$/, "");

export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(SERVER_ROOT, "data");
export const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.join(DATA_DIR, "aniverse.db");

export const SESSION_COOKIE = "av_session";
export const SESSION_TTL_DAYS = 30;
export const SESSION_TTL_HOURS = 12;
export const SESSION_REFRESH_BELOW_MS = 7 * 24 * 60 * 60 * 1000;

export const COOKIE_SECURE = process.env.COOKIE_SECURE
  ? process.env.COOKIE_SECURE === "true"
  : IS_PROD;

/* Behind a reverse proxy (Caddy) the peer is the proxy, so req.ip would
   otherwise be the SAME address for every visitor and the auth/comment rate
   limits would be global. Set ANIVERSE_TRUST_PROXY=true only when the app
   really sits behind a proxy that sets X-Forwarded-For. */
export const TRUST_PROXY = process.env.ANIVERSE_TRUST_PROXY === "true"
  || process.env.ANIVERSE_TRUST_PROXY === "1";

/* Breach lists are long. This is the floor, not a policy. */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;
export const NAME_MIN = 1;
export const NAME_MAX = 40;

/* Guest comments (Phase 3b). A guest supplies a display name (max 40) and a
   comment (max 1000); a signed-in user's name comes from their account. */
export const COMMENT_NAME_MAX = 40;
export const COMMENT_TEXT_MAX = 1000;
/* One comment per IP per 30 seconds — enough for a conversation, far too
   slow to flood. */
export const COMMENT_RATE_LIMIT_MS = 30 * 1000;

/* Auth rate limits (Phase 3b), in-memory fixed windows. Login is limited per
   IP AND per account (whichever trips first); a successful login resets the
   per-account counter. Registration is limited per IP. */
export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const REGISTER_MAX_ATTEMPTS = 5;
export const REGISTER_WINDOW_MS = 60 * 60 * 1000;

/* Password-reset rate limits. Forgot-password is limited per IP AND per
   email address (whichever trips first) so one address cannot be spammed
   from many addresses and one address cannot enumerate accounts. The reset
   endpoint itself is limited per IP — the token is 256 bits of randomness,
   so this is belt-and-braces against probing, not the main defence. */
export const FORGOT_PASSWORD_MAX_ATTEMPTS = 5;
export const FORGOT_PASSWORD_WINDOW_MS = 60 * 60 * 1000;
export const RESET_PASSWORD_MAX_ATTEMPTS = 10;
export const RESET_PASSWORD_WINDOW_MS = 60 * 60 * 1000;

/* Password-reset token lifetimes. A reset link is short-lived (1 hour);
   the set-password link for a new social account lives a day, because the
   user may not open it right after signing up. */
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
export const SETUP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/* ZokoAnime embed player configuration (never hardcoded in the frontend). */
export const ZOKO_EMBED_ORIGIN = (process.env.ZOKO_EMBED_ORIGIN || "https://zokoanime.video").replace(/\/+$/, "");
export const ZOKO_DEFAULT_SOURCE = process.env.ZOKO_DEFAULT_SOURCE || "mal";
export const ZOKO_DEFAULT_TRACK = process.env.ZOKO_DEFAULT_TRACK || "sub";
export const ZOKO_DEFAULT_COLOR = (process.env.ZOKO_DEFAULT_COLOR || "cae962").replace(/^#/, "");

/* animegg fallback provider, resolved through the self-hosted Anivexa-API
   (server/src/animegg.js). The instance is NOT reachable from the browser —
   every call goes through this server. */
export const ANIVEXA_BASE_URL = (process.env.ANIVEXA_BASE_URL || "http://127.0.0.1:4100").replace(/\/+$/, "");
export const ANIVEXA_EPISODES_TIMEOUT_MS = Number(process.env.ANIVEXA_EPISODES_TIMEOUT_MS || 25000);
export const ANIVEXA_WATCH_TIMEOUT_MS = Number(process.env.ANIVEXA_WATCH_TIMEOUT_MS || 20000);
export const ANIVEXA_AVAIL_CACHE_MS = Number(process.env.ANIVEXA_AVAIL_CACHE_MS || 10 * 60 * 1000);

export const HISTORY_LIMIT = 50;
export const HISTORY_PER_USER_CAP = 500;
export const CONTINUE_LIMIT = 12;
