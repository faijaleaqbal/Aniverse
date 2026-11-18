/**
 * Ani Verse — Phase 1 real-metadata seed.
 *
 * Run once:  node server/scripts/fetch-metadata.mjs
 *
 * For every catalog title this queries the AniList GraphQL API (no key needed),
 * downloads the real cover + banner art into ani-verse/img/{covers,banners}/,
 * and writes the real title / synopsis / score / status / year / studios into
 * the SQLite `titles` table. The fictional placeholder name is preserved in
 * `old_title`. Slugs are NEVER changed (they are the stable watchlist/progress
 * key). Episode titles are normalized so none repeat (fixes the 021-024 bug).
 *
 * ID resolution: the Zoko embed streams by `mal_id`, so the displayed metadata
 * MUST describe the same anime that actually plays. We therefore prefer the
 * AniList-id result only when its idMal agrees with the catalog malId; otherwise
 * we fall back to the idMal result. (Two catalog rows carry an AniList id that
 * points at a different anime than their malId — this keeps title == stream.)
 *
 * The catalog `episodes` count (the number actually seeded / streamable) is left
 * untouched; AniList's real total is stored separately in `anilist_episodes`.
 * The catalog `genres` taxonomy is also left untouched so genre counts/filters
 * stay honest (e.g. Adventure = 1). AniList genres are stored in `anilist_genres`.
 */
import fs from "node:fs";
import path from "node:path";
import { db } from "../src/db.js";
import { CATALOG } from "../src/catalog.js";
import { episodeTitleFor } from "../src/seed.js";
import { SITE_ROOT } from "../src/config.js";

const ANILIST_API = "https://graphql.anilist.co";
const COVERS_DIR = path.join(SITE_ROOT, "img", "covers");
const BANNERS_DIR = path.join(SITE_ROOT, "img", "banners");
fs.mkdirSync(COVERS_DIR, { recursive: true });
fs.mkdirSync(BANNERS_DIR, { recursive: true });

const MEDIA_FIELDS = `
  id
  idMal
  title { english romaji native }
  description
  genres
  averageScore
  episodes
  status
  seasonYear
  studios { nodes { name isAnimationStudio } }
  coverImage { extraLarge }
  bannerImage
`;

const QUERY = `
  query ($id: Int, $idMal: Int) {
    byId: Media(id: $id, type: ANIME) { ${MEDIA_FIELDS} }
    byMal: Media(idMal: $idMal, type: ANIME) { ${MEDIA_FIELDS} }
  }
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stripHtml(html) {
  if (!html) return "";
  return String(html)
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(p|div)>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function gql(variables, attempt = 0) {
  try {
    const res = await fetch(ANILIST_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: QUERY, variables }),
    });
    if (res.status === 429 && attempt < 4) {
      const wait = Number(res.headers.get("Retry-After") || 2) * 1000 + 500;
      console.log(`    rate-limited, waiting ${wait}ms…`);
      await sleep(wait);
      return gql(variables, attempt + 1);
    }
    const json = await res.json();
    if (json.errors) throw new Error(json.errors.map((e) => e.message).join("; "));
    return json.data || {};
  } catch (err) {
    if (attempt < 2) {
      await sleep(1200);
      return gql(variables, attempt + 1);
    }
    throw err;
  }
}

/* Prefer the AniList-id result when it matches the streaming malId; else use
   the idMal result so the metadata always describes what the player plays. */
function pickMedia(byAni, byMal, malId) {
  if (byAni && (!malId || byAni.idMal === malId)) return byAni;
  if (byMal) return byMal;
  return byAni || null;
}

async function downloadImage(url, destAbs, attempt = 0) {
  try {
    const res = await fetch(url, { headers: { Accept: "image/*" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error("empty body");
    fs.writeFileSync(destAbs, buf);
    return buf.length;
  } catch (err) {
    if (attempt < 2) {
      await sleep(900);
      return downloadImage(url, destAbs, attempt + 1);
    }
    throw err;
  }
}

const updateTitle = db.prepare(`
  UPDATE titles SET
    old_title = ?,
    name = ?,
    real_title = ?,
    romaji_title = ?,
    native_title = ?,
    synopsis = ?,
    score = ?,
    status = ?,
    year = ?,
    studio = ?,
    studios = ?,
    anilist_genres = ?,
    anilist_episodes = ?,
    cover_local = ?,
    banner_local = ?,
    cover_remote = ?,
    banner_remote = ?
  WHERE slug = ?
