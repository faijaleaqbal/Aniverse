/* Cloudflare Turnstile helpers: public site-key lookup and server-side token
   verification. Keys are read from process.env at call time so tests and live
   environments stay dynamic. Never log TURNSTILE_SECRET_KEY. */
import { forbidden } from "./utils.js";

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_TIMEOUT_MS = 10000;
const TURNSTILE_FAIL_MSG = "Bot verification failed. Please try again.";

let unconfiguredWarned = false;

export function getTurnstileSiteKey() {
  return (process.env.TURNSTILE_SITE_KEY || "").trim();
}

export function getTurnstileSecretKey() {
  return (process.env.TURNSTILE_SECRET_KEY || "").trim();
}

export async function verifyTurnstile({ token, remoteip, fetchImpl = fetch } = {}) {
  const secret = getTurnstileSecretKey();
  if (!secret) {
    if (!unconfiguredWarned) {
      unconfiguredWarned = true;
      console.warn("[turnstile] TURNSTILE_SECRET_KEY is not configured; skipping bot verification (fail-open).");
    }
    return { ok: true, skipped: true };
  }

  const responseToken = typeof token === "string" ? token.trim() : "";
  if (!responseToken) {
    throw forbidden(TURNSTILE_FAIL_MSG);
  }

  const payload = { secret, response: responseToken };
  if (remoteip && remoteip !== "unknown") {
    payload.remoteip = remoteip;
  }

  let data = null;
  try {
    const res = await fetchImpl(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw forbidden(TURNSTILE_FAIL_MSG);
    }
    data = await res.json().catch(() => null);
  } catch (err) {
    if (err && err.status === 403) throw err;
    throw forbidden(TURNSTILE_FAIL_MSG);
  }

  if (!data || data.success !== true) {
    throw forbidden(TURNSTILE_FAIL_MSG);
  }

  return { ok: true, skipped: false };
}
