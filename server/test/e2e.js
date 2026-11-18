import assert from "node:assert/strict";
import app from "../src/index.js";
import { db } from "../src/db.js";

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
