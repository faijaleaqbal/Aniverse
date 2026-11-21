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
  /* Counts live in their own store, but they are just cached AniList data:
     a test/ops clear must reset them too or a stale count outlives the rest. */
  yearCountCache.clear();
  yearCountInFlight.clear();
  azSnapshotInFlight.clear();
  genreCache = null;
}

/* Shared media fields for every query (spec). isAdult: false is added to
   every AniList query — hentai is excluded everywhere. */
export const MEDIA_FIELDS = `
  id idMal isAdult
  title { romaji english native }
  coverImage { large }
  description(asHtml: false)
  episodes duration format status type
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

/* AniList's image CDN (s4.anilist.co) refuses cross-site <img> requests, so
   hotlinked live posters never render and every card falls back to the
   placeholder. Live covers are therefore served through the site's OWN
   origin (/api/cover) — the same artwork, but a same-origin URL the browser
   can always load. Non-AniList URLs pass through untouched. */
const ANILIST_COVER_HOSTS = new Set(["s4.anilist.co"]);
function localCoverUrl(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (u.protocol === "https:" && ANILIST_COVER_HOSTS.has(u.hostname)) {
      return `/api/cover?url=${encodeURIComponent(u.href)}`;
    }
  } catch {
    /* Not an absolute URL — leave it alone. */
  }
  return url;
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
    cover: localCoverUrl((media.coverImage && media.coverImage.large) || null),
    banner: localCoverUrl((media.coverImage && media.coverImage.large) || null),
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

/* Detail-only fields. These are HEAVY (characters/relations/tags) and are
   fetched by /api/live only — the list endpoints (search/browse/airing) keep
   MEDIA_FIELDS so a grid page never pays for them. */
export const LIVE_DETAIL_FIELDS = `
  ${MEDIA_FIELDS}
  endDate { year month day }
  season
  studios { nodes { name isAnimationStudio } }
  characters(perPage: 12, sort: [ROLE, RELEVANCE]) {
    edges {
      role
      node { name { full } image { large } }
      voiceActors(language: JAPANESE) { name { full } image { large } }
    }
  }
  relations {
    edges {
      relationType
      node { id idMal isAdult type title { romaji english } coverImage { large } format status }
    }
  }
  /* "More Like This": AniList's own recommendation edges. Screened like
     everything else (a recommendation can point at an adult title). */
  recommendations(perPage: 12) {
    nodes {
      rating
      mediaRecommendation { id idMal isAdult title { romaji english } coverImage { large } averageScore format }
    }
  }
  tags { name rank isMediaSpoiler }
  bannerImage
