/**
 * AniList GraphQL proxy (server side only — the browser never calls AniList).
 * Free, keyless API: POST https://graphql.anilist.co (~90 req/min per IP).
 * Every response is cached in memory (10 min TTL; 1 h for single titles)
 * so the site stays inside the rate limit. No DB changes, no dependencies.
 *
 * CONTENT RULES (enforced here, on EVERY query):
 *   - `isAdult: false` is added to every AniList query, and adult media are
 *     filtered again on the way out. Hentai is excluded from search, browse,
 *     airing and direct links.
 *   - `is18plus` is a SEPARATE rule: mature-but-not-hentai titles (the
 *     "Ecchi" genre) stay visible and are tagged 18+. The UI only renders the
 *     badge from that flag — it never decides by itself.
 */

const ANILIST_URL = (process.env.ANILIST_URL || "https://graphql.anilist.co").replace(/\/+$/, "");
const TIMEOUT_MS = 8000;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
export const LIVE_TITLE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX = 500;

export class AniListBusyError extends Error {
  constructor(message = "AniList is busy") {
    super(message);
    this.name = "AniListBusyError";
  }
}

/* AniList answers "Media(id: <adult id>)" with a GraphQL Not Found error
   (HTTP 404 + errors[].status 404). That is NOT a busy service — the title
   simply is not available (because it is adult). */
export class AniListNotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "AniListNotFoundError";
  }
}

/* (query + variables) -> { at, ttl, value }. Lazy expiry on read + a size cap
   with oldest-first eviction keeps the Map bounded without a timer. */
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttl) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value, ttl) {
  if (cache.size >= CACHE_MAX) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [k, v] of cache) {
      if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; }
    }
    if (oldestKey != null) cache.delete(oldestKey);
  }
  cache.set(key, { at: Date.now(), ttl, value });
}

export function clearAniListCache() {
  cache.clear();
}

/* Shared media fields for every query (spec). isAdult: false is added to
   every AniList query — hentai is excluded everywhere. */
export const MEDIA_FIELDS = `
  id idMal isAdult
  title { romaji english native }
  coverImage { large }
  description(asHtml: false)
  episodes duration format status
  startDate { year month day }
  genres averageScore seasonYear popularity
  nextAiringEpisode { episode airingAt }
`;

/* POST the GraphQL query with an 8s timeout. 429 / 5xx / timeout / network
   failure all surface as AniListBusyError -> the routes answer HTTP 502
   {error:"search_busy"} and the UI degrades to the local catalog. */
export async function anilistQuery(query, variables, ttlMs = DEFAULT_TTL_MS) {
  const key = JSON.stringify({ query, variables });
  const hit = cacheGet(key);
  if (hit) return hit;

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(ANILIST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: ctl.signal,
    });
  } catch {
    throw new AniListBusyError("AniList request failed or timed out");
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 429 || res.status >= 500) {
    throw new AniListBusyError(`AniList responded ${res.status}`);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    if (!res.ok) throw new AniListBusyError(`AniList responded ${res.status}`);
    throw new AniListBusyError("AniList returned invalid JSON");
  }
  if (body && Array.isArray(body.errors) && body.errors.length) {
    /* A GraphQL "Not Found" means the title does not exist for this query
       (the isAdult filter hides adult titles that way). Everything else —
       rate limits, upstream errors — is "busy". */
    const allNotFound = body.errors.every(
      (e) => e && (e.status === 404 || /not found/i.test(String(e.message || "")))
    );
    if (allNotFound) {
      /* Cache the miss so a direct link to an adult title does NOT hit
         AniList again on every request (rate limit). */
      cacheSet(key, { Media: null }, ttlMs);
      throw new AniListNotFoundError("AniList: not found");
    }
    throw new AniListBusyError("AniList query error");
  }
  if (!res.ok) throw new AniListBusyError(`AniList responded ${res.status}`);
  const data = body ? body.data : null;
  cacheSet(key, data, ttlMs);
  return data;
}

/* AniList descriptions carry HTML (<br>, <i>, <b>) even with asHtml:false.
   The site renders synopses as text — strip tags and collapse whitespace. */
