/**
 * Ani Verse — real episode titles per title (MyAnimeList data).
 *
 * Run:  node server/scripts/fetch-episode-titles.mjs
 *
 * The seed used to stamp one shared pool of Jujutsu Kaisen episode names onto
 * EVERY title (Solo Leveling showed "Ryomen Sukuna / The Awakening" etc.).
 * This script fetches the real episode list for each title's mapped MAL id
 * and writes the real titles into the `episodes` table — metadata always
 * describes what the Zoko player actually streams (the embed streams by
 * mal_id).
 *
 * Sources (both free, no key):
 *   1. Kitsu edge API — MAL-id mapping -> per-episode canonicalTitle.
 *      (Kitsu carries the MyAnimeList episode titles.)
 *   2. Jikan v4 (api.jikan.moe) — direct MAL episode list, used as fallback.
 *      NOTE: api.jikan.moe is unreachable from some networks (incl. the build
 *      host this was written on); Kitsu is the primary for that reason.
 * Only episodes that exist in the local DB are updated (the catalog's seeded
 * episode count stays untouched). Missing/untitled entries fall back to
 * "Episode N". Films seeded as a single episode take episode 1's title —
 * that is the episode the stream plays.
 */
import { db } from "../src/db.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/* Verified titles for shows Kitsu/Jikan cannot supply (see file for sources). */
const OVERRIDES = JSON.parse(fs.readFileSync(path.join(HERE, "episode-title-overrides.json"), "utf8"));

