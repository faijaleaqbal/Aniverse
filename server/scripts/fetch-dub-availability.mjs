/**
 * AniFlick — per-title DUB truth.
 *
 * Probes EVERY seeded episode of every catalog title with the same probe the
 * watch page uses (src/dub-check.js: sub vs dub payload -> variant playlists
 * -> segment bytes) and persists the result in `dub_checks`. The UI's DUB
 * count is COUNT(available = 1) per title — never a copy of the episode count.
 *
 *   node scripts/fetch-dub-availability.mjs            # probe missing/unknown
 *   node scripts/fetch-dub-availability.mjs --force    # re-probe everything
 *   node scripts/fetch-dub-availability.mjs --slug second-wind
 *
 * Confirmed results (available 0/1) are skipped on re-runs; failed probes
 * (NULL) are retried. Safe to run while the API server is up (WAL +
 * busy_timeout). Results are durable: a fresh clone re-probes via this script.
 */
import { db } from "../src/db.js";
import { CATALOG } from "../src/catalog.js";
import { checkDubAvailability } from "../src/dub-check.js";
import { nowIso } from "../src/utils.js";

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const slugIdx = args.indexOf("--slug");
const ONLY_SLUG = slugIdx >= 0 ? args[slugIdx + 1] : null;
const CONCURRENCY = 4;
const STAGGER_MS = 250;

const upsert = db.prepare(`
  INSERT INTO dub_checks (title_slug, ep_num, available, reason, checked_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(title_slug, ep_num) DO UPDATE SET
    available = excluded.available,
    reason = excluded.reason,
    checked_at = excluded.checked_at
`);
const getChecked = db.prepare(
  "SELECT ep_num, available FROM dub_checks WHERE title_slug = ?"
);
const getEpisodes = db.prepare(
  "SELECT ep_num FROM episodes WHERE title_slug = ? ORDER BY ep_num ASC"
);
const getTitle = db.prepare("SELECT mal_id FROM titles WHERE slug = ?");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probeOne(slug, malId, ep) {
  const result = await checkDubAvailability(malId, ep);
  const available = result.available === true ? 1 : result.available === false ? 0 : null;
  upsert.run(slug, ep, available, result.reason || null, nowIso());
  return available;
}

async function main() {
  const titles = CATALOG.filter((t) => !ONLY_SLUG || t.slug === ONLY_SLUG);
  if (!titles.length) {
    console.error(`No catalog title matches --slug ${ONLY_SLUG}`);
    process.exit(1);
  }
  let grandProbed = 0;
  let grandDub = 0;
  let grandUnknown = 0;
  const summary = [];

  for (const item of titles) {
    const slug = item.slug;
    const title = getTitle.get(slug);
    const malId = title ? title.mal_id : item.malId;
    const epNums = getEpisodes.all(slug).map((r) => r.ep_num);
    if (!epNums.length) {
      console.log(`- ${slug}: no seeded episodes, skipped`);
      continue;
    }
    if (!malId) {
      for (const ep of epNums) upsert.run(slug, ep, 0, "no-mal-id", nowIso());
      console.log(`- ${slug}: no MAL id -> dub 0/${epNums.length}`);
      summary.push({ slug, total: epNums.length, dub: 0, unknown: 0 });
      continue;
    }

    const checked = new Map(getChecked.all(slug).map((r) => [r.ep_num, r.available]));
    const todo = epNums.filter((ep) => {
      const prev = checked.get(ep);
      return FORCE || prev == null; // unknown/missing only
    });
    const alreadyDub = epNums.filter((ep) => checked.get(ep) === 1).length;
    console.log(
      `\n${slug} (mal ${malId}): ${epNums.length} episodes, ${todo.length} to probe` +
        (todo.length === 0 ? " (all confirmed)" : "")
    );

    /* With --force EVERY episode is re-probed, so the count must start at 0
       — seeding it with the old confirmed dubs double-counted them (the
       summary printed "DUB 54/28"). Without --force only unknown/missing
       episodes are probed, so the old confirmed dubs carry over. */
    let dub = FORCE ? 0 : alreadyDub;
    let unknown = 0;
    let done = 0;
    /* Small worker pool with a stagger so the provider is never hit by a
       burst of simultaneous probes. */
    const queue = todo.slice();
    async function worker() {
      while (queue.length) {
        const ep = queue.shift();
        await sleep(STAGGER_MS);
        const available = await probeOne(slug, malId, ep);
        if (available === 1) dub++;
        else if (available == null) unknown++;
        done++;
        if (done % 50 === 0 || done === todo.length) {
          console.log(`    ${done}/${todo.length} probed (dub so far: ${dub}, unknown: ${unknown})`);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length || 1) }, worker));

    /* Retry failed probes once — transient provider/network errors must not
       leave a title's count silently incomplete. */
    if (unknown > 0) {
      const retry = getChecked
        .all(slug)
        .filter((r) => r.available == null)
        .map((r) => r.ep_num);
      console.log(`    retrying ${retry.length} failed probes…`);
      unknown = 0;
      for (const ep of retry) {
        await sleep(STAGGER_MS);
        const available = await probeOne(slug, malId, ep);
        if (available === 1) dub++;
        else if (available == null) unknown++;
      }
    }

    grandProbed += todo.length;
    grandDub += dub;
    grandUnknown += unknown;
    summary.push({ slug, total: epNums.length, dub, unknown });
    console.log(`  => ${slug}: DUB ${dub}/${epNums.length}${unknown ? ` (${unknown} unknown)` : ""}`);
  }

  console.log("\n=== DUB SUMMARY (confirmed probes only) ===");
  for (const s of summary) {
    console.log(`  ${s.slug.padEnd(28)} DUB ${String(s.dub).padStart(4)} / ${s.total}${s.unknown ? `  [${s.unknown} unknown]` : ""}`);
  }
  console.log(`\nProbed ${grandProbed} episodes this run; confirmed dubs: ${grandDub}; still unknown: ${grandUnknown}.`);
  if (grandUnknown > 0) {
    console.log("Re-run this script to retry the unknown episodes (confirmed results are kept).");
  }
}

main().catch((err) => {
  console.error("fetch-dub-availability fatal:", err);
  process.exit(1);
});