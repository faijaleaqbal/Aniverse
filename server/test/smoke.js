import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildEmbedUrl, ZOKO_SOURCES } from "../src/zoko.js";
import { ZOKO_EMBED_ORIGIN, ANIVEXA_BASE_URL } from "../src/config.js";
import { episodeSetFromAnivexa, pickAnimeggStreamUrl } from "../src/animegg.js";
import { isMusicMedia, canonicalFormat, canonicalGenre, normalizeBrowseArgs } from "../src/anilist.js";
import {
  pkceChallenge,
  buildRedirectUri,
  placeholderEmail,
  isPlaceholderEmail,
  cleanSocialName,
  providerConfig,
  OAUTH_PROVIDER_IDS,
} from "../src/oauth-providers.js";
import { buildDetailSeo, truncateDescription } from "../src/seo.js";
import { extractTmdbFromExternalLinks, resolveTmdbInfo } from "../src/tmdb.js";
import { isBlakiteUnavailableHtml, withHindiAvailability, clearHindiCaches } from "../src/hindi.js";

console.log("=== Running ZokoAnime Unit / Smoke Tests ===");

let passed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}:`, err.message);
    throw err;
  }
}

// 1. Basic Embed URL construction
test("buildEmbedUrl generates valid URL with required params", () => {
  const url = buildEmbedUrl({
    origin: "https://zokoanime.video",
    source: "mal",
    id: 21,
    episode: 1,
    track: "sub",
    color: "cae962",
  });
  assert.equal(
    url,
    "https://zokoanime.video/stream/mal/21/1/sub?color=cae962&autoplay=1&autoskip=1&autonext=1"
  );
});

// 2. Resume parameter ?t=
test("buildEmbedUrl appends resume ?t= param correctly", () => {
  const url = buildEmbedUrl({
    origin: "https://zokoanime.video",
    source: "mal",
    id: 40748,
    episode: 5,
    track: "sub",
    startTime: 125,
  });
  assert.ok(url.includes("&t=125"), `Expected url to include &t=125, got: ${url}`);
  assert.ok(url.startsWith("https://zokoanime.video/stream/mal/40748/5/sub?"));
});

// 3. Audio track options (sub, hsub, dub)
test("buildEmbedUrl supports all official audio tracks (sub, hsub, dub)", () => {
  for (const track of ["sub", "hsub", "dub"]) {
    const url = buildEmbedUrl({
      origin: "https://zokoanime.video",
      source: "mal",
      id: 21,
      episode: 2,
      track,
    });
    assert.ok(url.includes(`/stream/mal/21/2/${track}?`));
  }
});

/* Zoko's /stream/anilist/ route is dead upstream (HTTP 404 for every id
   probed), so the site only ever builds the mal route. */
test("the only Zoko source is mal (the anilist route is dead upstream)", () => {
  assert.deepEqual(ZOKO_SOURCES, ["mal"]);
  assert.throws(
    () => buildEmbedUrl({ origin: "https://zokoanime.video", source: "anilist", id: 113415, episode: 3, track: "dub" }),
    /Unsupported ZokoAnime source/
  );
});

// 5. Query param boolean flags 1/0
test("buildEmbedUrl formats boolean flags as 1 and 0", () => {
  const url = buildEmbedUrl({
    origin: "https://zokoanime.video",
    source: "mal",
    id: 21,
    episode: 1,
    autoplay: false,
    autoskip: true,
    autonext: false,
  });
  assert.ok(url.includes("autoplay=0"));
  assert.ok(url.includes("autoskip=1"));
  assert.ok(url.includes("autonext=0"));
});

// 6. Color normalization (stripping #)
test("buildEmbedUrl strips leading # from color hex", () => {
  const url = buildEmbedUrl({
    origin: "https://zokoanime.video",
    id: 21,
    episode: 1,
    color: "#CAE962",
  });
  assert.ok(url.includes("color=cae962"));
});

// 7. Rejects invalid source
test("buildEmbedUrl throws on unsupported source", () => {
  assert.throws(
    () => {
      buildEmbedUrl({
        origin: "https://zokoanime.video",
        source: "unsupported_source",
        id: 21,
        episode: 1,
      });
    },
    /Unsupported ZokoAnime source/
  );
});

// 8. Rejects invalid track
test("buildEmbedUrl throws on unsupported track", () => {
  assert.throws(
    () => {
      buildEmbedUrl({
        origin: "https://zokoanime.video",
        track: "invalid_track",
        id: 21,
        episode: 1,
      });
    },
    /Unsupported ZokoAnime track/
  );
});

// 9. Rejects missing numeric id
test("buildEmbedUrl throws when id is missing or not a positive number", () => {
  assert.throws(
    () => {
      buildEmbedUrl({
        origin: "https://zokoanime.video",
        id: 0,
        episode: 1,
      });
    },
    /numeric anime id is required/
  );
});

// 10. Rejects missing origin
test("buildEmbedUrl throws when origin is not provided", () => {
  assert.throws(
    () => {
      buildEmbedUrl({
        id: 21,
        episode: 1,
      });
    },
    /origin is not configured/
  );
});

// 11. Resume emits BOTH t= and time= (the live embed only honours time=;
//     t= alone is ignored and playback starts at 0 — verified against
//     zokoanime.video). Track switches and Resume depend on this.
test("buildEmbedUrl resume emits time= alongside t=", () => {
  const url = buildEmbedUrl({
    origin: "https://zokoanime.video",
    id: 52299,
    episode: 1,
    track: "dub",
    startTime: 185,
  });
  assert.ok(url.includes("&t=185"), `Expected &t=185, got: ${url}`);
  assert.ok(url.includes("&time=185"), `Expected &time=185, got: ${url}`);
});

/* ==========================================================================
   animegg fallback (Anivexa proxy) — the shipped pure helpers, no network.
   The route-level tests (live stub server) live in e2e.js.
   ========================================================================== */

// 12. Anivexa base URL defaults to the production loopback port.
test("ANIVEXA_BASE_URL defaults to http://127.0.0.1:4100", () => {
  assert.equal(ANIVEXA_BASE_URL, "http://127.0.0.1:4100");
});

// 13. Availability parsing: the per-provider route lists episodes under sub.
test("animegg episode list reads the per-provider /episodes response", () => {
  const listed = episodeSetFromAnivexa({
    animegg: { episodes: { sub: [{ number: 1 }, { number: 2 }], dub: [] } },
  });
  assert.deepEqual([...listed].sort(), [1, 2]);
  assert.equal(listed.has(1), true);
  assert.equal(listed.has(3), false);

  /* The bare provider object (no `animegg` wrapper) is accepted too. */
  const bare = episodeSetFromAnivexa({ episodes: { sub: [{ episode: 4 }] } });
  assert.deepEqual([...bare], [4]);

  /* Nothing listed -> empty set, never a throw. */
  assert.deepEqual([...episodeSetFromAnivexa({ animegg: { error: "no match" } })], []);
  assert.deepEqual([...episodeSetFromAnivexa(null)], []);
});

// 14. Stream selection: the iframe-able embed URL wins over a direct mp4.
test("animegg stream selection prefers the embed URL, falls back to mp4", () => {
  const embed = pickAnimeggStreamUrl([
    { type: "mp4", url: "https://cdn.test/video.mp4?for=1", server: "Animegg" },
    { type: "embed", embed: "https://www.animegg.org/embed/119601", server: "Animegg-embed" },
  ]);
  assert.deepEqual(embed, {
    ok: true,
    embedUrl: "https://www.animegg.org/embed/119601",
    url: "https://www.animegg.org/embed/119601",
  });

  const mp4Only = pickAnimeggStreamUrl([
    { type: "mp4", url: "https://www.animegg.org/play/119601/video.mp4?for=101795376258733" },
  ]);
  assert.equal(mp4Only.ok, true);
  assert.equal(mp4Only.embedUrl, null, "no embed -> embedUrl stays null");
  assert.ok(mp4Only.url.includes("animegg.org/play/119601/video.mp4"));

  /* embedUrl alias is honoured as well. */
  const alias = pickAnimeggStreamUrl([{ embedUrl: "https://www.animegg.org/embed/123714" }]);
  assert.equal(alias.embedUrl, "https://www.animegg.org/embed/123714");

  /* No usable stream -> ok:false, never a throw. */
  assert.deepEqual(pickAnimeggStreamUrl([]), { ok: false, embedUrl: null, url: null });
  assert.deepEqual(pickAnimeggStreamUrl([{ type: "mp4" }]), { ok: false, embedUrl: null, url: null });
  /* A relative/invalid URL is rejected rather than handed to an iframe. */
  assert.deepEqual(pickAnimeggStreamUrl([{ url: "not a url" }]), { ok: false, embedUrl: null, url: null });
});

/* ==========================================================================
   AniList content screens — MUSIC is excluded exactly like adult media.
   ========================================================================== */

// 15. isMusicMedia flags only the MUSIC format.
test("isMusicMedia flags only AniList's MUSIC format", () => {
  assert.equal(isMusicMedia(null), false);
  assert.equal(isMusicMedia(undefined), false);
  assert.equal(isMusicMedia({}), false);
  assert.equal(isMusicMedia({ format: "MUSIC" }), true);
  assert.equal(isMusicMedia({ format: "TV" }), false);
  assert.equal(isMusicMedia({ format: "MOVIE" }), false);
  assert.equal(isMusicMedia({ format: "music" }), false, "the enum is uppercase");
  /* A genre named "Music" is not the media format. */
  assert.equal(isMusicMedia({ format: "TV", genres: ["Music"] }), false);
});

// 16. canonicalFormat('MUSIC') is null so a format=MUSIC request can never
//     ask AniList for Music titles.
test("canonicalFormat('MUSIC') is null (MUSIC can never be requested)", () => {
  assert.equal(canonicalFormat("MUSIC"), null);
  assert.equal(canonicalFormat("music"), null);
  assert.equal(canonicalFormat(" Music "), null);
  assert.equal(canonicalFormat(""), null);
  /* Other formats still canonicalise. */
  assert.equal(canonicalFormat("movie"), "MOVIE");
  assert.equal(canonicalFormat("TV"), "TV");
  assert.equal(canonicalFormat("ona"), "ONA");
});

// 17. PKCE S256 challenge matches the RFC 7636 test vector.
test("pkceChallenge matches the RFC 7636 S256 test vector", () => {
  assert.equal(
    pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
  );
});

// 18. OAuth redirect URIs follow the BASE_URL + /auth/<provider>/callback pattern.
test("buildRedirectUri builds the exact callback URL per provider", () => {
  assert.equal(
    buildRedirectUri("google"),
    "https://aniversetesting.duckdns.org/auth/google/callback"
  );
  assert.equal(buildRedirectUri("mal"), "https://aniversetesting.duckdns.org/auth/mal/callback");
  assert.equal(
    buildRedirectUri("anilist"),
    "https://aniversetesting.duckdns.org/auth/anilist/callback"
  );
});

// 19. Placeholder emails for no-email providers are clearly fake (.invalid)
//     and unique per provider identity.
test("placeholderEmail is an obviously-fake .invalid address, unique per identity", () => {
  assert.equal(placeholderEmail("mal", "123"), "no-email-mal-123@aniflick.invalid");
  assert.equal(placeholderEmail("anilist", "456"), "no-email-anilist-456@aniflick.invalid");
  assert.notEqual(placeholderEmail("mal", "123"), placeholderEmail("mal", "124"));
  assert.ok(isPlaceholderEmail("no-email-mal-123@aniflick.invalid"));
  assert.ok(!isPlaceholderEmail("user@example.com"));
  /* Unsafe characters in a provider id are sanitised out of the local part. */
  assert.equal(placeholderEmail("google", "a/b c"), "no-email-google-a-b-c@aniflick.invalid");
});

// 20. Social display names are cleaned and capped at the 40-char limit.
test("cleanSocialName cleans and caps provider names at 40 chars", () => {
  assert.equal(cleanSocialName("  Zoro Fan  "), "Zoro Fan");
  assert.equal(cleanSocialName("x".repeat(100)).length, 40);
  assert.equal(cleanSocialName(""), "AniFlick User");
  assert.equal(cleanSocialName("   "), "AniFlick User");
});

// 21. All four providers exist and are DISABLED with no credentials set
//     (the test environment has none — same as a fresh deploy).
test("all four OAuth providers are defined and disabled without credentials", () => {
  assert.deepEqual([...OAUTH_PROVIDER_IDS].sort(), ["anilist", "discord", "google", "mal"]);
  for (const id of OAUTH_PROVIDER_IDS) {
    const cfg = providerConfig(id);
    assert.ok(cfg, `${id} must have a provider definition`);
    assert.equal(cfg.enabled, false, `${id} must be disabled with no credentials`);
    assert.ok(cfg.authorizeUrl.startsWith("https://"), `${id} authorize URL is HTTPS`);
    assert.ok(cfg.tokenUrl.startsWith("https://"), `${id} token URL is HTTPS`);
  }
  /* MAL requires PKCE — the flow must never start without it. */
  assert.equal(providerConfig("mal").pkce, true, "MAL requires PKCE");
  assert.equal(providerConfig("google").pkce, true, "Google uses PKCE too");
  assert.equal(providerConfig("unknown"), null, "unknown provider ids resolve to null");
});

test("buildDetailSeo formats title, truncated description, canonical URL, and TVSeries/Movie JSON-LD", () => {
  const longSyn = "<p>A long <b>synopsis</b> " + "word ".repeat(50) + "</p>";
  const desc = truncateDescription(longSyn, 155);
  assert.ok(desc.length <= 155, `truncated length ${desc.length} <= 155`);
  assert.ok(!desc.includes("<"), "HTML tags stripped from description");
  assert.ok(desc.endsWith("..."), "long description ends with ellipsis");

  const series = buildDetailSeo({
    slug: "kagerou-protocol",
    name: "Jujutsu Kaisen",
    kind: "Series",
    episodes: 24,
    genres: ["action", "supernatural"],
    synopsis: "A boy swallows a cursed talisman and joins a secret school of jujutsu sorcerers.",
    cover: "/img/covers/kagerou-protocol.jpg",
  });
  assert.equal(series.pageTitle, "Watch Jujutsu Kaisen English Sub/Dub Online — AniFlick");
  assert.equal(series.canonicalUrl, "https://aniflick.duckdns.org/anime/kagerou-protocol");
  assert.equal(series.jsonLd["@type"], "TVSeries");
  assert.equal(series.jsonLd.numberOfEpisodes, 24);
  assert.deepEqual(series.jsonLd.genre, ["Action", "Supernatural"]);

  const movie = buildDetailSeo({
    slug: "paper-cranes-at-dawn",
    name: "A Silent Voice",
    kind: "Film",
    episodes: 1,
    genres: ["life", "drama"],
    synopsis: "A heartwarming story of redemption.",
  });
  assert.equal(movie.jsonLd["@type"], "Movie");
  assert.equal(movie.jsonLd.numberOfEpisodes, undefined);
});

test("extractTmdbFromExternalLinks and resolveTmdbInfo resolve TV TMDB ids and reject movies/unmapped", () => {
  assert.equal(
    extractTmdbFromExternalLinks([
      { site: "Crunchyroll", type: "STREAMING", url: "https://www.crunchyroll.com/naruto" },
      { site: "TMDB", type: "TV", url: "https://www.themoviedb.org/tv/31910" },
    ]),
    31910
  );
  assert.equal(
    extractTmdbFromExternalLinks([
      { site: "The Movie Database", type: "INFO", url: "https://www.themoviedb.org/tv/280042-wild-last-boss" },
    ]),
    280042
  );
  assert.equal(
    extractTmdbFromExternalLinks([
      { site: "TMDB", type: "MOVIE", url: "https://www.themoviedb.org/movie/378064" },
    ]),
    null,
    "movie links must not resolve as TMDB TV ids"
  );
  assert.equal(extractTmdbFromExternalLinks([]), null);

  assert.deepEqual(
    resolveTmdbInfo({ anilistId: 1735, format: "TV", externalLinks: [] }),
    { tmdbId: 31910, tmdbSeason: 1, tmdbEpisodeOffset: 0 }
  );
  assert.deepEqual(
    resolveTmdbInfo({ anilistId: 142838, format: "TV", externalLinks: [] }),
    { tmdbId: 120089, tmdbSeason: 1, tmdbEpisodeOffset: 12 }
  );
  assert.deepEqual(
    resolveTmdbInfo({ anilistId: 20954, format: "MOVIE", kind: "Film" }),
    { tmdbId: null, tmdbSeason: null, tmdbEpisodeOffset: 0 }
  );
  assert.deepEqual(
    resolveTmdbInfo({ anilistId: 99999999, format: "TV", externalLinks: [] }),
    { tmdbId: null, tmdbSeason: null, tmdbEpisodeOffset: 0 }
  );
});

test("withHindiAvailability uses the swept map: true when Vidstream-3 or Nitro has it, false otherwise", () => {
  clearHindiCaches();
  assert.deepEqual(
    withHindiAvailability({ tmdbId: null, tmdbSeason: null, tmdbEpisodeOffset: 0 }),
    { tmdbId: null, tmdbSeason: null, tmdbEpisodeOffset: 0, hindiAvailable: false }
  );
  /* Frieren (209867): no Vidstream-3, Nitro-only — still Hindi, badge allowed. */
  assert.deepEqual(
    withHindiAvailability({ tmdbId: 209867, tmdbSeason: 1, tmdbEpisodeOffset: 0 }),
    { tmdbId: 209867, tmdbSeason: 1, tmdbEpisodeOffset: 0, hindiAvailable: true }
  );
  /* Naruto (46260): both players. */
  assert.equal(
    withHindiAvailability({ tmdbId: 46260, tmdbSeason: 1, tmdbEpisodeOffset: 0 }).hindiAvailable,
    true
  );
  /* Cowboy Bebop (30991): swept, neither player — badge must stay hidden. */
  assert.equal(
    withHindiAvailability({ tmdbId: 30991, tmdbSeason: 1, tmdbEpisodeOffset: 0 }).hindiAvailable,
    false
  );
  /* Unswept title: defaults to false, never null. */
  assert.equal(
    withHindiAvailability({ tmdbId: 999999, tmdbSeason: 1, tmdbEpisodeOffset: 0 }).hindiAvailable,
    false
  );
});

/* Genre/tag routing: Isekai is an AniList TAG, not a genre — it must never
   reach genre_in, or every genre filter returns the same wrong list. */
test("canonicalGenre returns null for known tags and normalizeBrowseArgs routes genre=isekai to tags", () => {
  assert.equal(canonicalGenre("isekai"), null);
  assert.equal(canonicalGenre("Isekai"), null);
  assert.equal(canonicalGenre("fantasy"), "Fantasy");
  const isekaiArgs = normalizeBrowseArgs({ genre: "isekai" });
  assert.deepEqual(isekaiArgs.genres, []);
  assert.deepEqual(isekaiArgs.tags, ["Isekai"]);
  const fantasyArgs = normalizeBrowseArgs({ genre: "fantasy" });
  assert.deepEqual(fantasyArgs.genres, ["Fantasy"]);
  assert.deepEqual(fantasyArgs.tags, []);
  const bothArgs = normalizeBrowseArgs({ genre: "fantasy", tags: "isekai" });
  assert.deepEqual(bothArgs.genres, ["Fantasy"]);
  assert.deepEqual(bothArgs.tags, ["Isekai"]);
});

/* Search ranking lives in the shipped client JS; evaluate the marked block
   directly so the test covers the exact code the page runs. */
test("search ranking ranks exact > prefix > substring and highlights the match", () => {
  const client = readFileSync(
    fileURLToPath(new URL("../../ani-verse/js/zoro-aizen.js", import.meta.url)),
    "utf8"
  );
  const start = client.indexOf("/* __SEARCH_RANKING_LOGIC_START__ */");
  const end = client.indexOf("/* __SEARCH_RANKING_LOGIC_END__ */");
  assert.ok(start >= 0 && end > start, "zoro-aizen.js must contain the SEARCH_RANKING_LOGIC block");
  const block = client.slice(start, end);
  /* highlightSearchMatch uses escapeHtml, which lives outside the block. */
  const escapeHtml = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const { searchMatchTier, rankSearchResults, highlightSearchMatch } = eval(
    `${block}\n({ searchMatchTier, rankSearchResults, highlightSearchMatch });`
  );
  assert.equal(searchMatchTier({ name: "Naruto" }, "naruto"), 3, "exact match is tier 3");
  assert.equal(searchMatchTier({ name: "Naruto: Shippuden" }, "naruto"), 2, "prefix match is tier 2");
  assert.equal(searchMatchTier({ name: "Boruto: Naruto Next Generations" }, "naruto"), 1, "substring match is tier 1");
  assert.equal(searchMatchTier({ name: "One Piece" }, "naruto"), 0, "no match is tier 0");
  assert.equal(searchMatchTier({ romajiTitle: "Naruto" }, "naruto"), 3, "romaji title counts");
  const ranked = rankSearchResults(
    [{ name: "Boruto: Naruto Next Generations" }, { name: "Naruto: Shippuden" }, { name: "Naruto" }],
    "naruto"
  ).map((t) => t.name);
  assert.deepEqual(ranked, ["Naruto", "Naruto: Shippuden", "Boruto: Naruto Next Generations"]);
  assert.equal(highlightSearchMatch("Naruto: Shippuden", "naruto"), "<mark>Naruto</mark>: Shippuden");
  assert.equal(highlightSearchMatch("One Piece", "naruto"), "One Piece");
});

test("isBlakiteUnavailableHtml detects CFG errors and visible unavailable markers without false positives on JS templates", () => {
  assert.equal(
    isBlakiteUnavailableHtml(
      '<script>window.CFG={"err":"Content not available","dataId":""};</script><script>showMsg("<h1>Video Unavailable</h1>");</script>'
    ),
    true
  );
  assert.equal(
    isBlakiteUnavailableHtml(
      '<script>window.CFG={"err":"","dataId":"fww1/46/s8/2/W/W/-/a/WW-aA"};</script><script>showMsg("<h1>Video Unavailable</h1>");</script>'
    ),
    false,
    "JS template string inside <script> must not mark a valid CFG.dataId page unavailable"
  );
  assert.equal(
    isBlakiteUnavailableHtml("<html><body><h1>Video Unavailable</h1></body></html>"),
    true
  );
  assert.equal(
    isBlakiteUnavailableHtml("<html><body><video></video></body></html>"),
    false
  );
});

/* Turnstile: the login widget must surface the widget's own error code
   (110200 = domain not authorized renders as "Unable to connect to
   website") instead of leaving a mysterious Cloudflare error box. The
   config-error path must exist in the shipped login.js. */
test("login.js wires Turnstile error-callback and names the 110200 domain fix", () => {
  const loginJs = readFileSync(
    fileURLToPath(new URL("../../ani-verse/js/login.js", import.meta.url)),
    "utf8"
  );
  assert.ok(loginJs.includes('"error-callback"'), "login.js must pass error-callback to turnstile.render");
  assert.ok(loginJs.includes("110200"), "login.js must recognize the 110200 domain-not-authorized code");
  assert.ok(
    loginJs.includes("TURNSTILE_CONFIG_ERRORS"),
    "login.js must have a config-error code map"
  );
  assert.ok(
    loginJs.includes("showTurnstileConfigError"),
    "login.js must have a config-error handler"
  );
  assert.ok(
    loginJs.includes('data-turnstile-error'),
    "login.js must stamp the error code on the slot for browser verification"
  );
  assert.ok(
    loginJs.includes("hostname list"),
    "login.js must tell the user the fix is the Turnstile hostname list"
  );
});

console.log(`\nAll ${passed} smoke / unit tests passed successfully!\n`);
