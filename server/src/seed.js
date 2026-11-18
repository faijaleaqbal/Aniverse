import { db } from "./db.js";
import { CATALOG } from "./catalog.js";
import { hashPassword, nowIso } from "./utils.js";

const EPISODE_NAMES_POOL = [
  "Ryomen Sukuna / The Awakening",
  "For Myself",
  "Girl of Steel",
  "Curse Womb Must Die",
  "Curse Womb Must Die -II-",
  "After Rain",
  "The Long Way Down",
  "Boredom",
  "Small Fry and Reverse Retribution",
  "Idle Transfiguration",
  "Narrow-minded",
  "To You, Someday",
  "Tomorrow",
  "Kyoto Sister School Goodwill Event",
  "Black Flash",
  "Playful Cloud",
  "Deep Roar",
  "Sage of the Six Paths",
  "The Final Valley",
  "A New Dawn",
];

export async function seed() {
  console.log("Beginning Ani Verse database seed with ZokoAnime streaming mappings...");
  const now = nowIso();

  const insertTitle = db.prepare(`
    INSERT INTO titles (slug, name, kind, year, episodes, runtime_min, genres, tone, studio, tagline, synopsis, mal_id, anilist_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
      name = excluded.name,
      kind = excluded.kind,
      year = excluded.year,
      episodes = excluded.episodes,
      runtime_min = excluded.runtime_min,
      genres = excluded.genres,
      tone = excluded.tone,
      studio = excluded.studio,
      tagline = excluded.tagline,
      synopsis = excluded.synopsis,
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
          let epTitle;
          if (item.slug === "kagerou-protocol" && ep === 7) {
            epTitle = "The Long Way Down";
          } else {
            epTitle = EPISODE_NAMES_POOL[(ep - 1) % EPISODE_NAMES_POOL.length] || `Episode ${ep}`;
          }

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
    }

    return { titleCount, episodeCount };
  });

  const { titleCount, episodeCount } = tx();
  console.log(`Seeded ${titleCount} titles and ${episodeCount} episodes with ZokoAnime streams.`);

  // Seed default demo user if not existing
  const existingUser = db.prepare("SELECT id FROM users WHERE email = ?").get("demo@aniverse.io");
  let userId;
  if (!existingUser) {
    const passwordHash = await hashPassword("password123");
    const res = db.prepare(`
      INSERT INTO users (email, password_hash, name, avatar_tone, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("demo@aniverse.io", passwordHash, "Akihiro", 2, now, now);
    userId = res.lastInsertRowid;
    console.log("Seeded demo user: demo@aniverse.io (password: password123)");

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

    db.prepare(`
      INSERT INTO comments (user_id, title_slug, episode_num, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(userId, "kagerou-protocol", 7, "The ZokoAnime streaming stream loads instantly with 1080p!", now);

    console.log("Seeded demo user watchlist, progress, and comments.");
  } else {
    console.log("Demo user already exists.");
  }

  console.log("Database seed completed successfully.");
}

if (process.argv[1] && process.argv[1].endsWith("seed.js")) {
  seed().catch((err) => {
    console.error("Seed error:", err);
    process.exit(1);
  });
}
