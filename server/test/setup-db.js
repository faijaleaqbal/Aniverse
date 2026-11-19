/* Test database bootstrap — makes `npm test` pass on a FRESH CLONE with zero
   manual steps and zero network:

   1. Points DB_PATH at a brand-new temporary file (never the live database).
      config.js reads DB_PATH at import time, so this MUST happen before any
      ../src/* module is imported — hence the dynamic imports below.
   2. Seeds the catalog (fictional placeholder names, generic episode titles).
   3. Applies fixtures/enriched-metadata.json — an offline snapshot of the
      real enriched metadata (real titles + real per-title episode names),
      equivalent to running scripts/fetch-metadata.mjs + fetch-episode-titles.mjs
      but deterministic and offline.

   The temporary directory is removed on process exit. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aniverse-test-"));
process.env.DB_PATH = path.join(tmpDir, "test.db");

const { db } = await import("../src/db.js");
const { seed } = await import("../src/seed.js");

await seed();

const fixture = JSON.parse(
  fs.readFileSync(path.join(here, "fixtures", "enriched-metadata.json"), "utf8")
);
const updTitle = db.prepare(
  "UPDATE titles SET name = ?, old_title = ?, real_title = ?, romaji_title = ?, native_title = ? WHERE slug = ?"
);
const updEpisode = db.prepare(
  "UPDATE episodes SET title = ? WHERE title_slug = ? AND ep_num = ?"
);
db.transaction(() => {
  for (const t of fixture.titles) {
    updTitle.run(t.name, t.old_title, t.real_title, t.romaji_title, t.native_title, t.slug);
  }
  for (const e of fixture.episodes) {
    updEpisode.run(e.title, e.title_slug, e.ep_num);
  }
})();
console.log(
  `Test DB ready at ${process.env.DB_PATH} (seeded + enriched offline: ${fixture.titles.length} titles, ${fixture.episodes.length} episode titles).`
);

const app = (await import("../src/index.js")).default;

process.on("exit", () => {
  try { db.close(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

export { db, app };