`;

/* Map a detail response onto the site shape: everything mediaView exposes,
   plus the live-detail metadata. Studios are animation studios only;
   characters are the top 6 by AniList's ROLE/RELEVANCE sort; relations are
   ANIME only and adult-screened (a relation can point at an adult title even
   when the parent query is isAdult: false). */
export function liveDetailView(media) {
  const base = mediaView(media);
  if (!base) return null;

  const studios = (media.studios && Array.isArray(media.studios.nodes))
    ? media.studios.nodes
        .filter((n) => n && n.isAnimationStudio && n.name)
        .map((n) => n.name)
    : [];

  const characterEdges = (media.characters && Array.isArray(media.characters.edges))
    ? media.characters.edges
    : [];
  const characters = characterEdges.slice(0, 6)
    .map((edge) => {
      const node = (edge && edge.node) || {};
      const va = edge && Array.isArray(edge.voiceActors) ? edge.voiceActors[0] : null;
      return {
        name: (node.name && node.name.full) || null,
        image: localCoverUrl(node.image && node.image.large),
        role: (edge && edge.role) || null,
        voiceActor: va
          ? {
              name: (va.name && va.name.full) || null,
              image: localCoverUrl(va.image && va.image.large),
            }
          : null,
      };
    })
    .filter((c) => c.name);

  const relationEdges = (media.relations && Array.isArray(media.relations.edges))
    ? media.relations.edges
    : [];
  const relations = relationEdges
    .map((edge) => {
      const node = edge && edge.node;
      if (!node) return null;
      if (node.type && node.type !== "ANIME") return null;
      if (isAdultMedia(node)) return null;
      const title = node.title || {};
      return {
        relationType: edge.relationType || null,
        anilistId: node.id != null ? Number(node.id) : null,
        malId: node.idMal != null ? Number(node.idMal) : null,
        name: title.english || title.romaji || "Unknown title",
        cover: localCoverUrl(node.coverImage && node.coverImage.large),
        format: node.format || null,
        status: node.status || null,
      };
    })
    .filter(Boolean);

  const tags = Array.isArray(media.tags)
    ? media.tags
        .map((t) => ({
          name: t.name || null,
          rank: t.rank != null ? Number(t.rank) : null,
          isMediaSpoiler: !!t.isMediaSpoiler,
        }))
        .filter((t) => t.name)
    : [];

  /* Recommendations ("More Like This"). A node whose mediaRecommendation is
     null (deleted/unavailable media) or that points at the title itself is
     dropped, and every survivor goes through the SAME adult screen as every
     other title on the site — a recommendation edge is not a trusted source.
     `rating` is AniList's own score for the edge; it is kept because it is
     real data, but nothing is invented when it is absent. */
  const recommendationNodes = (media.recommendations && Array.isArray(media.recommendations.nodes))
    ? media.recommendations.nodes
    : [];
  const recommendations = recommendationNodes
    .map((node) => {
      const rec = node && node.mediaRecommendation;
      if (!rec) return null;
      if (rec.id != null && media.id != null && Number(rec.id) === Number(media.id)) return null;
      if (isAdultMedia(rec)) return null;
      const title = rec.title || {};
      return {
        anilistId: rec.id != null ? Number(rec.id) : null,
        malId: rec.idMal != null ? Number(rec.idMal) : null,
        name: title.english || title.romaji || "Unknown title",
        cover: localCoverUrl(rec.coverImage && rec.coverImage.large),
        score: rec.averageScore != null ? Number(rec.averageScore) : null,
        format: rec.format || null,
        rating: node.rating != null ? Number(node.rating) : null,
      };
    })
    .filter(Boolean);

  return {
    ...base,
    startDate: media.startDate || null,
    endDate: media.endDate || null,
    season: media.season || null,
    studios,
    characters,
    relations,
    recommendations,
    tags,
    banner: localCoverUrl(media.bannerImage) || base.banner,
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

/* GET /api/search — SEARCH_MATCH, anime only, adult excluded.
   AniList's SEARCH_MATCH pagination is NOT stable: every page re-runs the
   fuzzy match and returns a different total (a "Naruto" search reported
   5,000 matches on page 1 and 26 on page 3), and consecutive pages can hand
   back the SAME titles — which made the site's page 2 largely repeat page 1.
   So the search is served from a SNAPSHOT: one fixed set of results is
   fetched (3 AniList pages x 50), de-duplicated by AniList id, screened for
   adult content, and cached for 30 minutes. Every page of a given query is
   then a slice of that one immutable set — the total never moves, no page
   repeats another page's titles, and there is never a page past the end. */
export const SEARCH_PAGE_SIZE = 12;
const SEARCH_SNAPSHOT_PAGES = 3;
const SEARCH_SNAPSHOT_PER_PAGE = 50;
const SEARCH_SNAPSHOT_TTL_MS = 30 * 60 * 1000;

/* In-flight snapshot builds, keyed by the normalized query. The search page
   fires concurrent /api/search calls (dropdown + grid); without dedup every
   cold-cache caller built its OWN snapshot from AniList's non-deterministic
   SEARCH_MATCH, so concurrent callers got DIFFERENT result sets (audit-6 B4:
   totals [0, 5, 5, 5, 5] for one query). Callers that arrive while a build
   is running await the SAME promise; the entry is removed when it settles
   (success or failure). */
const snapshotInFlight = new Map();

/* Build one snapshot: 3 pages in parallel, per-page success tracked. A
   failing page contributes fewer titles — but if ALL pages fail the build
   throws AniListBusyError (the route answers 502 search_busy) instead of
   returning an empty set that would then be cached as a real "no results". */
async function buildSearchSnapshot(q) {
  const query = `query ($search: String, $page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      media(search: $search, type: ANIME, sort: SEARCH_MATCH, isAdult: false) { ${MEDIA_FIELDS} }
    }
  }`;
  /* The three pages are fetched in parallel — one slow page must not serialise
     the others. A failing page just contributes fewer titles. */
  const pages = await Promise.all(
    Array.from({ length: SEARCH_SNAPSHOT_PAGES }, (_, i) =>
      anilistQuery(query, { search: q, page: i + 1, perPage: SEARCH_SNAPSHOT_PER_PAGE })
        .then((data) => ({
          ok: true,
          media: data && data.Page && Array.isArray(data.Page.media) ? data.Page.media : [],
        }))
        .catch(() => ({ ok: false, media: [] }))
    )
  );
  if (pages.every((p) => !p.ok)) {
    throw new AniListBusyError("AniList search failed on every page");
  }

  const seen = new Set();
  const items = [];
  for (const media of pages.flatMap((p) => p.media)) {
    if (!media || media.id == null || seen.has(media.id)) continue;
    if (isAdultMedia(media)) continue;
    seen.add(media.id);
    items.push(mediaView(media));
  }
  return items;
}

/* One snapshot of a search: the raw media list, de-duplicated by id and
   adult-screened. Cached by the query, so all pages share one result set.
   A genuinely empty result (at least one page succeeded, zero matches) is
   cached like any other; an all-pages-failure never is. */
async function searchSnapshot(q) {
  const key = `search-snapshot:${String(q).trim().toLowerCase()}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const running = snapshotInFlight.get(key);
  if (running) return running;

  const build = buildSearchSnapshot(q)
    .then((items) => {
      cacheSet(key, items, SEARCH_SNAPSHOT_TTL_MS);
      return items;
    })
    .finally(() => {
      snapshotInFlight.delete(key);
    });
  snapshotInFlight.set(key, build);
  return build;
}

