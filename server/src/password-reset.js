/* Password-reset / set-password magic-link tokens.
   - The raw token is 32 random bytes (base64url, 256 bits of entropy) and
     exists ONLY in the email and in the caller's memory. The database
     stores only its SHA-256 hash — a leaked database reveals no usable
     link.
   - Single-use: a token is marked used the moment its password is set.
   - Expiry: reset links live 1 hour, setup links 24 hours
     (RESET_TOKEN_TTL_MS / SETUP_TOKEN_TTL_MS in config.js).
   - A password change invalidates EVERY token for that user and deletes
     ALL of their sessions (forced re-login everywhere).
*/
import { db } from "./db.js";
import { BASE_URL, RESET_TOKEN_TTL_MS, SETUP_TOKEN_TTL_MS } from "./config.js";
import { nowIso, addMs, randomToken, sha256 } from "./utils.js";

export const RESET_TOKEN_PURPOSES = ["reset", "setup"];

export function hashResetToken(rawToken) {
  return sha256(String(rawToken));
}

export function resetLink(rawToken) {
  return `${BASE_URL}/reset-password?token=${encodeURIComponent(rawToken)}`;
}

/* Create a token for a user and return the RAW token (the only time it is
   ever available). The caller is responsible for emailing it. */
export function createResetToken(userId, purpose) {
  const rawToken = randomToken(32);
  const now = nowIso();
  const ttl = purpose === "setup" ? SETUP_TOKEN_TTL_MS : RESET_TOKEN_TTL_MS;
  db.prepare(`
    INSERT INTO password_reset_tokens (user_id, token_hash, purpose, expires_at, used_at, created_at)
    VALUES (?, ?, ?, ?, NULL, ?)
  `).run(userId, hashResetToken(rawToken), purpose, addMs(now, ttl), now);
  return rawToken;
}

/* Look up a token by its raw value. Returns the row only when it exists,
   is unused, and has not expired — every other case returns null, so the
   caller cannot distinguish "unknown" from "expired" from "used" (one
   generic error for all three). */
export function findValidResetToken(rawToken) {
  if (typeof rawToken !== "string" || !rawToken) return null;
  const row = db
    .prepare("SELECT * FROM password_reset_tokens WHERE token_hash = ?")
    .get(hashResetToken(rawToken));
  if (!row) return null;
  if (row.used_at) return null;
  if (Date.parse(row.expires_at) <= Date.now()) return null;
  return row;
}

/* Delete every token for a user (used on password change — a fresh password
   must not leave any older link usable). */
export function invalidateUserTokens(userId) {
  db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(userId);
}

/* Delete every session for a user (used on password change — a password
   reset must log the account out everywhere, including a stolen session). */
export function invalidateUserSessions(userId) {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

/* Apply a password change atomically: set the new hash, mark this token
   used, delete every other token for the user, and delete all of the
   user's sessions. The password hash must be computed (async scrypt)
   BEFORE calling this — better-sqlite3 transactions are synchronous. */
export function applyPasswordReset({ tokenId, userId, passwordHash }) {
  const now = nowIso();
  db.transaction(() => {
    db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(
      passwordHash,
      now,
      userId
    );
    db.prepare("UPDATE password_reset_tokens SET used_at = ? WHERE id = ?").run(now, tokenId);
    db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ? AND id != ?").run(userId, tokenId);
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  })();
}