function cleanDescription(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* AniList's own `isAdult` flag already removes the titles it knows as
   adult. A handful of hentai titles are NOT flagged by AniList (their title
   carries the word), so they get a second, server-side screen: the title
   itself names the content. This runs on the server for every title the
   API returns — search, browse, airing and direct links alike.

   "xxx" is matched as a whole word, so xxxHOLiC (a legitimate series) is
   NOT caught. "sex" is deliberately absent — "Sex Education" is a real anime. */
const ADULT_TITLE_PATTERN = /\b(hentai|porn|nsfw|18\+)\b/i;

/* True when a title must never reach the site. */
export function isAdultMedia(media) {
  if (!media) return false;
  if (media.isAdult) return true;
  const title = media.title || {};
  const blob = [title.english, title.romaji, title.native].filter(Boolean).join(" ");
  if (ADULT_TITLE_PATTERN.test(blob)) return true;
  /* The description catches the hentai titles whose own title is clean but
     whose credits/plot name the content (e.g. "music by HENTAI SHINSHI CLUB"). */
  return ADULT_TITLE_PATTERN.test(String(media.description || ""));
}

/* Map AniList media to the site's title shape. is18plus is a SERVER rule:
   true when the genres include "Ecchi" (mature-but-not-hentai stays visible
   with an 18+ tag). isAdult titles never reach this mapper — every query
   filters them out. The UI only renders the badge from this flag. */
export function mediaView(media) {
  if (!media) return null;
  const genres = Array.isArray(media.genres) ? media.genres : [];
  const title = media.title || {};
  const name = title.english || title.romaji || title.native || "Unknown title";
  return {
    live: true,
    anilistId: media.id,
    malId: media.idMal != null ? Number(media.idMal) : null,
    name,
    englishTitle: title.english || null,
    romajiTitle: title.romaji || null,
    nativeTitle: title.native || null,
    cover: (media.coverImage && media.coverImage.large) || null,
    banner: (media.coverImage && media.coverImage.large) || null,
    synopsis: cleanDescription(media.description),
    episodes: media.episodes != null ? Number(media.episodes) : null,
    runtimeMin: media.duration != null ? Number(media.duration) : null,
    format: media.format || null,
    kind: media.format === "MOVIE" ? "Film" : "Series",
    status: media.status || null,
    year: (media.startDate && media.startDate.year) || media.seasonYear || null,
    seasonYear: media.seasonYear || null,
    genres,
    score: media.averageScore != null ? Number(media.averageScore) : null,
    popularity: media.popularity != null ? Number(media.popularity) : null,
    nextAiringEpisode: media.nextAiringEpisode || null,
    is18plus: genres.includes("Ecchi"),
  };
}

const PAGE_INFO_FIELDS = `pageInfo { total currentPage lastPage hasNextPage }`;

function pageResult(pageData) {
  const media = (pageData && Array.isArray(pageData.media)) ? pageData.media : [];
  return {
    results: media.filter((m) => m && !isAdultMedia(m)).map(mediaView),
    pageInfo: (pageData && pageData.pageInfo) || { total: 0, currentPage: 1, lastPage: 1, hasNextPage: false },
  };
}

/* GET /api/search — SEARCH_MATCH, 12 per page, adult excluded. */
export async function searchAniList(q, page = 1) {
  const query = `query ($search: String, $page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      ${PAGE_INFO_FIELDS}
      media(search: $search, type: ANIME, sort: SEARCH_MATCH, isAdult: false) { ${MEDIA_FIELDS} }
    }
  }`;
  const data = await anilistQuery(query, { search: q, page, perPage: 12 });
  return pageResult(data && data.Page);
}

/* GET /api/browse — one flexible list endpoint. Sort/filter mapping is
   server-side; isAdult: false always. */
export const BROWSE_SORTS = {
  trending: "TRENDING_DESC",
  popular: "POPULARITY_DESC",
  top: "SCORE_DESC",
  newest: "START_DATE_DESC",
};

/* AniList genre names are case-sensitive (genre_in: ["Action"]). The site
   sends lowercased / human labels — normalise them to AniList's spelling. */
const GENRE_CANONICAL = {
  action: "Action",
  adventure: "Adventure",
  comedy: "Comedy",
  drama: "Drama",
  ecchi: "Ecchi",
  fantasy: "Fantasy",
  horror: "Horror",
  "mahou shoujo": "Mahou Shoujo",
  mecha: "Mecha",
  music: "Music",
  mystery: "Mystery",
  romance: "Romance",
  "sci-fi": "Sci-Fi",
  "science fiction": "Sci-Fi",
  "slice of life": "Slice of Life",
  "slice-of-life": "Slice of Life",
  /* The local catalog calls it "life" — AniList calls it "Slice of Life". */
  life: "Slice of Life",
  sports: "Sports",
  supernatural: "Supernatural",
  thriller: "Thriller",
};

export function canonicalGenre(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const hit = GENRE_CANONICAL[raw.toLowerCase()];
  if (hit) return hit;
  /* Unknown genre: pass it through title-cased so a valid AniList genre the
     map does not know still works. */
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

const FORMAT_CANONICAL = {
  tv: "TV",
  movie: "MOVIE",
  film: "MOVIE",
  ova: "OVA",
  ona: "ONA",
  special: "SPECIAL",
};

export function canonicalFormat(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  return FORMAT_CANONICAL[raw.toLowerCase()] || raw.toUpperCase();
}

const STATUS_CANONICAL = {
  airing: "RELEASING",
  releasing: "RELEASING",
  finished: "FINISHED",
  completed: "FINISHED",
  upcoming: "NOT_YET_RELEASED",
  "not yet released": "NOT_YET_RELEASED",
  hiatus: "HIATUS",
  cancelled: "CANCELLED",
};

export function canonicalStatus(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  return STATUS_CANONICAL[raw.toLowerCase()] || raw.toUpperCase();
}

/* Normalise the browse query string into AniList arguments. */
export function normalizeBrowseArgs(query = {}) {
  const sortKey = String(query.sort || "trending").toLowerCase();
  const sort = BROWSE_SORTS[sortKey] || BROWSE_SORTS.trending;

  const asList = (value) => {
    if (value == null) return [];
    const raw = Array.isArray(value) ? value : [value];
    return raw
      .flatMap((v) => String(v).split(","))
      .map((v) => v.trim())
      .filter(Boolean);
  };

  const genres = asList(query.genre).map(canonicalGenre).filter(Boolean);
  const formats = asList(query.format).map(canonicalFormat).filter(Boolean);
  const statuses = asList(query.status).map(canonicalStatus).filter(Boolean);

  const yearRaw = Number(query.year);
  const year = Number.isFinite(yearRaw) && yearRaw > 1800 && yearRaw < 2200 ? Math.floor(yearRaw) : null;

  const pageRaw = Number(query.page);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;

  return { sort, genres, formats, statuses, year, page };
}

export async function browseAniList(opts = {}) {
  const { sort, genres, formats, statuses, year, page } = normalizeBrowseArgs(opts);
  const args = ["type: ANIME", "sort: " + sort, "isAdult: false"];
  const vars = { page, perPage: 12 };
  if (genres.length) { args.push("genre_in: $genre"); vars.genre = genres; }
  if (formats.length) { args.push("format_in: $format"); vars.format = formats; }
  if (statuses.length) { args.push("status_in: $status"); vars.status = statuses; }
  if (year) { args.push("seasonYear: $year"); vars.year = year; }
  const varDecls = ["$page: Int", "$perPage: Int"];
  if (vars.genre) varDecls.push("$genre: [String]");
  if (vars.format) varDecls.push("$format: [MediaFormat]");
  if (vars.status) varDecls.push("$status: [MediaStatus]");
  if (vars.year) varDecls.push("$year: Int");
  const query = `query (${varDecls.join(", ")}) {
    Page(page: $page, perPage: $perPage) {
      ${PAGE_INFO_FIELDS}
      media(${args.join(", ")}) { ${MEDIA_FIELDS} }
    }
  }`;
  const data = await anilistQuery(query, vars);
  return pageResult(data && data.Page);
}

/* GET /api/live/:anilistId — one title, 1-hour cache. The isAdult: false
   filter means an adult title resolves to null -> the route answers 404
   {error:"not_available"}, so adult titles cannot be opened by direct link. */
export async function getLiveTitle(anilistId) {
  const id = Number(anilistId);
  if (!Number.isFinite(id) || id <= 0) return null;
  const query = `query ($id: Int) {
    Media(id: $id, type: ANIME, isAdult: false) { ${MEDIA_FIELDS} }
  }`;
  let data;
  try {
    data = await anilistQuery(query, { id: Math.trunc(id) }, LIVE_TITLE_TTL_MS);
  } catch (err) {
    /* An adult (or unknown) title is simply not available — not an error. */
    if (err instanceof AniListNotFoundError) return null;
    throw err;
  }
  const media = data && data.Media;
  if (!media || isAdultMedia(media)) return null;
  return mediaView(media);
}

/* GET /api/airing — episodes aired in the last 7 days, newest first.
   24 per page, 10-minute cache. Adult media are skipped server-side. */
export async function getAiringSchedule(page = 1, nowSec = Math.floor(Date.now() / 1000)) {
  const pageNum = Number(page);
  const safePage = Number.isFinite(pageNum) && pageNum > 0 ? Math.floor(pageNum) : 1;
  const query = `query ($page: Int, $perPage: Int, $airingAt_greater: Int, $airingAt_lesser: Int) {
    Page(page: $page, perPage: $perPage) {
      ${PAGE_INFO_FIELDS}
      airingSchedules(airingAt_greater: $airingAt_greater, airingAt_lesser: $airingAt_lesser, sort: TIME_DESC) {
        airingAt episode
        media { ${MEDIA_FIELDS} }
      }
    }
  }`;
  const vars = {
    page: safePage,
    perPage: 24,
    airingAt_greater: nowSec - 7 * 24 * 3600,
    airingAt_lesser: nowSec,
  };
  const data = await anilistQuery(query, vars);
  const pageData = data && data.Page;
  const rows = (pageData && Array.isArray(pageData.airingSchedules)) ? pageData.airingSchedules : [];
  return {
    results: rows
      .filter((r) => r && r.media && !isAdultMedia(r.media))
      .map((r) => ({ airingAt: r.airingAt, episode: r.episode, media: mediaView(r.media) })),
    pageInfo: (pageData && pageData.pageInfo) || { total: 0, currentPage: 1, lastPage: 1, hasNextPage: false },
  };
}