/* The whole search result set for a query (stable, snapshot-backed). The
   caller slices it into pages. */
export async function searchAniList(q) {
  const items = await searchSnapshot(q);
  return { items, total: items.length };
}

/* GET /api/az — A-Z list. AniList has NO prefix search, so a letter is served
   from a SNAPSHOT exactly like a search: one fixed candidate pool is fetched
   (10 AniList pages x 50, SEARCH_MATCH on the letter itself), then filtered
   server-side to titles whose romaji OR english title STARTS with the letter
   (0-9 = starts with a digit), de-duplicated by id and adult-screened. Every
   page of a letter is a slice of that one immutable set.

   EXCEPT a single-letter "A" search returns NOTHING on AniList's side, so for
   an empty A-Z letter snapshot the pool falls back to TITLE_ROMAJI paging
   (no search term) with an early stop past the letter.

   The pool is a best-effort candidate set, not the whole catalog: if the
   10-page fetch cap is reached the snapshot is partial, so the total is a
   FLOOR. `capped` is returned and the UI must label it with a "+" — a partial
   snapshot is never presented as a complete list. */
export const AZ_PAGE_SIZE = SEARCH_PAGE_SIZE;
const AZ_SNAPSHOT_PAGES = 10;
const AZ_SNAPSHOT_PER_PAGE = 50;
const AZ_SNAPSHOT_TTL_MS = 30 * 60 * 1000;

const azSnapshotInFlight = new Map();

/* True when the title's romaji OR english name starts with the letter. */
function azPrefixMatch(media, letter) {
  const title = (media && media.title) || {};
  const names = [title.romaji, title.english].filter(Boolean).map((s) => String(s).trim());
  if (letter === "0-9") return names.some((s) => /^[0-9]/.test(s));
  const ch = String(letter).toLowerCase();
  return names.some((s) => s.toLowerCase().startsWith(ch));
}

async function buildAzSnapshot(letter) {
  /* The letter itself is the only search term AniList can take — there is no
     prefix match. "0-9" searches "0" (digit-led titles are rare and the
     capped flag keeps the result honest either way). */
  const search = letter === "0-9" ? "0" : letter;
  const query = `query ($search: String, $page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      pageInfo { total lastPage }
      media(search: $search, type: ANIME, sort: SEARCH_MATCH, isAdult: false) { ${MEDIA_FIELDS} }
    }
  }`;
  /* Pages in parallel; a failing page contributes fewer candidates. Only an
     all-pages failure is "busy" (the route answers 502, nothing is cached). */
  const pages = await Promise.all(
    Array.from({ length: AZ_SNAPSHOT_PAGES }, (_, i) =>
      anilistQuery(query, { search, page: i + 1, perPage: AZ_SNAPSHOT_PER_PAGE })
        .then((data) => ({
          ok: true,
          media: data && data.Page && Array.isArray(data.Page.media) ? data.Page.media : [],
          lastPage: data && data.Page && data.Page.pageInfo ? Number(data.Page.pageInfo.lastPage) : null,
        }))
        .catch(() => ({ ok: false, media: [], lastPage: null }))
    )
  );
  if (pages.every((p) => !p.ok)) {
    throw new AniListBusyError("AniList A-Z search failed on every page");
  }

  const last = pages[pages.length - 1];
  const lastPageFull = !!(last && last.ok && last.media.length >= AZ_SNAPSHOT_PER_PAGE);
  const reportedMore = pages.some((p) => p.ok && Number.isFinite(p.lastPage) && p.lastPage > AZ_SNAPSHOT_PAGES);
  const capped = lastPageFull || reportedMore;

  const seen = new Set();
  const items = [];
  for (const media of pages.flatMap((p) => p.media)) {
    if (!media || media.id == null || seen.has(media.id)) continue;
    if (!azPrefixMatch(media, letter)) continue;
    if (isAdultMedia(media)) continue;
    seen.add(media.id);
    items.push(mediaView(media));
  }

  /* FALLBACK — TITLE_ROMAJI paging, A-Z letters only. AniList returns NOTHING
     for a single-letter "A" search (every other letter works), so the search
     snapshot is empty and the most common starting letter of the whole catalog
     rendered an empty list. A-Z only: "0-9" is a search-only bucket (its
     search term is "0"), and a NON-EMPTY search snapshot never falls back
     (B/C/S/... keep the search path exactly as-is). */
  if (!items.length && isAzFallbackLetter(letter)) {
    const fallback = await buildAzTitleRomajiSnapshot(letter);
    if (fallback.items.length) return fallback;
    /* The fallback itself is a real, empty catalog slice for this letter —
       that honest empty set is cached like any other (same key, same TTL). */
    return { items: fallback.items, capped: fallback.capped };
  }

  return { items, capped };
}

