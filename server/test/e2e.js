import assert from "node:assert/strict";
/* Self-contained test database: a temporary seeded + enriched DB (see
   setup-db.js). `npm test` needs no manual seed/metadata steps and never
   touches the live database. */
const { app, db } = await import("./setup-db.js");
const { clearAniListCache } = await import("../src/anilist.js");

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

/* Install a responder. `mediaList` answers Page.media queries, `mediaById`
   answers single-title Media queries, `airing` answers airingSchedules. */
function mockAniList({ mediaList = [], mediaById = {}, airing = [], fail = false } = {}) {
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
    return jsonResponse({
      data: { Page: { pageInfo: MOCK_PAGE_INFO, media: mediaList } },
    });
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
