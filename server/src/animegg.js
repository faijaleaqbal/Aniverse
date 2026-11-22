/**
 * animegg fallback provider, resolved through the self-hosted Anivexa-API.
 *
 * Why this exists: the curated catalog's gap tail (ONAs, OVAs, SPECIALS,
 * MUSIC — verified against a 200-title stratified sample) is largely absent
 * from Zoko / TVplus / MegaPlay. Anivexa's animegg provider covers 29 of those
 * 200 (~14.5%), sub-only, SD 360p/480p, as an iframe-able embed page
 * (animegg.org/embed/{id} — no X-Frame-Options / CSP frame-ancestors) plus
 * direct mp4 URLs.
 *
 * Design rules (mirrors dub-check.js: never throw, never affect the other
 * players):
 *   - ONE provider route: /episodes/animegg/:anilistId. The 12-provider
 *     fan-out /episodes/:anilistId takes ~12 s/title and the other 11
 *     providers contribute ~nothing on the gap tail.
 *   - AVAILABILITY is a cheap, cacheable fact (which episodes the provider
 *     lists). Cached in memory.
 *   - STREAM URLs are NEVER cached: the `?for=` token rotates on every
 *     /watch call, so resolveEmbed() performs a LIVE /watch on each call and
 *     callers must not persist what it returns.
 *   - Every upstream failure (down / timeout / 4xx / 5xx / malformed body)
 *     resolves to available:false. The caller shows the honest
 *     not-available state; the page never breaks.
 */

import {
  ANIVEXA_BASE_URL,
  ANIVEXA_EPISODES_TIMEOUT_MS,
  ANIVEXA_WATCH_TIMEOUT_MS,
  ANIVEXA_AVAIL_CACHE_MS,
} from "./config.js";

/* `let` (not const): the e2e test seam re-points it at a stub per test. */
let BASE = ANIVEXA_BASE_URL;
const EPISODES_TIMEOUT_MS = ANIVEXA_EPISODES_TIMEOUT_MS;
const WATCH_TIMEOUT_MS = ANIVEXA_WATCH_TIMEOUT_MS;
const AVAIL_CACHE_TTL_MS = ANIVEXA_AVAIL_CACHE_MS;
/* Availability cache: "anilistId" -> { episodes: Set<number>, at }. */
const availCache = new Map();
/* Concurrent /episodes lookups coalesced, so a burst of episode loads costs
   one upstream call. */
const availInflight = new Map();

/* Test seam: `server/test/e2e.js` runs in one process with several app
   instances, and config.js reads ANIVEXA_BASE_URL only once at import time.
   Pointing a given instance at its own stub is done by assigning this before
   the request (production never touches it). */
export function _setAnivexaBaseUrlForTests(url) {
  BASE = url || ANIVEXA_BASE_URL;
}

function baseUrl() {
  return BASE;
}

