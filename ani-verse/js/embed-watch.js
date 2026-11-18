/**
 * Watch page player UI (ZokoAnime embed).
 *
 * Owns everything around the embed iframe:
 *  - embed loading / track switching / settings toggles
 *  - auto-next, continue watching (resume), toasts, error + retry
 *  - fullscreen that survives an episode swap
 *  - episode navigation + keyboard shortcuts
 *
 * The player itself lives inside the iframe - no video element, no library.
 */
(function (global) {
  "use strict";

  const Z = global.ZokoPlayer;
  if (!Z) {
    console.error("[zoko] zoko-player.js must be loaded before zoko-watch.js");
    return;
  }

  const RESUME_MIN_SEC = 30; // below this we just start the episode from the top
  const RESUME_MAX_RATIO = 0.95; // above this the episode is basically finished
  const SAVE_THROTTLE_MS = 5000;

  let controller = null;
  let ctx = null;
  let settings = null;
  let currentEp = 1;
  let episodes = [];
  let lastPosition = 0;
  let lastDuration = 0;
  let lastPaused = true;
  let lastSaveAt = 0;
  let readyReceived = false;

  /* -------------------------------------------------------------------
     DOM helpers
     ------------------------------------------------------------------- */

  const $ = (id) => document.getElementById(id);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /* -------------------------------------------------------------------
     Toasts
     ------------------------------------------------------------------- */

  function toast(message, kind) {
    const host = $("zoko-toasts");
    if (!host) return;
    const node = el("div", `zoko-toast zoko-toast-${kind || "info"}`, message);
    host.appendChild(node);
    setTimeout(() => {
      node.classList.add("is-leaving");
      setTimeout(() => node.remove(), 320);
    }, 2600);
  }

  /* -------------------------------------------------------------------
     Player overlay (finished / error / retry)
     ------------------------------------------------------------------- */

  function showOverlay(title, text, actionLabel, onAction) {
    const overlay = $("zoko-player-overlay");
    if (!overlay) return;
    const titleEl = $("zoko-overlay-title");
    const textEl = $("zoko-overlay-text");
    const actionBtn = $("zoko-overlay-action");
    if (titleEl) titleEl.textContent = title;
    if (textEl) textEl.textContent = text;
    if (actionBtn) {
      actionBtn.textContent = actionLabel || "";
      actionBtn.hidden = !actionLabel;
      actionBtn.onclick = () => {
        hideOverlay();
        if (typeof onAction === "function") onAction();
      };
    }
    overlay.hidden = false;
    overlay.classList.add("is-visible");
  }

  function hideOverlay() {
    const overlay = $("zoko-player-overlay");
    if (!overlay) return;
    overlay.classList.remove("is-visible");
    overlay.hidden = true;
  }

  function showSpinner(show) {
    const spinner = $("zoko-player-spinner");
    if (!spinner) return;
    spinner.hidden = !show;
    spinner.classList.toggle("is-visible", !!show);
  }

  function showResumeNote(seconds) {
    const note = $("zoko-resume-note");
    if (!note) return;
    if (!seconds || seconds <= 0) {
      note.hidden = true;
      note.textContent = "";
      return;
    }
    note.hidden = false;
    note.textContent = `Resumed from ${Z.formatSecs(seconds)}`;
    setTimeout(() => {
      note.hidden = true;
    }, 6000);
  }

  /* -------------------------------------------------------------------
     Episode / anime helpers
     ------------------------------------------------------------------- */

  function episodeList() {
    return Array.isArray(episodes) ? episodes : [];
  }

  function episodeNumbers() {
    return episodeList()
      .map((ep) => Number(ep.ep_num))
      .filter((n) => Number.isFinite(n));
  }

  function currentAnimeId() {
    const title = (ctx && ctx.title) || {};
    const source = settings.source === "anilist" ? "anilist" : "mal";
    const override = ctx.slug ? Z.getIdOverride(ctx.slug) : null;
    const id = source === "anilist" ? Number(title.anilistId) : Number(title.malId);
    if (override && override.malId) return override.malId;
    return id;
  }

  function nextEpisodeNumber() {
    const nums = episodeNumbers().filter((n) => n > currentEp);
    return nums.length ? nums[0] : null;
  }

  function prevEpisodeNumber() {
    const nums = episodeNumbers().filter((n) => n < currentEp);
    return nums.length ? nums[nums.length - 1] : null;
  }

  function episodeMeta(number) {
    return episodeList().find((ep) => Number(ep.ep_num) === Number(number)) || null;
  }

  /* -------------------------------------------------------------------
     Progress (localStorage)
     ------------------------------------------------------------------- */

  function saveProgress(position, duration) {
    if (!ctx || !ctx.slug) return;
    const meta = episodeMeta(currentEp);
    Z.setProgress(ctx.slug, currentEp, position, duration, {
      name: (ctx.title && ctx.title.name) || "",
      episodeTitle: (meta && meta.title) || "",
      episodeCount: episodeNumbers().length,
    });
  }

  function resumePoint() {
    if (!ctx || !ctx.slug) return 0;
    const saved = Z.getProgress(ctx.slug, currentEp);
    if (!saved) return 0;
    const pos = Number(saved.position) || 0;
    const dur = Number(saved.duration) || 0;
    if (pos < RESUME_MIN_SEC) return 0;
    if (dur > 0 && pos > dur * RESUME_MAX_RATIO) return 0;
    return pos;
  }

  /* -------------------------------------------------------------------
     Loading episodes
     ------------------------------------------------------------------- */

  function currentUrl() {
    const id = currentAnimeId();
    if (!Number.isFinite(id) || id <= 0) return "";
    const resumeAt = resumePoint();
    return Z.buildEmbedUrl({
      source: settings.source,
      id,
      episode: currentEp,
      track: settings.track,
      color: Z.readThemeColor() || Z.getEmbedConfig().defaultColor,
      autoplay: settings.autoplay,
      autoskip: settings.autoskip,
      autonext: settings.autonext,
      startTime: resumeAt,
    });
  }

  /** Swap the iframe source for an episode. Never reloads the page. */
  function loadEpisode(number, options) {
    const opts = options || {};
    const target = Number(number);
    if (!Number.isFinite(target) || target <= 0) return false;

    currentEp = target;
    readyReceived = false;
    lastPosition = 0;
    lastDuration = 0;
    hideOverlay();
    showSpinner(true);

    const resumeAt = opts.resume === false ? 0 : resumePoint();
    const url = currentUrl();
    if (!url) {
      showSpinner(false);
      showOverlay(
        "Missing anime id",
        "This title has no MyAnimeList / AniList id yet. Use “Switch Anime MAL ID” to set one.",
        "Close"
      );
      return false;
    }

    controller.load(url);
    showResumeNote(resumeAt);
    updateEpisodeUi();
    syncUrl();
    return true;
  }

  function syncUrl() {
    try {
      const params = new URLSearchParams(global.location.search);
      params.set("slug", ctx.slug);
      params.set("ep", String(currentEp));
      global.history.replaceState(null, "", `${global.location.pathname}?${params.toString()}`);
    } catch {
      /* history is not essential */
    }
  }

  /* -------------------------------------------------------------------
     UI sync
     ------------------------------------------------------------------- */

  function updateEpisodeUi() {
    const grid = $("zoro-episodes-grid");
    if (grid) {
      grid.querySelectorAll(".ep-number-btn, .ep-btn").forEach((btn) => {
        btn.classList.toggle("active", Number(btn.dataset.ep) === currentEp);
      });
    }

    const meta = episodeMeta(currentEp);
    const subtitle = $("watch-ep-subtitle");
    if (subtitle) {
      subtitle.textContent = meta && meta.title
        ? `Episode ${currentEp}: ${meta.title}`
        : `Episode ${currentEp}`;
    }

    const prevBtn = $("btn-prev-ep");
    const nextBtn = $("btn-next-ep");
    const prev = prevEpisodeNumber();
    const next = nextEpisodeNumber();
    if (prevBtn) prevBtn.disabled = !prev;
    if (nextBtn) nextBtn.disabled = !next;

    if (typeof ctx.onEpisodeChange === "function") {
      ctx.onEpisodeChange(currentEp, { prev, next, meta });
    }
  }

  function renderEpisodeGrid() {
    const grid = $("zoro-episodes-grid");
    if (!grid) return;
    const nums = episodeNumbers();
    const total = nums.length || Number((ctx.title && ctx.title.episodes) || 0);
    const list = nums.length ? nums : Array.from({ length: total }, (_, i) => i + 1);

    grid.innerHTML = list
      .map((num) => `<button class="ep-number-btn ${num === currentEp ? "active" : ""}" data-ep="${num}" type="button">${num}</button>`)
      .join("");

    grid.querySelectorAll(".ep-number-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        loadEpisode(Number(btn.dataset.ep));
      });
    });

    // Keep the range tab label in sync with the real episode list.
    const rangeTab = document.querySelector(".ep-tab-btn");
    if (rangeTab && list.length) {
      rangeTab.textContent = `${String(list[0]).padStart(3, "0")} - ${String(list[list.length - 1]).padStart(3, "0")}`;
    }
  }

  function syncTrackButtons() {
    const switcher = $("zoko-track-switcher");
    if (!switcher) return;
    switcher.querySelectorAll("[data-track]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.track === settings.track);
    });
  }

  function syncSettingToggles() {
    const holder = $("zoko-setting-toggles");
    if (!holder) return;
    holder.querySelectorAll("[data-setting]").forEach((input) => {
      input.checked = settings[input.dataset.setting] !== false;
    });
  }

  /* -------------------------------------------------------------------
     Fullscreen (survives episode swaps because the WRAP is fullscreen)
     ------------------------------------------------------------------- */

  function isFullscreen() {
    const wrap = $("player-wrap");
    return !!(wrap && document.fullscreenElement === wrap);
  }

  function reportFullscreenState() {
    if (!controller) return;
    controller.send("fullscreen", { active: isFullscreen() });
  }

  function toggleFullscreen() {
    const wrap = $("player-wrap");
    if (!wrap) return;
    if (document.fullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    } else if (wrap.requestFullscreen) {
      wrap.requestFullscreen().catch(() => {});
    }
  }

  /* -------------------------------------------------------------------
     Playback commands
     ------------------------------------------------------------------- */

  function togglePlayPause() {
    if (!controller) return;
    if (lastPaused) {
      controller.send("play");
    } else {
      controller.send("pause");
    }
  }

  function seekBy(delta) {
    if (!controller) return;
    const base = Number(lastPosition) || 0;
    const next = Math.max(0, base + delta);
    controller.send("seek", { time: Math.floor(next) });
  }

  function onProgressEvent(position, duration) {
    lastPosition = Number(position) || 0;
    if (Number.isFinite(Number(duration)) && Number(duration) > 0) lastDuration = Number(duration);

    const fill = $("video-progress-fill");
    const track = $("video-progress-track");
    const timeText = $("video-time-text");
    if (fill && lastDuration > 0) {
      fill.style.width = `${Math.min(100, (lastPosition / lastDuration) * 100)}%`;
    }
    if (track) {
      track.setAttribute("data-percent", lastDuration > 0 ? String((lastPosition / lastDuration) * 100) : "0");
    }
    if (timeText) {
      timeText.textContent = `${Z.formatSecs(lastPosition)} / ${Z.formatSecs(lastDuration)}`;
    }

    const now = Date.now();
    if (now - lastSaveAt >= SAVE_THROTTLE_MS) {
      lastSaveAt = now;
      saveProgress(lastPosition, lastDuration);
      if (typeof ctx.onProgress === "function") ctx.onProgress(lastPosition, lastDuration);
    }
  }

  /* -------------------------------------------------------------------
     Wiring
     ------------------------------------------------------------------- */

  function trackLabel(track) {
    if (track === "dub") return "Dub";
    if (track === "hsub") return "Hard-sub";
    return "Sub";
  }

  function wireTrackSwitcher() {
    const switcher = $("zoko-track-switcher");
    if (!switcher) return;
    switcher.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-track]");
      if (!btn) return;
      const track = btn.dataset.track;
      if (!Z.TRACKS.includes(track) || track === settings.track) return;
      settings = Z.saveSettings({ track });
      syncTrackButtons();
      loadEpisode(currentEp);
      toast(`Switched to ${trackLabel(track)}`, "info");
    });
  }

  function wireSettingToggles() {
    const holder = $("zoko-setting-toggles");
    if (!holder) return;
    holder.addEventListener("change", (event) => {
      const input = event.target.closest("[data-setting]");
      if (!input) return;
      const key = input.dataset.setting;
      const on = !!input.checked;
      settings = Z.saveSettings({ [key]: on });
      if (controller) controller.send(key, { on });
      if (key === "autonext") {
        toast(on ? "Auto-next episode on" : "Auto-next episode off", "info");
      } else if (key === "autoskip") {
        toast(on ? "Auto-skip intro/outro on" : "Auto-skip intro/outro off", "info");
      } else if (key === "autoplay") {
        toast(on ? "Autoplay on" : "Autoplay off", "info");
      }
    });
  }

  function wireEpisodeNav() {
    const prevBtn = $("btn-prev-ep");
    const nextBtn = $("btn-next-ep");
    if (prevBtn) {
      prevBtn.onclick = () => {
        const prev = prevEpisodeNumber();
        if (prev) loadEpisode(prev);
      };
    }
    if (nextBtn) {
      nextBtn.onclick = () => {
        const next = nextEpisodeNumber();
        if (next) loadEpisode(next);
      };
    }
  }

  function wirePlayerBar() {
    const playPauseBtn = $("btn-player-playpause");
    if (playPauseBtn) {
      playPauseBtn.onclick = () => togglePlayPause();
    }

    const skipBack = $("btn-skip-back");
    if (skipBack) skipBack.onclick = () => seekBy(-10);
    const skipForward = $("btn-skip-forward");
    if (skipForward) skipForward.onclick = () => seekBy(10);

    const fsBtn = $("btn-fullscreen");
    if (fsBtn) fsBtn.onclick = () => toggleFullscreen();

    const track = $("video-progress-track");
    if (track) {
      track.onclick = (event) => {
        const rect = track.getBoundingClientRect();
        const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
        if (!lastDuration) return;
        controller.send("seek", { time: Math.floor(ratio * lastDuration) });
      };
    }
  }

  function wireCover() {
    const cover = $("video-cover-overlay");
    if (!cover) return;
    cover.addEventListener("click", () => {
      if (!readyReceived) loadEpisode(currentEp);
    });
  }

  function wireKeyboard() {
    document.addEventListener("keydown", (event) => {
      const tag = (event.target && event.target.tagName) || "";
      if (["INPUT", "TEXTAREA", "SELECT"].includes(tag)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      if (event.code === "Space" || event.key === " ") {
        event.preventDefault();
        togglePlayPause();
      } else if (event.key === "f" || event.key === "F") {
        event.preventDefault();
        toggleFullscreen();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        seekBy(10);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        seekBy(-10);
      }
    });
  }

  function wireFullscreenChange() {
    document.addEventListener("fullscreenchange", reportFullscreenState);
  }

  /* -------------------------------------------------------------------
     Player events
     ------------------------------------------------------------------- */

  function wirePlayerEvents() {
    controller.on("ready", () => {
      readyReceived = true;
      showSpinner(false);
      const cover = $("video-cover-overlay");
      if (cover) cover.classList.add("is-playing");
      reportFullscreenState();
    });

    controller.on("play", () => {
      lastPaused = false;
      const btn = $("btn-player-playpause");
      if (btn) btn.textContent = "❚❚";
    });

    controller.on("pause", () => {
      lastPaused = true;
      const btn = $("btn-player-playpause");
      if (btn) btn.textContent = "▶";
    });

    controller.on("state", (msg) => {
      if (typeof msg.paused === "boolean") {
        lastPaused = msg.paused;
        const btn = $("btn-player-playpause");
        if (btn) btn.textContent = lastPaused ? "▶" : "❚❚";
      }
      if (Number.isFinite(Number(msg.position))) lastPosition = Number(msg.position);
      if (Number.isFinite(Number(msg.duration)) && Number(msg.duration) > 0) lastDuration = Number(msg.duration);
    });

    controller.on("time", (msg) => {
      onProgressEvent(msg.position, msg.duration);
    });

    controller.on("watching-log", (msg) => {
      onProgressEvent(msg.currentTime, msg.duration);
    });

    controller.on("seeked", (msg) => {
      onProgressEvent(msg.position, msg.duration);
    });

    controller.on("skipped", (msg) => {
      const name = msg && msg.name === "outro" ? "outro" : "intro";
      toast(`Skipped ${name}`, "info");
    });

    controller.on("fullscreen", (msg) => {
      if (!msg) return;
      if (msg.request === "enter") {
        const wrap = $("player-wrap");
        if (wrap && wrap.requestFullscreen && document.fullscreenElement !== wrap) {
          wrap.requestFullscreen().catch(() => {});
        }
      } else if (msg.request === "exit") {
        if (document.fullscreenElement && document.exitFullscreen) {
          document.exitFullscreen().catch(() => {});
        }
      }
    });

    controller.on("ended", (msg) => {
      // Episode finished - drop the saved progress for this episode.
      if (ctx && ctx.slug) Z.clearProgress(ctx.slug, currentEp);
      if (typeof ctx.onProgress === "function") ctx.onProgress(0, 0);

      const autoNext = msg && typeof msg.auto_next === "boolean" ? msg.auto_next : settings.autonext;
      const next = nextEpisodeNumber();
      if (autoNext && next) {
        toast(`Next: Episode ${next}`, "info");
        loadEpisode(next);
      } else if (!next) {
        showOverlay("You finished this anime", "That was the last episode. Enjoy the next one!", "Close");
        showSpinner(false);
      } else {
        toast("Episode finished", "info");
      }
    });

    controller.on("complete", () => {
      // Kept for parity with "ended"; the actual transition happens on "ended".
    });

    controller.on("error", (msg) => {
      showSpinner(false);
      const reason = msg && msg.reason;
      if (reason === "sandboxed") {
        showOverlay(
          "Player blocked: remove sandbox",
          "The ZokoAnime player cannot run inside a sandboxed iframe. Remove the sandbox attribute and reload.",
          "Close"
        );
        toast("Player blocked: remove sandbox", "error");
        return;
      }
      showOverlay(
        "Stream failed",
        (msg && msg.message) || "The player reported an error while loading this episode.",
        "Retry",
        () => {
          const iframe = $("zoko-embed-frame");
          if (!iframe) return;
          const url = iframe.getAttribute("src") || currentUrl();
          iframe.setAttribute("src", "about:blank");
          setTimeout(() => {
            iframe.setAttribute("src", url);
            showSpinner(true);
          }, 60);
        }
      );
      toast("Stream failed", "error");
    });
  }

  /* -------------------------------------------------------------------
     Public API
     ------------------------------------------------------------------- */

  function init(options) {
    ctx = options || {};
    if (!ctx.iframe) ctx.iframe = $("zoko-embed-frame");
    if (!ctx.iframe) {
      console.error("[zoko] embed iframe not found");
      return null;
    }

    episodes = Array.isArray(ctx.episodes) ? ctx.episodes : [];
    currentEp = Number(ctx.episode) || 1;
    settings = Z.loadSettings();

    try {
      controller = Z.createPlayerController(ctx.iframe, { origin: Z.getEmbedConfig().origin });
    } catch (err) {
      console.error("[zoko]", err);
      showOverlay("Player unavailable", String(err && err.message ? err.message : err), "Close");
      return null;
    }

    ctx.iframe.addEventListener("load", reportFullscreenState);

    wirePlayerEvents();
    wireTrackSwitcher();
    wireSettingToggles();
    wireEpisodeNav();
    wirePlayerBar();
    wireCover();
    wireKeyboard();
    wireFullscreenChange();

    syncTrackButtons();
    syncSettingToggles();
    renderEpisodeGrid();
    updateEpisodeUi();

    loadEpisode(currentEp);

    return {
      controller,
      destroy() {
        if (controller) controller.destroy();
        controller = null;
      },
      loadEpisode,
      get episode() {
        return currentEp;
      },
      get settings() {
        return settings;
      },
    };
  }

  global.ZokoWatchUI = { init };
})(window);
