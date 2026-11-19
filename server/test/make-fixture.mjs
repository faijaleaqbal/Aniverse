// One-off generator: dump enriched metadata from the live DB into a test
// fixture so `npm test` can build an enriched TEMP database fully offline.
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG } from "../src/catalog.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const live = new Database(path.join(here, "..", "data", "aniverse.db"), { readonly: true });
const catalogSlugs = new Set(CATALOG.map((c) => c.slug));

const titles = live
  .prepare("SELECT slug, name, old_title, real_title, romaji_title, native_title FROM titles ORDER BY slug")
  .all()
  .filter((t) => catalogSlugs.has(t.slug));

const episodes = live
  .prepare("SELECT title_slug, ep_num, title FROM episodes ORDER BY title_slug, ep_num")
  .all()
  .filter((e) => catalogSlugs.has(e.title_slug));

const fixture = {
  _comment:
    "Offline snapshot of the real (enriched) metadata for the seeded catalog. " +
    "test/setup-db.js applies this to a temporary seeded database so the E2E " +
    "suite passes on a fresh clone with no network and no manual DB steps. " +
    "Regenerate after catalog/metadata changes with: node test/make-fixture.mjs",
  titles,
  episodes,
};
const out = path.join(here, "fixtures", "enriched-metadata.json");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(fixture, null, 2) + "\n");
console.log(`Wrote ${out}: ${titles.length} titles, ${episodes.length} episodes`);
// sanity: the two search-critical rows
for (const s of ["second-wind", "ronin-of-the-neon-ward"]) {
  const t = titles.find((x) => x.slug === s);
  console.log(s, "->", JSON.stringify(t));
}
const sl = episodes.filter((e) => e.title_slug === "second-wind");
console.log("second-wind ep1:", sl[0]?.title, "| distinct:", new Set(sl.map((e) => e.title)).size, "of", sl.length);
live.close();