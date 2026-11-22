import assert from "node:assert/strict";
import { buildEmbedUrl, ZOKO_SOURCES } from "../src/zoko.js";
import { ZOKO_EMBED_ORIGIN } from "../src/config.js";

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

console.log(`\nAll ${passed} smoke / unit tests passed successfully!\n`);
