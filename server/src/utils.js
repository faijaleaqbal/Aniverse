import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 64;

export class ApiError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}

export const badRequest = (message, fields) => new ApiError(400, "BAD_REQUEST", message, fields);
export const unauthorized = (message = "Sign in to continue.") =>
  new ApiError(401, "UNAUTHORIZED", message);
export const notFound = (message = "Not found.") => new ApiError(404, "NOT_FOUND", message);
export const conflict = (code, message) => new ApiError(409, code, message);

export function nowIso() {
  return new Date().toISOString();
}

export function addMs(iso, ms) {
  return new Date(Date.parse(iso) + ms).toISOString();
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LEN, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");
  if (!salt.length || !expected.length) return false;
  let key;
  try {
    key = await scrypt(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT.maxmem,
    });
  } catch {
    return false;
  }
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/* Same amount of work for unknown accounts, so login timing does not leak. */
let decoyHash = null;
export async function burnPasswordCheck(password) {
  if (!decoyHash) decoyHash = await hashPassword(randomToken(24));
  await verifyPassword(password, decoyHash);
}

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function cleanText(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const key = part.slice(0, index).trim();
    const raw = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

export function toInt(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function userView(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarTone: row.avatar_tone,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function titleView(row) {
  if (!row) return null;
  return {
    slug: row.slug,
    name: row.name,
    kind: row.kind,
    year: row.year,
    episodes: row.episodes,
    runtimeMin: row.runtime_min,
    genres: row.genres ? row.genres.split(",").filter(Boolean) : [],
    tone: row.tone,
    studio: row.studio,
    tagline: row.tagline,
    synopsis: row.synopsis,
    malId: row.mal_id || 21,
    anilistId: row.anilist_id || 21,
  };
}
