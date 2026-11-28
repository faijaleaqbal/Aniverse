/**
 * Hindi player server-side helpers (Vidstream-3 / blakiteapi.xyz).
 *
 * - Vidstream-3 (blakiteapi.xyz) has no frame-ancestors restriction, but returns a
 *   "Content not available" / "Video Unavailable" page when a title/episode is missing.
 *   We check availability server-side (failing open on transient network errors) and
 *   cache the check briefly so the watch page hides the button when unavailable and
 *   card lists / detail pages suppress Multi Audio for titles known unavailable.
 */

const DEFAULT_BLAKITE_ORIGIN = (process.env.BLAKITE_ORIGIN || "https://blakiteapi.xyz").replace(/\/+$/, "");

let blakiteOrigin = DEFAULT_BLAKITE_ORIGIN;

const FETCH_TIMEOUT_MS = 10_000;
const VIDSTREAM3_CACHE_TTL_MS = 3 * 60 * 1000; // availability cache (3 min)
const CACHE_MAX = 500;

const vidstream3Cache = new Map();
const vidstream3Inflight = new Map();

export function _setHindiOriginsForTests({ blakite } = {}) {
  blakiteOrigin = (blakite || DEFAULT_BLAKITE_ORIGIN).replace(/\/+$/, "");
}

export function clearHindiCaches() {
  vidstream3Cache.clear();
  vidstream3Inflight.clear();
}

function boundedSet(map, key, entry) {
  if (map.size >= CACHE_MAX) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [k, v] of map) {
      if (v.at < oldestAt) {
        oldestAt = v.at;
        oldestKey = k;
      }
    }
    if (oldestKey != null) map.delete(oldestKey);
  }
  map.set(key, entry);
}

/**
 * Detect whether a blakiteapi.xyz embed page reports unavailable content.
 * Inspects `window.CFG` first (so JS error-handler template strings like
 * `showMsg('<h1>Video Unavailable</h1>')` on working pages do not false-positive),
 * then falls back to non-script HTML text matching "Video Unavailable" or
 * "Content not available".
 */
export function isBlakiteUnavailableHtml(html) {
  if (typeof html !== "string" || !html.trim()) return true;

  const cfgMatch = html.match(/window\.CFG\s*=\s*(\{[\s\S]*?\})\s*;/);
  if (cfgMatch && cfgMatch[1]) {
    try {
      const cfg = JSON.parse(cfgMatch[1]);
      if (cfg && typeof cfg === "object") {
        if (String(cfg.err || "").trim()) return true;
        if (!String(cfg.dataId || "").trim()) return true;
        return false;
      }
    } catch {
      /* Fall through to non-script HTML text check. */
    }
  }

  const withoutScripts = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ");
  return /video\s+unavailable|content\s+not\s+available/i.test(withoutScripts);
}

async function fetchHtml(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Synchronously return cached Vidstream-3 availability (`true`, `false`, or `null` if unknown).
 * Never performs network I/O; safe for card list endpoints.
 */
export function getKnownVidstream3Availability({ tmdbId, season = 1, episode = 1 } = {}) {
  const id = Math.trunc(Number(tmdbId));
  const s = Math.trunc(Number(season));
  const ep = Math.trunc(Number(episode));
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(s) || s <= 0 || !Number.isFinite(ep) || ep <= 0) {
    return false;
  }
  const hit = vidstream3Cache.get(`${id}:${s}-${ep}`);
  if (!hit || Date.now() - hit.at >= VIDSTREAM3_CACHE_TTL_MS) return null;
  return Boolean(hit.available);
}

/**
 * Attach `hindiAvailable` (`true` | `false` | `null`) to a resolved TMDB info object
 * using the in-memory Vidstream-3 availability cache.
 */
export function withHindiAvailability(tmdbInfo = {}) {
  const tmdbId = tmdbInfo && tmdbInfo.tmdbId ? Number(tmdbInfo.tmdbId) : null;
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
    return { ...tmdbInfo, hindiAvailable: false };
  }
  const season = Number(tmdbInfo.tmdbSeason) > 0 ? Math.floor(Number(tmdbInfo.tmdbSeason)) : 1;
  const offset = Number(tmdbInfo.tmdbEpisodeOffset) > 0 ? Math.floor(Number(tmdbInfo.tmdbEpisodeOffset)) : 0;
  return {
    ...tmdbInfo,
    hindiAvailable: getKnownVidstream3Availability({ tmdbId, season, episode: 1 + offset }),
  };
}

/**
 * Check whether Vidstream-3 (blakiteapi.xyz) carries Hindi content for a TMDB episode.
 * Fails open (`available: true, checked: false`) on transient network/5xx errors so
 * a working title is not hidden by a temporary upstream blip.
 */
export async function checkVidstream3Availability({ tmdbId, season = 1, episode = 1 } = {}) {
  const id = Math.trunc(Number(tmdbId));
  const s = Math.trunc(Number(season));
  const ep = Math.trunc(Number(episode));
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(s) || s <= 0 || !Number.isFinite(ep) || ep <= 0) {
    return { ok: true, available: false, checked: true, reason: "invalid_params", embedUrl: null };
  }

  const embedUrl = `${blakiteOrigin}/embed/${id}/${s}-${ep}`;
  const key = `${id}:${s}-${ep}`;
  const hit = vidstream3Cache.get(key);
  if (hit && Date.now() - hit.at < VIDSTREAM3_CACHE_TTL_MS) {
    return {
      ok: true,
      available: hit.available,
      checked: true,
      reason: hit.reason || null,
      embedUrl: hit.available ? embedUrl : null,
    };
  }
  if (vidstream3Inflight.has(key)) {
    return vidstream3Inflight.get(key);
  }

  const task = (async () => {
    let res;
    try {
      res = await fetchHtml(embedUrl);
    } catch {
      return { ok: true, available: true, checked: false, reason: "upstream_error", embedUrl };
    }

    if (res.status === 404 || res.status === 410) {
      boundedSet(vidstream3Cache, key, { available: false, reason: "not_found", at: Date.now() });
      return { ok: true, available: false, checked: true, reason: "not_found", embedUrl: null };
    }
    if (!res.ok) {
      return { ok: true, available: true, checked: false, reason: `upstream_http_${res.status}`, embedUrl };
    }

    let html;
    try {
      html = await res.text();
    } catch {
      return { ok: true, available: true, checked: false, reason: "upstream_read_error", embedUrl };
    }

    const available = !isBlakiteUnavailableHtml(html);
    const reason = available ? null : "video_unavailable";
    boundedSet(vidstream3Cache, key, { available, reason, at: Date.now() });
    return {
      ok: true,
      available,
      checked: true,
      reason,
      embedUrl: available ? embedUrl : null,
    };
  })().finally(() => {
    vidstream3Inflight.delete(key);
  });

  vidstream3Inflight.set(key, task);
  return task;
}
