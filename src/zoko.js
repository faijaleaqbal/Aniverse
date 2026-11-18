/**
 * ZokoAnime embed URL builder (server side).
 *
 * Embed URL format (official spec):
 *   https://zokoanime.video/stream/{source}/{id}/{episode}/{track}
 *
 * Optional query params (the only ones that exist):
 *   ?color=<hex without #>  ?autoplay=0|1  ?autoskip=0|1  ?autonext=0|1  ?t=<seconds>
 *
 * There is NO "server" parameter - sub/dub is the {track} path segment.
 */

export const ZOKO_SOURCES = ["mal", "anilist"];
export const ZOKO_TRACKS = ["sub", "hsub", "dub"];

function clampHex(color) {
  return String(color || "").replace(/^#/, "").trim().toLowerCase();
}

/**
 * @param {object} opts
 * @param {string} opts.origin       embed origin, e.g. "https://zokoanime.video"
 * @param {string} opts.source       "mal" | "anilist"
 * @param {number} opts.id           numeric MAL / AniList id
 * @param {number} opts.episode      episode number
 * @param {string} opts.track        "sub" | "hsub" | "dub"
 * @param {string} [opts.color]      accent color hex without "#"
 * @param {boolean} [opts.autoplay]  default true
 * @param {boolean} [opts.autoskip]  default true
 * @param {boolean} [opts.autonext]  default true
 * @param {number}  [opts.startTime] resume position in seconds
 */
export function buildEmbedUrl(opts = {}) {
  const {
    origin,
    source = "mal",
    id,
    episode,
    track = "sub",
    color,
    autoplay = true,
    autoskip = true,
    autonext = true,
    startTime,
  } = opts;

  if (!origin) throw new Error("ZokoAnime embed origin is not configured.");

  const src = String(source).toLowerCase();
  if (!ZOKO_SOURCES.includes(src)) throw new Error(`Unsupported ZokoAnime source: ${source}`);

  const trk = String(track).toLowerCase();
  if (!ZOKO_TRACKS.includes(trk)) throw new Error(`Unsupported ZokoAnime track: ${track}`);

  const numericId = Number(id);
  const numericEp = Number(episode);
  if (!Number.isFinite(numericId) || numericId <= 0) throw new Error("A numeric anime id is required.");
  if (!Number.isFinite(numericEp) || numericEp <= 0) throw new Error("A numeric episode number is required.");

  const base = `${String(origin).replace(/\/+$/, "")}/stream/${src}/${Math.trunc(numericId)}/${Math.trunc(numericEp)}/${trk}`;

  const params = new URLSearchParams();
  const hex = clampHex(color);
  if (hex) params.set("color", hex);
  params.set("autoplay", autoplay ? "1" : "0");
  params.set("autoskip", autoskip ? "1" : "0");
  params.set("autonext", autonext ? "1" : "0");

  const t = Number(startTime);
  if (Number.isFinite(t) && t > 0) params.set("t", Math.floor(t));

  return `${base}?${params.toString()}`;
}
