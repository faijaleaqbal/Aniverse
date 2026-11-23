/**
 * Dub availability probe for the ZokoAnime embed.
 *
 * Why this exists: Zoko serves a /dub URL for every title, but for some titles
 * the "dub" stream is byte-identical to the sub stream (verified on Solo
 * Leveling ep 1 — first/middle/last HLS segments hash the same). Clicking Dub
 * then silently plays Japanese. The watch page asks this probe before swapping
 * tracks so it can show "English dub not available for this episode" instead.
 *
 * How it works (no private API, only what the embed page itself loads):
 *   1. Fetch the /sub and /dub embed pages and decode their `window.__P`
 *      payload (base64 + XOR, the embed's own obfuscate.js scheme).
 *   2. Same video_id / same master URL  -> no separate dub.
 *   3. Otherwise compare the HLS variant playlists' segment lists, then the
 *      actual bytes of the first and middle segments. Identical content means
 *      the provider has no real dub for this episode.
 *
 * Results are cached in memory (6h) and concurrent probes are coalesced.
 * A probe failure returns available: null (unknown) — never a false positive.
 */
import { createHash } from "node:crypto";
import { ZOKO_EMBED_ORIGIN } from "./config.js";

const OBF_KEY = "otaku-embed-v1";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 12000;

const cache = new Map(); // "malId:ep" -> { available, reason, at }
const inflight = new Map(); // "malId:ep" -> Promise

function deobfuscate(blob) {
  const raw = Buffer.from(String(blob), "base64");
  const out = Buffer.alloc(raw.length);
  for (let i = 0; i < raw.length; i++) {
    out[i] = raw[i] ^ OBF_KEY.charCodeAt(i % OBF_KEY.length);
  }
  return JSON.parse(out.toString("utf8"));
}

async function fetchWithTimeout(url, as = "text") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Referer: `${ZOKO_EMBED_ORIGIN}/`,
        /* The HLS segment CDN (hls1.drama1.cfd) answers 403 to requests
           WITHOUT an Origin header on some files (verified 2026-11-20:
           ERASED eps 1-6/9-12 dub segments 403 with Referer alone, 200
           with Origin — the browser's embed sends Origin on every media
           XHR). Without it those dubs stayed "unknown" and the DUB badge
           under-counted a fully dubbed title. */
        Origin: ZOKO_EMBED_ORIGIN,
        "User-Agent": "Mozilla/5.0 (AniFlick dub-check)",
        Accept: as === "text" ? "text/html,*/*" : "*/*",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return as === "text" ? await res.text() : Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

function payloadOf(html) {
  const m = String(html).match(/window\.__P="([^"]+)"/);
  if (!m) throw new Error("embed payload not found");
  return deobfuscate(m[1]);
}

function firstVariant(masterText) {
  const line = masterText.split(/\r?\n/).find((l) => l.trim() && !l.startsWith("#"));
  if (!line) throw new Error("master playlist has no variant");
  return line.trim();
}

function segmentList(playlistText) {
  return playlistText.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
}

function sha(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function probe(malId, ep) {
  const base = `${ZOKO_EMBED_ORIGIN}/stream/mal/${malId}/${ep}`;
  const qs = "color=cae962&autoplay=1&autoskip=1&autonext=1";
  const [subHtml, dubHtml] = await Promise.all([
    fetchWithTimeout(`${base}/sub?${qs}`),
    fetchWithTimeout(`${base}/dub?${qs}`),
  ]);
  /* A page that LOADS but carries no __P payload is the provider's definitive
     "no stream here" answer (e.g. an episode beyond the title's real range,
     or a title with no dub at all) — not a transient failure. Classify it:
     no dub payload -> no dub (false); only a missing SUB payload with a
     present dub stays unknown (nothing to compare against). */
  let sub = null;
  let dub = null;
  try { sub = payloadOf(subHtml); } catch {}
  try { dub = payloadOf(dubHtml); } catch {}
  if (!dub) {
    return { available: false, reason: sub ? "no-dub-stream" : "no-stream" };
  }
  if (!sub) throw new Error("sub embed payload not found");

  if (!sub.src || !dub.src) throw new Error("embed payload has no stream src");
  if (sub.src === dub.src || (sub.video_id != null && sub.video_id === dub.video_id)) {
    return { available: false, reason: "same-stream" };
  }

  const [subMaster, dubMaster] = await Promise.all([
    fetchWithTimeout(sub.src),
    fetchWithTimeout(dub.src),
  ]);
  const subBase = sub.src.slice(0, sub.src.lastIndexOf("/"));
  const dubBase = dub.src.slice(0, dub.src.lastIndexOf("/"));
  const [subPlaylist, dubPlaylist] = await Promise.all([
    fetchWithTimeout(`${subBase}/${firstVariant(subMaster)}`),
    fetchWithTimeout(`${dubBase}/${firstVariant(dubMaster)}`),
  ]);
  const subSegs = segmentList(subPlaylist);
  const dubSegs = segmentList(dubPlaylist);
  if (!subSegs.length || !dubSegs.length) throw new Error("empty variant playlist");
  if (subSegs.join("\n") === dubSegs.join("\n")) {
    return { available: false, reason: "same-segments" };
  }

  // Different URLs can still serve identical bytes (Zoko re-labels the sub
  // file as dub). Compare first AND middle segment content before deciding.
  const idxs = [0, Math.floor(Math.min(subSegs.length, dubSegs.length) / 2)];
  for (const i of idxs) {
    const [a, b] = await Promise.all([
      fetchWithTimeout(subSegs[i], "bytes"),
      fetchWithTimeout(dubSegs[i], "bytes"),
    ]);
    if (sha(a) !== sha(b)) {
      return { available: true, reason: "distinct-content" };
    }
  }
  return { available: false, reason: "identical-content" };
}

/**
 * @returns {Promise<{available: boolean|null, reason: string}>}
 *   true  = a real dub stream exists, false = dub is the sub file (or absent),
 *   null  = could not verify (network/provider error).
 */
export async function checkDubAvailability(malId, ep) {
  const id = Number(malId);
  const episode = Number(ep);
  if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(episode) || episode <= 0) {
    return { available: false, reason: "invalid-id" };
  }
  const key = `${id}:${episode}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { available: hit.available, reason: hit.reason };
  }
  if (inflight.has(key)) return inflight.get(key);

  const task = (async () => {
    try {
      const result = await probe(id, episode);
      cache.set(key, { ...result, at: Date.now() });
      return result;
    } catch (err) {
      return { available: null, reason: `probe-failed: ${String((err && err.message) || err)}` };
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}