`);

const updateEpisodeTitle = db.prepare(
  "UPDATE episodes SET title = ? WHERE title_slug = ? AND ep_num = ?"
);
const getEpisodes = db.prepare(
  "SELECT ep_num FROM episodes WHERE title_slug = ? ORDER BY ep_num ASC"
);

async function main() {
  console.log("Fetching real AniList metadata for", CATALOG.length, "titles…\n");
  const results = [];

  for (const item of CATALOG) {
    const slug = item.slug;
    try {
      const data = await gql({ id: item.anilistId || null, idMal: item.malId || null });
      const media = pickMedia(data.byId, data.byMal, item.malId);
      if (!media) {
        console.log(`  ✗ ${slug}: no AniList media resolved (ani=${item.anilistId} mal=${item.malId})`);
        results.push({ slug, ok: false, reason: "no media" });
        await sleep(700);
        continue;
      }

      const english = media.title && media.title.english;
      const romaji = (media.title && media.title.romaji) || "";
      const native = (media.title && media.title.native) || "";
      const realTitle = english || romaji || item.name;
      const synopsis = stripHtml(media.description);
      const studioNodes = (media.studios && media.studios.nodes) || [];
      const animationStudios = studioNodes.filter((s) => s.isAnimationStudio && s.name);
      const studioNames = (animationStudios.length ? animationStudios : studioNodes)
        .map((s) => s.name)
        .filter(Boolean);
      const primaryStudio = studioNames[0] || item.studio;
      const genres = Array.isArray(media.genres) ? media.genres : [];
      const year = media.seasonYear || item.year;

      // Download cover (primary) + banner (when present).
      const coverRemote = (media.coverImage && media.coverImage.extraLarge) || null;
      const bannerRemote = media.bannerImage || null;
      let coverLocal = null;
      let bannerLocal = null;

      if (coverRemote) {
        try {
          const bytes = await downloadImage(coverRemote, path.join(COVERS_DIR, `${slug}.jpg`));
          coverLocal = `img/covers/${slug}.jpg`;
          console.log(`    cover  ${coverLocal} (${bytes} bytes)`);
        } catch (e) {
          console.log(`    ! cover download failed for ${slug}: ${e.message} (remote fallback kept)`);
        }
      }
      if (bannerRemote) {
        try {
          const bytes = await downloadImage(bannerRemote, path.join(BANNERS_DIR, `${slug}.jpg`));
          bannerLocal = `img/banners/${slug}.jpg`;
          console.log(`    banner ${bannerLocal} (${bytes} bytes)`);
        } catch (e) {
          console.log(`    ! banner download failed for ${slug}: ${e.message} (remote fallback kept)`);
        }
      }

      updateTitle.run(
        item.name,                 // old_title (fictional placeholder, preserved)
        realTitle,                 // name (real display title)
        realTitle,                 // real_title
        romaji || null,
        native || null,
        synopsis || item.synopsis,
        media.averageScore != null ? media.averageScore : null,
        media.status || null,
        year,
        primaryStudio,
        studioNames.join(", ") || null,
        genres.join(", ") || null,
        media.episodes != null ? media.episodes : null,
        coverLocal,
        bannerLocal,
        coverRemote,
        bannerRemote,
        slug
      );

      // Normalize episode titles so none repeat (real names where known, else "Episode N").
      const eps = getEpisodes.all(slug);
      const fixEps = db.transaction(() => {
        for (const e of eps) updateEpisodeTitle.run(episodeTitleFor(slug, e.ep_num), slug, e.ep_num);
      });
      fixEps();

      const usedId = media.id === (data.byId && data.byId.id) && media === data.byId ? `ani:${media.id}` : `mal:${item.malId}->ani:${media.id}`;
      console.log(`  ✓ ${slug} → "${realTitle}" [${usedId}] score=${media.averageScore} year=${year} eps=${eps.length}`);
      results.push({ slug, ok: true, realTitle, cover: !!coverLocal, banner: !!bannerLocal });
    } catch (err) {
      console.log(`  ✗ ${slug}: ${err.message}`);
      results.push({ slug, ok: false, reason: err.message });
    }
    await sleep(700); // stay well under AniList rate limits
  }

  const ok = results.filter((r) => r.ok).length;
  const withCover = results.filter((r) => r.cover).length;
  const withBanner = results.filter((r) => r.banner).length;
  console.log(`\nDone: ${ok}/${CATALOG.length} titles enriched, ${withCover} local covers, ${withBanner} local banners.`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log("Failed:", failed.map((f) => `${f.slug} (${f.reason})`).join(", "));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("fetch-metadata fatal:", err);
  process.exit(1);
});