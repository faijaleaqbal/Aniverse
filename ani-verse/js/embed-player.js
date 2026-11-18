/**
 * ZokoAnime embed player core.
 *
 * Responsibilities:
 *  - buildEmbedUrl(): official embed URL builder
 *  - createPlayerController(iframe): postMessage protocol (events + commands)
 *  - localStorage stores: player settings, watch progress, per-anime id overrides
 *
 * Loaded as a classic script before zoko-watch.js; exposes window.ZokoPlayer.
 */
(function (global) {
  "use strict";

  const CHANNEL = "zokoanime";

  const LS_SETTINGS = "av_zoko_settings";
  const LS_PROGRESS = "av_zoko_progress";
  const LS_IDS = "av_zoko_ids";

  const SOURCES = ["mal", "anilist"];
  const TRACKS = ["sub", "hsub", "dub"];

  const DEFAULT_SETTINGS = {
    source: "mal",
    track: "sub",
    autoplay: true,
    autoskip: true,
    autonext: true,
  };

  /* ---------------------------------------------------------------------
     Storage helpers (never throw - private mode / disabled storage)
     --------------------------------------------------------------------- */

  function readJSON(key, fallback) {
    try {
      const raw = global.localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      global.localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  /* ---------------------------------------------------------------------
     Embed configuration (origin / defaults come from the server config)
     --------------------------------------------------------------------- */

  let embedConfig = {
    origin: "",
    source: DEFAULT_SETTINGS.source,
    defaultTrack: DEFAULT_SETTINGS.track,
    defaultColor: "",
    autoplay: true,
    autoskip: true,
    autonext: true,
  };

  function setEmbedConfig(config) {
    embedConfig = Object.assign({}, embedConfig, config || {});
    if (!embedConfig.source || !SOURCES.includes(embedConfig.source)) {
      embedConfig.source = DEFAULT_SETTINGS.source;
    }
    if (!embedConfig.defaultTrack || !TRACKS.includes(embedConfig.defaultTrack)) {
      embedConfig.defaultTrack = DEFAULT_SETTINGS.track;
    }
    return getEmbedConfig();
  }

  function getEmbedConfig() {
    return Object.assign({}, embedConfig);
  }

  /* ---------------------------------------------------------------------
     Settings + id overrides
     --------------------------------------------------------------------- */

  function loadSettings() {
    const stored = readJSON(LS_SETTINGS, {});
    const cfg = getEmbedConfig();
    const settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      {
        source: cfg.source,
        track: cfg.defaultTrack,
        autoplay: cfg.autoplay !== false,
        autoskip: cfg.autoskip !== false,
        autonext: cfg.autonext !== false,
      },
      stored || {}
    );

    if (!SOURCES.includes(settings.source)) settings.source = DEFAULT_SETTINGS.source;
    if (!TRACKS.includes(settings.track)) settings.track = DEFAULT_SETTINGS.track;
    settings.autoplay = settings.autoplay !== false;
    settings.autoskip = settings.autoskip !== false;
    settings.autonext = settings.autonext !== false;
    return settings;
  }

  function saveSettings(settings) {
    const next = Object.assign({}, loadSettings(), settings || {});
    writeJSON(LS_SETTINGS, next);
    return next;
  }

  function getIdOverrides() {
    return readJSON(LS_IDS, {});
  }

  /** Per-anime MAL/AniList id override (ids are never guessed - the user sets them). */
  function getIdOverride(slug) {
    const all = getIdOverrides();
    return all && all[slug] ? all[slug] : null;
  }

  function setIdOverride(slug, malId) {
    const all = getIdOverrides();
    const id = Number(malId);
    if (!slug || !Number.isFinite(id) || id <= 0) return null;
    all[slug] = { malId: Math.trunc(id), updatedAt: new Date().toISOString() };
    writeJSON(LS_IDS, all);
    return all[slug];
  }

  function clearIdOverride(slug) {
    const all = getIdOverrides();
    delete all[slug];
    writeJSON(LS_IDS, all);
  }

  /* ---------------------------------------------------------------------
     Watch progress (localStorage)
     --------------------------------------------------------------------- */

  function progressKey(slug, episode) {
    return `${slug}::${Number(episode)}`;
  }

  function listProgress() {
    const all = readJSON(LS_PROGRESS, {});
    return Object.keys(all)
      .map((key) => Object.assign({ key }, all[key]))
      .filter((entry) => entry && entry.slug && Number.isFinite(Number(entry.position)))
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  }

  function getProgress(slug, episode) {
    const all = readJSON(LS_PROGRESS, {});
    return all[progressKey(slug, episode)] || null;
  }

  function setProgress(slug, episode, position, duration, meta) {
    const all = readJSON(LS_PROGRESS, {});
    const pos = Math.max(0, Math.floor(Number(position) || 0));
    const dur = Math.max(0, Math.floor(Number(duration) || 0));
    if (!slug || pos <= 0) return null;

    all[progressKey(slug, episode)] = Object.assign(
      {
        slug,
        episode: Number(episode),
        position: pos,
        duration: dur,
        updatedAt: new Date().toISOString(),
      },
      meta || {}
    );
    writeJSON(LS_PROGRESS, all);
    return all[progressKey(slug, episode)];
  }

  function clearProgress(slug, episode) {
    const all = readJSON(LS_PROGRESS, {});
    delete all[progressKey(slug, episode)];
    writeJSON(LS_PROGRESS, all);
  }

  /* ---------------------------------------------------------------------
     Theme color (accent picked up from the site's CSS variables)
     --------------------------------------------------------------------- */

  function rgbToHex(value) {
    const match = String(value || "").match(/rgba?\(([^)]+)\)/);
    if (!match) return "";
    const parts = match[1].split(",").map((part) => parseFloat(part.trim()));
    if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return "";
    return parts
      .slice(0, 3)
      .map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0"))
      .join("");
  }

  /** Reads --zoro-lime from the live theme so the player matches the site. */
  function readThemeColor() {
    try {
      const styles = global.getComputedStyle(document.documentElement);
      const raw = styles.getPropertyValue("--zoro-lime").trim();
      if (!raw) return "";
      if (raw.startsWith("#")) return raw.slice(1).toLowerCase();
      return rgbToHex(raw);
    } catch {
      return "";
    }
  }

  /* ---------------------------------------------------------------------
     URL builder
     --------------------------------------------------------------------- */

  /**
   * buildEmbedUrl({ source, id, episode, track, color, autoplay, autoskip,
   *                 autonext, startTime })
   *
   * https://{origin}/stream/{source}/{id}/{episode}/{track}?color=&autoplay=
   *   &autoskip=&autonext=&t=
   */
  function buildEmbedUrl(options) {
    const opts = options || {};
    const cfg = getEmbedConfig();
    const origin = opts.origin || cfg.origin;
    if (!origin) throw new Error("ZokoAnime embed origin is not configured.");

    const source = String(opts.source || cfg.source || DEFAULT_SETTINGS.source).toLowerCase();
    if (!SOURCES.includes(source)) throw new Error(`Unsupported ZokoAnime source: ${opts.source}`);

    const track = String(opts.track || cfg.defaultTrack || DEFAULT_SETTINGS.track).toLowerCase();
    if (!TRACKS.includes(track)) throw new Error(`Unsupported ZokoAnime track: ${opts.track}`);

    const id = Number(opts.id);
    const episode = Number(opts.episode);
    if (!Number.isFinite(id) || id <= 0) throw new Error("A numeric anime id is required.");
    if (!Number.isFinite(episode) || episode <= 0) throw new Error("A numeric episode number is required.");

    const base = `${String(origin).replace(/\/+$/, "")}/stream/${source}/${Math.trunc(id)}/${Math.trunc(episode)}/${track}`;

    const params = new URLSearchParams();
    const color = String(opts.color || cfg.defaultColor || "").replace(/^#/, "").trim();
    if (color) params.set("color", color);
    params.set("autoplay", opts.autoplay === false ? "0" : "1");
    params.set("autoskip", opts.autoskip === false ? "0" : "1");
    params.set("autonext", opts.autonext === false ? "0" : "1");

    const t = Number(opts.startTime);
    if (Number.isFinite(t) && t > 0) params.set("t", Math.floor(t));

    return `${base}?${params.toString()}`;
  }

  /* ---------------------------------------------------------------------
     Player controller (postMessage protocol)
     -------------------------------------------------------------------*/

  /**
   * createPlayerController(iframe, { origin })
   * -> { send, on, off, load, destroy, origin }
   */
  function createPlayerController(iframe, options) {
    const opts = options || {};
    const origin = opts.origin || getEmbedConfig().origin;
    if (!origin) throw new Error("ZokoAnime embed origin is not configured.");

    const handlers = new Map();

    function onMessage(event) {
      // Hard security gate: only messages from the embed origin, only our channel.
      if (event.origin !== origin) return;
      const msg = event.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.channel !== CHANNEL) return;
      if (typeof msg.type !== "string") return;

      const typed = handlers.get(msg.type);
      if (typed) typed.slice().forEach((fn) => fn(msg));
      const any = handlers.get("*");
      if (any) any.slice().forEach((fn) => fn(msg));
    }

    global.addEventListener("message", onMessage);

    function on(type, handler) {
      if (typeof handler !== "function") return () => {};
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(handler);
      return () => off(type, handler);
    }

    function off(type, handler) {
      const list = handlers.get(type);
      if (!list) return;
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    }

    /** Send a command to the player (queued by the player when not ready yet). */
    function send(type, payload) {
      if (!iframe || !iframe.contentWindow) return false;
      const message = Object.assign({ channel: CHANNEL, type }, payload || {});
      iframe.contentWindow.postMessage(message, origin);
      return true;
    }

    /** Swap the player source (episode / track change) without reloading the page. */
    function load(url) {
      if (!iframe || !url) return false;
      iframe.src = url;
      return true;
    }

    function destroy() {
      global.removeEventListener("message", onMessage);
      handlers.clear();
    }

    return { send, on, off, load, destroy, origin };
  }

  /* ---------------------------------------------------------------------
     Misc helpers
     ------------------------------------------------------------------- */

  function formatSecs(sec) {
    let s = Number(sec);
    if (!Number.isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const rest = Math.floor(s % 60);
    return `${m < 10 ? "0" + m : m}:${rest < 10 ? "0" + rest : rest}`;
  }

  global.ZokoPlayer = {
    CHANNEL,
    SOURCES,
    TRACKS,
    setEmbedConfig,
    getEmbedConfig,
    buildEmbedUrl,
    createPlayerController,
    loadSettings,
    saveSettings,
    listProgress,
    getProgress,
    setProgress,
    clearProgress,
    getIdOverride,
    setIdOverride,
    clearIdOverride,
    readThemeColor,
    formatSecs,
  };
})(window);