async function fetchJson(path, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "AniVerse/animegg-fallback",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function episodeSet(body) {
  const out = new Set();
  const collect = (value) => {
    if (!Array.isArray(value)) return;
    for (const ep of value) {
      if (!ep || typeof ep !== "object") continue;
      const num = ep.number != null ? Number(ep.number) : Number(ep.episode);
      if (Number.isFinite(num) && num > 0) out.add(Math.trunc(num));
    }
  };
  if (!body || typeof body !== "object") return out;
  /* Documented shape: { animegg: { episodes: { sub: [...], dub: [...] } } }.
     /episodes/animegg/:id may answer with either the bare provider object or
     the full map, and the track lists may also sit at the top level. */
  const provider = body.animegg && typeof body.animegg === "object" ? body.animegg : body;
  if (provider.episodes && typeof provider.episodes === "object") {
    collect(provider.episodes.sub);
    collect(provider.episodes.dub);
  } else {
    collect(provider.sub);
    collect(provider.dub);
  }
  return out;
}

async function lookupEpisodes(anilistId) {
  const body = await fetchJson(`/episodes/animegg/${anilistId}`, EPISODES_TIMEOUT_MS);
  return episodeSet(body);
}

/**
 * Which episodes animegg lists for a title (sub track). Cached; failures are
 * NOT cached — the next request retries, so a transient outage does not pin a
 * title to "unavailable" for the whole cache window.
 *
 * @returns {Promise<Set<number>>} empty set when the provider is unreachable
 *   or lists nothing. Never rejects.
 */
export async function animeggEpisodeList(anilistId) {
  const id = Number(anilistId);
  if (!Number.isFinite(id) || id <= 0) return new Set();
  const key = String(Math.trunc(id));
  const hit = availCache.get(key);
  if (hit && Date.now() - hit.at < AVAIL_CACHE_TTL_MS) return hit.episodes;
  if (availInflight.has(key)) return availInflight.get(key);

  const task = (async () => {
    try {
      const episodes = await lookupEpisodes(Math.trunc(id));
      availCache.set(key, { episodes, at: Date.now() });
      return episodes;
    } catch {
      return new Set();
    } finally {
      availInflight.delete(key);
    }
  })();
  availInflight.set(key, task);
  return task;
}

/**
 * Is this episode listed on animegg (sub)?
 * @returns {Promise<boolean>} false on every failure. Never rejects.
 */
export async function animeggAvailable(anilistId, ep) {
  const episode = Number(ep);
  if (!Number.isFinite(episode) || episode <= 0) return false;
  const episodes = await animeggEpisodeList(anilistId);
  return episodes.has(Math.trunc(episode));
}

/** First non-empty string field of a stream object. */
function firstUrl(...values) {
  for (const v of values) {
    const s = typeof v === "string" ? v.trim() : "";
    if (s) return s;
  }
  return null;
}

function absolute(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * The embed URL (animegg.org/embed/{id}) of a stream entry, if present.
 * The embed page is the one the browser can actually iframe.
 */
function streamEmbedUrl(stream) {
  return firstUrl(
    stream && stream.embed,
    stream && stream.embedUrl,
    stream && stream.embed_url,
    stream && stream.iframe,
    stream && stream.frame
  );
}

/** Direct media URL (mp4) of a stream entry. */
function streamDirectUrl(stream) {
  return firstUrl(
    stream && stream.url,
    stream && stream.file,
    stream && stream.src,
    stream && stream.play_url
  );
}

/** Prefer a direct .mp4, else the first media-ish URL. */
function directMp4Url(streams) {
  const candidates = [];
  for (const s of streams) {
    const url = streamDirectUrl(s);
    if (url) candidates.push(url);
  }
  if (!candidates.length) return null;
  return candidates.find((u) => /\.mp4(\?|$)/i.test(u)) || candidates[0];
}

/**
 * Resolve a playable URL for an episode. LIVE on every call — the returned
 * URL carries a `?for=` token that rotates per /watch call, so it must never
 * be cached, persisted or reused for a later view.
 *
 * @param {number|string} anilistId
 * @param {number|string} ep
 * @returns {Promise<{ok: boolean, embedUrl: string|null, url: string|null}>}
 *   ok=false and both URLs null when the episode is not listed or the /watch
 *   call yields no usable URL. Never rejects.
 */
export async function resolveAnimeggEmbed(anilistId, ep) {
  const id = Number(anilistId);
  const episode = Number(ep);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(episode) || episode <= 0) {
    return { ok: false, embedUrl: null, url: null };
  }
  const num = Math.trunc(episode);
  try {
    const body = await fetchJson(
      `/watch/animegg/${Math.trunc(id)}/sub/animegg-${num}`,
      WATCH_TIMEOUT_MS
    );
    const streams = Array.isArray(body && body.streams) ? body.streams : [];
    if (!streams.length) return { ok: false, embedUrl: null, url: null };

    /* 1. The embed page: iframe-able (verified: no X-Frame-Options / CSP
          frame-ancestors), so the site can show it like the other players. */
    for (const s of streams) {
      const embed = absolute(streamEmbedUrl(s));
      if (embed) return { ok: true, embedUrl: embed, url: embed };
    }
    /* 2. No embed: fall back to a direct mp4 (the browser plays it natively;
          the site surfaces it honestly, it is not an iframe). */
    const mp4 = absolute(directMp4Url(streams));
    if (mp4) return { ok: true, embedUrl: null, url: mp4 };
    return { ok: false, embedUrl: null, url: null };
  } catch {
    return { ok: false, embedUrl: null, url: null };
  }
}

/**
 * Availability + live stream resolution for one request.
 * @returns {Promise<{anilistId: number, ep: number, available: boolean, embedUrl: string|null, url: string|null, reason: string}>}
 *   Never rejects: an unreachable Anivexa is simply available:false.
 */
export async function resolveAnimegg(anilistId, ep) {
  const id = Number(anilistId);
  const episode = Number(ep);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(episode) || episode <= 0) {
    return {
      anilistId: id,
      ep: episode,
      available: false,
      embedUrl: null,
      url: null,
      reason: "invalid-id",
    };
  }
  const num = Math.trunc(episode);
  const available = await animeggAvailable(id, num);
  if (!available) {
    return {
      anilistId: Math.trunc(id),
      ep: num,
      available: false,
      embedUrl: null,
      url: null,
      reason: "not-listed",
    };
  }
  const stream = await resolveAnimeggEmbed(id, num);
  if (!stream.ok) {
    return {
      anilistId: Math.trunc(id),
      ep: num,
      available: false,
      embedUrl: null,
      url: null,
      reason: "no-stream",
    };
  }
  return {
    anilistId: Math.trunc(id),
    ep: num,
    available: true,
    embedUrl: stream.embedUrl,
    url: stream.url,
    reason: "ok",
  };
}

export const ANIMEGG_PROVIDER_BASE_URL = BASE;

/* ---- Pure helpers (exported for the unit/smoke tests; no I/O) ---------- */

/** Episode numbers listed for a provider, from an /episodes response body. */
export function episodeSetFromAnivexa(body) {
  return episodeSet(body);
}

/** Pick the URL for an iframe: the embed page first, a direct mp4 second. */
export function pickAnimeggStreamUrl(streams) {
  if (!Array.isArray(streams) || !streams.length) {
    return { ok: false, embedUrl: null, url: null };
  }
  for (const s of streams) {
    const embed = absolute(streamEmbedUrl(s));
    if (embed) return { ok: true, embedUrl: embed, url: embed };
  }
  const mp4 = absolute(directMp4Url(streams));
  if (mp4) return { ok: true, embedUrl: null, url: mp4 };
  return { ok: false, embedUrl: null, url: null };
}

/* Test seam: clear the availability cache and coalescing map. */
export function _resetAnimeggCache() {
  availCache.clear();
  availInflight.clear();
}
