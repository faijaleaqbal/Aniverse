import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const SERVER_ROOT = path.resolve(here, "..");
export const SITE_ROOT = path.resolve(SERVER_ROOT, "..", "ani-verse");

export const NODE_ENV = process.env.NODE_ENV || "development";
export const IS_PROD = NODE_ENV === "production";

export const HOST = process.env.HOST || "127.0.0.1";
export const PORT = Number(process.env.PORT || 4000);

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

/* Breach lists are long. This is the floor, not a policy. */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;
export const NAME_MIN = 1;
export const NAME_MAX = 40;

/* ZokoAnime embed player configuration (never hardcoded in the frontend). */
export const ZOKO_EMBED_ORIGIN = (process.env.ZOKO_EMBED_ORIGIN || "https://zokoanime.video").replace(/\/+$/, "");
export const ZOKO_DEFAULT_SOURCE = process.env.ZOKO_DEFAULT_SOURCE || "mal";
export const ZOKO_DEFAULT_TRACK = process.env.ZOKO_DEFAULT_TRACK || "sub";
export const ZOKO_DEFAULT_COLOR = (process.env.ZOKO_DEFAULT_COLOR || "cae962").replace(/^#/, "");

export const HISTORY_LIMIT = 50;
export const HISTORY_PER_USER_CAP = 500;
export const CONTINUE_LIMIT = 12;