/* Only the 26 single letters fall back; "0-9" and "all" never do. */
function isAzFallbackLetter(letter) {
  return /^[A-Z]$/.test(String(letter || ""));
}

/* The fallback pool: page the WHOLE catalog sorted by TITLE_ROMAJI (no search
   term), SEQUENTIALLY — the early stop needs the order, so the pages cannot be
   fetched in parallel. Collect titles whose romaji OR english name starts with
   the letter, and STOP at the first title whose ROMAJI name starts with a
   letter strictly after the target: TITLE_ROMAJI sorts by romaji, so every
   later page is past the letter too.

   The scan stops on PAST-THE-LETTER or the 10-page cap (same cap as the search
   path, capped=true then). A SHORT page is NOT a stop: the boundary page that
   carries the first past-letter title is itself short (it ends the letter's
   run), and stopping on shortness would never fetch it — which is exactly the
   page that proves the scan is done. */
async function buildAzTitleRomajiSnapshot(letter) {
  const query = `query ($page: Int, $perPage: Int) {
    Page(page: $page, perPage: $perPage) {
      media(type: ANIME, sort: TITLE_ROMAJI, isAdult: false) { ${MEDIA_FIELDS} }
    }
  }`;
  const target = String(letter).toLowerCase();
  const seen = new Set();
  const items = [];
  let capped = false;

  for (let page = 1; page <= AZ_SNAPSHOT_PAGES; page++) {
    const data = await anilistQuery(query, { page, perPage: AZ_SNAPSHOT_PER_PAGE });
    const media = data && data.Page && Array.isArray(data.Page.media) ? data.Page.media : [];
    /* A title whose ROMAJI name starts with a LETTER strictly after the target
       ends the scan — TITLE_ROMAJI sorts by romaji, so every later page is past
       the letter too. A symbol/digit-led romaji (which sorts before "a") is NOT
       a stop: it has not reached the letter yet. */
    let stop = false;
    for (const m of media) {
      if (!m) continue;
      const romaji = String(((m.title || {}).romaji) || "").trim();
      const first = romaji.charAt(0).toLowerCase();
      if (/^[a-z]$/.test(first) && first > target) {
        stop = true;
        break;
      }
    }
    for (const m of media) {
      if (!m || m.id == null || seen.has(m.id)) continue;
      if (!azPrefixMatch(m, letter)) continue;
      if (isAdultMedia(m)) continue;
      seen.add(m.id);
      items.push(mediaView(m));
    }
    if (stop) break;
    /* Filling the 10th page means the cap was reached -> the total is a floor.
       (A short page is not a stop: see the note above.) */
    if (page === AZ_SNAPSHOT_PAGES) capped = true;
  }

  return { items, capped };
}

