/* In-memory fixed-window rate limiter (Phase 3b).
   Deliberately NOT a database table: it only throttles abuse, and a process
   restart clearing it is acceptable. Each key owns { count, resetAt }; the
   window starts at the first hit, so a burst is limited per rolling window
   anchored to the client, not a shared wall-clock slot. */

export function createRateLimiter({ max, windowMs }) {
  const hits = new Map();
  /* Hard cap on the map itself (audit C6): entries only expired by time,
     so an attacker spraying distinct keys (IPs, emails) could grow it
     without bound. Evict the OLDEST entry once past the cap — a fixed
     window is a throttle, not a database. */
  const HARD_CAP = 10000;

  function prune(now) {
    for (const [key, rec] of hits) {
      if (rec.resetAt <= now) hits.delete(key);
    }
  }

  return {
    /* Returns { allowed, retryAfterMs }. A disallowed key is NOT re-armed:
       the client must wait out the original window. */
    check(key) {
      const now = Date.now();
      /* Bound memory: drop expired entries when the map grows. */
      if (hits.size > 5000) prune(now);
      if (hits.size >= HARD_CAP) {
        const oldest = hits.keys().next().value;
        if (oldest !== undefined) hits.delete(oldest);
      }

      const rec = hits.get(key);
      if (!rec || rec.resetAt <= now) {
        hits.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, retryAfterMs: 0 };
      }
      if (rec.count >= max) {
        return { allowed: false, retryAfterMs: Math.max(0, rec.resetAt - now) };
      }
      rec.count += 1;
      return { allowed: true, retryAfterMs: 0 };
    },
    /* Successful login clears the per-account counter (the IP counter is
       deliberately left alone). */
    reset(key) {
      hits.delete(key);
    },
    get size() {
      return hits.size;
    },
  };
}
