/**
 * The AniFlick shelf. Each title maps to real anime metadata & MAL/AniList IDs
 * for real-time ZokoAnime embedding and streaming.
 */
export const CATALOG = [
  {
    slug: "kagerou-protocol",
    name: "Jujutsu Kaisen",
    oldTitle: "Kagerou Protocol",
    kind: "Series",
    year: 2026,
    episodes: 24, // JJK S1 = 24 (AniList); Zoko payload verified ep 13 & 24 (was 12)
    runtimeMin: 24,
    genres: ["action", "supernatural"],
    tone: 1,
    studio: "MAPPA / Verse Works",
    malId: 40748, // Jujutsu Kaisen
    anilistId: 113415,
    tagline: "A courier runs the last unmonitored line in a watched city.",
    synopsis:
      "A courier runs the last unmonitored line in a watched city. The drop goes missing and the route closes behind her as ancient powers awaken.",
  },
  {
    slug: "ronin-of-the-neon-ward",
    name: "One Piece",
    oldTitle: "Ronin of the Neon Ward",
    kind: "Series",
    year: 2025,
    episodes: 1180, // One Piece (ongoing): provider max verified ep 1180 yes / 1181 no (was 1084)
    runtimeMin: 24,
    genres: ["action", "fantasy"],
    tone: 2,
    studio: "Toei / Verse Works",
    malId: 21, // One Piece
    anilistId: 21,
    tagline: "A swordsman keeps the peace in a district that never sleeps.",
    synopsis:
      "A masterless swordsman takes a job guarding a neon district where every favour is a debt and every debt is collected in the rain.",
  },
  {
    slug: "zero-gravity-club",
    name: "Fruits Basket: The Final Season",
    oldTitle: "Zero Gravity Club",
    kind: "Series",
    year: 2026,
    episodes: 13, // Fruits Basket The Final = 13 (AniList idMal 42938); Zoko ep 13 payload verified (was 12)
    runtimeMin: 24,
    genres: ["romance", "drama"],
    tone: 3,
    studio: "Eight Bit / Orbit Eight",
    malId: 42938, // Fruits Basket: The Final Season
    anilistId: 10087,
    tagline: "A high-school diving team that practices in an abandoned pool.",
    synopsis:
      "A high-school diving team that practices in an abandoned pool chases one clean entry before the water is shut off for good.",
  },
  {
    slug: "the-fox-who-counted-rain",
    name: "Demon Slayer",
    oldTitle: "The Fox Who Counted Rain",
    kind: "Series",
    year: 2024,
    episodes: 26,
    runtimeMin: 24,
    genres: ["fantasy", "drama"],
    tone: 5,
    studio: "ufotable",
    malId: 38000, // Demon Slayer
    anilistId: 101922,
    tagline: "A fox spirit keeps a ledger of every drop that falls on one village.",
    synopsis:
      "A fox spirit keeps a ledger of every drop that falls on one village, until a dry summer makes the arithmetic impossible.",
  },
  {
    slug: "ghost-line-9",
    name: "Attack on Titan",
    oldTitle: "Ghost Line 9",
    kind: "Series",
    year: 2025,
    episodes: 25, // AoT S1 (MAL 16498) = 25 (AniList); Zoko NO payload ep 26/75 (was 75 - 50 dead eps)
    runtimeMin: 23,
    genres: ["horror", "mystery"],
    tone: 1,
    studio: "Wit Studio / Kuroi Frame",
    malId: 16498, // Attack on Titan
    anilistId: 16498,
    tagline: "The ninth platform announces trains that stopped running in 1998.",
    synopsis:
      "The ninth platform announces trains that stopped running in 1998, and the night staff have learned not to answer.",
  },
  {
    slug: "iron-bloom",
    name: "Fullmetal Alchemist: Brotherhood",
    oldTitle: "Iron Bloom",
    kind: "Series",
    year: 2026,
    episodes: 64,
    runtimeMin: 24,
    genres: ["mecha", "drama"],
    tone: 2,
    studio: "Bones / Heavy Petal",
    malId: 5114, // Fullmetal Alchemist: Brotherhood
    anilistId: 5114,
    tagline: "Pilots grow their machines from seed. The harvest is the war.",
    synopsis:
      "Pilots grow their machines from seed in glasshouses the size of cities. The harvest is the war, and the war is late.",
  },
  {
    slug: "sakura-static",
    name: "Kaguya-sama: Love Is War",
    oldTitle: "Sakura Static",
    kind: "Series",
    year: 2024,
    episodes: 12, // Kaguya S1 (MAL 37999) = 12 (AniList); Zoko NO payload ep 13/24 (was 24 - 12 dead eps)
    runtimeMin: 24,
    genres: ["romance", "music"],
    tone: 3,
    studio: "A-1 Pictures / Petal Radio",
    malId: 37999, // Kaguya-sama
    anilistId: 101921,
    tagline: "Two bedroom producers share a wall, a sample pack and a deadline.",
    synopsis:
      "Two bedroom producers share a wall, a sample pack and a deadline. Everything they cannot say ends up in the mix.",
  },
  {
    slug: "cobalt-season",
    name: "Frieren: Beyond Journey's End",
    oldTitle: "Cobalt Season",
    kind: "Series",
    year: 2025,
    episodes: 28, // Frieren S1 = 28 (AniList); Zoko payload verified ep 26 & 28 (was 25)
    runtimeMin: 24,
    genres: ["fantasy", "adventure"],
    tone: 4,
    studio: "Madhouse / Blue Nine",
    malId: 52991, // Frieren: Beyond Journey's End
    anilistId: 154587,
    tagline: "An elven journey tracing the memories of a hero's party.",
    synopsis:
      "An elven mage embarks on a quiet voyage across the northern plateau to trace the steps of the companions who taught her human time.",
  },
  {
    slug: "moonlit-ramen",
    name: "Bocchi the Rock!",
    oldTitle: "Moonlit Ramen",
    kind: "Series",
    year: 2025,
    episodes: 12,
    runtimeMin: 24,
    genres: ["life", "music"],
    tone: 1,
    studio: "CloverWorks / Late Bowl",
    malId: 47917, // Bocchi the Rock!
    anilistId: 130003,
    tagline: "A six-seat counter, open only when the last train has gone.",
    synopsis:
      "A shy guitarist finds courage playing midnight sessions at a six-seat counter after the last train has gone.",
  },
  {
    slug: "the-last-train-to-aomori",
    name: "Rascal Does Not Dream of Bunny Girl Senpai",
    oldTitle: "The Last Train to Aomori",
    kind: "Series",
    year: 2026,
    episodes: 13,
    runtimeMin: 24,
    genres: ["romance", "drama"],
    tone: 2,
    studio: "CloverWorks / Verse Works",
    malId: 37450, // Rascal Does Not Dream of Bunny Girl Senpai
    anilistId: 101291,
    tagline: "Two people miss the same train every winter.",
    synopsis:
      "Two people miss the same train every winter as strange quantum anomalies alter the memories of the passengers.",
  },
  {
    slug: "paper-cranes-at-dawn",
    name: "A Silent Voice",
    oldTitle: "Paper Cranes at Dawn",
    kind: "Film",
    year: 2024,
    episodes: 1,
    runtimeMin: 130, // A Silent Voice = 2:09:42 (player duration 7783s; AniList 130; was 92)
    genres: ["life", "drama"],
    tone: 3,
    studio: "Kyoto Animation / Quiet Hour",
    malId: 28851, // A Silent Voice
    anilistId: 20954,
    tagline: "A hospital orderly folds one crane for every patient who leaves.",
    synopsis:
      "A heartwarming story of redemption, friendship, and signs that heal words left unspoken.",
  },
  {
    slug: "sea-of-stars",
    name: "Naruto",
    oldTitle: "Sea of Stars",
    kind: "Series",
    year: 2025,
    episodes: 220, // Naruto = 220 (AniList); Zoko payload verified ep 25 & 220 (was 24)
    runtimeMin: 24,
    genres: ["action", "fantasy"],
    tone: 1,
    studio: "Pierrot / Tide Atlas",
    malId: 20, // Naruto
    anilistId: 20,
    tagline: "A cartographer maps a sea that rearranges itself every night.",
    synopsis:
      "A ninja cartographer maps a sea that rearranges itself every night, and finds his own chakra signature on the first chart.",
  },
  {
    slug: "the-quiet-ward",
    name: "ERASED",
    oldTitle: "The Quiet Ward",
    kind: "Series",
    year: 2024,
    episodes: 12, // ERASED = 12 (AniList); Zoko payload verified ep 9 & 12 (was 8 - 4 missing)
    runtimeMin: 25,
    genres: ["horror", "mystery"],
    tone: 2,
    studio: "A-1 Pictures / Kuroi Frame",
    malId: 31043, // Erased
    anilistId: 21234,
    tagline: "The night shift files the same report, in the same hand, every week.",
    synopsis:
      "A struggling manga artist is sent back in time to prevent a series of tragedies from claiming his closest friends.",
  },
  {
    slug: "second-wind",
    name: "Solo Leveling",
    oldTitle: "Second Wind",
    kind: "Series",
    year: 2026,
    episodes: 12,
    runtimeMin: 23,
    genres: ["action", "fantasy"],
    tone: 3,
    studio: "A-1 Pictures / Blue Nine",
    malId: 52299, // Solo Leveling
    anilistId: 151807,
    tagline: "The weakest hunter reawakens with a system that grants limitless power.",
    synopsis:
      "After surviving a catastrophic double dungeon, Jinwoo awakens with a mysterious player system that only he can see.",
  },
  {
    slug: "deep-frame",
    name: "Chainsaw Man",
    oldTitle: "Deep Frame",
    kind: "Series",
    year: 2023,
    episodes: 12, // Chainsaw Man (MAL 44511) = 12 (AniList); Zoko NO payload ep 13/22 (was 22 - 10 dead eps)
    runtimeMin: 24,
    genres: ["action", "supernatural"],
    tone: 4,
    studio: "MAPPA / Heavy Petal",
    malId: 44511, // Chainsaw Man
    anilistId: 127230,
    tagline: "A young devil hunter fuses with his chainsaw canine.",
    synopsis:
      "Denji was living a depressed life debt-ridden until he merged with Pochita and joined Public Safety Special Division 4.",
  },
  {
    slug: "corner-store-hours",
    name: "Spy x Family",
    oldTitle: "Corner Store Hours",
    kind: "Series",
    year: 2025,
    episodes: 12, // SPY x FAMILY S1 (MAL 50265) = 12 (AniList); Zoko NO payload ep 13/24 (was 24 - 12 dead eps). Cour 2 (eps 13-25) streams separately as MAL 50602 / AniList 142838 — Next Ep continues there via TITLE_CONTINUATIONS in js/zoro-aizen.js.
    runtimeMin: 24,
    genres: ["comedy", "action"],
    tone: 1,
    studio: "Wit Studio / Late Bowl",
    malId: 50265, // Spy x Family
    anilistId: 140960,
    tagline: "A spy, an assassin, and a telepath form a temporary family.",
    synopsis:
      "Master spy Twilight must build a family for his mission, unaware that his wife is an assassin and his daughter reads minds.",
  },
  {
    slug: "encore-one-more",
    name: "Kaguya-sama: Love Is War – Ultra Romantic",
    oldTitle: "Encore, One More",
    /* Streams Kaguya-sama: Love is War -Ultra Romantic- (MAL 43608): a TV
       series of 13 episodes, ~24 min each — NOT a 101-minute film. Metadata
       must describe what the mapped mal_id actually plays. */
    kind: "Series",
    year: 2022,
    episodes: 13,
    runtimeMin: 24,
    genres: ["romance", "comedy"],
    tone: 2,
    studio: "A-1 Pictures",
    malId: 43608, // Kaguya-sama Ultra Romantic
    anilistId: 125367,
    tagline: "A touring band plays one last show in a hall scheduled for demolition.",
    synopsis:
      "The student council duel reaches its climactic cultural festival confession under a moonlit sky.",
  },
  {
    slug: "salt-and-cinder",
    name: "Attack on Titan: The Final Season Part 2",
    oldTitle: "Salt and Cinder",
    kind: "Series",
    year: 2024,
    episodes: 12, // MAL 48583 = AoT Final Season Part 2 = 12 (AniList 131681); Zoko NO payload ep 13/14/16 (was 16)
    runtimeMin: 24,
    genres: ["fantasy", "action"],
    tone: 3,
    studio: "Pierrot / Tide Atlas",
    malId: 48583, // Attack on Titan Final Season Part 2 - NOT Bleach TYBW (old comment was wrong; trust mal_id)
    anilistId: 114446,
    tagline: "The Soul Society faces an extermination war against the Wandenreich.",
    synopsis:
      "When the Quincy army emerges from the shadows, Ichigo Kurosaki enters the fray with newly forged dual blades.",
  },
];

/* Renamed slugs: old slug -> canonical slug. Old/bookmarked/shared links
   using a retired slug resolve to the same title instead of 404ing.
   paper-cranes was the pre-rename slug for A Silent Voice (malId 28851),
   now paper-cranes-at-dawn. */
export const SLUG_ALIASES = {
  "paper-cranes": "paper-cranes-at-dawn",
};

export function resolveSlug(slug) {
  return SLUG_ALIASES[slug] || slug;
}
