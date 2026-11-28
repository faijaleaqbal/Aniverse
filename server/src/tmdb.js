import fs from "node:fs";

/* Compact offline AniList/MAL -> TMDB TV mapping (generated from
   Fribb/anime-lists). Used as fallback when AniList externalLinks does
   not carry a TMDB entry (live AniList omits TMDB on almost all anime). */
const MAP_PATH = new URL("./tmdb-map.json", import.meta.url);
const RAW_MAP = JSON.parse(fs.readFileSync(MAP_PATH, "utf8"));

function parseEntry(val) {
  if (typeof val === "number" && Number.isFinite(val) && val > 0) {
    return { tmdbId: val, season: 1, epOffset: 0 };
  }
  if (Array.isArray(val) && val.length >= 1) {
    const tmdbId = Number(val[0]);
    if (!Number.isFinite(tmdbId) || tmdbId <= 0) return null;
    const season = Number(val[1]) > 0 ? Math.floor(Number(val[1])) : 1;
    const epOffset = Number(val[2]) > 0 ? Math.floor(Number(val[2])) : 0;
    return { tmdbId, season, epOffset };
  }
  return null;
}

const ANILIST_TO_TMDB = new Map();
for (const [k, v] of Object.entries((RAW_MAP && RAW_MAP.anilist) || {})) {
  const parsed = parseEntry(v);
  if (parsed) ANILIST_TO_TMDB.set(Number(k), parsed);
}

const MAL_TO_TMDB = new Map();
for (const [k, v] of Object.entries((RAW_MAP && RAW_MAP.mal) || {})) {
  const parsed = parseEntry(v);
  if (parsed) MAL_TO_TMDB.set(Number(k), parsed);
}

/**
 * Extract a TMDB TV id from AniList Media.externalLinks.
 * Matches TMDB links of TV type (and rejects MOVIE links so films do not
 * get broken /embed/{id}/{s}-{ep} players).
 */
export function extractTmdbFromExternalLinks(externalLinks) {
  if (!Array.isArray(externalLinks)) return null;
  for (const link of externalLinks) {
    if (!link || typeof link !== "object") continue;
    const site = String(link.site || "").trim().toLowerCase();
    const type = String(link.type || "").trim().toUpperCase();
    const url = String(link.url || "").trim();
    const isTmdbSite =
      site === "tmdb" || site === "the movie database" || /themoviedb\.org/i.test(url);
    if (!isTmdbSite) continue;
    if (type === "MOVIE" || /themoviedb\.org\/movie\b/i.test(url)) continue;

    const tvMatch = url.match(/themoviedb\.org\/tv\/(\d+)/i);
    if (tvMatch) {
      const id = Number(tvMatch[1]);
      if (Number.isFinite(id) && id > 0) return id;
    }
    if (type === "TV") {
      const numMatch = url.match(/\b(\d+)\b/);
      if (numMatch) {
        const id = Number(numMatch[1]);
        if (Number.isFinite(id) && id > 0) return id;
      }
    }
  }
  return null;
}

/**
 * Resolve TMDB TV id + season/episode offset for an anime.
 * Checks AniList externalLinks first, then the Fribb AniList/MAL mapping.
 * Returns tmdbId: null for films/music or unmapped titles.
 */
export function resolveTmdbInfo({
  anilistId,
  malId,
  format,
  kind,
  externalLinks,
  preferMal = false,
} = {}) {
  const fmt = String(format || "").toUpperCase();
  const k = String(kind || "").toLowerCase();
  if (fmt === "MOVIE" || fmt === "MUSIC" || k === "film") {
    return { tmdbId: null, tmdbSeason: null, tmdbEpisodeOffset: 0 };
  }

  const fromLinks = extractTmdbFromExternalLinks(externalLinks);
  const byAnilist = anilistId != null ? ANILIST_TO_TMDB.get(Number(anilistId)) : null;
  const byMal = malId != null ? MAL_TO_TMDB.get(Number(malId)) : null;
  const entry = preferMal ? (byMal || byAnilist || null) : (byAnilist || byMal || null);

  const tmdbId = fromLinks || (entry ? entry.tmdbId : null);
  if (!tmdbId) {
    return { tmdbId: null, tmdbSeason: null, tmdbEpisodeOffset: 0 };
  }

  const matchesEntry = entry && entry.tmdbId === tmdbId;
  return {
    tmdbId,
    tmdbSeason: matchesEntry ? entry.season : 1,
    tmdbEpisodeOffset: matchesEntry ? entry.epOffset : 0,
  };
}
