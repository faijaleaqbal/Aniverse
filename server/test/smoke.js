import assert from "node:assert/strict";
import { buildEmbedUrl, ZOKO_SOURCES } from "../src/zoko.js";
import { ZOKO_EMBED_ORIGIN, ANIVEXA_BASE_URL } from "../src/config.js";
import { episodeSetFromAnivexa, pickAnimeggStreamUrl } from "../src/animegg.js";
import { isMusicMedia, canonicalFormat } from "../src/anilist.js";
import {
  pkceChallenge,
  buildRedirectUri,
  placeholderEmail,
  isPlaceholderEmail,
  cleanSocialName,
  providerConfig,
  OAUTH_PROVIDER_IDS,
} from "../src/oauth-providers.js";

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

console.log(`\nAll ${passed} smoke / unit tests passed successfully!\n`);
