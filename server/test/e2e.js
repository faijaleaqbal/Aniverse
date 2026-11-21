import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
/* Self-contained test database: a temporary seeded + enriched DB (see
   setup-db.js). `npm test` needs no manual seed/metadata steps and never
   touches the live database. */
const { app, db } = await import("./setup-db.js");
const { clearAniListCache } = await import("../src/anilist.js");

/* The shipped frontend logic lives in a plain browser script (no module
   exports), so these tests extract its marked pure-function blocks and
   evaluate them directly — the exact code the page runs, without a DOM. */
const ZORO_JS_PATH = fileURLToPath(new URL("../../ani-verse/js/zoro-aizen.js", import.meta.url));

function evalZoroBlock(marker, exportNames) {
  const source = readFileSync(ZORO_JS_PATH, "utf8");
  const startTag = `/* __${marker}_START__ */`;
  const endTag = `/* __${marker}_END__ */`;
  const start = source.indexOf(startTag);
  const end = source.indexOf(endTag);
  assert.ok(start >= 0 && end > start, `zoro-aizen.js must contain the marked block ${marker}`);
  const block = source.slice(start, end);
  return new Function(`${block}\nreturn { ${exportNames.join(", ")} };`)();
}


/* ==========================================================================
   ANILIST MOCK
   The live-catalog endpoints talk to AniList through the server (never from
   the browser). These tests mock that ONE call so the suite stays offline
   and deterministic: every request to graphql.anilist.co is intercepted and
   answered from a fixture, everything else passes through untouched.
   ========================================================================== */

const realFetch = globalThis.fetch;
let anilistResponder = null;
const anilistRequests = [];

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : (input && input.url) || "";
  if (url.includes("graphql.anilist.co")) {
    const body = JSON.parse(init.body);
    anilistRequests.push(body);
    if (!anilistResponder) {
      throw new Error("AniList mock: no responder installed");
    }
    return anilistResponder(body);
  }
  return realFetch(input, init);
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fakeMedia(overrides = {}) {
  return {
    id: 900001,
    idMal: 900001,
    type: "ANIME",
    isAdult: false,
    title: { romaji: "Mock Anime", english: "Mock Anime", native: "モック" },
    coverImage: { large: "https://cdn.test/mock-cover.jpg" },
    description: "A <br>mock description with <i>markup</i>",
    episodes: 12,
    duration: 24,
    format: "TV",
    status: "RELEASING",
    startDate: { year: 2024, month: 4, day: 1 },
    genres: ["Action", "Adventure"],
    averageScore: 81,
    seasonYear: 2024,
    popularity: 5000,
    nextAiringEpisode: null,
    ...overrides,
  };
}

const MOCK_PAGE_INFO = { total: 42, currentPage: 1, lastPage: 4, hasNextPage: true };

/* How the Page query answers. Default: always hand back `mediaList` with a
   fixed pageInfo (the old deterministic shape). `paged` emulates a real year:
   slice `allMedia` by page/perPage AND report AniList's 5,000 / 416 cap once
   the set is multi-page — the exact behavior that hides a small year's total.
   `alwaysFull` answers every page with `perPage` rows (no short page), so a
   count runs into the 40-page cap. */
