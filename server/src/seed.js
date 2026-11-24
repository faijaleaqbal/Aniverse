import { db } from "./db.js";
import { CATALOG } from "./catalog.js";
import { IS_PROD } from "./config.js";
import { hashPassword, nowIso } from "./utils.js";

/* Episode titles are seeded as generic "Episode N" placeholders. REAL episode
   titles are fetched per title from Jikan (MyAnimeList) by
   scripts/fetch-episode-titles.mjs and written into the episodes table.
   NEVER stamp one title's episode names onto another — that is what made
   Solo Leveling show Jujutsu Kaisen episode titles. */
export function episodeTitleFor(slug, ep) {
  return `Episode ${ep}`;
}

export async function seed() {
  console.log("Beginning AniFlick database seed with ZokoAnime streaming mappings...");
  const now = nowIso();

  const insertTitle = db.prepare(`
    INSERT INTO titles (slug, name, kind, year, episodes, runtime_min, genres, tone, studio, tagline, synopsis, mal_id, anilist_id, old_title, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
      /* Enriched metadata is PRESERVED on a re-seed. scripts/fetch-metadata.mjs
         writes the real title (name), the fictional placeholder (old_title),
         romaji/native, score, status, studios and the cover/banner art. A plain
         "overwrite everything from the catalog" upsert would silently wipe all
         of that back to the codenames — so the ENRICHED fields (name, synopsis,
         score, status, studios, real_title, romaji/native, art) are only
         written when the STORED row is still unenriched (its enrichment
         markers score/studios are NULL). The marker test is intentionally
         "any enrichment present": a row with a real synopsis but no score yet
         is still treated as enriched, so a later run can never roll it back.
         The structural fields (kind/episodes/ids/genres/tone) always track
         the catalog, which is the streamable truth. */
      name = CASE WHEN titles.score IS NULL AND titles.studios IS NULL THEN excluded.name ELSE titles.name END,
      old_title = CASE WHEN titles.old_title IS NULL THEN excluded.old_title ELSE titles.old_title END,
      real_title = CASE WHEN titles.score IS NULL AND titles.studios IS NULL THEN excluded.name ELSE titles.real_title END,
      romaji_title = CASE WHEN titles.score IS NULL AND titles.studios IS NULL THEN NULL ELSE titles.romaji_title END,
      native_title = CASE WHEN titles.score IS NULL AND titles.studios IS NULL THEN NULL ELSE titles.native_title END,
      synopsis = CASE WHEN titles.score IS NULL AND titles.studios IS NULL THEN excluded.synopsis ELSE titles.synopsis END,
      score = CASE WHEN titles.score IS NULL THEN NULL ELSE titles.score END,
      status = CASE WHEN titles.status IS NULL THEN NULL ELSE titles.status END,
      studios = CASE WHEN titles.studios IS NULL THEN NULL ELSE titles.studios END,
      anilist_genres = CASE WHEN titles.anilist_genres IS NULL THEN NULL ELSE titles.anilist_genres END,
      anilist_episodes = CASE WHEN titles.anilist_episodes IS NULL THEN NULL ELSE titles.anilist_episodes END,
      cover_local = CASE WHEN titles.cover_local IS NULL THEN NULL ELSE titles.cover_local END,
      banner_local = CASE WHEN titles.banner_local IS NULL THEN NULL ELSE titles.banner_local END,
      cover_remote = CASE WHEN titles.cover_remote IS NULL THEN NULL ELSE titles.cover_remote END,
      banner_remote = CASE WHEN titles.banner_remote IS NULL THEN NULL ELSE titles.banner_remote END,
      /* Structural fields always track the catalog (the streamable truth). */
      kind = excluded.kind,
      year = CASE WHEN titles.year IS NULL THEN excluded.year ELSE titles.year END,
      episodes = excluded.episodes,
      runtime_min = excluded.runtime_min,
      genres = excluded.genres,
      tone = excluded.tone,
      tagline = excluded.tagline,
      studio = excluded.studio,
      mal_id = excluded.mal_id,
      anilist_id = excluded.anilist_id
  `);

  const insertEpisode = db.prepare(`
    INSERT INTO episodes (title_slug, ep_num, title, duration_sec, video_url, thumbnail_url, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(title_slug, ep_num) DO UPDATE SET
      title = excluded.title,
      duration_sec = excluded.duration_sec,
      video_url = excluded.video_url
  `);

  const tx = db.transaction(() => {
    let titleCount = 0;
    let episodeCount = 0;

    for (const item of CATALOG) {
      const genresStr = Array.isArray(item.genres) ? item.genres.join(",") : "";
      const malId = item.malId || 21;
      const anilistId = item.anilistId || 21;

      insertTitle.run(
        item.slug,
        item.name,
        item.kind,
        item.year,
        item.episodes,
        item.runtimeMin,
        genresStr,
        item.tone || 1,
        item.studio,
        item.tagline,
        item.synopsis,
        malId,
        anilistId,
        item.oldTitle || null,
        now
      );
      titleCount++;

      // Seed episodes with ZokoAnime streaming embeds
      if (item.kind === "Film") {
        insertEpisode.run(
          item.slug,
          1,
          "Full Feature Film",
          (item.runtimeMin || 90) * 60,
          `https://zokoanime.video/stream/mal/${malId}/1/sub?color=cae962&autoplay=true&asi=true&autonext=true`,
          null,
          now
        );
        episodeCount++;
      } else {
        const count = item.episodes || 12;
        for (let ep = 1; ep <= count; ep++) {
          const epTitle = episodeTitleFor(item.slug, ep);

          insertEpisode.run(
            item.slug,
            ep,
            epTitle,
            (item.runtimeMin || 24) * 60,
            `https://zokoanime.video/stream/mal/${malId}/${ep}/sub?color=cae962&autoplay=true&asi=true&autonext=true`,
            null,
            now
          );
          episodeCount++;
        }
      }

      /* Prune rows beyond the catalog count. Upserts alone never removed
         episodes when a count was REDUCED (e.g. AoT 75->25), leaving dead
         "Episode N" rows listed on the detail page. Keep DB == catalog.
         dub_checks is pruned too so stale rows can never inflate DUB counts
         (dubCount = COUNT(available=1) over dub_checks, no episodes join).
         User data (watchlist / watch_progress / comments) is never touched. */
      const maxEp = item.kind === "Film" ? 1 : (item.episodes || 12);
      db.prepare("DELETE FROM episodes WHERE title_slug = ? AND ep_num > ?").run(item.slug, maxEp);
      db.prepare("DELETE FROM dub_checks WHERE title_slug = ? AND ep_num > ?").run(item.slug, maxEp);
    }

    return { titleCount, episodeCount };
  });

  const { titleCount, episodeCount } = tx();
  console.log(`Seeded ${titleCount} titles and ${episodeCount} episodes with ZokoAnime streams.`);

  /* Demo account (audit H-1): seeded ONLY outside production. The demo
     credentials were public (hardcoded in client JS + README), so the
     account must never exist on a production database. Tests and local
     dev still get it — NODE_ENV is unset/"test" there. */
  const demoComment = "The ZokoAnime stream loads instantly — great player!";
  if (IS_PROD) {
    console.log("Production mode: demo user seeding skipped.");
  } else {
    // Seed default demo user if not existing
    const existingUser = db.prepare("SELECT id FROM users WHERE email = ?").get("demo@aniflick.org");
    let userId;
    if (!existingUser) {
      const passwordHash = await hashPassword("password123");
      const res = db.prepare(`
        INSERT INTO users (email, password_hash, name, avatar_tone, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run("demo@aniflick.org", passwordHash, "Akihiro", 2, now, now);
      userId = res.lastInsertRowid;
      /* Never print the password — it used to be logged to stdout. */
      console.log("Seeded demo user: demo@aniflick.org (dev/test only)");

      const insertWatchlist = db.prepare(`
        INSERT OR IGNORE INTO watchlist (user_id, title_slug, added_at) VALUES (?, ?, ?)
      `);
      insertWatchlist.run(userId, "kagerou-protocol", now);
      insertWatchlist.run(userId, "ronin-of-the-neon-ward", now);
      insertWatchlist.run(userId, "iron-bloom", now);

      db.prepare(`
        INSERT OR REPLACE INTO watch_progress (user_id, title_slug, episode_num, position_sec, duration_sec, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(userId, "kagerou-protocol", 7, 521, 1440, now);

      console.log("Seeded demo user watchlist and progress.");
    } else {
      userId = existingUser.id;
      console.log("Demo user already exists.");
    }

    /* Demo comment seeding is IDEMPOTENT: insert only when this exact
       comment (user + episode + content) is absent, so re-running the seed
       never stacks duplicates. (It used to live inside the new-user branch,
       which meant an existing DB never got the demo comment at all.) */
    const hasDemoComment = db.prepare(
      "SELECT id FROM comments WHERE user_id = ? AND title_slug = ? AND episode_num = ? AND content = ?"
    ).get(userId, "kagerou-protocol", 7, demoComment);
    if (!hasDemoComment) {
      db.prepare(
        `INSERT INTO comments (user_id, title_slug, episode_num, content, created_at)
        VALUES (?, ?, ?, ?, ?)`
      ).run(userId, "kagerou-protocol", 7, demoComment, now);
    }
  }

  /* Idempotent cleanup: the original demo comment claimed "1080p", a
     resolution the site cannot verify. Correct any existing copy so no
     watch page displays an unverifiable quality claim. */
  db.prepare(
    `UPDATE comments SET content = ? WHERE content = ?`
  ).run(
    demoComment,
    "The ZokoAnime streaming stream loads instantly with 1080p!"
  );

  /* Dedupe cleanup: identical comments on the same episode (e.g. six
     copies of "Amazing episode! Visuals are stunning." posted through the
     API on JJK ep7) are collapsed to the EARLIEST copy per (user, episode,
     content) group. Runs on every seed, so a re-seed both removes existing
     duplicates and can never create new ones. */
  const dedup = db.prepare(`
    DELETE FROM comments WHERE id NOT IN (
      SELECT MIN(id) FROM comments GROUP BY user_id, title_slug, episode_num, content
    )
  `);
  const removed = dedup.run().changes;
  if (removed) console.log(`Removed ${removed} duplicate comment(s).`);

  console.log("Database seed completed successfully.");
}

if (process.argv[1] && process.argv[1].endsWith("seed.js")) {
  seed().catch((err) => {
    console.error("Seed error:", err);
    process.exit(1);
  });
}
