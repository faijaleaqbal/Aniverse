/**
 * MAL-id overrides for live AniList titles that have NO idMal.
 *
 * Why this exists: AniList returns `idMal: null` for a handful of titles
 * (music videos, some Chinese ONAs, a couple of specials). Those titles can
 * never be streamed by the site's players, because every player route is keyed
 * by an id — and Zoko's /stream/anilist/<id>/ route is DEAD upstream
 * (HTTP 404 for every id probed, including valid ones). A no-MAL title was
 * therefore a guaranteed-404 embed on every surface.
 *
 * Each entry below was resolved against Kitsu (search by title, matched on
 * title + format + episode count, then the `myanimelist/anime` mapping read
 * from /api/edge/anime/{kitsuId}/mappings) and is verified by probing
 * https://zokoanime.video/stream/mal/<id>/1/sub for the `window.__P=` player
 * payload. Entries WITHOUT a verified MAL id are deliberately absent — the
 * site must not invent one.
 *
 * The map is applied in anilist.js mediaView() ONLY when `media.idMal` is
 * null, so a real AniList idMal always wins and a future AniList change can
 * never be overridden by this file.
 *
 * Verified 2026-11-22:
 *   149939 Ranma ½ (1989)                      -> 210   (Kitsu 186)
 *   206425 Sousou no Frieren: ●● no Mahou Part 3 -> 56885 (Kitsu 48105)
 *   2627   Oshougatsu da yo! Doraemon           -> 2627  (Kitsu 2391; Zoko
 *          has no file for this MAL id — the mapping is real, the player
 *          simply does not carry the title)
 *
 * Deliberately NOT in the map (no real MAL entry / no verified stream):
 *   186337 Taxi to the Moon (MUSIC), 213317 Roman Jet Charisma (MUSIC) —
 *     Kitsu has no matching entry (the only hits are unrelated titles).
 *   168164 Dou Po Cangqiong: Nian Fan 3 (ONA, 52 eps) — Kitsu 48063 exists
 *     and its AniList mapping is 168164 (a positive identity match), but it
 *     has NO myanimelist/anime mapping, so no MAL id is asserted.
 *   131867 Fate/Grand Order × Thunderbolt Fantasy 3 (ONA) — Kitsu 44280,
 *     same situation (AniList 131867 only, no MAL mapping).
 *
 * An override is a pure id fix: it lets the site build the correct player
 * URL. It never claims the title streams — the watch page still reports an
 * honest "not available" state when no player answers.
 */
export const MAL_ID_OVERRIDES = {
  149939: 210,
  206425: 56885,
  2627: 2627,
};

/* True when an AniList id has a MAL override. Exported for tests. */
export function malIdOverride(anilistId) {
  const key = Number(anilistId);
  if (!Number.isFinite(key)) return null;
  const hit = MAL_ID_OVERRIDES[key];
  return hit != null ? Number(hit) : null;
}