async function azSnapshot(letter) {
  const key = `az-snapshot:${letter}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const running = azSnapshotInFlight.get(key);
  if (running) return running;

  const build = buildAzSnapshot(letter)
    .then((value) => {
      cacheSet(key, value, AZ_SNAPSHOT_TTL_MS);
      return value;
    })
    .finally(() => {
      azSnapshotInFlight.delete(key);
    });
  azSnapshotInFlight.set(key, build);
  return build;
}

/* One snapshot of a letter: the filtered, de-duplicated, adult-screened list
   plus the capped flag. Cached by letter so all pages share one result set. */
export async function azAniList(letter) {
  const snap = await azSnapshot(letter);
  return { items: snap.items, total: snap.items.length, capped: !!snap.capped };
}

/* Normalize an A-Z letter param: "all" | "0-9" | a single A-Z letter. */
export function normalizeAzLetter(value) {
  const raw = String(value || "all").trim().toLowerCase();
  if (raw === "all") return "all";
  if (raw === "0-9" || raw === "09" || raw === "digit" || raw === "digits") return "0-9";
  if (/^[a-z]$/.test(raw)) return raw.toUpperCase();
  return null;
}

/* AniList CAPS the `pageInfo.total` it reports for a multi-page query at
   5,000 and `lastPage` at 416 — for ANY filter, even a single year with ~40
   titles (live probes: year=1975 / 1998 / 2025 all reported total 5,000;
   only a genuinely single-page result set gets a real total). A year view
   therefore cannot show its exact total from pageInfo alone.

   Fix: count the year's titles ourselves. Page through AniList with the SAME
   filters (year + genre + format + status, isAdult: false, perPage 50, no
   sort — a count is sort-independent) until a page comes back short (<50) or
   empty, counting post-screen titles deduped by AniList id. The grid results
   are untouched; only pageInfo is replaced.

   This runs ONLY for year views (a year param present) and ONLY when AniList's
   reported total is capped (>= 5,000). Unfiltered Browse and genre/format/
   status-only views keep the current capped behavior. */
export const YEAR_COUNT_CAP_TOTAL = 5000;
const YEAR_COUNT_PAGE_SIZE = 50;
const YEAR_COUNT_MAX_PAGES = 40;
const YEAR_COUNT_PAST_TTL_MS = 24 * 60 * 60 * 1000;
const YEAR_COUNT_LIVE_TTL_MS = 60 * 60 * 1000;

/* Counts, keyed by the normalised filter set. Past years never change -> 24 h;
   the current year and next year keep gaining titles -> 1 h. */
const yearCountCache = new Map();

function yearCountGet(key) {
  const hit = yearCountCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttl) {
    yearCountCache.delete(key);
    return null;
  }
  return hit.value;
}

function yearCountSet(key, value, ttl) {
  yearCountCache.set(key, { at: Date.now(), ttl, value });
}

/* In-flight counts, keyed like the cache. The browse page fires concurrent
   /api/browse calls; without dedup two cold-cache callers would each page
   through AniList for the same year. Callers arriving while a count runs
   await the SAME promise; the entry is removed when it settles. */
const yearCountInFlight = new Map();

/* Cache key for a filter set: year + genre + format + status + the Phase 2
   filters (tags / season / score / date range), canonicalised and
   order-insensitive so "action,comedy" and "comedy,action" share one count.
   The extra args keep the signature backwards compatible: the original four
   still work and still isolate a bare year from a year+genre view. */
export function yearCountKey(year, genres, formats, statuses, tags = [], season = null, minScore = null, maxScore = null, startAfter = null, startBefore = null) {
  const norm = (list) => (Array.isArray(list) ? list.slice().sort().join(",") : "");
  return JSON.stringify([
    Number(year),
    norm(genres),
    norm(formats),
    norm(statuses),
    norm(tags),
    season || "",
    minScore == null ? "" : minScore,
    maxScore == null ? "" : maxScore,
    startAfter == null ? "" : startAfter,
    startBefore == null ? "" : startBefore,
  ]);
}

function yearCountTtl(year) {
  const nowYear = new Date().getFullYear();
  return (Number(year) >= nowYear ? YEAR_COUNT_LIVE_TTL_MS : YEAR_COUNT_PAST_TTL_MS);
}

async function buildYearCount(year, genres, formats, statuses, tags = [], season = null, minScore = null, maxScore = null, startAfter = null, startBefore = null) {
  const args = ["type: ANIME", "isAdult: false"];
  const vars = { page: 1, perPage: YEAR_COUNT_PAGE_SIZE };
  if (genres.length) { args.push("genre_in: $genre"); vars.genre = genres; }
  if (formats.length) { args.push("format_in: $format"); vars.format = formats; }
  if (statuses.length) { args.push("status_in: $status"); vars.status = statuses; }
  if (tags.length) { args.push("tag_in: $tag"); vars.tag = tags; }
  if (season) { args.push("season: $season"); vars.season = season; }
  if (year) { args.push("seasonYear: $year"); vars.year = year; }
  if (minScore != null) { args.push("averageScore_greater: $minScore"); vars.minScore = minScore; }
  if (maxScore != null) { args.push("averageScore_lesser: $maxScore"); vars.maxScore = maxScore; }
  if (startAfter != null) { args.push("startDate_greater: $startAfter"); vars.startAfter = startAfter; }
  if (startBefore != null) { args.push("startDate_lesser: $startBefore"); vars.startBefore = startBefore; }
  const varDecls = ["$page: Int", "$perPage: Int"];
  if (vars.genre) varDecls.push("$genre: [String]");
  if (vars.format) varDecls.push("$format: [MediaFormat]");
  if (vars.status) varDecls.push("$status: [MediaStatus]");
  if (vars.tag) varDecls.push("$tag: [String]");
  if (vars.season) varDecls.push("$season: MediaSeason");
  if (vars.year) varDecls.push("$year: Int");
  if (vars.minScore != null) varDecls.push("$minScore: Int");
  if (vars.maxScore != null) varDecls.push("$maxScore: Int");
  if (vars.startAfter != null) varDecls.push("$startAfter: FuzzyDateInt");
  if (vars.startBefore != null) varDecls.push("$startBefore: FuzzyDateInt");
  const query = `query (${varDecls.join(", ")}) {
    Page(page: $page, perPage: $perPage) {
      media(${args.join(", ")}) { ${MEDIA_FIELDS} }
    }
  }`;

  const seen = new Set();
  let pages = 0;
  for (;;) {
    if (pages >= YEAR_COUNT_MAX_PAGES) return null;
    const data = await anilistQuery(query, { ...vars, page: pages + 1 });
    const media = (data && data.Page && Array.isArray(data.Page.media)) ? data.Page.media : [];
    for (const item of media) {
      if (!item || item.id == null || seen.has(item.id)) continue;
      if (isAdultMedia(item)) continue;
      seen.add(item.id);
    }
    pages++;
    if (media.length < YEAR_COUNT_PAGE_SIZE) break;
  }
  return seen.size;
}

/* The real count for a year view, or null when it could not be measured
   (paging cap hit, or an AniList failure mid-count). Never caches a failure
   or a capped/partial count. */
async function yearCount(year, genres, formats, statuses, tags = [], season = null, minScore = null, maxScore = null, startAfter = null, startBefore = null) {
  const key = yearCountKey(year, genres, formats, statuses, tags, season, minScore, maxScore, startAfter, startBefore);
  const hit = yearCountGet(key);
  if (hit != null) return hit;

  const running = yearCountInFlight.get(key);
  if (running) return running;

  const build = buildYearCount(year, genres, formats, statuses, tags, season, minScore, maxScore, startAfter, startBefore)
    .then((count) => {
      if (count != null) yearCountSet(key, count, yearCountTtl(year));
      return count;
    })
    .finally(() => {
      yearCountInFlight.delete(key);
    });
  yearCountInFlight.set(key, build);
  return build;
}

/* Replace AniList's capped pageInfo with one built from the real year count.
   Returns the ORIGINAL pageInfo unchanged when there is no year filter, the
   reported total is not capped, or the count could not be measured — so a
   failure degrades to the current behavior instead of failing the request.
   The Phase 2 filters are passed into the count's filter set too: AniList
   supports score/season/tag/date args, so a year view with any of them still
   gets a real total (and a filter it could not count falls back to capped). */
export async function withRealYearTotal(pageInfo, opts = {}) {
  const {
    year, genres, formats, statuses, tags, season,
    minScore, maxScore, startAfter, startBefore,
  } = normalizeBrowseArgs(opts);
  if (!year) return pageInfo;
  const reportedTotal = Number(pageInfo && pageInfo.total);
  if (!(reportedTotal >= YEAR_COUNT_CAP_TOTAL)) return pageInfo;

  /* A failure while counting must never fail the browse request: the grid is
     already in hand, so degrade to AniList's own (capped) pageInfo. */
  let count;
  try {
    count = await yearCount(year, genres, formats, statuses, tags, season, minScore, maxScore, startAfter, startBefore);
  } catch {
    return pageInfo;
  }
  if (count == null) return pageInfo;

  const lastPage = Math.max(1, Math.ceil(count / SEARCH_PAGE_SIZE));
  const currentPage = Number.isFinite(Number(pageInfo && pageInfo.currentPage))
    ? Math.floor(Number(pageInfo.currentPage))
    : 1;
  return {
    total: count,
    currentPage,
    lastPage,
    hasNextPage: currentPage < lastPage,
  };
}

/* GET /api/browse — one flexible list endpoint. Sort/filter mapping is
   server-side; isAdult: false always. */
export const BROWSE_SORTS = {
  trending: "TRENDING_DESC",
  popular: "POPULARITY_DESC",
  top: "SCORE_DESC",
  newest: "START_DATE_DESC",
  /* Phase 2: full-filter browse sorts. */
  az: "TITLE_ROMAJI",
  name: "TITLE_ROMAJI",
  episodes: "EPISODES_DESC",
  updated: "UPDATED_ON_DESC",
  favourites: "FAVOURITES_DESC",
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

/* ---- The FULL AniList genre list (GenreCollection) ----
   The browse filters used to hardcode 17 genres. AniList's own list is the
   real one, so it is fetched once and cached for 24 h (genre taxonomy barely
   moves, and the endpoint is one cheap query). A failure degrades to the
   known 17 — the filters keep working, never a 500 and never an invented
   genre. */
const GENRE_QUERY = `query { GenreCollection }`;
const GENRE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/* Adult genres must never surface as a browse shelf, exactly like adult
   titles never do. */
const ADULT_GENRES = new Set(["Hentai"]);
const FALLBACK_GENRES = [...new Set(Object.values(GENRE_CANONICAL))];
let genreCache = null;

export async function getAniListGenres() {
  if (genreCache) return genreCache;
  try {
    const data = await anilistQuery(GENRE_QUERY, {}, GENRE_CACHE_TTL_MS);
    const raw = data && Array.isArray(data.GenreCollection) ? data.GenreCollection : [];
    const list = raw
      .filter((g) => typeof g === "string" && g.trim())
      .map((g) => g.trim())
      .filter((g) => !ADULT_GENRES.has(g));
    if (list.length) {
      genreCache = list;
      return list;
    }
  } catch {
    /* AniList down / rate-limited: fall through to the known list. */
  }
  return FALLBACK_GENRES;
}

/* Browse VIEW presets that are really FORMAT filters. `subbed` (every title)
   and `dubbed` (catalog titles with a verified dub) are handled by the route,
   not here. */
const VIEW_FORMATS = {
  movie: "MOVIE",
  ona: "ONA",
  special: "SPECIAL",
  tv: "TV",
};

export function browseViewFormat(view) {
  return VIEW_FORMATS[String(view || "").toLowerCase()] || null;
}

/* AniList TAGS are case-sensitive too (tag_in: ["Isekai"]). The browse filter
   panel sends the site's curated tag list; this map canonicalises the popular
   ones so a lowercased "isekai" still matches. Unknown tags pass through
   trimmed — the panel only offers known AniList tags, so this is a safety
   net, not a guess. */
const TAG_CANONICAL = {
  isekai: "Isekai",
  cgdct: "CGDCT",
  "mahou shoujo": "Mahou Shoujo",
  military: "Military",
  school: "School",
  "time travel": "Time Travel",
  "super power": "Super Power",
  "strategy game": "Strategy Game",
  "team sports": "Team Sports",
  travel: "Travel",
  "urban fantasy": "Urban Fantasy",
  workplace: "Workplace",
  villainess: "Villainess",
  magic: "Magic",
  "martial arts": "Martial Arts",
  demons: "Demons",
  dragon: "Dragon",
  cyberpunk: "Cyberpunk",
  "post-apocalyptic": "Post-Apocalyptic",
  detective: "Detective",
};

export function canonicalTag(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  return TAG_CANONICAL[raw.toLowerCase()] || raw;
}

/* YYYY / YYYY-MM / YYYY-MM-DD -> AniList FuzzyDateInt (YYYYMMDD). Returns null
   for anything unparseable, so a bad date filter is ignored rather than sent
   to AniList as 0. */
export function fuzzyDateInt(value) {
  const raw = String(value || "").trim();
  const full = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const month = raw.match(/^(\d{4})-(\d{2})$/);
  const year = raw.match(/^(\d{4})$/);
  if (full) {
    const [, y, m, d] = full;
    if (+m < 1 || +m > 12 || +d < 1 || +d > 31) return null;
    return Number(`${y}${m}${d}`);
  }
  if (month) {
    const [, y, m] = month;
    if (+m < 1 || +m > 12) return null;
    return Number(`${y}${m}01`);
  }
  if (year) {
    const y = Number(year[1]);
    if (y < 1900 || y > 2200) return null;
    return Number(`${year[1]}0101`);
  }
  return null;
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
  const tags = asList(query.tags).map(canonicalTag).filter(Boolean);

  const seasonRaw = String(query.season || "").trim().toUpperCase();
  const season = ["WINTER", "SPRING", "SUMMER", "FALL"].includes(seasonRaw) ? seasonRaw : null;

  const yearRaw = Number(query.year);
  const year = Number.isFinite(yearRaw) && yearRaw > 1800 && yearRaw < 2200 ? Math.floor(yearRaw) : null;

  /* Score is AniList's 0-100 averageScore. A range is only sent when it is
     real and ordered; an inverted range is swapped rather than silently
     dropped, so ?minScore=90&maxScore=70 still means "70 to 90". */
  const score = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.min(100, Math.max(0, Math.floor(n)));
  };
  let minScore = score(query.minScore);
  let maxScore = score(query.maxScore);
  if (minScore != null && maxScore != null && minScore > maxScore) {
    [minScore, maxScore] = [maxScore, minScore];
  }
  /* 0 is "no floor" and 100 is "no ceiling" — sending them is harmless but
     noise; drop the ones that cannot constrain anything. */
  if (minScore === 0) minScore = null;
  if (maxScore === 100) maxScore = null;

  const startAfter = fuzzyDateInt(query.startAfter);
  const startBefore = fuzzyDateInt(query.startBefore);

  const pageRaw = Number(query.page);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;

  /* Page size. Browse grids are 12; the Home "Top 10" rail asks for exactly
     10. Capped at 50 (AniList's own perPage ceiling). */
  const perPageRaw = Number(query.perPage);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0
    ? Math.min(50, Math.floor(perPageRaw))
    : 12;

  return {
    sort, genres, formats, statuses, tags, season, year,
    minScore, maxScore, startAfter, startBefore, page, perPage,
  };
}

export async function browseAniList(opts = {}) {
  const {
    sort, genres, formats, statuses, tags, season, year,
    minScore, maxScore, startAfter, startBefore, page, perPage,
  } = normalizeBrowseArgs(opts);
  const args = ["type: ANIME", "sort: " + sort, "isAdult: false"];
  const vars = { page, perPage };
  if (genres.length) { args.push("genre_in: $genre"); vars.genre = genres; }
  if (formats.length) { args.push("format_in: $format"); vars.format = formats; }
  if (statuses.length) { args.push("status_in: $status"); vars.status = statuses; }
  if (tags.length) { args.push("tag_in: $tag"); vars.tag = tags; }
  if (season) { args.push("season: $season"); vars.season = season; }
  if (year) { args.push("seasonYear: $year"); vars.year = year; }
  if (minScore != null) { args.push("averageScore_greater: $minScore"); vars.minScore = minScore; }
  if (maxScore != null) { args.push("averageScore_lesser: $maxScore"); vars.maxScore = maxScore; }
  if (startAfter != null) { args.push("startDate_greater: $startAfter"); vars.startAfter = startAfter; }
  if (startBefore != null) { args.push("startDate_lesser: $startBefore"); vars.startBefore = startBefore; }
  const varDecls = ["$page: Int", "$perPage: Int"];
  if (vars.genre) varDecls.push("$genre: [String]");
  if (vars.format) varDecls.push("$format: [MediaFormat]");
  if (vars.status) varDecls.push("$status: [MediaStatus]");
  if (vars.tag) varDecls.push("$tag: [String]");
  if (vars.season) varDecls.push("$season: MediaSeason");
  if (vars.year) varDecls.push("$year: Int");
  if (vars.minScore != null) varDecls.push("$minScore: Int");
  if (vars.maxScore != null) varDecls.push("$maxScore: Int");
  if (vars.startAfter != null) varDecls.push("$startAfter: FuzzyDateInt");
  if (vars.startBefore != null) varDecls.push("$startBefore: FuzzyDateInt");
  const query = `query (${varDecls.join(", ")}) {
    Page(page: $page, perPage: $perPage) {
      ${PAGE_INFO_FIELDS}
      media(${args.join(", ")}) { ${MEDIA_FIELDS} }
    }
  }`;
  const data = await anilistQuery(query, vars);
  return pageResult(data && data.Page);
}

/* Live title alias mappings (e.g. user-facing alternate IDs) */
const LIVE_ID_ALIASES = {
  167728: 159042, // Reincarnated as a Sword S2 anime ID
};

/* GET /api/live/:anilistId — one title, 1-hour cache. The isAdult: false
   filter means an adult title resolves to null -> the route answers 404
   {error:"not_available"}, so adult titles cannot be opened by direct link. */
export async function getLiveTitle(anilistId) {
  let id = Number(anilistId);
  if (!Number.isFinite(id) || id <= 0) return null;
  id = LIVE_ID_ALIASES[id] || id;
  /* ONE request carries both the shared fields and the detail-only fields
     (studios / characters / relations / tags / banner). List endpoints never
     request these. */
  const query = `query ($id: Int) {
    Media(id: $id, type: ANIME, isAdult: false) { ${LIVE_DETAIL_FIELDS} }
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
  /* Not an anime (a manga id, for example) -> not available. */
  if (!media || (media.type && media.type !== "ANIME") || isAdultMedia(media)) return null;
  return liveDetailView(media);
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
      .filter((r) => r && r.media && (!r.media.type || r.media.type === "ANIME") && !isAdultMedia(r.media))
      .map((r) => ({ airingAt: r.airingAt, episode: r.episode, media: mediaView(r.media) })),
    pageInfo: (pageData && pageData.pageInfo) || { total: 0, currentPage: 1, lastPage: 1, hasNextPage: false },
  };
}