const KITSU = "https://kitsu.io/api/edge";
const JIKAN = "https://api.jikan.moe/v4";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, attempt = 0) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      /* Kitsu (JSON:API) answers 406 to "Accept: application/json"; a wildcard
         Accept is accepted by both Kitsu and Jikan. */
      headers: { Accept: "*/*", "User-Agent": "AniVerse-metadata/1.0" },
    });
    if (res.status === 429 && attempt < 4) {
      const wait = Number(res.headers.get("Retry-After") || 2) * 1000 + 500;
      console.log(`    rate-limited, waiting ${wait}ms…`);
      await sleep(wait);
      return getJson(url, attempt + 1);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (attempt < 1) {
      await sleep(1000);
      return getJson(url, attempt + 1);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function cleanTitle(t) {
  if (typeof t !== "string") return "";
  const s = t.trim();
  if (!s || /^episode\s+\d+$/i.test(s)) return "";
  return s;
}

/** Kitsu: resolve MAL id -> Kitsu anime id, then page through episodes. */
async function viaKitsu(malId) {
  const map = await getJson(
    `${KITSU}/mappings?filter[externalSite]=myanimelist/anime&filter[externalId]=${malId}&include=item`
  );
  const entries = Array.isArray(map.data) ? map.data : [];
  if (!entries.length) throw new Error("no Kitsu mapping");
  const animeId = entries[0].relationships.item.data.id;

  const titles = new Map();
  let offset = 0;
  const limit = 20; // Kitsu caps page[limit] at 20
  let total = Infinity;
  while (offset < total) {
    const json = await getJson(
      `${KITSU}/anime/${animeId}/episodes?page[limit]=${limit}&page[offset]=${offset}&sort=number`
    );
    const items = Array.isArray(json.data) ? json.data : [];
    total = (json.meta && json.meta.count) || items.length;
    items.forEach((e, i) => {
      const a = e.attributes || {};
      const n = Number(a.number);
      const epNum = Number.isFinite(n) && n > 0 ? n : offset + i + 1;
      const t =
        cleanTitle(a.canonicalTitle) ||
        cleanTitle(a.titles && a.titles.en_us) ||
        cleanTitle(a.titles && a.titles.en_jp);
      if (t) titles.set(epNum, t);
    });
    offset += limit;
    if (offset < total) await sleep(350);
  }
  return { titles, source: `kitsu:${animeId}` };
}

/** Jikan: direct MAL episode pages (fallback when Kitsu has no data). */
async function viaJikan(malId) {
  const titles = new Map();
  let page = 1;
  let lastPage = 1;
  do {
    const json = await getJson(`${JIKAN}/anime/${malId}/episodes?page=${page}`);
    const items = Array.isArray(json.data) ? json.data : [];
    for (const it of items) {
      const n = Number(it.mal_id);
      const t = cleanTitle(it.title);
      if (Number.isFinite(n) && n > 0 && t) titles.set(n, t);
    }
    lastPage = (json.pagination && json.pagination.last_visible_page) || 1;
    page++;
    if (page <= lastPage) await sleep(450);
  } while (page <= lastPage);
  return { titles, source: `jikan:mal/${malId}` };
}

const getTitles = db.prepare(
  "SELECT slug, name, kind, mal_id FROM titles WHERE mal_id IS NOT NULL ORDER BY slug"
);
const getEps = db.prepare(
  "SELECT ep_num FROM episodes WHERE title_slug = ? ORDER BY ep_num ASC"
);
const setEpTitle = db.prepare(
  "UPDATE episodes SET title = ? WHERE title_slug = ? AND ep_num = ?"
);

async function main() {
  const rows = getTitles.all();
  console.log(`Fetching real episode titles for ${rows.length} titles (Kitsu primary, Jikan fallback)…\n`);
  let updated = 0;
  let fallback = 0;
  const failed = [];

  for (const row of rows) {
    const eps = getEps.all(row.slug);
    if (!eps.length) {
      console.log(`  – ${row.slug}: no local episodes, skipped`);
      continue;
    }
    let result = null;
    try {
      result = await viaKitsu(row.mal_id);
      if (!result.titles.size) throw new Error("Kitsu returned no episode titles");
    } catch (kitsuErr) {
      try {
        result = await viaJikan(row.mal_id);
        if (!result.titles.size) throw new Error("Jikan returned no episode titles");
      } catch (jikanErr) {
        console.log(`  ! ${row.slug}: kitsu(${kitsuErr.message}) jikan(${jikanErr.message}) — trying fallbacks`);
        result = { titles: new Map(), source: "fallback" };
      }
    }
    /* A film seeded as one episode is titled after the film itself (the MAL
       convention for movies) when no episode title is available. */
    if (row.kind === "Film" && eps.length === 1 && !result.titles.has(1)) {
      result.titles.set(1, row.name);
      result.source += "+film-name";
    }
    /* Verified overrides last (shows whose titles no reachable API carries). */
    const ov = OVERRIDES[row.slug];
    if (ov) {
      for (const [k, v] of Object.entries(ov)) {
        if (k.startsWith("_")) continue;
        const n = Number(k);
        if (Number.isFinite(n) && typeof v === "string" && v.trim()) result.titles.set(n, v.trim());
      }
      result.source += "+override";
    }
    if (!result.titles.size) {
      console.log(`  ✗ ${row.slug}: no episode titles from any source`);
      failed.push(row.slug);
      await sleep(350);
      continue;
    }
    const tx = db.transaction(() => {
      for (const e of eps) {
        const t = result.titles.get(e.ep_num);
        if (t) {
          setEpTitle.run(t, row.slug, e.ep_num);
          updated++;
        } else {
          setEpTitle.run(`Episode ${e.ep_num}`, row.slug, e.ep_num);
          fallback++;
        }
      }
    });
    tx();
    const sample = result.titles.get(eps[0].ep_num) || `Episode ${eps[0].ep_num}`;
    console.log(`  ✓ ${row.slug} (${row.name}, mal ${row.mal_id}): ${eps.length} eps via ${result.source}, ep1="${sample}"`);
    await sleep(350);
  }

  console.log(`\nDone: ${updated} real episode titles written, ${fallback} fallbacks ("Episode N").`);
  if (failed.length) {
    console.log("Failed:", failed.join(", "));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("fetch-episode-titles fatal:", err);
  process.exit(1);
});