function mockAniList({ mediaList = [], allMedia = null, alwaysFull = false, mediaById = {}, airing = [], fail = false } = {}) {
  clearAniListCache();
  anilistRequests.length = 0;
  anilistResponder = async (body) => {
    const query = String(body.query || "");
    if (fail) {
      return jsonResponse({ errors: [{ message: "Upstream boom", status: 500 }] }, 500);
    }
    if (query.includes("airingSchedules")) {
      return jsonResponse({
        data: { Page: { pageInfo: MOCK_PAGE_INFO, airingSchedules: airing } },
      });
    }
    if (/Media\(/.test(query)) {
      const id = body.variables && body.variables.id;
      const media = mediaById[id];
      if (!media) {
        return jsonResponse({ errors: [{ message: "Not Found.", status: 404 }] }, 404);
      }
      return jsonResponse({ data: { Media: media } });
    }

    const variables = (body && body.variables) || {};
    const perPage = Number(variables.perPage) || 12;
    const page = Number(variables.page) || 1;
    let media;
    let pageInfo;
    if (allMedia) {
      const total = allMedia.length;
      media = allMedia.slice((page - 1) * perPage, page * perPage);
      /* AniList caps the reported total/lastPage for any multi-page set. */
      const countPages = Math.ceil(total / perPage);
      pageInfo = {
        total: countPages > 1 ? 5000 : total,
        currentPage: page,
        lastPage: countPages > 1 ? 416 : Math.max(1, countPages),
        hasNextPage: page < countPages,
      };
    } else if (alwaysFull) {
      const base = 900000 + (page - 1) * perPage;
      media = Array.from({ length: perPage }, (_, i) =>
        fakeMedia({ id: base + i, idMal: base + i })
      );
      pageInfo = { total: 5000, currentPage: page, lastPage: 416, hasNextPage: true };
    } else {
      media = mediaList;
      pageInfo = MOCK_PAGE_INFO;
    }
    return jsonResponse({ data: { Page: { pageInfo, media } } });
  };
}

function resetAniListMock() {
  clearAniListCache();
  anilistResponder = null;
  anilistRequests.length = 0;
}

console.log("=== Running Ani Verse API & Zoko E2E Integration Tests ===");

let passed = 0;
let server = null;
let baseUrl = "";

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}:`, err.message);
    throw err;
  }
}

async function runTests() {
  // Start server on an ephemeral port (port 0)
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  try {
    // 1. /api/player/config returns embed config
    await test("GET /api/player/config returns valid Zoko embed configuration", async () => {
      const res = await fetch(`${baseUrl}/api/player/config`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.ok(data.embed);
      assert.equal(data.embed.origin, "https://zokoanime.video");
      assert.deepEqual(data.embed.sources, ["mal", "anilist"]);
      assert.deepEqual(data.embed.tracks, ["sub", "hsub", "dub"]);
    });

    // 2. /api/stream/ronin-of-the-neon-ward/1 returns One Piece (MAL 21) Zoko URLs for sub + hsub + dub
    await test("GET /api/stream/ronin-of-the-neon-ward/1 returns spec-compliant Zoko URLs (MAL 21)", async () => {
      const res = await fetch(`${baseUrl}/api/stream/ronin-of-the-neon-ward/1`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.equal(data.malId, 21);
      assert.ok(data.streams);
      assert.equal(
        data.streams.zokoSub,
        "https://zokoanime.video/stream/mal/21/1/sub?color=cae962&autoplay=1&autoskip=1&autonext=1"
      );
      assert.equal(
        data.streams.zokoHsub,
        "https://zokoanime.video/stream/mal/21/1/hsub?color=cae962&autoplay=1&autoskip=1&autonext=1"
      );
      assert.equal(
        data.streams.zokoDub,
        "https://zokoanime.video/stream/mal/21/1/dub?color=cae962&autoplay=1&autoskip=1&autonext=1"
      );
    });

    // 3. /api/stream for a title with NO mapped id returns HTTP 400
    await test("GET /api/stream for a title with NO mapped id returns HTTP 400", async () => {
      // Insert a temporary test title with no MAL or AniList id
      db.prepare(`
        INSERT OR REPLACE INTO titles (slug, name, kind, year, episodes, runtime_min, mal_id, anilist_id, created_at)
        VALUES ('no-id-test-anime', 'No ID Anime', 'Series', 2026, 12, 24, NULL, NULL, datetime('now'))
      `).run();

      const res = await fetch(`${baseUrl}/api/stream/no-id-test-anime/1`);
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.ok, false);
      assert.equal(data.error, "No MAL/AniList id mapped for this title.");

      // Clean up temporary title
      db.prepare("DELETE FROM titles WHERE slug = 'no-id-test-anime'").run();
    });

    // 4. /api/stream for an unknown slug returns HTTP 404
    await test("GET /api/stream for unknown slug returns HTTP 404", async () => {
      const res = await fetch(`${baseUrl}/api/stream/non-existent-anime-xyz/1`);
      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.ok, false);
    });

    // 5. /api/stream supports ?mal_id= query override
    await test("GET /api/stream supports ?mal_id= query override", async () => {
      const res = await fetch(`${baseUrl}/api/stream/ronin-of-the-neon-ward/1?mal_id=9999`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.equal(data.malId, 9999);
      assert.ok(data.streams.zokoSub.includes("/stream/mal/9999/1/sub?"));
    });

    // 6. titleView returns null when row has no mal_id (Task 8 fix)
    await test("GET /api/titles/:slug returns malId: null when title has no id", async () => {
      db.prepare(`
        INSERT OR REPLACE INTO titles (slug, name, kind, year, episodes, runtime_min, mal_id, anilist_id, created_at)
        VALUES ('null-id-test', 'Null ID Anime', 'Series', 2026, 12, 24, NULL, NULL, datetime('now'))
      `).run();

      const res = await fetch(`${baseUrl}/api/titles/null-id-test`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.equal(data.title.malId, null);
      assert.equal(data.title.anilistId, null);

      db.prepare("DELETE FROM titles WHERE slug = 'null-id-test'").run();
    });

    // 7. Search matches REAL titles only — the fictional placeholder names
    //    (old_title) must not match ("Ronin" used to return One Piece).
    await test("GET /api/titles?q=ronin does not match old fictional titles", async () => {
      const res = await fetch(`${baseUrl}/api/titles?q=ronin&limit=10`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.equal(data.titles.length, 0, `Expected no results for "ronin", got: ${data.titles.map((t) => t.name).join(", ")}`);
    });

    // 8. Search still finds real titles (english + romaji).
    await test("GET /api/titles?q=solo finds Solo Leveling by real title", async () => {
      const res = await fetch(`${baseUrl}/api/titles?q=solo&limit=10`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.titles.some((t) => t.slug === "second-wind"), "Solo Leveling (second-wind) must match 'solo'");
    });

    // 9. Dub availability for a title with no MAL id is false without any
    //    network probe (the watch page uses this to gate the Dub pill).
    await test("GET /api/dub-availability for a no-id title returns available:false", async () => {
      db.prepare(`
        INSERT OR REPLACE INTO titles (slug, name, kind, year, episodes, runtime_min, mal_id, anilist_id, created_at)
        VALUES ('dub-no-id-test', 'Dub No ID Anime', 'Series', 2026, 12, 24, NULL, NULL, datetime('now'))
      `).run();
      const res = await fetch(`${baseUrl}/api/dub-availability/dub-no-id-test/1`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.equal(data.available, false);
      assert.equal(data.reason, "no-mal-id");
      db.prepare("DELETE FROM titles WHERE slug = 'dub-no-id-test'").run();
    });

    // 10. Episode titles are per-title real data, not one shared pool: Solo
    //     Leveling must not show Jujutsu Kaisen names, and titles are distinct.
    await test("Solo Leveling episode titles are real and distinct (no JJK pool)", async () => {
      const res = await fetch(`${baseUrl}/api/titles/second-wind`);
      assert.equal(res.status, 200);
      const data = await res.json();
      const eps = data.episodes;
      assert.ok(eps.length >= 12, "Solo Leveling has 12 seeded episodes");
      assert.ok(!/sukuna/i.test(eps[0].title), `ep1 must not be a JJK title, got: ${eps[0].title}`);
      assert.ok(!/^Episode \d+$/.test(eps[0].title), `ep1 should be a real title, got: ${eps[0].title}`);
      const titles = eps.map((e) => e.title);
      assert.equal(new Set(titles).size, titles.length, "episode titles must be distinct");

      // The watch page seeds its per-episode dub cache from this same payload
      // (probe-backed dub_checks rows) — both lists must always be arrays,
      // even when no probe has run yet (fresh test DB).
      assert.ok(Array.isArray(data.dubEpisodes), "dubEpisodes must be an array");
      assert.ok(Array.isArray(data.noDubEpisodes), "noDubEpisodes must be an array");
    });

    /* ======================================================================
       LIVE CATALOG (AniList) — mocked, offline, deterministic
       ====================================================================== */

    // 11. /api/search returns the CATALOG entry first and never shows the
    //     same title twice (dedupe by MAL id).
    await test("GET /api/search puts the catalog entry first and dedupes by MAL id", async () => {
      mockAniList({
        mediaList: [
          // Naruto (mal 20) IS in the curated catalog -> catalog entry only.
          fakeMedia({
            id: 20, idMal: 20,
            title: { romaji: "NARUTO", english: "Naruto", native: "ナルト" },
            episodes: 220, status: "FINISHED", genres: ["Action", "Adventure"],
          }),
          fakeMedia({
            id: 700, idMal: 700,
            title: { romaji: "Naruto Shippuden", english: "Naruto Shippuden", native: null },
          }),
        ],
      });

      const res = await fetch(`${baseUrl}/api/search?q=Naruto`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.equal(data.local.length, 1, "the catalog Naruto must be the local match");
      assert.equal(data.local[0].slug, "sea-of-stars");
      assert.equal(
        data.results.some((t) => t.malId === 20),
        false,
        "the live Naruto row must be dropped (dedupe by MAL id)"
      );
      assert.ok(
        data.results.some((t) => t.malId === 700),
        "other live Naruto results must still be listed"
      );
      resetAniListMock();
    });

    // 12. /api/search marks mature-but-not-hentai titles with is18plus.
    await test("GET /api/search marks Ecchi titles with is18plus", async () => {
      mockAniList({
        mediaList: [
          fakeMedia({
            id: 11617, idMal: 11617,
            title: { romaji: "High School DxD", english: "High School DxD", native: null },
            genres: ["Action", "Comedy", "Ecchi", "Fantasy", "Romance"],
          }),
        ],
      });
      const res = await fetch(`${baseUrl}/api/search?q=High School DxD`);
      const data = await res.json();
      assert.equal(data.results.length, 1);
      assert.equal(data.results[0].is18plus, true, "Ecchi genre must set is18plus");
      resetAniListMock();
    });

    // 13. Adult titles never reach the client: neither the AniList flag nor
    //     a hentai title in the name.
    await test("GET /api/search hides adult titles (flag and hentai title)", async () => {
      mockAniList({
        mediaList: [
          fakeMedia({ id: 1, idMal: 1, isAdult: true, title: { romaji: "Adult", english: "Adult", native: null } }),
          fakeMedia({ id: 2, idMal: 2, title: { romaji: "Hentai Prince", english: "Hentai Prince", native: null } }),
          fakeMedia({ id: 3, idMal: 3, title: { romaji: "Clean Show", english: "Clean Show", native: null } }),
        ],
      });
      const res = await fetch(`${baseUrl}/api/search?q=hentai`);
      const data = await res.json();
      const names = data.results.map((t) => t.name);
      assert.equal(names.includes("Adult"), false, "isAdult titles must be hidden");
      assert.equal(names.includes("Hentai Prince"), false, "hentai titles must be hidden");
      assert.ok(names.includes("Clean Show"), "clean titles must still be listed");
      resetAniListMock();
    });

    // 14. /api/browse maps the sort + filter args onto AniList's own args.
    await test("GET /api/browse maps sort and filters to AniList args", async () => {
      mockAniList({ mediaList: [fakeMedia()] });
      const res = await fetch(`${baseUrl}/api/browse?sort=top&genre=action&format=movie&status=airing&year=2024&page=2`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.equal(data.results.length, 1);
      assert.equal(data.page, 2);

      const query = anilistRequests[0].query;
      assert.ok(query.includes("sort: SCORE_DESC"), "sort=top must map to SCORE_DESC");
      assert.ok(query.includes("genre_in: $genre"), "genre must map to genre_in");
      assert.ok(query.includes("format_in: $format"), "format must map to format_in");
      assert.ok(query.includes("status_in: $status"), "status must map to status_in");
      assert.ok(query.includes("seasonYear: $year"), "year must map to seasonYear");
      assert.ok(query.includes("isAdult: false"), "every query must exclude adult titles");

      const vars = anilistRequests[0].variables;
      assert.deepEqual(vars.genre, ["Action"], "genre names must be canonicalised");
      assert.deepEqual(vars.format, ["MOVIE"], "format names must be canonicalised");
      assert.deepEqual(vars.status, ["RELEASING"], "status names must be canonicalised");
      assert.equal(vars.year, 2024);
      assert.equal(vars.page, 2);
      assert.equal(vars.perPage, 12);
      resetAniListMock();
    });

    // 15. A live title that IS a catalog title links to the catalog page.
    await test("GET /api/browse flags catalog titles with their catalog slug", async () => {
      mockAniList({
        mediaList: [
          fakeMedia({
            id: 21, idMal: 21,
            title: { romaji: "ONE PIECE", english: "ONE PIECE", native: null },
            episodes: 1180,
          }),
          fakeMedia({ id: 555, idMal: 555 }),
        ],
      });
      const res = await fetch(`${baseUrl}/api/browse?sort=popular`);
      const data = await res.json();
      const onePiece = data.results.find((t) => t.malId === 21);
      const other = data.results.find((t) => t.malId === 555);
      assert.equal(onePiece.catalogSlug, "ronin-of-the-neon-ward");
      assert.equal(other.catalogSlug, undefined, "a non-catalog title has no catalog slug");
      resetAniListMock();
    });

    // 16. /api/airing returns recently aired episodes and skips adult media.
    await test("GET /api/airing returns aired episodes and skips adult media", async () => {
      mockAniList({
        airing: [
          { airingAt: 1700000000, episode: 5, media: fakeMedia({ id: 10, idMal: 10 }) },
          { airingAt: 1700000100, episode: 1, media: fakeMedia({ id: 11, idMal: 11, isAdult: true }) },
        ],
      });
      const res = await fetch(`${baseUrl}/api/airing`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.results.length, 1, "adult media must be skipped");
      assert.equal(data.results[0].episode, 5);
      assert.equal(data.results[0].media.name, "Mock Anime");
      assert.equal(data.results[0].media.is18plus, false);
      resetAniListMock();
    });

    // 17. A direct link to an adult title is 404, not the title.
    await test("GET /api/live/:id returns 404 not_available for an adult title", async () => {
      mockAniList({ mediaById: {} });
      const res = await fetch(`${baseUrl}/api/live/12345`);
      assert.equal(res.status, 404);
      const data = await res.json();
      assert.equal(data.ok, false);
      assert.equal(data.error, "not_available");
      resetAniListMock();
    });

    // 18. A live title carries the server-computed 18+ flag.
    await test("GET /api/live/:id returns the title with its is18plus flag", async () => {
      mockAniList({
        mediaById: {
          11617: fakeMedia({
            id: 11617, idMal: 11617,
            title: { romaji: "High School DxD", english: "High School DxD", native: null },
            genres: ["Action", "Ecchi"],
          }),
        },
      });
      const res = await fetch(`${baseUrl}/api/live/11617`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.title.name, "High School DxD");
      assert.equal(data.title.is18plus, true);
      assert.equal(data.title.malId, 11617);
      resetAniListMock();
    });

    // 19. AniList down -> HTTP 502 search_busy (never a stack trace, never a
    //     500 that would break the page).
    await test("GET /api/browse returns 502 search_busy when AniList fails", async () => {
      mockAniList({ fail: true });
      const res = await fetch(`${baseUrl}/api/browse?sort=trending`);
      assert.equal(res.status, 502);
      const data = await res.json();
      assert.equal(data.ok, false);
      assert.equal(data.error, "search_busy");
      resetAniListMock();
    });

    // 20. The local catalog still answers while AniList is down.
    await test("GET /api/titles still works while AniList is down", async () => {
      mockAniList({ fail: true });
      const res = await fetch(`${baseUrl}/api/titles?q=solo&limit=10`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.titles.some((t) => t.slug === "second-wind"));
      resetAniListMock();
    });

    // 21. Audit-6 B4: concurrent cold-cache searches for ONE query must all
    //     share a single snapshot build (in-flight dedup). The mock answers
    //     every request with a DIFFERENT id set (SEARCH_MATCH is
    //     non-deterministic) after a delay, so without dedup each caller
    //     would build its own snapshot and get different results.
    await test("concurrent searchSnapshot calls share one snapshot (in-flight dedup)", async () => {
      clearAniListCache();
      anilistRequests.length = 0;
      let n = 0;
      anilistResponder = async () => {
        n++;
        const seq = n;
        await new Promise((r) => setTimeout(r, 60));
        return jsonResponse({
          data: {
            Page: {
              pageInfo: MOCK_PAGE_INFO,
              media: [
                fakeMedia({ id: seq * 100 + 1, idMal: seq * 100 + 1, title: { romaji: `Race ${seq} A`, english: `Race ${seq} A`, native: null } }),
                fakeMedia({ id: seq * 100 + 2, idMal: seq * 100 + 2, title: { romaji: `Race ${seq} B`, english: `Race ${seq} B`, native: null } }),
              ],
            },
          },
        });
      };
      const { searchAniList } = await import("../src/anilist.js");
      const results = await Promise.all(
        Array.from({ length: 5 }, () => searchAniList("race-unique-query"))
      );
      const idSets = results.map((r) => r.items.map((t) => t.anilistId).join(","));
      assert.equal(new Set(idSets).size, 1, "every concurrent caller must get the SAME result set");
      for (const r of results) assert.equal(r.total, r.items.length, "total is the snapshot count");
      assert.equal(anilistRequests.length, 3, "one build = 3 page fetches, not 5 builds x 3 pages");
      resetAniListMock();
    });

    // 22. Audit-6 B4: when ALL 3 snapshot pages fail, /api/search answers
    //     502 search_busy and caches NOTHING — an empty set must never be
    //     cached as a real "no results" for 30 minutes.
    await test("GET /api/search answers 502 when all snapshot pages fail and caches nothing", async () => {
      mockAniList({ fail: true });
      const res = await fetch(`${baseUrl}/api/search?q=all-pages-fail`);
      assert.equal(res.status, 502);
      const data = await res.json();
      assert.equal(data.ok, false);
      assert.equal(data.error, "search_busy");
      /* AniList recovers: the SAME query must now return real results —
         proof the failed build did not cache an empty snapshot. */
      mockAniList({ mediaList: [fakeMedia({ id: 987654, idMal: 987654 })] });
      const res2 = await fetch(`${baseUrl}/api/search?q=all-pages-fail`);
      assert.equal(res2.status, 200);
      const data2 = await res2.json();
      assert.equal(data2.pageInfo.total, 1);
      assert.equal(data2.results[0].anilistId, 987654);
      resetAniListMock();
    });

    // 23. A GENUINELY empty result (pages succeeded, zero matches) is still
    //     cached — the dedup/busy fix must not break real "no results".
    await test("a genuinely empty search result is still cached", async () => {
      mockAniList({ mediaList: [] });
      const res = await fetch(`${baseUrl}/api/search?q=definitely-no-match-xyz`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.pageInfo.total, 0);
      const afterFirst = anilistRequests.length;
      assert.equal(afterFirst, 3, "one snapshot build = 3 page fetches");
      const res2 = await fetch(`${baseUrl}/api/search?q=definitely-no-match-xyz`);
      assert.equal(res2.status, 200);
      const data2 = await res2.json();
      assert.equal(data2.pageInfo.total, 0);
      assert.equal(anilistRequests.length, afterFirst, "the empty-but-real snapshot is served from cache");
      resetAniListMock();
    });

    /* ======================================================================
       BROWSE BY YEAR (full library navigation)
       AniList caps a single query's total at 5,000 titles, so the whole
       catalog is reachable only one year at a time. These tests run against
       the SHIPPED frontend logic: server/test/e2e.js extracts the marked
       pure-function blocks out of ani-verse/js/zoro-aizen.js and evaluates
       them directly (no DOM needed, no per-year API calls).
       ====================================================================== */

    // 24. ?year=1998 reaches AniList as seasonYear: 1998 and the route hands
    //     back the server's own pageInfo (the exact total a year view shows).
    await test("GET /api/browse?year=1998 filters AniList by seasonYear 1998", async () => {
      mockAniList({
        mediaList: [
          fakeMedia({
            id: 199801,
            idMal: 199801,
            seasonYear: 1998,
            startDate: { year: 1998, month: 10, day: 1 },
          }),
        ],
      });
      const res = await fetch(`${baseUrl}/api/browse?year=1998`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true);

      const request = anilistRequests[0];
      assert.ok(request.query.includes("seasonYear: $year"), "year must map to seasonYear");
      assert.equal(request.variables.year, 1998);
      assert.ok(request.query.includes("isAdult: false"), "every query must exclude adult titles");
      assert.deepEqual(data.pageInfo, MOCK_PAGE_INFO, "the route returns AniList's pageInfo verbatim");
      resetAniListMock();
    });

    // 25. The dropdown/chip year range covers 1960 (anime's TV era, AniList's
    //     earliest titles) through current year + 1, contiguously.
    await test("browse year range covers 1960 through current year + 1", () => {
      const { BROWSE_YEAR_MIN, browseYearRange, browseDecadeOf } = evalZoroBlock("BROWSE_YEAR_LOGIC", [
        "BROWSE_YEAR_MIN",
        "browseYearRange",
        "browseDecadeOf",
      ]);
      assert.equal(BROWSE_YEAR_MIN, 1960);
      const now = new Date();
      const years = browseYearRange(now);
      assert.equal(years[0], now.getFullYear() + 1, "range must start at next year");
      assert.equal(years[years.length - 1], 1960, "range must end at 1960");
      assert.ok(years.length > 60, `range should span the whole catalog, got ${years.length} years`);
      for (let i = 1; i < years.length; i++) {
        assert.equal(years[i], years[i - 1] - 1, "years must be contiguous and descending");
      }
      assert.equal(new Set(years).size, years.length, "no duplicate years");
      assert.equal(browseDecadeOf(1998), 1990, "decade grouping drives the chip rows");
      assert.equal(browseDecadeOf(2027), 2020);
    });

    // 26. A year view is always under the 5,000 cap, so its heading shows the
    //     EXACT total and its paginator a real last page — no "5,000+" and no
    //     "+" floor mark. Unfiltered Browse keeps the capped treatment.
    await test("year views show exact totals and a real last page", () => {
      const { browseCountLabel, browsePaginationBounds } = evalZoroBlock("BROWSE_LABEL_LOGIC", [
        "browseCountLabel",
        "browsePaginationBounds",
      ]);
      const samples = [
        { year: 2025, total: 312, lastPage: 26 },
        { year: 2010, total: 587, lastPage: 49 },
        { year: 1998, total: 143, lastPage: 12 },
        { year: 1975, total: 41, lastPage: 4 },
      ];
      for (const sample of samples) {
        const pageInfo = { total: sample.total, currentPage: 1, lastPage: sample.lastPage, hasNextPage: true };
        const label = browseCountLabel(pageInfo, 12, false);
        assert.equal(label, `${sample.total} titles`, `year ${sample.year} must show its exact total`);
        assert.ok(!label.includes("+"), `year ${sample.year} must not show a capped/floor label`);
        const bounds = browsePaginationBounds(true, pageInfo, 1);
        assert.equal(bounds.bounded, false, `year ${sample.year} knows its own end`);
        assert.equal(bounds.last, sample.lastPage, `year ${sample.year} last page must be exact`);
      }

      /* Unfiltered Browse: unchanged — capped total, real (floor) last page. */
      const unfilteredCapped = { total: 5000, currentPage: 1, lastPage: 416, hasNextPage: true };
      assert.equal(browseCountLabel(unfilteredCapped, 12, false), "5,000+ titles");
      assert.equal(browsePaginationBounds(false, unfilteredCapped, 1).bounded, false);
      assert.equal(browsePaginationBounds(false, unfilteredCapped, 1).last, 416);

      /* The one regime that keeps the "+" floor: capped AND filtered. */
      const bounded = browsePaginationBounds(true, unfilteredCapped, 1);
      assert.equal(bounded.bounded, true);
      assert.equal(bounded.last, 2, "a capped filtered view windows around the current page");
    });

    /* ======================================================================
       SERVER-SIDE YEAR COUNTING (the fix for capped totals)
       AniList caps pageInfo.total at 5,000 / lastPage 416 for ANY multi-page
       browse query, so a small year showed "5,000+ titles" / "Page 1 of 416+".
       The server now counts the year's titles itself and returns the real
       pageInfo. These tests mock AniList to reproduce the cap.
       ====================================================================== */

    // 27. A year with a known count: 3 full pages of 50 + 7 = 157 titles ->
    //     exact total, real last page, real hasNextPage. The count pages use
    //     perPage 50, no sort, isAdult: false; the grid keeps its own page.
    await test("GET /api/browse?year=1998 counts the year server-side (157 titles)", async () => {
      const all = Array.from({ length: 157 }, (_, i) =>
        fakeMedia({
          id: 400000 + i,
          idMal: 400000 + i,
          seasonYear: 1998,
          startDate: { year: 1998, month: 1, day: 1 },
        })
      );
      mockAniList({ allMedia: all });
      const res = await fetch(`${baseUrl}/api/browse?year=1998`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.deepEqual(
        data.pageInfo,
        { total: 157, currentPage: 1, lastPage: 14, hasNextPage: true },
        "year view must show the real count and a real last page"
      );

      /* Count queries: perPage 50, no sort, adult screen still on, same year. */
      const countQueries = anilistRequests.filter((r) => r.variables.perPage === 50);
      assert.equal(countQueries.length, 4, "157 titles = 4 count pages (50 x 3 + 7)");
      for (const q of countQueries) {
        assert.ok(q.query.includes("seasonYear: $year"), "count keeps the year filter");
        assert.ok(q.query.includes("isAdult: false"), "count keeps the adult filter");
        assert.ok(!/sort:/.test(q.query), "count does not need a sort");
        assert.equal(q.variables.year, 1998);
      }
      resetAniListMock();
    });

    // 28. Non-year views keep AniList's capped pageInfo verbatim — the fix
    //     must not count (or change anything) outside year views.
    await test("non-year browse keeps the capped pageInfo (no counting)", async () => {
      mockAniList({ mediaList: [fakeMedia()] });
      const res = await fetch(`${baseUrl}/api/browse?sort=trending&genre=action`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.deepEqual(data.pageInfo, MOCK_PAGE_INFO, "unfiltered/genre browse is unchanged");
      assert.ok(
        anilistRequests.every((r) => r.variables.perPage === 12),
        "no count query may run for a non-year view"
      );
      resetAniListMock();
    });

    // 28b. Counts are keyed by the whole filter set — a year with a genre is a
    //      DIFFERENT cache entry from the bare year, so counts never cross
    //      between filter combinations. The key is also order-insensitive.
    await test("year-count cache keys on year + genre + format + status", async () => {
      const { yearCountKey } = await import("../src/anilist.js");
      assert.notEqual(
        yearCountKey(1998, ["Action"], [], []),
        yearCountKey(1998, [], [], []),
        "a genre filter must change the count key"
      );
      assert.notEqual(
        yearCountKey(1998, [], [], []),
        yearCountKey(1999, [], [], []),
        "a different year must change the count key"
      );
      assert.equal(
        yearCountKey(1998, ["Action", "Comedy"], [], []),
        yearCountKey(1998, ["Comedy", "Action"], [], []),
        "genre order must not change the count key"
      );

      /* Two different years must not share a cached count: each counts its
         own set (2 vs 50), proving the key isolates them end to end. */
      mockAniList({ allMedia: Array.from({ length: 2 }, (_, i) => fakeMedia({ id: 550000 + i, idMal: 550000 + i })) });
      const resA = await (await fetch(`${baseUrl}/api/browse?year=1960`)).json();
      assert.equal(resA.pageInfo.total, 2);
      resetAniListMock();
      mockAniList({ allMedia: Array.from({ length: 50 }, (_, i) => fakeMedia({ id: 560000 + i, idMal: 560000 + i })) });
      const resB = await (await fetch(`${baseUrl}/api/browse?year=1961`)).json();
      assert.equal(resB.pageInfo.total, 50);
      resetAniListMock();
    });

    // 29. A year whose reported total is under the cap needs no counting: the
    //     real pageInfo passes through untouched.
    await test("a single-page year keeps its real pageInfo without counting", async () => {
      mockAniList({
        allMedia: Array.from({ length: 2 }, (_, i) => fakeMedia({ id: 500000 + i, idMal: 500000 + i })),
      });
      const res = await fetch(`${baseUrl}/api/browse?year=1960`);
      const data = await res.json();
      assert.deepEqual(
        data.pageInfo,
        { total: 2, currentPage: 1, lastPage: 1, hasNextPage: false },
        "a single-page year already had a real total"
      );
      assert.ok(
        anilistRequests.every((r) => r.variables.perPage === 12),
        "no count query when AniList's total is not capped"
      );
      resetAniListMock();
    });

    // 30. Paging cap: a count that never sees a short page stops after 40
    //     pages and falls back to the capped pageInfo (5,000 / 416).
    await test("a count hitting the paging cap falls back to the capped pageInfo", async () => {
      mockAniList({ alwaysFull: true });
      const res = await fetch(`${baseUrl}/api/browse?year=2025`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.deepEqual(
        data.pageInfo,
        { total: 5000, currentPage: 1, lastPage: 416, hasNextPage: true },
        "cap hit -> capped pageInfo, never a partial count"
      );
      const countPages = anilistRequests.filter((r) => r.variables.perPage === 50);
      assert.equal(countPages.length, 40, "count must stop after 40 pages");
      resetAniListMock();
    });

    // 31. Cache: a second identical year request makes NO new AniList calls.
    await test("the year count is cached (second identical request makes no AniList calls)", async () => {
      const all = Array.from({ length: 80 }, (_, i) => fakeMedia({ id: 600000 + i, idMal: 600000 + i }));
      mockAniList({ allMedia: all });
      const first = await fetch(`${baseUrl}/api/browse?year=1999`);
      assert.equal(first.status, 200);
      const afterFirst = anilistRequests.length;
      assert.ok(afterFirst > 0);
      const second = await fetch(`${baseUrl}/api/browse?year=1999`);
      assert.equal(second.status, 200);
      const data2 = await second.json();
      assert.equal(data2.pageInfo.total, 80);
      assert.equal(anilistRequests.length, afterFirst, "cache hit must not re-fetch");
      resetAniListMock();
    });

    // 32. In-flight dedup: concurrent cold-cache year requests share ONE
    //     count (assert the number of AniList fetches).
    await test("concurrent year-count requests share one count (in-flight dedup)", async () => {
      const all = Array.from({ length: 120 }, (_, i) => fakeMedia({ id: 700000 + i, idMal: 700000 + i }));
      mockAniList({ allMedia: all });
      /* Delay count pages so the 5 builds genuinely overlap — without dedup
         each of the 5 callers would run its OWN count (5 builds x N pages). */
      const originalResponder = anilistResponder;
      anilistResponder = async (body) => {
        if (Number((body && body.variables || {}).perPage) === 50) {
          await new Promise((r) => setTimeout(r, 80));
        }
        return originalResponder(body);
      };
      const results = await Promise.all(
        Array.from({ length: 5 }, () => fetch(`${baseUrl}/api/browse?year=1997`).then((r) => r.json()))
      );
      for (const data of results) {
        assert.equal(data.pageInfo.total, 120, "every caller gets the same real count");
        assert.equal(data.pageInfo.lastPage, 10);
      }
      /* The 5 requests share ONE identical grid query, so anilistQuery's own
         cache serves it once; only the count paging (perPage 50) is shared by
         the year-count dedup — 3 pages for 120 titles, once. */
      const countFetches = anilistRequests.filter((r) => r.variables.perPage === 50);
      assert.equal(countFetches.length, 3, "one shared count = 3 count fetches, not 5 builds x 3");
      assert.equal(anilistRequests.length, 4, "1 shared grid fetch + 3 shared count fetches");
      resetAniListMock();
    });

    // 33. An AniList failure mid-count must NOT fail the browse request and
    //     must NOT cache a failed/partial count: the grid still renders and
    //     pageInfo falls back to the capped values.
    await test("a count failure falls back to the capped pageInfo and caches nothing", async () => {
      const all = Array.from({ length: 120 }, (_, i) => fakeMedia({ id: 800000 + i, idMal: 800000 + i }));
      mockAniList({ allMedia: all });
      const originalResponder = anilistResponder;
      /* Fail ONLY the count paging (perPage 50) after its first page; the
         grid query (perPage 12) keeps answering so results still render. */
      anilistResponder = async (body) => {
        const variables = (body && body.variables) || {};
        if (variables.perPage === 50 && variables.page >= 2) {
          return jsonResponse({ errors: [{ message: "Upstream boom", status: 500 }] }, 500);
        }
        return originalResponder(body);
      };
      const res = await fetch(`${baseUrl}/api/browse?year=1996`);
      assert.equal(res.status, 200, "a mid-count failure must not 502 the browse request");
      const data = await res.json();
      assert.ok(data.results.length > 0, "grid results still render");
      assert.equal(data.pageInfo.total, 5000, "falls back to the capped total");
      assert.equal(data.pageInfo.lastPage, 416);
      resetAniListMock();

      /* AniList recovers: the same year must now count normally — proof the
         failed count was not cached as a value. */
      mockAniList({ allMedia: all });
      const res2 = await fetch(`${baseUrl}/api/browse?year=1996`);
      assert.equal(res2.status, 200);
      const data2 = await res2.json();
      assert.equal(data2.pageInfo.total, 120, "a recovered count is computed, not served from a bad cache");
      resetAniListMock();
    });

    /* ======================================================================
       PHASE 2 — A-Z LIST (/api/az)
       AniList has no prefix search, so a letter is served from a
       SEARCH_MATCH snapshot filtered server-side by title prefix. The mock
       answers the A-Z snapshot pages with a pool whose titles straddle the
       letter boundary, so the prefix filter is observable.
       ====================================================================== */

    // 34. /api/az letter filtering: only titles whose romaji OR english name
    //     STARTS with the letter are returned, de-duplicated, adult-screened.
    await test("GET /api/az filters a letter by title prefix", async () => {
      clearAniListCache();
      anilistRequests.length = 0;
      anilistResponder = async (body) => {
        const vars = body.variables || {};
        /* Pages 1..10, 50 per page. Each page carries the SAME candidate pool
           (the mock's "search" is the letter itself), so a title repeated
           across pages exercises the de-dupe too. */
        const pool = [
          fakeMedia({ id: 900010, idMal: 900010, title: { romaji: "A Certain Magical Index", english: "A Certain Magical Index", native: null } }),
          fakeMedia({ id: 900011, idMal: 900011, title: { romaji: "Attack on Titan", english: "Attack on Titan", native: null } }),
          /* English title starts with A but romaji does not -> still a match. */
          fakeMedia({ id: 900012, idMal: 900012, title: { romaji: "Shingeki no Kyojin", english: "Attack on Titan", native: null } }),
          /* Romaji starts with A but english does not -> still a match. */
          fakeMedia({ id: 900013, idMal: 900013, title: { romaji: "Akame ga Kill", english: null, native: null } }),
          /* Starts with a different letter -> must be dropped. */
          fakeMedia({ id: 900014, idMal: 900014, title: { romaji: "Naruto", english: "Naruto", native: null } }),
          /* An "A" word, not a prefix -> must be dropped. */
          fakeMedia({ id: 900015, idMal: 900015, title: { romaji: "My Hero Academia", english: "My Hero Academia", native: null } }),
          /* Adult title starting with A -> must be dropped. */
          fakeMedia({ id: 900016, idMal: 900016, isAdult: true, title: { romaji: "Adult A", english: "Adult A", native: null } }),
        ];
        return jsonResponse({
          data: {
            Page: {
              pageInfo: { total: pool.length, lastPage: 1 },
              media: pool,
            },
          },
        });
      };

      const res = await fetch(`${baseUrl}/api/az?letter=A`);
      assert.equal(res.status, 200);
      const data = await res.json();
      const ids = data.results.map((t) => t.anilistId).sort();
      assert.deepEqual(ids, [900010, 900011, 900012, 900013], "only prefix matches, de-duplicated and adult-screened");
      assert.equal(data.letter, "A");
      assert.equal(data.pageInfo.total, 4, "total is the filtered snapshot count");
      resetAniListMock();
    });

    // 35. /api/az pagination slices the ONE immutable snapshot: page 2 is the
    //     second 12-title slice, and a page past the end clamps to the last.
    await test("GET /api/az paginates the letter snapshot", async () => {
      clearAniListCache();
      anilistRequests.length = 0;
      /* 25 titles, all "B…" -> 3 pages of 12. */
      const pool = Array.from({ length: 25 }, (_, i) =>
        fakeMedia({
          id: 910000 + i,
          idMal: 910000 + i,
          title: { romaji: `B Title ${i}`, english: `B Title ${i}`, native: null },
        })
      );
      anilistResponder = async () =>
        jsonResponse({ data: { Page: { pageInfo: { total: pool.length, lastPage: 1 }, media: pool } } });

      const page1 = await (await fetch(`${baseUrl}/api/az?letter=B&page=1`)).json();
      assert.equal(page1.results.length, 12);
      assert.equal(page1.pageInfo.total, 25);
      assert.equal(page1.pageInfo.lastPage, 3);
      assert.equal(page1.pageInfo.hasNextPage, true);
      assert.equal(page1.results[0].anilistId, 910000);
      assert.equal(page1.results[11].anilistId, 910011);

      const page2 = await (await fetch(`${baseUrl}/api/az?letter=B&page=2`)).json();
      assert.equal(page2.page, 2);
      assert.equal(page2.results[0].anilistId, 910012, "page 2 continues the same snapshot");
      assert.equal(page2.results.length, 12);

      const page3 = await (await fetch(`${baseUrl}/api/az?letter=B&page=3`)).json();
      assert.equal(page3.results.length, 1, "the last page holds the remainder");
      assert.equal(page3.pageInfo.hasNextPage, false);

      /* A page past the end clamps to the last page rather than answering
         an empty page or an error. */
      const page99 = await (await fetch(`${baseUrl}/api/az?letter=B&page=99`)).json();
      assert.equal(page99.page, 3);
      assert.equal(page99.results.length, 1);
      resetAniListMock();
    });

    // 36. The capped flag: a snapshot that fills the 10th fetch page is
    //     partial, so pageInfo.capped is true and the total is a floor.
    await test("GET /api/az flags a capped snapshot and keeps the total a floor", async () => {
      clearAniListCache();
      anilistRequests.length = 0;
      /* Every one of the 10 pages comes back FULL (50 rows) -> the fetch cap
         was reached, the pool is partial. */
      anilistResponder = async () =>
        jsonResponse({
          data: {
            Page: {
              pageInfo: { total: 5000, lastPage: 10 },
              media: Array.from({ length: 50 }, (_, i) =>
                fakeMedia({
                  id: 920000 + i,
                  idMal: 920000 + i,
                  title: { romaji: `C Title ${i}`, english: `C Title ${i}`, native: null },
                })
              ),
            },
          },
        });
      const data = await (await fetch(`${baseUrl}/api/az?letter=C`)).json();
      assert.equal(data.pageInfo.capped, true, "a full 10th page means the cap was hit");
      /* The same 50 ids repeat on every one of the 10 pages, so the filtered,
         de-duplicated snapshot holds 50 titles. That is the FLOOR the UI
         labels with a "+" — the true count is larger but unreachable. */
      assert.equal(data.pageInfo.total, 50, "the total is the de-duplicated snapshot count — a floor, not a real count");
      assert.ok(data.results.length <= 12);

      /* A SHORT last page (the snapshot's real end) is not capped. */
      clearAniListCache();
      anilistRequests.length = 0;
      anilistResponder = async (body) => {
        const page = Number((body.variables || {}).page) || 1;
        const media = page === 1
          ? Array.from({ length: 50 }, (_, i) => fakeMedia({ id: 930000 + i, idMal: 930000 + i, title: { romaji: `D ${i}`, english: `D ${i}`, native: null } }))
          : [fakeMedia({ id: 930099, idMal: 930099, title: { romaji: "D last", english: "D last", native: null } })];
        return jsonResponse({ data: { Page: { pageInfo: { total: 5000, lastPage: 10 }, media } } });
      };
      const data2 = await (await fetch(`${baseUrl}/api/az?letter=D`)).json();
      assert.equal(data2.pageInfo.capped, false, "a short final page means the snapshot reached its end");
      resetAniListMock();
    });

    // 37. letter=all is the plain TITLE_ROMAJI browse, and a bad letter is a
    //     400 — never a silent "all".
    await test("GET /api/az letter=all browses A-Z and rejects a bad letter", async () => {
      mockAniList({ mediaList: [fakeMedia({ id: 940001, idMal: 940001, title: { romaji: "All", english: "All", native: null } })] });
      const all = await (await fetch(`${baseUrl}/api/az?letter=all`)).json();
      assert.equal(all.letter, "all");
      assert.ok(anilistRequests[0].query.includes("sort: TITLE_ROMAJI"), "letter=all is the A-Z browse");
      resetAniListMock();

      mockAniList({ mediaList: [fakeMedia()] });
      const bad = await fetch(`${baseUrl}/api/az?letter=AB`);
      assert.equal(bad.status, 400);
      assert.equal((await bad.json()).error, "bad_letter");
      resetAniListMock();
    });

    /* ======================================================================
       PHASE 2 — FULL BROWSE FILTERS + NEW SORT KEYS
       ====================================================================== */

    // 38. Score / season / tag / date filters reach AniList as the right
    //     variables, and the four new sort keys map to AniList sorts.
    await test("GET /api/browse maps the Phase 2 filters and sort keys to AniList", async () => {
      const { normalizeBrowseArgs, BROWSE_SORTS } = await import("../src/anilist.js");

      /* Sort keys. */
      assert.equal(BROWSE_SORTS.az, "TITLE_ROMAJI");
      assert.equal(BROWSE_SORTS.name, "TITLE_ROMAJI");
      assert.equal(BROWSE_SORTS.episodes, "EPISODES_DESC");
      assert.equal(BROWSE_SORTS.updated, "UPDATED_ON_DESC");
      assert.equal(BROWSE_SORTS.favourites, "FAVOURITES_DESC");

      /* Normalisation. */
      const args = normalizeBrowseArgs({
        sort: "az",
        tags: "isekai, cgdct ,CGDCT",
        season: "winter",
        minScore: "80",
        maxScore: "95",
        startAfter: "2024-01",
        startBefore: "2024-12-31",
      });
      /* Trimmed and canonicalised (isekai -> Isekai, cgdct -> CGDCT). */
      assert.deepEqual(args.tags, ["Isekai", "CGDCT", "CGDCT"], "tags are trimmed and canonicalised");
      assert.equal(args.season, "WINTER");
      assert.equal(args.minScore, 80);
      assert.equal(args.maxScore, 95);
      assert.equal(args.startAfter, 20240101, "YYYY-MM becomes a FuzzyDateInt");
      assert.equal(args.startBefore, 20241231, "YYYY-MM-DD becomes a FuzzyDateInt");

      /* An inverted score range is swapped, and a bare YYYY bound works. */
      const inverted = normalizeBrowseArgs({ minScore: "90", maxScore: "70" });
      assert.equal(inverted.minScore, 70);
      assert.equal(inverted.maxScore, 90);
      assert.equal(normalizeBrowseArgs({ startAfter: "2020" }).startAfter, 20200101);

      /* The wire query carries every filter. */
      mockAniList({ mediaList: [fakeMedia()] });
      await fetch(`${baseUrl}/api/browse?sort=episodes&tags=Isekai&season=WINTER&minScore=80&maxScore=95&startAfter=2024-01-01&startBefore=2024-12-31`);
      const request = anilistRequests[0];
      assert.ok(request.query.includes("sort: EPISODES_DESC"), "sort=episodes must map to EPISODES_DESC");
      assert.ok(request.query.includes("tag_in: $tag"), "tags must map to tag_in");
      assert.ok(request.query.includes("season: $season"), "season must map to season");
      assert.ok(request.query.includes("averageScore_greater: $minScore"), "minScore must map to averageScore_greater");
      assert.ok(request.query.includes("averageScore_lesser: $maxScore"), "maxScore must map to averageScore_lesser");
      assert.ok(request.query.includes("startDate_greater: $startAfter"), "startAfter must map to startDate_greater");
      assert.ok(request.query.includes("startDate_lesser: $startBefore"), "startBefore must map to startDate_lesser");
      assert.ok(request.query.includes("isAdult: false"), "every query must exclude adult titles");
      assert.deepEqual(request.variables.tag, ["Isekai"]);
      assert.equal(request.variables.season, "WINTER");
      assert.equal(request.variables.minScore, 80);
      assert.equal(request.variables.maxScore, 95);
      assert.equal(request.variables.startAfter, 20240101);
      assert.equal(request.variables.startBefore, 20241231);
      resetAniListMock();
    });

    /* ======================================================================
       PHASE 2 — LIVE DETAIL METADATA
       ====================================================================== */

    // 39. getLiveTitle carries studios, characters, relations and tags from
    //     ONE detail request, and adult relations are screened out.
    await test("GET /api/live/:id returns studios, characters, relations and tags", async () => {
      const detail = fakeMedia({
        id: 159042,
        idMal: 540000,
        title: { romaji: "Reincarnated as a Sword", english: "Reincarnated as a Sword", native: null },
        studios: {
          nodes: [
            { name: "Studio A", isAnimationStudio: true },
            { name: "Studio B", isAnimationStudio: true },
            /* A production (non-animation) studio must be dropped. */
            { name: "Production IG", isAnimationStudio: false },
          ],
        },
        season: "FALL",
        startDate: { year: 2022, month: 10, day: 5 },
        endDate: { year: 2022, month: 12, day: 21 },
        bannerImage: "https://s4.anilist.co/banner.jpg",
        characters: {
          edges: [
            {
              role: "MAIN",
              node: { name: { full: "Fran" }, image: { large: "https://s4.anilist.co/char1.jpg" } },
              voiceActors: [{ name: { full: "Ai Kayano" }, image: { large: "https://s4.anilist.co/va1.jpg" } }],
            },
            {
              role: "SUPPORTING",
              node: { name: { full: "Teacher" }, image: { large: "https://s4.anilist.co/char2.jpg" } },
              voiceActors: [],
            },
          ],
        },
        relations: {
          edges: [
            { relationType: "SEQUEL", node: { id: 540001, idMal: 540001, type: "ANIME", title: { romaji: "Sequel", english: "Sequel" }, coverImage: { large: "https://s4.anilist.co/rel1.jpg" }, format: "TV", status: "NOT_YET_RELEASED" } },
            { relationType: "SIDE_STORY", node: { id: 540002, idMal: 540002, type: "ANIME", title: { romaji: "Side", english: "Side" }, coverImage: { large: "https://s4.anilist.co/rel2.jpg" }, format: "OVA", status: "FINISHED" } },
            /* A manga relation must be dropped. */
            { relationType: "ADAPTATION", node: { id: 540003, idMal: 540003, type: "MANGA", title: { romaji: "Manga", english: "Manga" }, coverImage: { large: "https://s4.anilist.co/rel3.jpg" } } },
            /* An adult relation must be dropped. */
            { relationType: "CHARACTER", node: { id: 540004, idMal: 540004, isAdult: true, type: "ANIME", title: { romaji: "Adult Rel", english: "Adult Rel" }, coverImage: { large: "https://s4.anilist.co/rel4.jpg" } } },
          ],
        },
        tags: [
          { name: "Isekai", rank: 90, isMediaSpoiler: false },
          { name: "Reincarnation", rank: 80, isMediaSpoiler: false },
        ],
      });
      mockAniList({ mediaById: { 159042: detail } });

      const res = await fetch(`${baseUrl}/api/live/159042`);
      assert.equal(res.status, 200);
      const data = await res.json();
      const t = data.title;
      assert.deepEqual(t.studios, ["Studio A", "Studio B"], "animation studios only");
      assert.equal(t.characters.length, 2, "only named characters are kept");
      assert.equal(t.characters[0].name, "Fran");
      assert.equal(t.characters[0].voiceActor.name, "Ai Kayano");
      assert.equal(t.characters[1].voiceActor, null, "no Japanese VA -> null");
      assert.equal(t.season, "FALL");
      assert.deepEqual(t.startDate, { year: 2022, month: 10, day: 5 });
      assert.deepEqual(t.endDate, { year: 2022, month: 12, day: 21 });
      assert.equal(t.banner, "/api/cover?url=https%3A%2F%2Fs4.anilist.co%2Fbanner.jpg", "AniList banner is served same-origin");
      assert.equal(t.tags.length, 2);
      assert.equal(t.tags[0].name, "Isekai");

      const relationIds = t.relations.map((r) => r.anilistId);
      assert.deepEqual(relationIds, [540001, 540002], "only ANIME, non-adult relations");
      assert.equal(t.relations[0].relationType, "SEQUEL");
      assert.equal(t.relations[0].name, "Sequel");
      /* ONE request carries both the shared and the detail-only fields. */
      assert.equal(anilistRequests.length, 1, "studios/characters/relations/tags ride ONE Media query");
      assert.ok(anilistRequests[0].query.includes("characters("));
      assert.ok(anilistRequests[0].query.includes("voiceActors(language: JAPANESE)"));
      assert.ok(anilistRequests[0].query.includes("relations {"));
      assert.ok(anilistRequests[0].query.includes("bannerImage"));
      resetAniListMock();
    });

    // 40. The frontend live-detail helpers format exactly what the page shows.
    await test("live detail helpers format aired ranges, seasons and relations", () => {
      const {
        liveAiredRange,
        liveSeasonLabel,
        liveMoreSeasons,
        liveRelatedAnime,
        liveCharacters,
      } = evalZoroBlock("LIVE_DETAIL_LOGIC", [
        "liveAiredRange",
        "liveSeasonLabel",
        "liveMoreSeasons",
        "liveRelatedAnime",
        "liveCharacters",
      ]);

      assert.equal(liveAiredRange({ year: 2024, month: 1, day: 7 }, { year: 2024, month: 3, day: 31 }), "Jan 7 – Mar 31, 2024");
      assert.equal(liveAiredRange({ year: 2022, month: 10, day: 5 }, null), "Oct 5, 2022 –", "an airing title is open-ended");
      assert.equal(liveAiredRange({ year: 2022, month: 10, day: 5 }, { year: 2022, month: 12, day: 5 }), "Oct 5 – Dec 5, 2022");
      assert.equal(liveAiredRange({ year: 2020, month: 1, day: 1 }, { year: 2021, month: 1, day: 1 }), "Jan 1, 2020 – Jan 1, 2021");
      assert.equal(liveAiredRange(null, null), "");
      assert.equal(liveAiredRange({ year: 2024, month: 13, day: 1 }, null), "", "an invalid date is not rendered");

      assert.equal(liveSeasonLabel("WINTER"), "Winter");
      assert.equal(liveSeasonLabel("fall"), "Fall");
      assert.equal(liveSeasonLabel(null), null);

      const relations = [
        { relationType: "SEQUEL", anilistId: 1 },
        { relationType: "PREQUEL", anilistId: 2 },
        { relationType: "SIDE_STORY", anilistId: 3 },
        { relationType: "ADAPTATION", anilistId: 4 },
        { relationType: "SPIN_OFF", anilistId: 5 },
        { relationType: "SUMMARY", anilistId: 6 },
        { relationType: "CHARACTER", anilistId: 7 },
        { relationType: "OTHER", anilistId: 8 },
        { relationType: "PARENT", anilistId: 9 },
      ];
      assert.deepEqual(liveMoreSeasons(relations).map((r) => r.anilistId), [1, 2], "More Seasons = SEQUEL/PREQUEL only");
      assert.deepEqual(
        liveRelatedAnime(relations).map((r) => r.anilistId),
        [3, 4, 5, 6, 7, 8],
        "Related Anime excludes SEQUEL/PREQUEL and PARENT"
      );
      assert.equal(liveCharacters([1, 2, 3, 4, 5, 6, 7, 8]).length, 6, "the cast grid caps at 6");
    });

    /* ======================================================================
       PHASE 2 — TOP UPCOMING VIEW
       ====================================================================== */

    // 41. The Top Upcoming view (frontend) resolves to status NOT_YET_RELEASED
    //     + sort popular — the Top Airing pattern. The server's /api/browse
    //     view-agnostic filters are covered above; this asserts the view's
    //     own preset logic and the rail URL it drives.
    await test("Top Upcoming view resolves to NOT_YET_RELEASED + popular", async () => {
      /* The rail (index.html) requests exactly this; the browse view's own
         state is asserted from the shipped source, and the nav links are
         asserted across EVERY html page (not just the one JS file). */
      const src = readFileSync(
        fileURLToPath(new URL("../../ani-verse/js/zoro-aizen.js", import.meta.url)),
        "utf8"
      );
      assert.ok(
        src.includes('id: "live-top-upcoming-grid", path: "/api/browse?sort=popular&status=NOT_YET_RELEASED&page=1"'),
        "the home rail must request the Top Upcoming set"
      );
      assert.ok(
        src.includes('viewIsTopAiring ? "RELEASING" : viewIsTopUpcoming ? "NOT_YET_RELEASED" : ""'),
        "the view's status preset must be NOT_YET_RELEASED"
      );
      assert.ok(
        src.includes('viewIsTopAiring || viewIsTopUpcoming ? "popular"'),
        "the view's default sort must be popular"
      );
      assert.ok(
        src.includes('href="browse.html?view=top-upcoming&sort=popular"'),
        "the mobile drawer must link Top Upcoming"
      );

      /* Every page's header nav links Top Upcoming, and the home page carries
         the rail element itself. */
      const pagesDir = fileURLToPath(new URL("../../ani-verse", import.meta.url));
      const pages = ["index.html", "browse.html", "detail.html", "genres.html", "schedule.html", "watch.html", "az-list.html"];
      for (const page of pages) {
        const html = readFileSync(`${pagesDir}/${page}`, "utf8");
        assert.ok(
          html.includes('href="browse.html?view=top-upcoming">Top Upcoming</a>'),
          `${page} must link Top Upcoming in the header nav`
        );
        assert.ok(
          html.includes('href="az-list.html">A-Z List</a>'),
          `${page} must link the A-Z List in the header nav`
        );
      }
      const indexHtml = readFileSync(`${pagesDir}/index.html`, "utf8");
      assert.ok(indexHtml.includes('id="live-top-upcoming-grid"'), "index.html must carry the Top Upcoming rail");

      /* The rail's own request reaches the server as the status filter. */
      mockAniList({ mediaList: [fakeMedia({ id: 950001, idMal: 950001, status: "NOT_YET_RELEASED" })] });
      const res = await fetch(`${baseUrl}/api/browse?sort=popular&status=NOT_YET_RELEASED&page=1`);
      assert.equal(res.status, 200);
      const request = anilistRequests[0];
      assert.ok(request.query.includes("status_in: $status"), "the rail's request sends a status filter");
      assert.ok(request.query.includes("sort: POPULARITY_DESC"), "the rail's request sorts by popularity");
      assert.deepEqual(request.variables.status, ["NOT_YET_RELEASED"]);
      resetAniListMock();
    });

    console.log(`\nAll ${passed} E2E integration tests passed successfully!\n`);
  } finally {
    if (server) {
      server.close();
    }
  }
}

runTests().catch((err) => {
  console.error("E2E tests failed:", err);
  process.exit(1);
});
