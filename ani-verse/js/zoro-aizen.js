(function () {
  "use strict";

  document.addEventListener(
    "keydown",
    (e) => {
      const mod = e.ctrlKey || e.metaKey; // Ctrl on Windows/Linux, Cmd on Mac
      const key = e.key || "";
      const isDevToolsKey =
        key === "F12" ||
        e.keyCode === 123 || // F12 fallback
        (mod &&
          e.shiftKey &&
          (key === "I" || key === "i" || key === "J" || key === "j" || key === "C" || key === "c")) ||
        (mod && (key === "U" || key === "u")); // View source
      if (isDevToolsKey) {
        e.preventDefault();
        e.stopPropagation();
        return false;
      }
    },
    true
  );

  document.addEventListener("contextmenu", (e) => e.preventDefault(), true);

  // Docked-DevTools detector (desktop only). On touch devices the
  // browser's own UI (address bar, bottom toolbar) makes
  // outerHeight - innerHeight routinely exceed 160px with no DevTools
  // open — a false positive on mobile Brave — and a docked DevTools
  // panel does not exist on mobile, so the check is skipped there.
  const isTouchDevice =
    "ontouchstart" in window ||
    navigator.maxTouchPoints > 0 ||
    window.matchMedia("(pointer: coarse)").matches;
  if (!isTouchDevice) {
    let devtoolsHits = 0;
    const devtoolsCheck = setInterval(() => {
      const widthGap = window.outerWidth - window.innerWidth;
      const heightGap = window.outerHeight - window.innerHeight;
      if (widthGap > 160 || heightGap > 160) {
        devtoolsHits += 1;
        if (devtoolsHits >= 2) {
          clearInterval(devtoolsCheck);
          document.body.innerHTML =
            '<div style="display:flex;align-items:center;justify-content:center;min-height:100vh;background:#0b0b0f;color:#e5e5e5;font-family:sans-serif;text-align:center;padding:24px;"><div><h1 style="font-size:22px;margin:0 0 8px;">DevTools is disabled on AniFlick</h1><p style="margin:0;opacity:.7;">Please close DevTools and reload the page to continue watching.</p></div></div>';
        }
      } else {
        devtoolsHits = 0;
      }
    }, 1000);
  }

  let currentUser = null;

  function escapeHtml(str) {
    if (str == null) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /* __COMMENT_TEXT_LOGIC_START__ */
  
  function decodeHtml(value) {
    if (value == null) return "";
    return String(value)
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
  }

  function buildCommentNode(c) {
    const wrap = document.createElement("div");
    wrap.className = "single-comment";

    const name = decodeHtml(c && c.user_name) || "";
    const body = decodeHtml(c && c.content) || "";

    const avatar = document.createElement("div");
    avatar.className = "user-comment-avatar";
    avatar.textContent = (name || "U").charAt(0).toUpperCase();

    const main = document.createElement("div");
    main.style.flex = "1";

    const head = document.createElement("div");
    const nameEl = document.createElement("span");
    nameEl.className = "comment-user-name";
    nameEl.textContent = name || "User";
    head.appendChild(nameEl);

    if (c && c.is_guest) {
      const badge = document.createElement("span");
      badge.className = "badge-mini-guest";
      badge.textContent = "Guest";
      head.appendChild(badge);
    }

    const dateEl = document.createElement("span");
    dateEl.className = "comment-date";
    dateEl.textContent = new Date(c.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    head.appendChild(dateEl);

    const textEl = document.createElement("div");
    textEl.className = "comment-body-text";
    textEl.textContent = body;

    main.appendChild(head);
    main.appendChild(textEl);
    wrap.appendChild(avatar);
    wrap.appendChild(main);
    return wrap;
  }
  /* __COMMENT_TEXT_LOGIC_END__ */

  /* __AUTONEXT_LOGIC_START__ */
  
  function autoNextAction({ server, currentEp, totalEps, autonext, continuation }) {
    if (server === "backup") return { action: "none" };
    if (server === "animegg") return { action: "none" };
    if (!autonext) return { action: "none" };
    const total = Number(totalEps) || 0;
    const current = Number(currentEp) || 0;
    if (total <= 0) return { action: "none" };
    if (current >= total) {
      
      if (continuation && continuation.live) {
        return { action: "continue", live: continuation.live, name: continuation.name || "" };
      }
      return { action: "completed" };
    }
    return { action: "next", nextEp: current + 1 };
  }
  /* __AUTONEXT_LOGIC_END__ */

  /* __POSTER_LOGIC_START__ */
  const COVER_FALLBACK = "img/banner.jpg";
  
  const LIVE_POSTER_FALLBACK = "img/banner.jpg";

  function localAssetFor(t, dir) {
    const slug = t && t.slug;
    return slug ? `img/${dir}/${slug}.jpg` : "";
  }

  function coverOf(t) {
    if (!t) return COVER_FALLBACK;
    const known = t.cover || t.coverLocal;
    return known || localAssetFor(t, "covers") || COVER_FALLBACK;
  }

  function livePosterAttrs() {
    return `referrerpolicy="no-referrer" data-fallback-src="${LIVE_POSTER_FALLBACK}"`;
  }

  function bannerOf(t) {
    if (!t) return COVER_FALLBACK;
    const known = t.banner || t.bannerLocal || t.cover || t.coverLocal;
    return known || localAssetFor(t, "banners") || COVER_FALLBACK;
  }
  /* __POSTER_LOGIC_END__ */
  if (typeof document !== "undefined") {
    document.addEventListener(
      "error",
      (e) => {
        const img = e.target;
        if (!img || img.tagName !== "IMG") return;
        const fallback = img.getAttribute("data-fallback-src");
        if (!fallback) return;
        img.removeAttribute("data-fallback-src");
        img.src = fallback;
      },
      true
    );
  }
  
  function truncateWords(text, max = 200) {
    const t = String(text || "").trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    const lastSpace = cut.lastIndexOf(" ");
    const base = lastSpace > 40 ? cut.slice(0, lastSpace) : cut;
    return base.replace(/[\s.,;:!?-]+$/, "") + "…";
  }

  function subCount(t) {
    const n = Number(t && t.episodes);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  function subBadge(t) {
    const n = subCount(t);
    if (n == null) return "";
    return `<span class="badge-mini-sub">SUB ${n}</span>`;
  }
  function dubBadge(t) {
    return t && t.dubCount > 0 ? `<span class="badge-mini-dub">DUB ${t.dubCount}</span>` : "";
  }
  function detailHref(slug) {
    return `detail.html?slug=${encodeURIComponent(slug)}`;
  }
  function watchHref(slug, ep) {
    return `watch.html?slug=${encodeURIComponent(slug)}&ep=${encodeURIComponent(ep == null ? 1 : ep)}`;
  }
  
  function parseTagList(value) {
    const parts = String(value == null ? "" : value)
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    return Array.from(new Set(parts));
  }

  function scoreLabel(t) {
    return t && t.score != null ? (t.score / 10).toFixed(1) : null;
  }
  function statusLabel(s) {
    if (!s) return "Unknown";
    const map = { FINISHED: "Finished", RELEASING: "Airing", NOT_YET_RELEASED: "Upcoming", CANCELLED: "Cancelled", HIATUS: "Hiatus" };
    return map[s] || s;
  }

  const API_TIMEOUT_MS = 10000;

  function prefetchStore() {
    return window.__zoroPrefetch || null;
  }

  async function api(path, options = {}, attempt = 0) {
    options.headers = options.headers || {};
    if (options.body && typeof options.body === "object") {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(options.body);
    }
    options.credentials = "same-origin";

    const store = prefetchStore();
    if (!options.body && store && store[path]) {
      const pending = store[path];
      delete store[path];
      const pre = await pending;
      if (pre && pre.ok) return pre;
      
    }

    const timeoutMs =
      Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : API_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(path, Object.assign({}, options, { signal: controller.signal }));
      const data = await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, data, error: null };
    } catch (err) {
      const timedOut = !!err && err.name === "AbortError";
      if (attempt === 0 && !options.body) {
        clearTimeout(timer);
        return api(path, options, 1);
      }
      console.error("API error:", err);
      return {
        ok: false,
        status: 0,
        data: null,
        error: timedOut ? "Request timed out" : String((err && err.message) || err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  const inflightTitles = new Map();

  function fetchTitles(limit) {
    const key = String(limit);
    if (!inflightTitles.has(key)) {
      const promise = api(`/api/titles?limit=${limit}`);
      inflightTitles.set(key, promise);
      promise.then((res) => {
        if (!res.ok && inflightTitles.get(key) === promise) inflightTitles.delete(key);
      });
    }
    return inflightTitles.get(key);
  }

  const LIVE_BUSY_MESSAGE = "Service is busy — try again in a moment.";
  const LIVE_LIBRARY_MESSAGE = "Showing your library — live catalog is busy.";
  const LIVE_PAGE_SIZE = 12;

  const ANILIST_GENRES = [
    "Action", "Adventure", "Comedy", "Drama", "Ecchi", "Fantasy", "Horror",
    "Mahou Shoujo", "Mecha", "Music", "Mystery", "Romance", "Sci-Fi",
    "Slice of Life", "Sports", "Supernatural", "Thriller",
  ];

  const SORT_LABELS = {
    trending: "Trending",
    popular: "Most Popular",
    top: "Top Rated",
    newest: "Newest",
    
    az: "Name A-Z",
    name: "Name A-Z",
    episodes: "Most Episodes",
    updated: "Recently Updated",
    favourites: "Most Favourited",
  };

  const BROWSE_TAGS = [
    "Isekai", "CGDCT", "Mahou Shoujo", "Mecha", "Sports", "Supernatural",
    "Thriller", "Vampire", "Military", "Parody", "Space", "Josei",
    "Seinen", "Shounen", "Shoujo", "Time Travel", "Super Power",
    "Strategy Game", "Team Sports", "Urban Fantasy",
  ];

  /* __BROWSE_YEAR_LOGIC_START__ */
  const BROWSE_YEAR_MIN = 1960;

  function browseYearRange(now) {
    const ref = now || new Date();
    const current = ref.getFullYear();
    const years = [];
    for (let y = current + 1; y >= BROWSE_YEAR_MIN; y--) years.push(y);
    return years;
  }

  function browseDecadeOf(year) {
    return Math.floor(Number(year) / 10) * 10;
  }
  /* __BROWSE_YEAR_LOGIC_END__ */

  const GENRE_ALIASES = {
    life: "Slice of Life",
    "slice of life": "Slice of Life",
    "slice-of-life": "Slice of Life",
    "sci-fi": "Sci-Fi",
    "science fiction": "Sci-Fi",
    "mahou shoujo": "Mahou Shoujo",
  };

  function canonicalGenreName(name) {
    const raw = String(name || "").trim();
    if (!raw) return "";
    return GENRE_ALIASES[raw.toLowerCase()] || raw;
  }

  function liveDetailHref(t) {
    if (!t) return "browse.html";
    if (t.catalogSlug) return detailHref(t.catalogSlug);
    if (t.anilistId != null) return `detail.html?live=${encodeURIComponent(t.anilistId)}`;
    return "browse.html";
  }

  function liveWatchHref(t, ep) {
    if (!t || t.anilistId == null) return "browse.html";
    return `watch.html?live=${encodeURIComponent(t.anilistId)}&ep=${encodeURIComponent(ep == null ? 1 : ep)}`;
  }

  function eighteenBadge(t) {
    return t && t.is18plus ? `<span class="badge-mini-18">18+</span>` : "";
  }

  function liveFormatLabel(t) {
    if (!t || !t.format) return "TV";
    const map = { TV: "TV", MOVIE: "Movie", OVA: "OVA", ONA: "ONA", SPECIAL: "Special" };
    return map[t.format] || t.format;
  }

  function liveStatusLabel(t) {
    if (!t) return "Unknown";
    const map = {
      FINISHED: "Finished", RELEASING: "Airing", NOT_YET_RELEASED: "Upcoming",
      CANCELLED: "Cancelled", HIATUS: "Hiatus",
    };
    return map[t.status] || t.status || "Unknown";
  }

  const LS_REMINDERS_KEY = "av_reminders";
  const BELL_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>`;
  function readReminders() {
    try {
      const raw = localStorage.getItem(LS_REMINDERS_KEY);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.filter((r) => r && r.slug && r.name) : [];
    } catch { return []; }
  }
  function writeReminders(list) {
    try { localStorage.setItem(LS_REMINDERS_KEY, JSON.stringify(list)); } catch {}
  }
  function isReminded(slug) {
    return readReminders().some((r) => r.slug === slug);
  }
  
  function toggleReminder(slug, name) {
    const list = readReminders();
    const i = list.findIndex((r) => r.slug === slug);
    if (i >= 0) { list.splice(i, 1); writeReminders(list); return false; }
    list.push({ slug, name });
    writeReminders(list);
    return true;
  }
  
  function reminderWatchHref(key) {
    if (typeof key === "string" && key.startsWith("live-")) {
      const id = key.slice("live-".length);
      return `watch.html?live=${encodeURIComponent(id)}&ep=1`;
    }
    return watchHref(key, 1);
  }
  
  function titleNeedsReminder(status) {
    return status === "RELEASING" || status === "NOT_YET_RELEASED";
  }
  
  function wireDetailRemindButton(btn, key, name) {
    if (!btn) return;
    const paint = () => {
      const set = isReminded(key);
      btn.classList.toggle("is-set", set);
      btn.innerHTML = set ? "✓ Alert Set" : `${BELL_SVG} Remind Me`;
    };
    btn.hidden = false;
    paint();
    btn.addEventListener("click", () => {
      const added = toggleReminder(key, name);
      paint();
      showToast(added
        ? `Reminder saved for ${name} — see Your Reminders on the Schedule page.`
        : `Reminder removed for ${name}`);
    });
  }

  function timeSinceLabel(unixSeconds) {
    const ts = Number(unixSeconds);
    if (!Number.isFinite(ts) || ts <= 0) return "";
    const diff = Math.max(0, Math.floor(Date.now() / 1000) - ts);
    const minutes = Math.floor(diff / 60);
    if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  function formatAiringDate(unixSeconds) {
    const ts = Number(unixSeconds);
    if (!Number.isFinite(ts) || ts <= 0) return "";
    try {
      return new Date(ts * 1000).toLocaleDateString(undefined, {
        year: "numeric", month: "short", day: "numeric",
      });
    } catch {
      return "";
    }
  }

  function renderRecommendationCard(o) {
    if (!o) return "";
    const isCatalog = !!o.slug;
    const href = isCatalog ? detailHref(o.slug) : liveDetailHref(o);
    const cover = coverOf(o);
    const typeLabel = isCatalog ? (o.kind || "Series") : liveFormatLabel(o);
    
    const yearPart = o.year != null ? ` • <span>${escapeHtml(String(o.year))}</span>` : "";
    return `
      <div class="zoro-card" ${isCatalog ? `data-slug="${escapeHtml(o.slug)}"` : `data-anilist-id="${escapeHtml(o.anilistId)}"`}>
        <a class="zoro-card-poster" href="${href}">
          <img src="${escapeHtml(cover)}" alt="${escapeHtml(o.name)}" loading="lazy" decoding="async" ${isCatalog ? "" : livePosterAttrs()}>
          <div class="zoro-play-overlay"><div class="zoro-play-circle">▶</div></div>
          <div class="zoro-poster-badges">
            <div class="badges-left">${subBadge(o)}${dubBadge(o)}${isCatalog ? "" : eighteenBadge(o)}</div>
          </div>
        </a>
        <div class="zoro-card-info">
          <a class="zoro-card-title" href="${href}">${escapeHtml(o.name)}</a>
          <div class="zoro-card-submeta"><span>${escapeHtml(typeLabel)}</span>${yearPart}</div>
        </div>
      </div>`;
  }

  function fillRecommendations(items, limit = 6) {
    const wrap = document.getElementById("detail-recommendations");
    if (!wrap) return;
    const section = wrap.closest("section");
    const recs = (Array.isArray(items) ? items : []).filter(Boolean).slice(0, limit);
    if (!recs.length) {
      wrap.innerHTML = "";
      if (section) section.hidden = true;
      return;
    }
    wrap.innerHTML = recs.map(renderRecommendationCard).join("");
    if (section) section.hidden = false;
  }

  function sameGenreRecommendations(titles, currentSlug, genres) {
    const myGenres = new Set((genres || []).map((g) => String(g).toLowerCase()));
    return (Array.isArray(titles) ? titles : [])
      .filter((o) => o && o.slug && o.slug !== currentSlug && !o.isAdult)
      .map((o) => ({ o, shared: (o.genres || []).filter((g) => myGenres.has(String(g).toLowerCase())).length }))
      .filter((x) => x.shared > 0)
      .sort((a, b) => b.shared - a.shared || (b.o.score || 0) - (a.o.score || 0))
      .map((x) => x.o);
  }

  function renderLiveCard(t, opts = {}) {
    if (!t) return "";
    
    const isCatalog = !!(t && t.slug);
    const href = opts.href || (isCatalog ? detailHref(t.slug) : liveDetailHref(t));
    const cover = coverOf(t);
    const score = scoreLabel(t);
    const year = t.year || "—";
    const typeLabel = isCatalog ? (t.kind || "Series") : liveFormatLabel(t);
    return `
      <div class="zoro-card" data-anilist-id="${escapeHtml(t.anilistId)}" data-title="${escapeHtml(t.name)}">
        <a class="zoro-card-poster" href="${href}">
          <img src="${escapeHtml(cover)}" alt="${escapeHtml(t.name)}" loading="lazy" decoding="async" ${livePosterAttrs()}>
          <div class="zoro-play-overlay">
            <div class="zoro-play-circle">▶</div>
          </div>
          <div class="zoro-poster-badges">
            <div class="badges-left">
              ${subBadge(t)}
              ${dubBadge(t)}
              ${eighteenBadge(t)}
            </div>
          </div>
        </a>
        <div class="zoro-card-info">
          <a class="zoro-card-title" href="${href}" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</a>
          <div class="zoro-card-submeta">
            <span>${escapeHtml(typeLabel)}</span> • <span>${escapeHtml(String(year))}</span>${score ? ` • <span class="text-zoro-lime">★ ${score}</span>` : ""}
          </div>
          ${opts.submeta ? `<div class="zoro-card-submeta live-ep-time">${opts.submeta}</div>` : ""}
        </div>
      </div>
    `;
  }

  function searchRowHtml(t, href) {
    const isLive = !!(t && t.live);
    const meta = isLive
      ? `<span>${escapeHtml(liveFormatLabel(t))}</span> • <span>${escapeHtml(String(t.year || "—"))}</span> • <span class="text-zoro-sub">${t.episodes != null ? `EP ${t.episodes}` : "ONGOING"}</span>`
      : `<span>${t.year || 2025}</span> • <span>${t.kind || "Series"}</span>${subCount(t) ? ` • <span class="text-zoro-sub">SUB ${subCount(t)}</span>` : ""}`;
    return `
      <a class="search-result-item" href="${href}">
        <img class="search-result-thumb" src="${escapeHtml(coverOf(t))}" alt="${escapeHtml(t.name)}" loading="lazy" ${livePosterAttrs()}>
        <div class="search-result-info">
          <div class="search-result-title">${escapeHtml(t.name)}${t && t.is18plus ? ' <span class="badge-mini-18">18+</span>' : ""}</div>
          <div class="search-result-meta">${meta}</div>
        </div>
      </a>`;
  }

  function renderLiveNotice(message, kind) {
    const wrap = document.getElementById("browse-notice");
    if (!wrap) return;
    if (!message) {
      wrap.innerHTML = "";
      return;
    }
    wrap.innerHTML = `
      <div class="zoro-live-notice${kind === "busy" ? " is-busy" : ""}">
        <span>⚠</span>
        <strong>${escapeHtml(kind === "busy" ? "Service is busy" : "Library mode")}</strong>
        <span>${escapeHtml(message)}</span>
      </div>`;
  }

  let contentReadyDispatched = false;

  function markContentReady() {
    if (contentReadyDispatched) return;
    contentReadyDispatched = true;
    window.dispatchEvent(new CustomEvent("zoro:contentReady"));
  }

  function initAizenIntro(force = false) {
    if (!force && window.matchMedia && window.matchMedia("(max-width: 820px)").matches) {
      return;
    }
    try {
      if (!force && sessionStorage.getItem("aizen_intro_seen")) {
        return;
      }
      sessionStorage.setItem("aizen_intro_seen", "true");
    } catch (e) {
      // ignore storage access errors
    }

    const overlay = document.createElement("div");
    overlay.className = "aizen-intro-overlay";
    overlay.innerHTML = `
      <div class="aizen-shutter-top"></div>
      <div class="aizen-shutter-bottom"></div>
      <div class="aizen-kanji-bg aizen-kanji-left">アニメ</div>
      <div class="aizen-kanji-bg aizen-kanji-right">起動</div>
      <div class="aizen-intro-content">
        <h1 class="aizen-glitch-title" data-text="ANI_VERSE">ANI_VERSE</h1>
        <div class="aizen-progress-track">
          <div class="aizen-progress-bar" id="aizen-bar"></div>
        </div>
        <div class="aizen-intro-meta">
          <span id="aizen-status-text">INITIALIZING RESOURCES... 0%</span>
          <span class="drawer-engine-tag">ZORO UI × AIZEN CINEMATIC ENGINE</span>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    let progress = 0;
    let timer = null;
    let finished = false;
    const startedAt = Date.now();
    const bar = overlay.querySelector("#aizen-bar");
    const statusText = overlay.querySelector("#aizen-status-text");

    function finish() {
      if (finished) return;
      finished = true;
      if (timer) clearInterval(timer);
      overlay.classList.add("is-exiting");
      sessionStorage.setItem("aizen_intro_seen", "true");
      
      setTimeout(() => overlay.remove(), 650);
    }

    window.addEventListener("zoro:contentReady", () => {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= 450) {
        finish();
      } else {
        setTimeout(finish, 450 - elapsed);
      }
    });

    timer = setInterval(() => {
      progress += Math.floor(Math.random() * 12) + 6;
      
      if (progress >= 100 || Date.now() - startedAt > 1000) {
        progress = 100;
        clearInterval(timer);
        bar.style.width = "100%";
        statusText.textContent = "SYSTEM READY • 100%";

        setTimeout(finish, 350);
      } else {
        bar.style.width = `${progress}%`;
        statusText.textContent = `INITIALIZING RESOURCES... ${progress}%`;
      }
    }, 60);

    // Allow skip on click
    overlay.addEventListener("click", finish);
  }

  function showToast(message, icon = "✓", duration = 2000) {
    let container = document.querySelector(".aizen-toast-container");
    if (!container) {
      container = document.createElement("div");
      container.className = "aizen-toast-container";
      document.body.appendChild(container);
    }

    const toast = document.createElement("div");
    toast.className = "aizen-toast";
    
    toast.innerHTML = `
      <div class="aizen-toast-icon">${escapeHtml(icon)}</div>
      <span>${escapeHtml(message)}</span>
    `;

    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add("toast-leave");
      setTimeout(() => toast.remove(), 260);
    }, duration);
  }

  function clearPlayerToasts() {
    document.querySelectorAll(".aizen-toast-container, #zoro-toasts").forEach((c) => {
      c.innerHTML = "";
    });
  }

  const LS_THEME_KEY = "av_theme";

  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const btn = document.getElementById("btn-theme-toggle");
    if (btn) btn.setAttribute("aria-pressed", theme === "light" ? "true" : "false");
    const drawerBtn = document.getElementById("drawer-theme-toggle");
    if (drawerBtn) {
      drawerBtn.setAttribute("aria-pressed", theme === "light" ? "true" : "false");
      drawerBtn.textContent = theme === "light" ? "🌙 Dark Mode" : "☀️ Light Mode";
    }
  }

  function initThemeToggle() {
    const btn = document.getElementById("btn-theme-toggle");
    if (!btn) return;
    applyTheme(currentTheme());
    btn.addEventListener("click", () => {
      const next = currentTheme() === "light" ? "dark" : "light";
      applyTheme(next);
      try { localStorage.setItem(LS_THEME_KEY, next); } catch {}
      showToast(next === "light" ? "Light theme" : "Dark theme");
    });
  }

  function initMobileDrawer() {
    const toggleBtns = document.querySelectorAll(".menu-toggle-btn");
    if (!toggleBtns.length) return;

    let backdrop = document.querySelector(".mobile-nav-backdrop");
    
    const setDrawer = (open) => {
      if (!backdrop) return;
      backdrop.classList.toggle("is-open", open);
      document.body.classList.toggle("drawer-open", open);
    };
    if (!backdrop) {
      backdrop = document.createElement("div");
      backdrop.className = "mobile-nav-backdrop";
      backdrop.innerHTML = `
        <div class="mobile-nav-drawer">
          <div class="mobile-drawer-header">
            <a class="zoro-brand" href="/">
              <img class="aniflick-logo-img" src="/images/aniflick-logo.png" alt="AniFlick">
            </a>
            <button class="mobile-drawer-close" type="button" aria-label="Close Menu">&times;</button>
          </div>
          <nav class="mobile-drawer-links">
            <a class="mobile-drawer-link" href="index.html">🏠 Home</a>
            <a class="mobile-drawer-link" href="browse.html">🔍 Browse Catalog</a>
            <a class="mobile-drawer-link" href="genres.html">📑 All Genres</a>
            <a class="mobile-drawer-link" href="schedule.html">📅 Broadcast Schedule</a>
            <a class="mobile-drawer-link" href="browse.html?view=subbed">📺 Subbed</a>
            <a class="mobile-drawer-link" href="browse.html?view=dubbed">🔊 Dubbed</a>
            <a class="mobile-drawer-link" href="browse.html?view=movie">🎬 Movies</a>
            <a class="mobile-drawer-link" href="browse.html?view=ona">📡 ONAs</a>
            <a class="mobile-drawer-link" href="browse.html?view=special">✨ Specials</a>
            <a class="mobile-drawer-link" href="browse.html?genre=action">🔥 Action Anime</a>
            <a class="mobile-drawer-link" href="browse.html?genre=fantasy">✨ Fantasy & Isekai</a>
            <a class="mobile-drawer-link" href="browse.html?view=top-airing&sort=newest">⭐ Top Airing</a>
            <a class="mobile-drawer-link" href="browse.html?view=top-upcoming&sort=popular">📅 Top Upcoming</a>
            <a class="mobile-drawer-link" href="az-list.html">🔤 A-Z List</a>
            <a class="mobile-drawer-link" href="/login">🔐 Sign In</a>
          </nav>
          <div class="mobile-drawer-actions">
            <button class="mobile-drawer-action" id="drawer-search-trigger" type="button">🔍 Search Anime</button>
            <button class="mobile-drawer-action" id="drawer-random-anime" type="button">🎲 Random Anime</button>
            <button class="mobile-drawer-action" id="drawer-theme-toggle" type="button" aria-pressed="false">☀️ Light Mode</button>
          </div>
        </div>
      `;
      document.body.appendChild(backdrop);

      const closeBtn = backdrop.querySelector(".mobile-drawer-close");
      if (closeBtn) closeBtn.addEventListener("click", () => setDrawer(false));
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) setDrawer(false);
      });

      const drawerSearchBtn = backdrop.querySelector("#drawer-search-trigger");
      if (drawerSearchBtn) {
        drawerSearchBtn.addEventListener("click", () => {
          setDrawer(false);
          const header = document.querySelector(".zoro-header");
          const input = document.getElementById("zoro-search-input");
          if (header) header.classList.add("mobile-search-open");
          const mobileSearchBtn = document.getElementById("btn-mobile-search");
          if (mobileSearchBtn) mobileSearchBtn.setAttribute("aria-expanded", "true");
          if (input) setTimeout(() => input.focus(), 50);
        });
      }

      const drawerRandomBtn = backdrop.querySelector("#drawer-random-anime");
      if (drawerRandomBtn) {
        drawerRandomBtn.addEventListener("click", () => {
          setDrawer(false);
          const headerRandom = document.getElementById("btn-random-anime");
          if (headerRandom) headerRandom.click();
        });
      }

      const drawerThemeBtn = backdrop.querySelector("#drawer-theme-toggle");
      if (drawerThemeBtn) {
        applyTheme(currentTheme());
        drawerThemeBtn.addEventListener("click", () => {
          const headerTheme = document.getElementById("btn-theme-toggle");
          if (headerTheme) headerTheme.click();
        });
      }
      
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && backdrop.classList.contains("is-open")) {
          setDrawer(false);
        }
      });
    }

    toggleBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        
        setDrawer(!backdrop.classList.contains("is-open"));
      });
    });
  }

  function renderAuthModal() {
    if (document.querySelector(".aizen-modal-backdrop")) return;

    const modal = document.createElement("div");
    modal.className = "aizen-modal-backdrop";
    modal.innerHTML = `
      <div class="aizen-modal-card" role="dialog" aria-modal="true">
        <button class="modal-close-cross" type="button" aria-label="Close">&times;</button>
        <div class="modal-tabs">
          <button class="modal-tab-btn active" type="button" data-tab="login">Sign In</button>
          <button class="modal-tab-btn" type="button" data-tab="register">Create Account</button>
        </div>
        <div id="modal-error-msg" class="modal-error-msg"></div>
        <form id="zoro-auth-form">
          <div class="input-field-group is-hidden" id="group-auth-name">
            <label for="reg-name">Display Name</label>
            <input id="reg-name" name="name" type="text" placeholder="e.g. ZoroFan99">
          </div>
          <div class="input-field-group">
            <label for="reg-email">Email Address</label>
            <input id="reg-email" name="email" type="email" placeholder="Your email address" required>
          </div>
          <div class="input-field-group">
            <label for="reg-password">Password</label>
            <input id="reg-password" name="password" type="password" placeholder="At least 8 characters" required>
          </div>
          <button class="forgot-password-link" id="btn-forgot-password" type="button">Forgot password?</button>
          <button class="btn-zoro-primary btn-modal-submit" id="btn-auth-submit" type="submit">Sign In</button>
        </form>
        <div id="zoro-forgot-view" class="is-hidden">
          <h3 class="forgot-view-title">Reset your password</h3>
          <p class="forgot-view-desc">Enter the email address for your account and we'll send you a link to set a new password.</p>
          <div id="forgot-msg" class="forgot-msg"></div>
          <form id="zoro-forgot-form">
            <div class="input-field-group">
              <label for="forgot-email">Email Address</label>
              <input id="forgot-email" name="email" type="email" placeholder="Your email address" required>
            </div>
            <button class="btn-zoro-primary btn-modal-submit" id="btn-forgot-submit" type="submit">Send reset link</button>
          </form>
          <button class="forgot-password-link btn-forgot-back" id="btn-forgot-back" type="button">&larr; Back to sign in</button>
        </div>
        <div id="zoro-social-block" class="is-hidden">
          <div class="social-login-divider"><span>or continue with</span></div>
          <div id="zoro-social-logins" class="social-login-list"></div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    renderSocialLogins(modal.querySelector("#zoro-social-block"), modal.querySelector("#zoro-social-logins"));

    let activeTab = "login";
    const form = modal.querySelector("#zoro-auth-form");
    const nameGroup = modal.querySelector("#group-auth-name");
    const submitBtn = modal.querySelector("#btn-auth-submit");
    const errorBox = modal.querySelector("#modal-error-msg");
    const tabBtns = modal.querySelectorAll(".modal-tab-btn");
    const closeBtn = modal.querySelector(".modal-close-cross");
    const tabsRow = modal.querySelector(".modal-tabs");
    const socialBlock = modal.querySelector("#zoro-social-block");
    const forgotLink = modal.querySelector("#btn-forgot-password");
    const forgotView = modal.querySelector("#zoro-forgot-view");
    const forgotForm = modal.querySelector("#zoro-forgot-form");
    const forgotMsg = modal.querySelector("#forgot-msg");
    const forgotBack = modal.querySelector("#btn-forgot-back");
    const forgotSubmit = modal.querySelector("#btn-forgot-submit");

    function showForgotView(show) {
      forgotView.style.display = show ? "block" : "none";
      form.style.display = show ? "none" : "";
      tabsRow.style.display = show ? "none" : "";
      socialBlock.style.display =
        show || !(socialProvidersCache && socialProvidersCache.length) ? "none" : "block";
      errorBox.style.display = "none";
      if (!show) forgotMsg.style.display = "none";
    }

    function setTab(tab) {
      activeTab = tab;
      showForgotView(false);
      errorBox.style.display = "none";
      tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
      forgotLink.style.display = tab === "login" ? "" : "none";
      if (tab === "login") {
        nameGroup.style.display = "none";
        submitBtn.textContent = "Sign In";
      } else {
        nameGroup.style.display = "flex";
        submitBtn.textContent = "Create Account";
      }
    }

    tabBtns.forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
    closeBtn.addEventListener("click", () => modal.classList.remove("is-active"));
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.classList.remove("is-active");
    });
    forgotLink.addEventListener("click", () => showForgotView(true));
    forgotBack.addEventListener("click", () => showForgotView(false));

    forgotForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      forgotMsg.style.display = "none";
      forgotSubmit.disabled = true;
      const res = await api("/api/auth/forgot-password", {
        method: "POST",
        body: { email: forgotForm.email.value.trim() },
      });
      forgotSubmit.disabled = false;
      
      forgotMsg.textContent =
        (res.data && (res.data.message || (res.data.error && res.data.error.message))) ||
        "If an account exists for that email, a reset link has been sent.";
      if (res.ok) {
        forgotMsg.style.background = "rgba(202,233,98,0.12)";
        forgotMsg.style.borderColor = "#cae962";
        forgotMsg.style.color = "#d9f99d";
      } else {
        forgotMsg.style.background = "rgba(255,80,80,0.15)";
        forgotMsg.style.borderColor = "#ff5050";
        forgotMsg.style.color = "#ff8080";
      }
      forgotMsg.style.display = "block";
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errorBox.style.display = "none";
      submitBtn.disabled = true;

      const endpoint = activeTab === "login" ? "/api/auth/login" : "/api/auth/register";
      const payload = {
        email: form.email.value.trim(),
        password: form.password.value,
      };
      if (activeTab === "register") {
        payload.name = form.name.value.trim();
      }

      const res = await api(endpoint, { method: "POST", body: payload });
      submitBtn.disabled = false;

      if (res.ok && res.data.user) {
        currentUser = res.data.user;
        modal.classList.remove("is-active");
        updateHeaderUser();
        window.dispatchEvent(new CustomEvent("zoro:auth", { detail: currentUser }));
      } else {
        errorBox.textContent = (res.data && res.data.error && res.data.error.message) || "Authentication failed.";
        errorBox.style.display = "block";
      }
    });
  }

  function openAuthModal(tab = "login") {
    const currentPath = window.location.pathname + window.location.search;
    const params = new URLSearchParams();
    if (currentPath && currentPath !== "/" && !currentPath.startsWith("/login")) {
      params.set("next", currentPath);
    }
    if (tab === "register") {
      params.set("mode", "register");
    }
    const qs = params.toString();
    window.location.assign(qs ? `/login?${qs}` : "/login");
  }

  let socialProvidersCache = null;

  async function renderSocialLogins(block, list) {
    if (!block || !list) return;
    if (socialProvidersCache === null) {
      const res = await api("/api/auth/providers");
      socialProvidersCache =
        res.ok && res.data && Array.isArray(res.data.providers) ? res.data.providers : [];
    }
    if (!socialProvidersCache.length) return; /* Block stays hidden. */
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    list.innerHTML = socialProvidersCache
      .map(
        (p) =>
          `<a class="btn-social btn-social-${escapeHtml(p.id)}" href="/auth/${encodeURIComponent(p.id)}?next=${next}">Continue with ${escapeHtml(p.name)}</a>`
      )
      .join("");
    block.style.display = "block";
  }

  function updateHeaderUser() {
    const slot = document.getElementById("header-user-slot");
    document.querySelectorAll('.header-nav a[href="/login"], .mobile-drawer-links a[href="/login"]').forEach((a) => {
      a.hidden = Boolean(currentUser);
    });
    if (!slot) return;
    slot.removeAttribute("aria-busy");

    if (currentUser) {
      const initial = (currentUser.name || "U")[0].toUpperCase();
      const safeName = escapeHtml(currentUser.name || "User");
      const safeEmail = escapeHtml(currentUser.email || "");

      slot.innerHTML = `
        <button class="user-badge-btn" id="btn-user-profile" type="button" aria-haspopup="true" aria-expanded="false" aria-label="User Profile Menu">
          <span class="user-avatar-circle">${initial}</span>
          <span>${safeName}</span>
          <span class="user-caret">▼</span>
        </button>
        <div class="user-dropdown-menu" id="user-dropdown-menu" role="menu">
          <div class="user-dropdown-header">
            <div class="user-dropdown-name">${safeName}</div>
            <div class="user-dropdown-email">${safeEmail}</div>
          </div>
          <div class="user-dropdown-divider"></div>
          <a href="#profile" class="user-dropdown-item" id="menu-item-profile" role="menuitem">
            <span class="user-dropdown-icon">👤</span>
            <span>Profile</span>
          </a>
          <a href="browse.html" class="user-dropdown-item" id="menu-item-mylist" role="menuitem">
            <span class="user-dropdown-icon">📑</span>
            <span>My List</span>
          </a>
          <div class="user-dropdown-divider"></div>
          <button type="button" class="user-dropdown-item user-dropdown-logout" id="menu-item-logout" role="menuitem">
            <span class="user-dropdown-icon">🚪</span>
            <span>Log Out</span>
          </button>
        </div>
      `;

      const btnProfile = slot.querySelector("#btn-user-profile");
      const dropdown = slot.querySelector("#user-dropdown-menu");

      function openMenu() {
        if (!dropdown) return;
        dropdown.classList.add("is-open");
        btnProfile.setAttribute("aria-expanded", "true");
      }

      function closeMenu() {
        if (!dropdown) return;
        dropdown.classList.remove("is-open");
        btnProfile.setAttribute("aria-expanded", "false");
      }

      function toggleMenu(e) {
        if (e) e.stopPropagation();
        if (dropdown && dropdown.classList.contains("is-open")) {
          closeMenu();
        } else {
          openMenu();
        }
      }

      btnProfile.addEventListener("click", toggleMenu);

      const profileItem = slot.querySelector("#menu-item-profile");
      if (profileItem) {
        profileItem.addEventListener("click", (e) => {
          e.preventDefault();
          closeMenu();
          showToast(`Logged in as ${currentUser.name} (${currentUser.email || "active"})`);
        });
      }

      const myListBtn = slot.querySelector("#menu-item-mylist");
      if (myListBtn) {
        myListBtn.addEventListener("click", () => {
          closeMenu();
        });
      }

      const logoutBtn = slot.querySelector("#menu-item-logout");
      if (logoutBtn) {
        logoutBtn.addEventListener("click", async (e) => {
          e.preventDefault();
          closeMenu();
          await api("/api/auth/logout", { method: "POST" });
          currentUser = null;
          updateHeaderUser();
          showToast("Signed out successfully.");
          window.dispatchEvent(new CustomEvent("zoro:auth", { detail: null }));
        });
      }

      // Close on outside click
      const handleOutsideClick = (e) => {
        if (!slot.contains(e.target)) {
          closeMenu();
        }
      };
      // Close on Escape
      const handleEscape = (e) => {
        if (e.key === "Escape") {
          closeMenu();
        }
      };

      if (slot._outsideHandler) document.removeEventListener("click", slot._outsideHandler);
      if (slot._escapeHandler) document.removeEventListener("keydown", slot._escapeHandler);
      slot._outsideHandler = handleOutsideClick;
      slot._escapeHandler = handleEscape;
      document.addEventListener("click", handleOutsideClick);
      document.addEventListener("keydown", handleEscape);
    } else {
      if (slot._outsideHandler) document.removeEventListener("click", slot._outsideHandler);
      if (slot._escapeHandler) document.removeEventListener("keydown", slot._escapeHandler);
      const currentPath = window.location.pathname + window.location.search;
      const loginHref = currentPath && currentPath !== "/" && !currentPath.startsWith("/login")
        ? `/login?next=${encodeURIComponent(currentPath)}`
        : "/login";
      slot.innerHTML = `
        <a class="btn-zoro-primary btn-signin-link" id="btn-open-signin" href="${loginHref}">Sign In</a>
      `;
    }
  }

  async function checkAuthSession() {
    const res = await api("/api/auth/me");
    if (res.ok && res.data && res.data.user) {
      currentUser = res.data.user;
    } else {
      currentUser = null;
    }
    updateHeaderUser();
  }

  function initSearch() {
    const input = document.getElementById("zoro-search-input");
    const dropdown = document.getElementById("zoro-search-dropdown");
    if (!input || !dropdown) return;

    const header = document.querySelector(".zoro-header");
    const headerActions = header ? header.querySelector(".header-actions") : null;
    const searchWrapper = input.closest(".search-wrapper");
    let mobileSearchBtn = document.getElementById("btn-mobile-search");

    if (header && headerActions && !mobileSearchBtn) {
      mobileSearchBtn = document.createElement("button");
      mobileSearchBtn.type = "button";
      mobileSearchBtn.id = "btn-mobile-search";
      mobileSearchBtn.className = "icon-action-btn mobile-search-toggle";
      mobileSearchBtn.setAttribute("aria-label", "Toggle Search");
      mobileSearchBtn.setAttribute("aria-expanded", "false");
      mobileSearchBtn.innerHTML =
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>';
      const userSlot = document.getElementById("header-user-slot");
      if (userSlot && userSlot.parentElement === headerActions) {
        headerActions.insertBefore(mobileSearchBtn, userSlot);
      } else {
        headerActions.appendChild(mobileSearchBtn);
      }

      mobileSearchBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const nextOpen = !header.classList.contains("mobile-search-open");
        header.classList.toggle("mobile-search-open", nextOpen);
        mobileSearchBtn.setAttribute("aria-expanded", nextOpen ? "true" : "false");
        if (nextOpen) {
          setTimeout(() => input.focus(), 20);
        } else {
          dropdown.classList.remove("is-open");
        }
      });
    }

    function closeMobileSearch() {
      if (header) header.classList.remove("mobile-search-open");
      if (mobileSearchBtn) mobileSearchBtn.setAttribute("aria-expanded", "false");
    }

    let debounceTimer = null;
    let searchToken = 0;

    input.addEventListener("input", () => {
      const q = input.value.trim();
      clearTimeout(debounceTimer);

      if (!q) {
        dropdown.classList.remove("is-open");
        dropdown.innerHTML = "";
        return;
      }

      if (q.length < 2) {
        dropdown.innerHTML = `<div class="search-dropdown-msg">Type at least 2 characters</div>`;
        dropdown.classList.add("is-open");
        return;
      }

      dropdown.innerHTML = `<div class="search-dropdown-msg">Searching…</div>`;
      dropdown.classList.add("is-open");

      const token = ++searchToken;
      debounceTimer = setTimeout(async () => {
        const res = await api(`/api/search?q=${encodeURIComponent(q)}&page=1`);
        
        if (token !== searchToken) return;

        const local = (res.ok && res.data && Array.isArray(res.data.local)) ? res.data.local : [];
        const more = (res.ok && res.data && Array.isArray(res.data.results)) ? res.data.results : [];

        if (!res.ok) {
          
          const localRes = await api(`/api/titles?q=${encodeURIComponent(q)}&limit=6`);
          if (token !== searchToken) return;
          const localTitles = (localRes.ok && localRes.data && Array.isArray(localRes.data.titles))
            ? localRes.data.titles : [];
          dropdown.innerHTML = localTitles.length
            ? `<div class="search-dropdown-busy">${escapeHtml(LIVE_BUSY_MESSAGE)}</div>` +
              localTitles.map((t) => searchRowHtml(t, detailHref(t.slug))).join("")
            : `<div class="search-dropdown-msg">${escapeHtml(LIVE_BUSY_MESSAGE)}</div>`;
          dropdown.classList.add("is-open");
          return;
        }

        if (!local.length && !more.length) {
          dropdown.innerHTML = `<div class="search-dropdown-msg">No anime found for "${escapeHtml(q)}"</div>`;
          dropdown.classList.add("is-open");
          return;
        }

        dropdown.innerHTML =
          (local.length
            ? `<div class="search-group-label">On AniFlick</div>` + local.map((t) => searchRowHtml(t, detailHref(t.slug))).join("")
            : "") +
          (more.length
            ? `<div class="search-group-label">More results</div>` + more.map((t) => searchRowHtml(t, liveDetailHref(t))).join("")
            : "");
        dropdown.classList.add("is-open");
      }, 300);
    });

    // Close dropdown on outside click
    document.addEventListener("click", (e) => {
      if (!input.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.classList.remove("is-open");
        if (
          searchWrapper &&
          !searchWrapper.contains(e.target) &&
          (!mobileSearchBtn || !mobileSearchBtn.contains(e.target))
        ) {
          closeMobileSearch();
        }
      }
    });

    function submitSearch() {
      const q = input.value.trim();
      if (!q) return;
      dropdown.classList.remove("is-open");
      const isBrowsePage = window.location.pathname.endsWith("browse.html") || window.location.pathname.endsWith("/browse");
      if (isBrowsePage) {
        const url = new URL(window.location);
        url.searchParams.set("q", q);
        window.history.replaceState({}, "", url.toString());
        if (typeof window.__onSearchLiveFilter === "function") {
          window.__onSearchLiveFilter(q);
        }
      } else {
        window.location.href = `browse.html?q=${encodeURIComponent(q)}`;
      }
    }

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitSearch();
      } else if (e.key === "Escape") {
        dropdown.classList.remove("is-open");
        dropdown.innerHTML = "";
        input.value = "";
        input.blur();
        closeMobileSearch();
      }
    });

    // Submit on search button click
    const searchBtn = input.parentElement ? input.parentElement.querySelector(".search-btn") : null;
    if (searchBtn) {
      searchBtn.addEventListener("click", (e) => {
        e.preventDefault();
        submitSearch();
      });
    }
  }

  async function initSpotlightSlider() {
    const sliderContainer = document.getElementById("spotlight-slider-container");
    if (!sliderContainer) return;

    let currentSlide = 0;
    let rendered = false;
    const pendingDirs = [];
    let autoInterval = null;
    let drainTimer = null;

    function applyBackdrop(slide) {
      if (!slide || slide.dataset.backdropLoaded === "true") return;
      const poster = slide.dataset.poster;
      if (!poster) return;
      slide.dataset.backdropLoaded = "true";
      const backdrop = slide.querySelector(".spotlight-backdrop");
      if (backdrop) backdrop.style.backgroundImage = `url('${poster}')`;
    }

    function goToSlide(n) {
      const slides = sliderContainer.querySelectorAll(".spotlight-slide");
      if (!slides.length) return;
      slides.forEach((s) => s.classList.remove("is-active"));
      currentSlide = ((n % slides.length) + slides.length) % slides.length;
      slides[currentSlide].classList.add("is-active");
      applyBackdrop(slides[currentSlide]);
    }

    function startAutoRotate() {
      if (autoInterval) clearInterval(autoInterval);
      autoInterval = setInterval(() => goToSlide(currentSlide + 1), 6000);
    }
    function manualGoTo(n) {
      goToSlide(n);
      startAutoRotate();
    }

    function drainPending() {
      drainTimer = null;
      if (!pendingDirs.length) return;
      manualGoTo(currentSlide + pendingDirs.shift());
      if (pendingDirs.length) drainTimer = setTimeout(drainPending, 150);
    }
    function onArrow(dir) {
      if (!rendered) {
        pendingDirs.push(dir);
        return;
      }
      manualGoTo(currentSlide + dir);
    }
    const prevBtn = document.getElementById("spotlight-prev");
    const nextBtn = document.getElementById("spotlight-next");
    if (prevBtn) prevBtn.addEventListener("click", () => onArrow(-1));
    if (nextBtn) nextBtn.addEventListener("click", () => onArrow(1));
    sliderContainer.addEventListener("mouseenter", () => {
      if (autoInterval) clearInterval(autoInterval);
      autoInterval = null;
    });
    sliderContainer.addEventListener("mouseleave", startAutoRotate);

    const res = await fetchTitles(18);
    if (!res.ok || !res.data || !res.data.titles || res.data.titles.length === 0) {
      
      rendered = true;
      applyBackdrop(sliderContainer.querySelector(".spotlight-slide"));
      startAutoRotate();
      if (pendingDirs.length) drainTimer = setTimeout(drainPending, 150);
      return;
    }

    const titles = res.data.titles;

    sliderContainer.innerHTML = titles
      .map((t, idx) => `
        <div class="spotlight-slide ${idx === 0 ? "is-active" : ""}" data-index="${idx}" data-poster="${bannerOf(t)}">
          <div class="spotlight-backdrop"></div>
          <div class="spotlight-overlay"></div>
          <div class="spotlight-content">
            <span class="spotlight-rank">🔥 #${idx + 1} Spotlight</span>
            <h1 class="spotlight-title"><a class="spotlight-title-link" href="${detailHref(t.slug)}">${escapeHtml(t.name)}</a></h1>
            <div class="spotlight-badges">
              ${subCount(t) ? `<span class="badge badge-sub">SUB ${subCount(t)}</span>` : ""}
              ${t.dubCount > 0 ? `<span class="badge badge-dub">DUB ${t.dubCount}</span>` : ""}
              <span class="badge badge-type">${t.kind}</span>
              <span class="badge badge-hd">HD</span>
              <span class="spotlight-runtime-meta">${t.year} • ${t.runtimeMin}m</span>
            </div>
            <p class="spotlight-desc">${escapeHtml(truncateWords(t.synopsis || t.tagline, 200))}</p>
            <div class="spotlight-actions">
              <a class="btn-watch-now" href="${watchHref(t.slug, 1)}">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>
                Watch Now
              </a>
              <a class="btn-detail" href="${detailHref(t.slug)}">+ Detail</a>
            </div>
          </div>
        </div>
      `)
      .join("");

    currentSlide = 0;
    rendered = true;
    applyBackdrop(sliderContainer.querySelector(".spotlight-slide"));
    startAutoRotate();
    
    if (pendingDirs.length) drainTimer = setTimeout(drainPending, 150);
  }

  async function initContinueWatchingRail() {
    const section = document.getElementById("continue-watching-section");
    if (!section) return;
    const row = document.getElementById("continue-watching-row");
    if (!row) return;

    if (!currentUser) {
      section.hidden = true;
      section.style.display = "none";
      row.innerHTML = "";
      return;
    }

    try {
      const res = await api("/api/progress/continue");
      if (!res.ok || !res.data || !Array.isArray(res.data.items) || res.data.items.length === 0) {
        section.hidden = true;
        section.style.display = "none";
        row.innerHTML = "";
        return;
      }

      const items = res.data.items;

      function formatSec(s) {
        const sec = Math.floor(Math.max(0, s || 0));
        const m = Math.floor(sec / 60);
        const rem = sec % 60;
        return `${m}:${rem < 10 ? "0" : ""}${rem}`;
      }

      function escapeText(str) {
        if (!str) return "";
        return String(str)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }

      row.innerHTML = items
        .map((item) => {
          const poster = item.cover || COVER_FALLBACK;
          const safeName = escapeText(item.titleName || item.slug);
          const epNum = item.episodeNum || 1;
          const detailLink = detailHref(item.slug);
          
          const resumeHref = `watch.html?slug=${encodeURIComponent(item.slug)}&ep=${encodeURIComponent(epNum)}`;
          const pct = Math.min(100, Math.max(0, typeof item.percent === "number" ? item.percent : 0));
          const timeLabel = item.durationSec ? `${formatSec(item.positionSec)} / ${formatSec(item.durationSec)}` : `${pct}%`;

          return `
            <div class="zoro-card" data-slug="${escapeText(item.slug)}">
              <a class="zoro-card-poster" href="${detailLink}">
                <img src="${poster}" alt="${safeName}" loading="lazy" decoding="async" fetchpriority="low">
                <div class="zoro-play-overlay">
                  <div class="zoro-play-circle">▶</div>
                </div>
                <div class="zoro-poster-badges">
                  <div class="badges-left">
                    ${subCount(item) ? subBadge(item) : ""}
                  </div>
                </div>
              </a>
              <div class="zoro-card-info">
                <a class="zoro-card-title" href="${detailLink}" title="${safeName}">${safeName}</a>
                <div class="zoro-card-submeta continue-card-submeta">
                  <span>Episode ${epNum}</span> • <span>${pct}%</span>
                </div>
                <div class="progress-track-zoro continue-progress-track" title="${timeLabel} (${pct}%)">
                  <div class="progress-fill-zoro" data-progress="${pct}"></div>
                </div>
                <a class="btn-zoro-primary btn-continue-resume" href="${resumeHref}">
                  ▶ Resume
                </a>
              </div>
            </div>
          `;
        })
        .join("");

      track.querySelectorAll(".progress-fill-zoro[data-progress]").forEach((el) => {
        el.style.width = `${el.dataset.progress}%`;
      });

      section.hidden = false;
      section.style.display = "";
    } catch (err) {
      console.error("Failed to load continue watching rail:", err);
      section.hidden = true;
      section.style.display = "none";
    }
  }

  window.addEventListener("zoro:auth", () => {
    initContinueWatchingRail();
  });

  async function initHomeCatalogColumns() {
    const airingList = document.getElementById("col-airing-list");
    const popularList = document.getElementById("col-popular-list");
    const favoriteList = document.getElementById("col-favorite-list");
    const completedList = document.getElementById("col-completed-list");

    for (const list of [airingList, popularList, favoriteList, completedList]) {
      if (list && !list.querySelector(".col-item")) {
        list.innerHTML = Array.from({ length: 5 }, () => `
          <div class="col-item col-item-skeleton" aria-hidden="true">
            <div class="col-thumb skeleton-shimmer"></div>
            <div class="col-item-details">
              <div class="skeleton-line skeleton-shimmer skeleton-w-90"></div>
              <div class="skeleton-line skeleton-shimmer skeleton-w-55"></div>
            </div>
          </div>
        `).join("");
      }
    }

    const res = await fetchTitles(18);
    if (!res.ok || !res.data || !res.data.titles) return;
    const allTitles = res.data.titles;

    function renderColItems(container, items) {
      if (!container) return;
      container.innerHTML = items.map((t) => `
        <a class="col-item" href="${detailHref(t.slug)}">
          <img class="col-thumb" src="${coverOf(t)}" alt="${escapeHtml(t.name)}" loading="lazy" decoding="async" fetchpriority="low">
          <div class="col-item-details">
            <div class="col-item-title" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</div>
            <div class="col-item-meta">
              ${subBadge(t)}
              ${dubBadge(t)}
            </div>
          </div>
        </a>
      `).join("");
    }

    renderColItems(airingList, allTitles.slice(0, 5));
    renderColItems(popularList, allTitles.slice(5, 10));
    renderColItems(favoriteList, allTitles.slice(10, 15));
    renderColItems(completedList, allTitles.slice(3, 8));
  }

  const TOP_TEN_TABS = [
    { sort: "trending", label: "Trending" },
    { sort: "popular", label: "Most Popular" },
    { sort: "top", label: "Top Rated" },
  ];

  async function initTopTenTabs() {
    const rail = document.getElementById("top10-rail");
    if (!rail) return;
    const tabsWrap = document.getElementById("top10-tabs");
    let activeSort = TOP_TEN_TABS[0].sort;

    rail.innerHTML = Array.from({ length: 7 }, () => `
      <div class="trending-item trending-item-skeleton" aria-hidden="true">
        <div class="trending-poster-wrap skeleton-shimmer"></div>
      </div>
    `).join("");

    function renderTabs() {
      if (!tabsWrap) return;
      tabsWrap.innerHTML = TOP_TEN_TABS.map((tab) =>
        `<button class="top10-tab${tab.sort === activeSort ? " active" : ""}" type="button" data-sort="${tab.sort}">${escapeHtml(tab.label)}</button>`
      ).join("");
    }
    renderTabs();

    if (tabsWrap && tabsWrap.dataset.bound !== "true") {
      tabsWrap.dataset.bound = "true";
      tabsWrap.addEventListener("click", (e) => {
        const btn = e.target.closest(".top10-tab");
        if (!btn || btn.dataset.sort === activeSort) return;
        activeSort = btn.dataset.sort;
        renderTabs();
        load();
      });
    }

    const prev = document.getElementById("top10-prev");
    const next = document.getElementById("top10-next");
    const scrollBy = (dirCards) => {
      const items = Array.from(rail.querySelectorAll(".trending-item"));
      if (!items.length) return;
      const railRect = rail.getBoundingClientRect();
      const gap = parseFloat(getComputedStyle(rail).columnGap) || 20;
      const step = items[0].getBoundingClientRect().width + gap;
      const visibleCount = Math.max(1, Math.round(railRect.width / step));
      const lastStartIdx = Math.max(0, items.length - visibleCount);
      const idx = Math.round(rail.scrollLeft / step);
      const targetIdx = Math.min(lastStartIdx, Math.max(0, idx + dirCards));
      let target;
      if (targetIdx >= lastStartIdx && items.length > visibleCount) {
        const lastRect = items[items.length - 1].getBoundingClientRect();
        target = rail.scrollLeft + (lastRect.right - railRect.right);
      } else {
        const cardRect = items[targetIdx].getBoundingClientRect();
        target = rail.scrollLeft + (cardRect.left - railRect.left);
      }
      rail.scrollTo({ left: Math.max(0, target), behavior: "instant" });
    };
    if (prev && prev.dataset.bound !== "true") {
      prev.dataset.bound = "true";
      prev.addEventListener("click", () => scrollBy(-2));
    }
    if (next && next.dataset.bound !== "true") {
      next.dataset.bound = "true";
      next.addEventListener("click", () => scrollBy(2));
    }

    async function load() {
      rail.innerHTML = Array.from({ length: 7 }, () => `
        <div class="trending-item trending-item-skeleton" aria-hidden="true">
          <div class="trending-poster-wrap skeleton-shimmer"></div>
        </div>
      `).join("");
      const tab = TOP_TEN_TABS.find((t) => t.sort === activeSort) || TOP_TEN_TABS[0];
      const res = await api(`/api/browse?sort=${encodeURIComponent(tab.sort)}&perPage=10&page=1`);
      if (!res.ok || !res.data || !Array.isArray(res.data.results) || !res.data.results.length) {
        const section = rail.closest("section");
        if (section) section.hidden = true;
        rail.innerHTML = "";
        return;
      }
      rail.innerHTML = res.data.results.slice(0, 10).map((t, i) => `
        <a class="trending-item" href="${liveDetailHref(t)}">
          <div class="trending-poster-wrap">
            <img src="${escapeHtml(coverOf(t))}" alt="${escapeHtml(t.name)}" loading="lazy" decoding="async" fetchpriority="low">
            <div class="trending-rank-num">${(i + 1 < 10 ? "0" : "") + (i + 1)}</div>
            <div class="trending-info-overlay">
              <div class="trending-anime-title">${escapeHtml(t.name)}</div>
              <div class="col-item-submeta">
                ${subCount(t) ? `<span class="text-zoro-sub">SUB ${subCount(t)}</span>` : ""}<span>${t.year}</span>
              </div>
            </div>
          </div>
        </a>
      `).join("");
      markContentReady();
    }

    await load();
  }

  let tooltipEl = null;
  let activeHoverSlug = null;

  function createHoverTooltip() {
    if (tooltipEl) return tooltipEl;
    tooltipEl = document.createElement("div");
    tooltipEl.className = "zoro-tooltip";
    document.body.appendChild(tooltipEl);
    return tooltipEl;
  }

  function hideHoverTooltip() {
    activeHoverSlug = null;
    if (tooltipEl) {
      tooltipEl.classList.remove("is-visible");
      tooltipEl.style.display = "none";
    }
  }

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".zoro-card") && !e.target.closest(".zoro-tooltip")) {
      hideHoverTooltip();
    }
  });
  window.addEventListener("scroll", hideHoverTooltip, { passive: true });

  async function initMainCatalogGrid() {
    const grid = document.getElementById("zoro-main-grid");
    if (!grid) return;

    const isBrowse = window.location.pathname.endsWith("browse.html") || window.location.pathname.endsWith("/browse");
    const PAGE_SIZE = 12;

    if (isBrowse) {
      initLiveBrowse();
      return;
    }

    if (!grid.querySelector(".zoro-card")) {
      grid.innerHTML = Array.from({ length: 12 }, () => `
        <div class="zoro-card zoro-card-skeleton" aria-hidden="true">
          <div class="zoro-card-poster skeleton-shimmer"></div>
          <div class="zoro-card-info">
            <div class="skeleton-line skeleton-shimmer skeleton-w-85"></div>
            <div class="skeleton-line skeleton-shimmer skeleton-w-55"></div>
          </div>
        </div>
      `).join("");
    }

    const urlParams = new URLSearchParams(window.location.search);
    const initialGenre = urlParams.get("genre");
    const initialQ = urlParams.get("q");
    const initialSort = urlParams.get("sort");
    const initialKind = (urlParams.get("kind") || "").toLowerCase();
    
    const initialView = (urlParams.get("view") || "").toLowerCase();

    const chipsWrap = document.getElementById("genre-chips-container");
    const sortSelect = document.getElementById("catalog-sort-select");
    const headingEl = document.getElementById("browse-heading");
    const subheadingEl = document.getElementById("browse-subheading");
    const paginationWrap = document.getElementById("catalog-pagination");

    let currentGenre = (initialGenre || "all").toLowerCase();
    let currentSearch = (initialQ || "").trim();
    let currentSort = ["popularity", "newest", "az"].includes(initialSort) ? initialSort : "popularity";
    let currentKind = initialKind === "film" ? "film" : "";
    let currentView = initialView === "top-airing" ? "top-airing" : "";
    let currentPage = 1;

    if (sortSelect) sortSelect.value = currentSort;

    const searchInput = document.getElementById("zoro-search-input");
    if (searchInput && initialQ) searchInput.value = initialQ;

    function browseMode() {
      if (currentSearch) return "search";
      if (currentKind === "film") return "movies";
      if (currentView === "top-airing") return "topairing";
      return "browse";
    }

    function setActiveNav() {
      if (!isBrowse) return;
      const mode = browseMode();
      const wantHref =
        mode === "movies" ? "browse.html?kind=film" :
        mode === "topairing" ? "browse.html?view=top-airing&sort=newest" :
        "browse.html";
      document.querySelectorAll(".header-nav .nav-link").forEach((a) => {
        a.classList.toggle("active", a.getAttribute("href") === wantHref);
      });
    }

    function updateHeading(count) {
      if (!headingEl) return;
      const mode = browseMode();
      
      const genreFiltered = currentGenre && currentGenre !== "all";
      if (mode === "search") {
        const countPart = count == null ? "" : ` (${count} ${count === 1 ? "result" : "results"})`;
        
        headingEl.innerHTML = `<span>Results for '<span class="accent">${escapeHtml(currentSearch)}</span>'${countPart}</span>`;
        if (subheadingEl) subheadingEl.textContent = "Refine with the genre filters below, or clear the search to see the full shelf.";
      } else if (genreFiltered) {
        const label = genreLabel(currentGenre);
        const countPart = count == null ? "" : ` (${count} ${count === 1 ? "title" : "titles"})`;
        headingEl.innerHTML = `<span>${escapeHtml(label)}<span class="accent">${countPart}</span></span>`;
        if (subheadingEl) subheadingEl.textContent = "Filtered by genre — pick another chip or All to see the full shelf.";
      } else if (mode === "movies") {
        headingEl.innerHTML = "Movies";
        if (subheadingEl) subheadingEl.textContent = "Every film in the catalog — feature-length titles ready to stream.";
      } else if (mode === "topairing") {
        headingEl.innerHTML = `Top <span class="accent">Airing</span>`;
        if (subheadingEl) subheadingEl.textContent = "The currently airing shelf — newest releases first by default; sort however you like.";
      } else {
        headingEl.innerHTML = `Explore <span class="accent">Anime Shelf</span>`;
        if (subheadingEl) subheadingEl.textContent = "Filter by genre, sort by popularity or release date.";
      }
      setActiveNav();
    }
    
    updateHeading(null);

    if (chipsWrap) {
      const gRes = await api("/api/genres");
      if (gRes.ok && gRes.data && gRes.data.counts) {
        const counts = gRes.data.counts;
        const keys = Object.keys(counts).sort(
          (a, b) => counts[b] - counts[a] || a.localeCompare(b)
        );
        chipsWrap.innerHTML =
          `<button class="genre-chip-zoro active" data-genre="all" type="button">All</button>` +
          keys
            .map((k) => {
              const label = (GENRE_META[k] && GENRE_META[k].label) || k.charAt(0).toUpperCase() + k.slice(1);
              return `<button class="genre-chip-zoro" data-genre="${encodeURIComponent(k)}" type="button">${escapeHtml(label)}</button>`;
            })
            .join("");
        if (currentGenre !== "all") {
          const match = chipsWrap.querySelector(`[data-genre="${currentGenre}"]`);
          if (match) {
            chipsWrap.querySelectorAll(".genre-chip-zoro").forEach((c) => c.classList.remove("active"));
            match.classList.add("active");
          }
        }
      }
    }

    const res = await fetchTitles(18);
    if (!res.ok || !res.data || !res.data.titles) return;

    const titles = res.data.titles;

    function filteredList() {
      let list = titles.slice();

      if (currentSearch) {
        const qLower = currentSearch.toLowerCase();
        list = list.filter(
          (t) =>
            t.name.toLowerCase().includes(qLower) ||
            (t.romajiTitle && t.romajiTitle.toLowerCase().includes(qLower)) ||
            (t.nativeTitle && t.nativeTitle.toLowerCase().includes(qLower))
        );
      }

      // 2. Filter by kind (Movies nav = films only)
      if (currentKind === "film") {
        list = list.filter((t) => (t.kind || "").toLowerCase() === "film");
      }

      // 3. Filter by genre
      if (currentGenre && currentGenre !== "all") {
        list = list.filter(
          (t) => t.genres && t.genres.some((g) => g.toLowerCase() === currentGenre)
        );
      }

      if (currentSort === "newest") {
        list.sort((a, b) => (b.year || 0) - (a.year || 0) || (b.created_at || 0) - (a.created_at || 0));
      } else if (currentSort === "az") {
        list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      } else if (currentSort === "popularity") {
        
      }

      return list;
    }

    function renderPagination(totalItems) {
      if (!paginationWrap) return;
      const totalPages = Math.ceil(totalItems / PAGE_SIZE);
      if (!isBrowse || totalPages <= 1) {
        paginationWrap.hidden = true;
        paginationWrap.innerHTML = "";
        return;
      }
      if (currentPage > totalPages) currentPage = totalPages;
      let html = `<button class="page-btn" type="button" data-page="${currentPage - 1}"${currentPage === 1 ? " disabled" : ""} aria-label="Previous page">‹ Prev</button>`;
      for (let p = 1; p <= totalPages; p++) {
        html += `<button class="page-btn${p === currentPage ? " active" : ""}" type="button" data-page="${p}"${p === currentPage ? ' aria-current="page"' : ""}>${p}</button>`;
      }
      html += `<button class="page-btn" type="button" data-page="${currentPage + 1}"${currentPage === totalPages ? " disabled" : ""} aria-label="Next page">Next ›</button>`;
      paginationWrap.innerHTML = html;
      paginationWrap.hidden = false;
    }

    function renderCards(list) {
      hideHoverTooltip();
      const mainEl = grid.closest("main");
      updateHeading(list.length);
      if (!list.length) {
        grid.innerHTML = `
          <div class="zoro-empty-state" id="zoro-empty-state">
            <div class="zoro-empty-state-icon">
              <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="11" cy="11" r="8"></circle>
                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
              </svg>
            </div>
            <h3 class="zoro-empty-state-title">No Anime Found</h3>
            <p class="zoro-empty-state-msg">We couldn't find any results${currentSearch ? ` for "<span class="accent-query">${escapeHtml(currentSearch)}</span>"` : ""}. Try another title or genre, or return to the full catalog.</p>
            <a href="browse.html" class="empty-state-browse-link">Back to Browse</a>
          </div>
        `;
        
        if (mainEl) mainEl.classList.add("grid-is-empty");
        renderPagination(0);
        markContentReady();
        return;
      }

      if (mainEl) mainEl.classList.remove("grid-is-empty");
      const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
      if (currentPage > totalPages) currentPage = totalPages;
      const pageItems = isBrowse
        ? list.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE)
        : list;
      grid.innerHTML = pageItems.map((t, i) => {
        
        const cardHref = isBrowse ? detailHref(t.slug) : watchHref(t.slug, t.episodes || 1);
        return `
        <div class="zoro-card" data-slug="${t.slug}" data-genres="${t.genres ? t.genres.join(" ") : ""}" data-title="${escapeHtml(t.name)}">
          <a class="zoro-card-poster" href="${cardHref}">
            <img src="${coverOf(t)}" alt="${escapeHtml(t.name)}" loading="${i < 6 ? "eager" : "lazy"}" decoding="async" fetchpriority="${i < 6 ? "high" : "low"}">
            <div class="zoro-play-overlay">
              <div class="zoro-play-circle">▶</div>
            </div>
            <div class="zoro-poster-badges">
              <div class="badges-left">
                ${subBadge(t)}
                ${dubBadge(t)}
              </div>
            </div>
          </a>
          <div class="zoro-card-info">
            <a class="zoro-card-title" href="${cardHref}">${escapeHtml(t.name)}</a>
            <div class="zoro-card-submeta">
              <span>${t.kind}</span> • <span>${t.runtimeMin}m</span>
            </div>
          </div>
        </div>
      `;
      }).join("");

      attachTooltipListeners();
      renderPagination(list.length);
      
      markContentReady();
    }

    function applyFilterAndSort() {
      currentPage = 1;
      renderCards(filteredList());
    }

    applyFilterAndSort();

    // Genre filter chips (dismiss preview on change)
    if (chipsWrap) {
      chipsWrap.addEventListener("click", (e) => {
        const chip = e.target.closest(".genre-chip-zoro");
        if (!chip) return;
        chipsWrap.querySelectorAll(".genre-chip-zoro").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        currentGenre = (chip.dataset.genre || "all").toLowerCase();
        applyFilterAndSort();
      });
    }

    // Sort dropdown change
    if (sortSelect) {
      sortSelect.addEventListener("change", () => {
        currentSort = sortSelect.value;
        applyFilterAndSort();
      });
    }

    if (paginationWrap) {
      paginationWrap.addEventListener("click", (e) => {
        const btn = e.target.closest(".page-btn");
        if (!btn || btn.disabled) return;
        const p = Number(btn.dataset.page);
        if (!Number.isFinite(p) || p === currentPage) return;
        currentPage = p;
        renderCards(filteredList());
        
        const top = grid.getBoundingClientRect().top + window.scrollY - 90;
        window.scrollTo({ top: Math.max(0, top), behavior: "instant" });
      });
    }

    if (isBrowse) {
      window.__onSearchLiveFilter = (q) => {
        currentSearch = (q || "").trim();
        applyFilterAndSort();
      };
    }
  }

  /* __BROWSE_LABEL_LOGIC_START__ */
  const ANILIST_TOTAL_CAP = 5000;

  function browseCountLabel(pageInfo, count, searchMode) {
    const rawTotal = pageInfo && Number.isFinite(Number(pageInfo.total)) ? Number(pageInfo.total) : null;
    if (rawTotal == null) {
      return count != null && searchMode ? `${count} ${count === 1 ? "title" : "titles"}` : "";
    }
    
    return rawTotal >= ANILIST_TOTAL_CAP
      ? `5,000+ ${rawTotal === 1 ? "title" : "titles"}`
      : `${rawTotal.toLocaleString()} ${rawTotal === 1 ? "title" : "titles"}`;
  }

  function browsePaginationBounds(hasFilter, pageInfo, current) {
    const bounded = !!(hasFilter && pageInfo && Number(pageInfo.total) >= ANILIST_TOTAL_CAP);
    const last = bounded
      ? (pageInfo.hasNextPage ? current + 1 : current)
      : ((pageInfo && Number(pageInfo.lastPage)) || current);
    return { bounded, last };
  }
  /* __BROWSE_LABEL_LOGIC_END__ */

  async function initLiveBrowse() {
    const grid = document.getElementById("zoro-main-grid");
    if (!grid) return;

    const chipsWrap = document.getElementById("genre-chips-container");
    const sortSelect = document.getElementById("catalog-sort-select");
    const formatSelect = document.getElementById("browse-format-select");
    const statusSelect = document.getElementById("browse-status-select");
    const yearSelect = document.getElementById("browse-year-select");
    const filterRow = document.getElementById("live-filter-row");
    const headingEl = document.getElementById("browse-heading");
    const subheadingEl = document.getElementById("browse-subheading");
    const paginationWrap = document.getElementById("catalog-pagination");
    const searchInput = document.getElementById("zoro-search-input");

    /* Phase 2 full-filter controls. */
    const filtersPanel = document.getElementById("filters-panel");
    const filtersToggle = document.getElementById("filters-toggle");
    const filtersBody = document.getElementById("filters-panel-body");
    const scoreSelect = document.getElementById("browse-score-select");
    const seasonSelect = document.getElementById("browse-season-select");
    const startYearSelect = document.getElementById("browse-start-year");
    const endYearSelect = document.getElementById("browse-end-year");
    const tagChipsWrap = document.getElementById("browse-tag-chips");
    const filtersApply = document.getElementById("filters-apply");
    const filtersReset = document.getElementById("filters-reset");

    const params = new URLSearchParams(window.location.search);
    const view = (params.get("view") || "").toLowerCase();
    const kind = (params.get("kind") || "").toLowerCase();
    
    const viewIsTopAiring = view === "top-airing";
    const viewIsTopUpcoming = view === "top-upcoming";
    
    const viewIsSubbed = view === "subbed";
    const viewIsDubbed = view === "dubbed";
    const VIEW_FORMAT = { movie: "MOVIE", ona: "ONA", special: "SPECIAL", tv: "TV" };
    const VIEW_LABEL = { movie: "Movies", ona: "ONAs", special: "Specials", tv: "TV" };
    const viewFormat = VIEW_FORMAT[view] || "";
    const viewIsMovie = view === "movie" || kind === "film";

    const state = {
      q: (params.get("q") || "").trim(),
      sort: params.get("sort") || (viewIsTopAiring || viewIsTopUpcoming ? "popular" : "trending"),
      genre: canonicalGenreName(params.get("genre") || ""),
      format: params.get("format") || viewFormat || (kind === "film" ? "MOVIE" : ""),
      status: params.get("status") || (viewIsTopAiring ? "RELEASING" : viewIsTopUpcoming ? "NOT_YET_RELEASED" : ""),
      year: params.get("year") || "",
      
      minScore: params.get("minScore") || "",
      maxScore: params.get("maxScore") || "",
      season: (params.get("season") || "").toUpperCase(),
      tags: parseTagList(params.get("tags")),
      startAfter: params.get("startAfter") || "",
      startBefore: params.get("startBefore") || "",
      page: (() => {
        const p = Number(params.get("page"));
        return Number.isFinite(p) && p > 0 ? Math.floor(p) : 1;
      })(),
    };
    if (!SORT_LABELS[state.sort]) state.sort = "trending";
    if (!["WINTER", "SPRING", "SUMMER", "FALL"].includes(state.season)) state.season = "";

    function isSearch() { return !!state.q; }
    if (searchInput && state.q) searchInput.value = state.q;

    function renderGridSkeleton() {
      grid.innerHTML = Array.from({ length: LIVE_PAGE_SIZE }, () => `
        <div class="zoro-card zoro-card-skeleton" aria-hidden="true">
          <div class="zoro-card-poster skeleton-shimmer"></div>
          <div class="zoro-card-info">
            <div class="skeleton-line skeleton-shimmer skeleton-w-85"></div>
            <div class="skeleton-line skeleton-shimmer skeleton-w-55"></div>
          </div>
        </div>`).join("");
    }
    renderGridSkeleton();

    let chipGenres = ANILIST_GENRES;
    function renderChips() {
      if (!chipsWrap) return;
      chipsWrap.innerHTML =
        `<button class="genre-chip-zoro${state.genre ? "" : " active"}" data-genre="" type="button">All</button>` +
        chipGenres.map((g) => {
          const active = state.genre && state.genre.toLowerCase() === g.toLowerCase();
          return `<button class="genre-chip-zoro${active ? " active" : ""}" data-genre="${encodeURIComponent(g)}" type="button">${escapeHtml(g)}</button>`;
        }).join("");
    }
    renderChips();
    api("/api/genres").then((res) => {
      const list = res && res.ok && res.data && Array.isArray(res.data.allGenres) ? res.data.allGenres : null;
      if (!list || !list.length || state.genre) return;
      chipGenres = list;
      renderChips();
    }).catch(() => {});

    function renderYears() {
      if (!yearSelect) return;
      let html = `<option value="">All years</option>`;
      for (const y of browseYearRange()) {
        html += `<option value="${y}">${y}</option>`;
      }
      yearSelect.innerHTML = html;
      yearSelect.value = state.year || "";
    }

    function renderFilterOptions() {
      const years = browseYearRange();
      const yearOptions = (sel, current) => {
        if (!sel) return;
        sel.innerHTML = `<option value="">${sel === startYearSelect ? "Any start" : "Any end"}</option>` +
          years.map((y) => `<option value="${y}">${y}</option>`).join("");
        sel.value = current || "";
      };
      yearOptions(startYearSelect, state.startAfter);
      yearOptions(endYearSelect, state.startBefore);
      if (scoreSelect) scoreSelect.value = state.minScore || "";
      if (seasonSelect) seasonSelect.value = state.season || "";
    }

    function renderTagChips() {
      if (!tagChipsWrap) return;
      tagChipsWrap.innerHTML = BROWSE_TAGS.map((tag) => {
        const active = state.tags.some((t) => t.toLowerCase() === tag.toLowerCase());
        return `<button class="filter-tag-chip${active ? " active" : ""}" type="button" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`;
      }).join("");
    }

    function syncFilterUI() {
      renderFilterOptions();
      renderTagChips();
    }

    function setFiltersOpen(open) {
      if (!filtersPanel || !filtersBody || !filtersToggle) return;
      filtersPanel.classList.toggle("is-open", open);
      filtersBody.hidden = !open;
      filtersToggle.setAttribute("aria-expanded", open ? "true" : "false");
    }

    function hasPhase2Filters() {
      return !!(state.minScore || state.maxScore || state.season || state.tags.length || state.startAfter || state.startBefore);
    }

    function applyFilters() {
      if (scoreSelect) state.minScore = scoreSelect.value || "";
      if (seasonSelect) state.season = seasonSelect.value || "";
      if (startYearSelect) state.startAfter = startYearSelect.value || "";
      if (endYearSelect) state.startBefore = endYearSelect.value || "";
      state.page = 1;
      updateUrl();
      load();
    }

    function resetFilters() {
      state.minScore = "";
      state.maxScore = "";
      state.season = "";
      state.tags = [];
      state.startAfter = "";
      state.startBefore = "";
      if (scoreSelect) scoreSelect.value = "";
      if (seasonSelect) seasonSelect.value = "";
      if (startYearSelect) startYearSelect.value = "";
      if (endYearSelect) endYearSelect.value = "";
      renderTagChips();
      state.page = 1;
      updateUrl();
      load();
    }

    const yearSection = document.getElementById("browse-year-section");
    const yearDecadesWrap = document.getElementById("browse-year-decades");

    function renderYearSection() {
      if (!yearDecadesWrap) return;
      const decades = new Map();
      for (const y of browseYearRange()) {
        const decade = browseDecadeOf(y);
        if (!decades.has(decade)) decades.set(decade, []);
        decades.get(decade).push(y);
      }
      yearDecadesWrap.innerHTML = Array.from(decades.keys())
        .sort((a, b) => b - a)
        .map((decade) => {
          const chips = decades
            .get(decade)
            .map(
              (y) =>
                `<button class="browse-year-chip${String(state.year) === String(y) ? " active" : ""}" type="button" data-year="${y}">${y}</button>`
            )
            .join("");
          return `<div class="browse-year-decade"><span class="browse-year-decade-label">${decade}s</span>${chips}</div>`;
        })
        .join("");
      const startEl = document.querySelector(".js-year-range-start");
      if (startEl) startEl.textContent = String(BROWSE_YEAR_MIN);
      const endEl = document.querySelector(".js-year-range-end");
      if (endEl) endEl.textContent = String(browseYearRange()[0]);
    }

    function syncYearUI() {
      if (yearSelect) yearSelect.value = state.year || "";
      if (yearDecadesWrap) {
        yearDecadesWrap.querySelectorAll(".browse-year-chip").forEach((chip) => {
          chip.classList.toggle("active", String(chip.dataset.year) === String(state.year || ""));
        });
      }
    }

    function updateUrl() {
      const p = new URLSearchParams();
      if (state.q) p.set("q", state.q);
      if (state.sort !== "trending") p.set("sort", state.sort);
      if (state.genre) p.set("genre", state.genre);
      if (state.format) p.set("format", state.format);
      if (state.status) p.set("status", state.status);
      if (state.year) p.set("year", state.year);
      
      if (state.minScore) p.set("minScore", state.minScore);
      if (state.maxScore) p.set("maxScore", state.maxScore);
      if (state.season) p.set("season", state.season);
      if (state.tags.length) p.set("tags", state.tags.join(","));
      if (state.startAfter) p.set("startAfter", state.startAfter);
      if (state.startBefore) p.set("startBefore", state.startBefore);
      if (state.page > 1) p.set("page", String(state.page));
      if (view) p.set("view", view);
      if (kind) p.set("kind", kind);
      const qs = p.toString();
      window.history.replaceState({}, "", `browse.html${qs ? `?${qs}` : ""}`);
    }

    function updateHeading(count, pageInfo) {
      if (!headingEl) return;
      
      const countLabel = browseCountLabel(pageInfo, count, isSearch());

      if (isSearch()) {
        const countPart = countLabel ? ` (${countLabel})` : "";
        headingEl.innerHTML = `<span>Results for '<span class="accent">${escapeHtml(state.q)}</span>'${countPart}</span>`;
        if (subheadingEl) {
          subheadingEl.textContent = "Searching the full catalog — your curated shelf comes first.";
        }
        return;
      }

      const chips = [];
      if (state.genre) chips.push(state.genre);
      if (state.format) chips.push(state.format === "MOVIE" ? "Movies" : state.format);
      if (state.status) chips.push(state.status === "RELEASING" ? "Airing" : state.status === "FINISHED" ? "Finished" : state.status);
      if (state.year) chips.push(state.year);
      
      if (state.minScore) chips.push(`${state.minScore}+ score`);
      if (state.maxScore) chips.push(`≤ ${state.maxScore} score`);
      if (state.season) chips.push(state.season.charAt(0) + state.season.slice(1).toLowerCase());
      if (state.tags.length) chips.push(state.tags.join(", "));
      if (state.startAfter || state.startBefore) {
        chips.push(`${state.startAfter || "…"} – ${state.startBefore || "…"}`);
      }

      let title;
      if (viewIsTopAiring) {
        title = `Top <span class="accent">Airing</span>`;
      } else if (viewIsTopUpcoming) {
        title = `Top <span class="accent">Upcoming</span>`;
      } else if (viewIsSubbed) {
        title = `Subbed <span class="accent">· ${escapeHtml(SORT_LABELS[state.sort] || "Trending")}</span>`;
      } else if (viewIsDubbed) {
        title = `Dubbed <span class="accent">· ${escapeHtml(SORT_LABELS[state.sort] || "Trending")}</span>`;
      } else if (viewIsMovie) {
        title = `Movies <span class="accent">· ${escapeHtml(SORT_LABELS[state.sort] || "")}</span>`;
      } else if (viewFormat) {
        title = `${escapeHtml(VIEW_LABEL[view] || state.format)} <span class="accent">· ${escapeHtml(SORT_LABELS[state.sort] || "Trending")}</span>`;
      } else if (chips.length) {
        title = `${escapeHtml(chips[0])} <span class="accent">· ${escapeHtml(SORT_LABELS[state.sort] || "Trending")}</span>`;
      } else {
        title = `Explore <span class="accent">Anime Shelf</span>`;
      }
      const countPart = countLabel ? ` <span class="accent">(${escapeHtml(countLabel)})</span>` : "";
      headingEl.innerHTML = `<span>${title}${countPart}</span>`;

      if (subheadingEl) {
        const bits = [];
        if (chips.length > 1) bits.push(chips.slice(1).join(" · "));
        bits.push("The full AniList catalog — filters update live.");
        subheadingEl.textContent = bits.join(" · ");
      }
    }

    function updateViewNote() {
      const note = document.getElementById("browse-view-note");
      if (!note) return;
      let text = "";
      if (viewIsSubbed) text = "Every title streams with subtitles.";
      else if (viewIsDubbed) text = "Dub status is verified for catalog titles only.";
      if (!text) {
        note.hidden = true;
        note.textContent = "";
        return;
      }
      note.textContent = text;
      note.hidden = false;
    }
    updateViewNote();

    function renderPagination(pageInfo) {
      if (!paginationWrap) return;
      const current = (pageInfo && Number(pageInfo.currentPage)) || state.page;
      const hasFilter = !!(state.genre || state.format || state.status || state.year || hasPhase2Filters());
      
      const { bounded, last } = browsePaginationBounds(hasFilter, pageInfo, current);
      if (!pageInfo || !pageInfo.hasNextPage && current >= last) {
        if (current <= 1) {
          paginationWrap.hidden = true;
          paginationWrap.innerHTML = "";
          return;
        }
      }
      const pages = [];
      const push = (p) => pages.push(p);
      push(1);
      const from = Math.max(2, current - 2);
      const to = Math.min(last - 1, current + 2);
      if (from > 2) push("…");
      for (let p = from; p <= to; p++) push(p);
      if (to < last - 1) push("…");
      if (last > 1) push(last);

      let html = `<button class="page-btn" type="button" data-page="${current - 1}"${current === 1 ? " disabled" : ""} aria-label="Previous page">‹ Prev</button>`;
      for (const p of pages) {
        if (p === "…") {
          html += `<span class="page-btn page-btn-static">…</span>`;
        } else {
          html += `<button class="page-btn${p === current ? " active" : ""}" type="button" data-page="${p}"${p === current ? ' aria-current="page"' : ""}>${p}</button>`;
        }
      }
      html += `<button class="page-btn" type="button" data-page="${current + 1}"${current >= last ? " disabled" : ""} aria-label="Next page">Next ›</button>`;
      
      if (bounded) {
        const lastFloor = (pageInfo && Number(pageInfo.lastPage)) || last;
        html += `<span class="page-btn page-btn-static" aria-live="polite">Page ${current} of ${lastFloor}+</span>`;
      } else if (last > 1) {
        html += `<span class="page-btn page-btn-static" aria-live="polite">Page ${current} of ${last}</span>`;
      }
      paginationWrap.innerHTML = html;
      paginationWrap.hidden = false;
    }

    async function renderLibraryFallback() {
      renderLiveNotice(LIVE_LIBRARY_MESSAGE, "library");
      const res = await api("/api/titles?limit=18");
      const titles = (res.ok && res.data && Array.isArray(res.data.titles)) ? res.data.titles : [];
      if (!titles.length) {
        grid.innerHTML = `<div class="zoro-empty-state"><h3 class="zoro-empty-state-title">Nothing to show</h3><p class="zoro-empty-state-msg">The catalog could not be reached right now. Please try again in a moment.</p></div>`;
        return;
      }
      grid.innerHTML = titles.map((t, i) => `
        <div class="zoro-card" data-slug="${escapeHtml(t.slug)}" data-title="${escapeHtml(t.name)}">
          <a class="zoro-card-poster" href="${detailHref(t.slug)}">
            <img src="${coverOf(t)}" alt="${escapeHtml(t.name)}" loading="${i < 6 ? "eager" : "lazy"}" decoding="async">
            <div class="zoro-play-overlay"><div class="zoro-play-circle">▶</div></div>
            <div class="zoro-poster-badges">
              <div class="badges-left">${subBadge(t)}${dubBadge(t)}</div>
            </div>
          </a>
          <div class="zoro-card-info">
            <a class="zoro-card-title" href="${detailHref(t.slug)}">${escapeHtml(t.name)}</a>
            <div class="zoro-card-submeta"><span>${escapeHtml(t.kind || "Series")}</span> • <span>${escapeHtml(String(t.year || "—"))}</span></div>
          </div>
        </div>`).join("");
      attachTooltipListeners();
      if (paginationWrap) {
        paginationWrap.hidden = true;
        paginationWrap.innerHTML = "";
      }
      markContentReady();
    }

    function renderEmptyState() {
      grid.innerHTML = `
        <div class="zoro-empty-state" id="zoro-empty-state">
          <div class="zoro-empty-state-icon">
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
          </div>
          <h3 class="zoro-empty-state-title">${isSearch() ? `No anime found for '${escapeHtml(state.q)}'` : "No Anime Found"}</h3>
          <p class="zoro-empty-state-msg">We couldn't find any results${isSearch() ? ` for "<span class="accent-query">${escapeHtml(state.q)}</span>"` : ""}. Try another title or genre, or return to the full shelf.</p>
          <a href="browse.html" class="empty-state-browse-link">Back to Browse</a>
        </div>`;
      if (paginationWrap) {
        paginationWrap.hidden = true;
        paginationWrap.innerHTML = "";
      }
      markContentReady();
    }

    /* ---- the main load ---- */
    let loadToken = 0;
    async function load() {
      const token = ++loadToken;
      
      renderGridSkeleton();
      updateHeading(null, null);
      let path;
      if (isSearch()) {
        path = `/api/search?q=${encodeURIComponent(state.q)}&page=${state.page}`;
      } else {
        const qs = new URLSearchParams();
        qs.set("sort", state.sort);
        
        if (view) qs.set("view", view);
        if (kind) qs.set("kind", kind);
        if (state.genre) qs.set("genre", state.genre);
        if (state.format) qs.set("format", state.format);
        if (state.status) qs.set("status", state.status);
        if (state.year) qs.set("year", state.year);
        
        if (state.minScore) qs.set("minScore", state.minScore);
        if (state.maxScore) qs.set("maxScore", state.maxScore);
        if (state.season) qs.set("season", state.season);
        if (state.tags.length) qs.set("tags", state.tags.join(","));
        if (state.startAfter) qs.set("startAfter", state.startAfter);
        if (state.startBefore) qs.set("startBefore", state.startBefore);
        qs.set("page", String(state.page));
        path = `/api/browse?${qs.toString()}`;
      }

      const res = await api(path);
      if (token !== loadToken) return;

      if (!res.ok) {
        
        await renderLibraryFallback();
        updateHeading(null, null);
        return;
      }

      renderLiveNotice(null);
      const data = res.data || {};
      const pageInfo = data.pageInfo || {};

      if (isSearch()) {
        const local = Array.isArray(data.local) ? data.local : [];
        const more = Array.isArray(data.results) ? data.results : [];
        
        const filtered = state.genre
          ? more.filter((t) => (t.genres || []).some((g) => g.toLowerCase() === state.genre.toLowerCase()))
          : more;

        if (!local.length && !filtered.length) {
          renderEmptyState();
          updateHeading(0, pageInfo);
          return;
        }
        
        const total = Number.isFinite(Number(pageInfo.total)) ? Number(pageInfo.total) : filtered.length;
        const availableTotal = total;
        grid.innerHTML =
          (local.length
            ? `<div class="live-result-group"><div class="live-result-group-title">On <span class="accent">AniFlick</span><span class="live-result-group-count">${local.length} curated</span></div><div class="cards-grid-zoro" id="live-local-grid">${local.map((t) => `
              <div class="zoro-card" data-slug="${escapeHtml(t.slug)}" data-title="${escapeHtml(t.name)}">
                <a class="zoro-card-poster" href="${detailHref(t.slug)}">
                  <img src="${coverOf(t)}" alt="${escapeHtml(t.name)}" loading="lazy" decoding="async">
                  <div class="zoro-play-overlay"><div class="zoro-play-circle">▶</div></div>
                  <div class="zoro-poster-badges">
                    <div class="badges-left">${subBadge(t)}${dubBadge(t)}</div>
                  </div>
                </a>
                <div class="zoro-card-info">
                  <a class="zoro-card-title" href="${detailHref(t.slug)}">${escapeHtml(t.name)}</a>
                  <div class="zoro-card-submeta"><span>${escapeHtml(t.kind || "Series")}</span> • <span>${escapeHtml(String(t.year || "—"))}</span></div>
                </div>
              </div>`).join("")}</div></div>`
            : "") +
          (filtered.length
            ? `<div class="live-result-group"><div class="live-result-group-title">More <span class="accent">results</span><span class="live-result-group-count">${filtered.length} of ${availableTotal}</span></div><div class="cards-grid-zoro">${filtered.map((t) => renderLiveCard(t)).join("")}</div></div>`
            : "");
        updateHeading(local.length + filtered.length, pageInfo);
        renderPagination(pageInfo);
        attachTooltipListeners();
        markContentReady();
        return;
      }
      const results = Array.isArray(data.results) ? data.results : [];
      if (!results.length) {
        renderEmptyState();
        updateHeading(0, pageInfo);
        return;
      }
      grid.innerHTML = results.map((t, i) => renderLiveCard(t, {})).join("");
      updateHeading(results.length, pageInfo);
      renderPagination(pageInfo);
      markContentReady();
    }

    /* ---- filters ---- */
    function setSort(value) {
      state.sort = SORT_LABELS[value] ? value : "trending";
      state.page = 1;
      updateUrl();
      load();
    }

    if (chipsWrap) {
      chipsWrap.addEventListener("click", (e) => {
        const chip = e.target.closest(".genre-chip-zoro");
        if (!chip) return;
        chipsWrap.querySelectorAll(".genre-chip-zoro").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        state.genre = chip.dataset.genre || "";
        state.page = 1;
        updateUrl();
        load();
      });
    }

    if (sortSelect) {
      sortSelect.value = state.sort;
      sortSelect.addEventListener("change", () => setSort(sortSelect.value));
    }
    if (formatSelect) {
      formatSelect.value = state.format || "";
      formatSelect.addEventListener("change", () => {
        state.format = formatSelect.value || "";
        state.page = 1;
        updateUrl();
        load();
      });
    }
    if (statusSelect) {
      statusSelect.value = state.status || "";
      statusSelect.addEventListener("change", () => {
        state.status = statusSelect.value || "";
        state.page = 1;
        updateUrl();
        load();
      });
    }
    if (yearSelect) {
      yearSelect.addEventListener("change", () => {
        state.year = yearSelect.value || "";
        state.page = 1;
        syncYearUI();
        updateUrl();
        load();
      });
    }
    
    if (yearDecadesWrap) {
      yearDecadesWrap.addEventListener("click", (e) => {
        const chip = e.target.closest(".browse-year-chip");
        if (!chip) return;
        state.year = chip.dataset.year || "";
        state.page = 1;
        syncYearUI();
        updateUrl();
        load();
      });
    }

    if (paginationWrap) {
      paginationWrap.addEventListener("click", (e) => {
        const btn = e.target.closest(".page-btn");
        if (!btn || btn.disabled) return;
        const p = Number(btn.dataset.page);
        if (!Number.isFinite(p) || p === state.page) return;
        state.page = p;
        updateUrl();
        load();
        const top = grid.getBoundingClientRect().top + window.scrollY - 90;
        window.scrollTo({ top: Math.max(0, top), behavior: "instant" });
      });
    }

    /* ---- Phase 2 filter panel ---- */
    if (filtersToggle) {
      filtersToggle.addEventListener("click", () => {
        setFiltersOpen(filtersBody ? filtersBody.hidden : false);
      });
    }
    if (tagChipsWrap) {
      
      tagChipsWrap.addEventListener("click", (e) => {
        const chip = e.target.closest(".filter-tag-chip");
        if (!chip) return;
        const tag = chip.dataset.tag;
        const idx = state.tags.findIndex((t) => t.toLowerCase() === tag.toLowerCase());
        if (idx >= 0) state.tags.splice(idx, 1);
        else state.tags.push(tag);
        chip.classList.toggle("active", idx < 0);
      });
    }
    if (filtersApply) filtersApply.addEventListener("click", applyFilters);
    if (filtersReset) filtersReset.addEventListener("click", resetFilters);

    window.__onSearchLiveFilter = (q) => {
      state.q = (q || "").trim();
      state.page = 1;
      if (searchInput) searchInput.value = state.q;
      
      if (filterRow) filterRow.hidden = isSearch();
      if (yearSection) yearSection.hidden = isSearch();
      if (filtersPanel) filtersPanel.hidden = isSearch();
      updateUrl();
      load();
    };

    renderChips();
    renderYears();
    renderYearSection();
    syncFilterUI();
    setFiltersOpen(hasPhase2Filters());
    syncYearUI();
    if (filterRow) filterRow.hidden = isSearch();
    if (yearSection) yearSection.hidden = isSearch();
    if (filtersPanel) filtersPanel.hidden = isSearch();
    updateHeading(null, null);
    await load();
  }

  /* __LIVE_DETAIL_LOGIC_START__ */
  const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function liveDateParts(date) {
    if (!date) return null;
    const y = Number(date.year);
    const m = Number(date.month);
    const d = Number(date.day);
    if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return { y, m, d };
  }

  function liveAiredRange(start, end) {
    const s = liveDateParts(start);
    const e = liveDateParts(end);
    if (!s && !e) return "";
    const fmt = (p) => `${MONTH_SHORT[p.m - 1]} ${p.d}`;
    if (s && e) {
      if (s.y === e.y) {
        if (s.m === e.m && s.d === e.d) return `${fmt(s)}, ${s.y}`;
        return `${fmt(s)} – ${fmt(e)}, ${s.y}`;
      }
      return `${fmt(s)}, ${s.y} – ${fmt(e)}, ${e.y}`;
    }
    if (s) return `${fmt(s)}, ${s.y} –`;
    return `– ${fmt(e)}, ${e.y}`;
  }

  function liveSeasonLabel(season) {
    const map = { WINTER: "Winter", SPRING: "Spring", SUMMER: "Summer", FALL: "Fall" };
    return map[String(season || "").toUpperCase()] || null;
  }

  const MORE_SEASONS_TYPES = new Set(["SEQUEL", "PREQUEL"]);
  const RELATED_ANIME_TYPES = new Set(["ADAPTATION", "SIDE_STORY", "SPIN_OFF", "SUMMARY", "CHARACTER", "OTHER"]);

  function liveRelationLabel(type) {
    return String(type || "").toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function liveMoreSeasons(relations) {
    return (Array.isArray(relations) ? relations : [])
      .filter((r) => r && MORE_SEASONS_TYPES.has(String(r.relationType || "").toUpperCase()));
  }

  function liveRelatedAnime(relations) {
    return (Array.isArray(relations) ? relations : [])
      .filter((r) => r && RELATED_ANIME_TYPES.has(String(r.relationType || "").toUpperCase()));
  }

  function liveCharacters(characters) {
    return (Array.isArray(characters) ? characters : []).slice(0, 6);
  }
  /* __LIVE_DETAIL_LOGIC_END__ */

  async function initAzList() {
    const grid = document.getElementById("az-grid");
    if (!grid) return;

    const bar = document.getElementById("az-bar");
    const headingEl = document.getElementById("az-heading");
    const subheadingEl = document.getElementById("az-subheading");
    const paginationWrap = document.getElementById("az-pagination");

    const LETTERS = ["0-9", ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i))];

    const params = new URLSearchParams(window.location.search);
    const state = {
      letter: normalizeAzLetterParam(params.get("letter")),
      page: (() => {
        const p = Number(params.get("page"));
        return Number.isFinite(p) && p > 0 ? Math.floor(p) : 1;
      })(),
    };

    /* ---- letter bar ---- */
    function renderBar() {
      if (!bar) return;
      const chips = [`<button class="az-chip${state.letter === "all" ? " active" : ""}" type="button" data-letter="all">All</button>`];
      for (const letter of LETTERS) {
        chips.push(`<button class="az-chip${state.letter === letter ? " active" : ""}" type="button" data-letter="${letter}">${letter}</button>`);
      }
      bar.innerHTML = chips.join("");
    }

    function normalizeAzLetterParam(value) {
      const raw = String(value == null ? "all" : value).trim().toLowerCase();
      if (!raw || raw === "all") return "all";
      if (raw === "0-9" || raw === "09" || raw === "digit" || raw === "digits") return "0-9";
      if (/^[a-z]$/.test(raw)) return raw.toUpperCase();
      return null;
    }

    function updateUrl() {
      const p = new URLSearchParams();
      if (state.letter !== "all") p.set("letter", state.letter);
      if (state.page > 1) p.set("page", String(state.page));
      const qs = p.toString();
      window.history.replaceState({}, "", `az-list.html${qs ? `?${qs}` : ""}`);
    }

    function renderSkeleton() {
      grid.innerHTML = Array.from({ length: LIVE_PAGE_SIZE }, () => `
        <div class="zoro-card zoro-card-skeleton" aria-hidden="true">
          <div class="zoro-card-poster skeleton-shimmer"></div>
          <div class="zoro-card-info">
            <div class="skeleton-line skeleton-shimmer skeleton-w-85"></div>
            <div class="skeleton-line skeleton-shimmer skeleton-w-55"></div>
          </div>
        </div>`).join("");
    }

    function updateHeading(pageInfo) {
      if (!headingEl) return;
      const total = pageInfo && Number.isFinite(Number(pageInfo.total)) ? Number(pageInfo.total) : null;
      const capped = !!(pageInfo && pageInfo.capped);
      const countPart = total == null ? "" : ` <span class="accent">(${total.toLocaleString()}${capped ? "+" : ""} ${total === 1 && !capped ? "title" : "titles"})</span>`;
      const label = state.letter === "all" ? "A-Z <span class=\"accent\">Anime List</span>"
        : `${escapeHtml(state.letter)} <span class=\"accent\">Anime</span>`;
      headingEl.innerHTML = `<span>${label}${countPart}</span>`;
      if (subheadingEl) {
        subheadingEl.textContent = state.letter === "all"
          ? "The whole live catalog, sorted by title."
          : `Titles whose name starts with “${state.letter}”.`;
      }
    }

    function renderPagination(pageInfo) {
      if (!paginationWrap) return;
      if (!pageInfo) {
        paginationWrap.hidden = true;
        paginationWrap.innerHTML = "";
        return;
      }
      const current = (pageInfo && Number(pageInfo.currentPage)) || state.page;
      const last = (pageInfo && Number(pageInfo.lastPage)) || 1;
      if (last <= 1 && !(pageInfo && pageInfo.hasNextPage)) {
        paginationWrap.hidden = true;
        paginationWrap.innerHTML = "";
        return;
      }
      const pages = [];
      pages.push(1);
      const from = Math.max(2, current - 2);
      const to = Math.min(last - 1, current + 2);
      if (from > 2) pages.push("…");
      for (let p = from; p <= to; p++) pages.push(p);
      if (to < last - 1) pages.push("…");
      if (last > 1) pages.push(last);

      let html = `<button class="page-btn" type="button" data-page="${current - 1}"${current === 1 ? " disabled" : ""} aria-label="Previous page">‹ Prev</button>`;
      for (const p of pages) {
        if (p === "…") {
          html += `<span class="page-btn page-btn-static">…</span>`;
        } else {
          html += `<button class="page-btn${p === current ? " active" : ""}" type="button" data-page="${p}"${p === current ? ' aria-current="page"' : ""}>${p}</button>`;
        }
      }
      html += `<button class="page-btn" type="button" data-page="${current + 1}"${current >= last ? " disabled" : ""} aria-label="Next page">Next ›</button>`;
      if (last > 1) {
        html += `<span class="page-btn page-btn-static" aria-live="polite">Page ${current} of ${last}</span>`;
      }
      paginationWrap.innerHTML = html;
      paginationWrap.hidden = false;
    }

    function renderEmpty() {
      grid.innerHTML = `
        <div class="zoro-empty-state">
          <div class="zoro-empty-state-icon">
            <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="11" cy="11" r="8"></circle>
              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
            </svg>
          </div>
          <h3 class="zoro-empty-state-title">No Anime Found</h3>
          <p class="zoro-empty-state-msg">We couldn't find any titles for “${escapeHtml(state.letter)}”. Try another letter.</p>
          <a href="az-list.html" class="empty-state-browse-link">Back to A-Z List</a>
        </div>`;
      if (paginationWrap) {
        paginationWrap.hidden = true;
        paginationWrap.innerHTML = "";
      }
    }

    async function renderLibraryFallback() {
      renderLiveNotice(LIVE_LIBRARY_MESSAGE, "library");
      const res = await api("/api/titles?limit=18");
      const titles = (res.ok && res.data && Array.isArray(res.data.titles)) ? res.data.titles : [];
      if (!titles.length) {
        grid.innerHTML = `<div class="zoro-empty-state"><h3 class="zoro-empty-state-title">Nothing to show</h3><p class="zoro-empty-state-msg">The catalog could not be reached right now. Please try again in a moment.</p></div>`;
        return;
      }
      grid.innerHTML = titles.map((t) => `
        <div class="zoro-card" data-slug="${escapeHtml(t.slug)}" data-title="${escapeHtml(t.name)}">
          <a class="zoro-card-poster" href="${detailHref(t.slug)}">
            <img src="${coverOf(t)}" alt="${escapeHtml(t.name)}" loading="lazy" decoding="async">
            <div class="zoro-play-overlay"><div class="zoro-play-circle">▶</div></div>
            <div class="zoro-poster-badges">
              <div class="badges-left">${subBadge(t)}${dubBadge(t)}</div>
            </div>
          </a>
          <div class="zoro-card-info">
            <a class="zoro-card-title" href="${detailHref(t.slug)}">${escapeHtml(t.name)}</a>
            <div class="zoro-card-submeta"><span>${escapeHtml(t.kind || "Series")}</span> • <span>${escapeHtml(String(t.year || "—"))}</span></div>
          </div>
        </div>`).join("");
      if (paginationWrap) {
        paginationWrap.hidden = true;
        paginationWrap.innerHTML = "";
      }
      markContentReady();
    }

    let loadToken = 0;
    async function load() {
      const token = ++loadToken;
      renderSkeleton();
      updateHeading(null);
      
      if (paginationWrap) {
        paginationWrap.hidden = true;
        paginationWrap.innerHTML = "";
      }
      
      const path = state.letter === "all"
        ? `/api/browse?sort=az&page=${state.page}`
        : `/api/az?letter=${encodeURIComponent(state.letter)}&page=${state.page}`;
      const res = await api(path);
      if (token !== loadToken) return;

      if (!res.ok) {
        await renderLibraryFallback();
        updateHeading(null);
        return;
      }

      renderLiveNotice(null);
      const data = res.data || {};
      const pageInfo = data.pageInfo || {};
      const results = Array.isArray(data.results) ? data.results : [];

      if (!results.length) {
        renderEmpty();
        updateHeading(pageInfo);
        return;
      }

      grid.innerHTML = results.map((t) => renderLiveCard(t)).join("");
      updateHeading(pageInfo);
      renderPagination(pageInfo);
      markContentReady();
    }

    if (bar) {
      bar.addEventListener("click", (e) => {
        const chip = e.target.closest(".az-chip");
        if (!chip) return;
        const letter = normalizeAzLetterParam(chip.dataset.letter);
        if (!letter || letter === state.letter) return;
        state.letter = letter;
        state.page = 1;
        renderBar();
        updateUrl();
        load();
      });
    }

    if (paginationWrap) {
      paginationWrap.addEventListener("click", (e) => {
        const btn = e.target.closest(".page-btn");
        if (!btn || btn.disabled) return;
        const p = Number(btn.dataset.page);
        if (!Number.isFinite(p) || p === state.page) return;
        state.page = p;
        updateUrl();
        load();
        const top = grid.getBoundingClientRect().top + window.scrollY - 90;
        window.scrollTo({ top: Math.max(0, top), behavior: "instant" });
      });
    }

    renderBar();
    updateHeading(null);
    await load();
  }

  async function initLiveRails() {
    const rails = [
      { id: "live-top-airing-grid", path: "/api/browse?sort=popular&status=RELEASING&page=1", mode: "browse" },
      { id: "live-top-upcoming-grid", path: "/api/browse?sort=popular&status=NOT_YET_RELEASED&page=1", mode: "browse" },
      { id: "live-trending-grid", path: "/api/browse?sort=trending&page=1", mode: "browse" },
      { id: "live-top-rated-grid", path: "/api/browse?sort=top&page=1", mode: "browse" },
      
      { id: "live-new-on-grid", path: "/api/browse?sort=newest&page=1", mode: "browse" },
      { id: "live-latest-episodes-grid", path: "/api/airing?page=1", mode: "airing" },
    ];

    for (const rail of rails) {
      const el = document.getElementById(rail.id);
      if (!el) continue;
      const section = el.closest("section");

      el.innerHTML = Array.from({ length: 12 }, () => `
        <div class="zoro-card zoro-card-skeleton" aria-hidden="true">
          <div class="zoro-card-poster skeleton-shimmer"></div>
          <div class="zoro-card-info">
            <div class="skeleton-line skeleton-shimmer skeleton-w-85"></div>
            <div class="skeleton-line skeleton-shimmer skeleton-w-55"></div>
          </div>
        </div>`).join("");

      const res = await api(rail.path);
      if (!res.ok || !res.data || !Array.isArray(res.data.results)) {
        if (section) section.hidden = true;
        el.innerHTML = "";
        continue;
      }
      const results = res.data.results;
      if (!results.length) {
        if (section) section.hidden = true;
        el.innerHTML = "";
        continue;
      }

      if (rail.mode === "airing") {
        
        el.innerHTML = results.map((row) => {
          const media = row.media || {};
          const aired = timeSinceLabel(row.airingAt);
          return renderLiveCard(media, {
            href: liveWatchHref(media, row.episode),
            
            submeta: `Ep ${row.episode}${aired ? ` · ${aired}` : ""}`,
          });
        }).join("");
      } else {
        el.innerHTML = results.map((t) => renderLiveCard(t)).join("");
      }
    }
  }

  function attachTooltipListeners() {
    const tip = createHoverTooltip();
    const cards = document.querySelectorAll(".zoro-card");

    cards.forEach((card) => {
      
      if (!card.dataset.slug) return;
      card.addEventListener("mouseenter", async (e) => {
        const slug = card.dataset.slug;
        activeHoverSlug = slug;

        const res = await api(`/api/titles/${encodeURIComponent(slug)}`);
        
        if (activeHoverSlug !== slug || !card.matches(":hover")) return;
        if (!res.ok || !res.data) return;

        const t = res.data.title;
        const rating = scoreLabel(t);
        tip.innerHTML = `
          <div class="tooltip-title">${escapeHtml(t.name)}</div>
          <div class="tooltip-rating">${rating ? `★ ${rating} <span class="tooltip-rating-meta">(AniList)</span>` : `<span class="tooltip-rating-meta">Not yet rated</span>`}</div>
          <div class="tooltip-synopsis">${escapeHtml(t.synopsis || t.tagline)}</div>
          <div class="tooltip-meta-rows">
            <span><strong>Type:</strong> ${t.kind}</span>
            <span><strong>Studio:</strong> ${escapeHtml(t.studio)}</span>
            <span><strong>Genres:</strong> ${t.genres ? t.genres.map(genreLabel).join(", ") : "Action"}</span>
          </div>
          <a class="btn-zoro-primary btn-tooltip-watch" href="${watchHref(t.slug, 1)}">▶ Watch Now</a>
        `;

        const rect = card.getBoundingClientRect();
        let left = rect.right + 12;
        if (left + 330 > window.innerWidth) {
          left = rect.left - 332;
        }
        if (left < 10) left = 10;

        const minTop = window.scrollY + 76;
        let top = Math.max(rect.top + window.scrollY, minTop);

        tip.style.left = `${left}px`;
        tip.style.top = `${top}px`;
        tip.style.display = "block";
        tip.classList.add("is-visible");
      });

      card.addEventListener("mouseleave", () => {
        hideHoverTooltip();
      });
    });
  }

  const GENRE_META = {
    action: { icon: "⚔️", kanji: "戦闘", label: "Action", desc: "High-octane sword fights, jujutsu martial arts, ninja battles, and intense physical confrontations." },
    adventure: { icon: "🗺️", kanji: "冒険", label: "Adventure", desc: "Grand voyages, uncharted lands, pirate crews, and journeys beyond the horizon." },
    fantasy: { icon: "✨", kanji: "幻想", label: "Fantasy", desc: "Elven journeys, mystical spells, ancient dungeons, and mythical realms beyond ordinary human time." },
    supernatural: { icon: "👁️", kanji: "怪異", label: "Supernatural", desc: "Spirits, cursed energy, exorcisms, and dark folklore hidden behind the veneer of modern Tokyo." },
    romance: { icon: "🌸", kanji: "恋愛", label: "Romance", desc: "Heartwarming confessions, rooftop encounters, unspoken feelings, and winter train stations." },
    drama: { icon: "🎭", kanji: "演劇", label: "Drama", desc: "Emotional human journeys, moral dilemmas, personal sacrifices, and complex character growth." },
    sports: { icon: "⚽", kanji: "競技", label: "Sports", desc: "High-stakes tournaments, ego-fueled rivalries, and the relentless pursuit of perfection." },
    comedy: { icon: "🤣", kanji: "喜劇", label: "Comedy", desc: "Secret agents playing house, chaotic mind games, hilarious misunderstandings, and witty banter." },
    mecha: { icon: "🤖", kanji: "機甲", label: "Mecha", desc: "Bio-mechanical armor, orbital warfare, cybernetic cockpits, and machines forged to survive the stars." },
    horror: { icon: "🩸", kanji: "恐怖", label: "Horror", desc: "Abandoned subway lines, psychological time slips, body horror, and midnight supernatural dread." },
    music: { icon: "🎸", kanji: "音楽", label: "Music", desc: "Basement guitar riffs, bedroom beatmakers, midnight diner jams, and soul-stirring concert climaxes." },
    mystery: { icon: "🔍", kanji: "謎解", label: "Mystery", desc: "Time loop paradoxes, cold case crimes, cryptic disappearance notices, and cerebral deductions." },
    life: { icon: "🍜", kanji: "日常", label: "Slice of Life", desc: "Cozy noodle bars after hours, quiet afternoon walks, nostalgic memories, and everyday companionship." },
  };

  const GENRE_LABELS = {
    action: "Action", adventure: "Adventure", comedy: "Comedy", drama: "Drama",
    ecchi: "Ecchi", fantasy: "Fantasy", horror: "Horror", "mahou shoujo": "Mahou Shoujo",
    mecha: "Mecha", music: "Music", mystery: "Mystery", psychological: "Psychological",
    romance: "Romance", "sci-fi": "Sci-Fi", "slice of life": "Slice of Life",
    sports: "Sports", supernatural: "Supernatural", thriller: "Thriller",
  };

  function genreLabel(g) {
    const k = String(g || "").toLowerCase();
    return (GENRE_META[k] && GENRE_META[k].label) || GENRE_LABELS[k] || k.charAt(0).toUpperCase() + k.slice(1);
  }

  async function initGenresPage() {
    const grid = document.querySelector(".genres-shelf-grid");
    if (!grid) return;

    const res = await api("/api/genres");
    if (!res.ok || !res.data) return;
    const counts = res.data.counts || {};
    
    const all = Array.isArray(res.data.allGenres) && res.data.allGenres.length
      ? res.data.allGenres
      : Object.keys(counts);
    
    const countKeyFor = (name) => {
      const k = String(name).toLowerCase();
      if (counts[k] != null) return k;
      const alias = Object.keys(GENRE_ALIASES).find((a) => GENRE_ALIASES[a].toLowerCase() === k);
      return alias && counts[alias] != null ? alias : null;
    };

    const keys = all.slice().sort((a, b) => {
      const ca = counts[countKeyFor(a)] || 0;
      const cb = counts[countKeyFor(b)] || 0;
      return cb - ca || a.localeCompare(b);
    });

    grid.innerHTML = keys
      .map((key) => {
        const meta = GENRE_META[key.toLowerCase()] || {
          icon: "🎬",
          kanji: "棚",
          label: genreLabel(key),
          desc: "Explore this curated shelf of titles.",
        };
        const countKey = countKeyFor(key);
        const cnt = countKey ? counts[countKey] : null;
        const countHtml = cnt != null
          ? `<span class="genre-card-count">${cnt} ${cnt === 1 ? "Title" : "Titles"}</span>`
          : `<span class="genre-card-count genre-card-count-none">—</span>`;
        return `
          <a class="genre-shelf-card" href="browse.html?genre=${encodeURIComponent(key)}" data-genre="${escapeHtml(key)}">
            <div class="genre-card-watermark">${meta.kanji}</div>
            <div class="genre-card-top">
              <div class="genre-card-icon-pill">${meta.icon}</div>
              ${countHtml}
            </div>
            <div>
              <div class="genre-card-title">
                ${meta.label} <span class="genre-card-kanji-sub">/ ${meta.kanji}</span>
              </div>
              <p class="genre-card-desc">${meta.desc}</p>
            </div>
            <div class="genre-card-footer">
              <span>Explore ${meta.label} Shelf</span>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </div>
          </a>
        `;
      })
      .join("");

    const heroAccent = document.querySelector(".genres-hero-header h1 .accent");
    if (heroAccent) heroAccent.textContent = `${keys.length} Genre Shelves`;
    markContentReady();
  }

  let activeEpisode = 1;
  let reloadComments = null;

  async function initWatchPage() {
    const watchStage = document.getElementById("zoro-video-stage");
    if (!watchStage) return;

    const params = new URLSearchParams(window.location.search);
    
    const currentSlug = (params.get("slug") || params.get("id") || "").trim();
    let currentEp = parseInt(params.get("ep"), 10) || 1;

    const liveParam = params.get("live");
    const liveId = liveParam ? parseInt(liveParam, 10) : null;
    const isLive = !!liveId && Number.isFinite(liveId) && liveId > 0;
    const progressKey = isLive ? `live-${liveId}` : currentSlug;
    
    let liveAiredCount = 0;
    let liveEpisodesUnknown = false;
    
    let currentTrack = "sub";
    let preferredTrack = "sub";
    
    let loadInFlight = false;

    /* __PLAYER_IFRAME_SANDBOX_START__ */
    
    const PLAYER_IFRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-presentation";
    
    const PLAYER_IFRAME_SANDBOX_BY_SERVER = {
      zoko: null,
      backup: PLAYER_IFRAME_SANDBOX,
      megaplay: PLAYER_IFRAME_SANDBOX,
      animegg: PLAYER_IFRAME_SANDBOX,
    };
    /* __PLAYER_IFRAME_SANDBOX_END__ */
    let iframe = document.getElementById("zoko-embed-frame");
    
    function applyIframeSandbox(server) {
      if (!iframe) return;
      const value = Object.prototype.hasOwnProperty.call(PLAYER_IFRAME_SANDBOX_BY_SERVER, server)
        ? PLAYER_IFRAME_SANDBOX_BY_SERVER[server]
        : null;
      if (value === null) iframe.removeAttribute("sandbox");
      else iframe.setAttribute("sandbox", value);
    }
    const coverOverlay = document.getElementById("video-cover-overlay");
    const spinner = document.getElementById("zoko-player-spinner");
    const overlay = document.getElementById("zoko-player-overlay");
    const overlayTitle = document.getElementById("zoko-overlay-title");
    const overlayText = document.getElementById("zoko-overlay-text");
    const resumeNote = document.getElementById("zoko-resume-note");
    const playerWrap = document.getElementById("player-wrap");
    const playPauseBtn = document.getElementById("btn-player-playpause");
    const progressFill = document.getElementById("video-progress-fill");
    const timeText = document.getElementById("video-time-text");

    const wlBtn = document.getElementById("watch-add-list-btn");
    const epGrid = document.getElementById("zoro-episodes-grid");
    const epSubtitle = document.getElementById("watch-ep-subtitle");
    const animeTitle = document.getElementById("watch-anime-title");
    const animeTitleH1 = document.getElementById("watch-anime-title-h1");
    const animeDesc = document.getElementById("watch-anime-desc");
    const dataError = document.getElementById("watch-data-error");
    const dataErrorText = document.getElementById("watch-data-error-text");
    const dataErrorRetry = document.getElementById("watch-data-error-retry");
    const rangeTabs = document.querySelector(".ep-range-tabs");

    let titleData = null;
    let episodesList = [];
    let currentPosition = 0;
    let duration = 1440;
    
    let durationIsReal = false;
    
    let playerEp = null;
    let playerReady = false;
    let isPaused = true;
    let lastProgressSync = 0;
    let lastLocalSave = 0;
    
    let resumeNoteTimer = null;
    let resumeNoteArmOnPlay = false;
    let resumeNoteShownForLoad = false;
    let resumeTimeForLoad = 0;
    let loadStartedAt = 0;
    let skippedThisLoad = false;
    let seekCommandThisLoad = false;

    // LocalStorage keys
    const LS_SETTINGS_KEY = "av_zoko_settings";
    const LS_IDS_KEY = "av_zoko_ids";

    // Player settings (persisted)
    let playerSettings = {
      autoplay: true,
      autoskip: true,
      autonext: true,
    };
    try {
      const saved = localStorage.getItem(LS_SETTINGS_KEY);
      if (saved) playerSettings = Object.assign(playerSettings, JSON.parse(saved));
    } catch {}

    // Custom MAL ID per anime (persisted)
    function getCustomMalId(slug) {
      try {
        const map = JSON.parse(localStorage.getItem(LS_IDS_KEY) || "{}");
        return map[slug] || null;
      } catch {
        return null;
      }
    }
    function setCustomMalId(slug, id) {
      try {
        const map = JSON.parse(localStorage.getItem(LS_IDS_KEY) || "{}");
        map[slug] = id;
        localStorage.setItem(LS_IDS_KEY, JSON.stringify(map));
      } catch {}
    }

    const LS_PROGRESS_KEY = "av_zoko_progress";

    const LS_TRACK_KEY = "av_zoko_track";
    function readPreferredTrack() {
      try {
        const v = localStorage.getItem(LS_TRACK_KEY);
        return v === "dub" || v === "hsub" ? v : "sub";
      } catch {
        return "sub";
      }
    }
    function writePreferredTrack(track) {
      try {
        localStorage.setItem(LS_TRACK_KEY, track);
      } catch {}
    }
    
    preferredTrack = readPreferredTrack();

    const SS_SERVER_KEY = "av_player_server";
    const BACKUP_ORIGIN = "https://embed.animetvplus.site";
    const MEGAPLAY_ORIGIN = "https://megaplay.buzz";
    
    const ANIMEGG_SERVER_ID = "animegg";
    let activeServer = "zoko";
    try {
      const storedServer = sessionStorage.getItem(SS_SERVER_KEY);
      if (storedServer === "backup" || storedServer === ANIMEGG_SERVER_ID) {
        activeServer = storedServer;
      }
    } catch {}
    const playerHook = params.get("player");
    if (playerHook === "backup" || playerHook === ANIMEGG_SERVER_ID) {
      activeServer = playerHook;
      try { sessionStorage.setItem(SS_SERVER_KEY, playerHook); } catch {}
    }
    
    applyIframeSandbox(activeServer);
    
    let megaPlayTrack = null;
    let megaPlayFrameLoaded = false;

    let animeggState = "unknown";
    let animeggLoadToken = 0;
    let animeggFailTimer = null;
    const ANIMEGG_NO_PLAY_TIMEOUT_MS = 20000;

    const ANIMEGG_ENABLED = false;

    function animeggAniListId() {
      if (isLive) return liveId || null;
      return (titleData && titleData.anilistId) || null;
    }

    async function resolveAnimeggStreamUrl(epNum) {
      const id = animeggAniListId();
      if (!id) {
        animeggState = "unavailable";
        return null;
      }
      animeggState = "unknown";
      const url = await probeAnimegg(epNum);
      return url || null;
    }

    async function probeAnimegg(epNum) {
      const id = animeggAniListId();
      if (!ANIMEGG_ENABLED) {
        animeggState = "unavailable";
        return null;
      }
      if (!id) {
        animeggState = "unavailable";
        return null;
      }
      try {
        
        const res = await api(`/api/animegg/${encodeURIComponent(id)}/${encodeURIComponent(epNum)}`, { timeoutMs: 45000 });
        const d = res && res.data;
        const ok = !!(d && d.available && (d.embedUrl || d.url));
        animeggState = ok ? "available" : "unavailable";
        
        return ok ? (d.embedUrl || d.url) : null;
      } catch {
        animeggState = "unavailable";
        return null;
      }
    }

    const BACKUP_ID_EXCEPTIONS = {
      
      "encore-one-more": { route: "anilist", id: 125367 },
      
      "paper-cranes-at-dawn": { route: "mal", id: 28851 },
      
      "the-quiet-ward": { route: "mal", id: 31043 },
      
    };

    const TITLE_CONTINUATIONS = {
      "corner-store-hours": { live: 142838, name: "SPY x FAMILY Cour 2", short: "Cour 2" },
    };
    function titleContinuation() {
      if (isLive) return null;
      return (currentSlug && TITLE_CONTINUATIONS[currentSlug]) || null;
    }

    function getBackupEmbedUrl(epNum, startTime, restart) {
      
      const ex = isLive ? null : BACKUP_ID_EXCEPTIONS[currentSlug];
      let route, id;
      if (ex) {
        route = ex.route;
        id = ex.id;
      } else {
        
        if (titleData && titleData.malId) {
          route = "mal";
          id = titleData.malId;
        } else if (titleData && titleData.anilistId) {
          route = "anilist";
          id = titleData.anilistId;
        } else {
          return null;
        }
      }
      
      let url = `${BACKUP_ORIGIN}/home/embed/${route}/${id}/${epNum}?accent=cae962`;
      
      let t = Math.floor(startTime || 0);
      if (restart) t = 1;
      if (t >= 1 && t <= 86400) url += `&t=${t}`;
      return url;
    }

    function getMegaPlayEmbedUrl(epNum, track) {
      const lang = track === "dub" ? "dub" : "sub";
      if (titleData && titleData.malId) {
        return `${MEGAPLAY_ORIGIN}/stream/mal/${titleData.malId}/${epNum}/${lang}`;
      }
      
      if (titleData && titleData.anilistId) {
        return `${MEGAPLAY_ORIGIN}/stream/ani/${titleData.anilistId}/${epNum}/${lang}`;
      }
      return null;
    }

    const ZOKO_NO_READY_TIMEOUT_MS = 45000;
    
    const ZOKO_NO_PLAY_AFTER_READY_MS = 30000;
    
    const ZOKO_NO_PLAYBACK_DEADLINE_MS = 45000;
    const ZOKO_PROBE_ABORT_MS = 20000;
    const BACKUP_NO_READY_TIMEOUT_MS = 45000;
    
    const MEGAPLAY_NO_PLAY_TIMEOUT_MS = 12000;
    let loadToken = 0;
    let zokoFailTimer = null;
    let zokoNoPlayTimer = null; // backstop: ready fired but playback never started
    let zokoNoPlaybackTimer = null; // load-start deadline: no playback evidence at all
    let playbackEvidenceForLoad = false; // play / first time event with cur > 0
    let backupFailTimer = null;
    let megaplayFailTimer = null;
    let fallbackOfferVisible = false;

    const SWITCH_SETTLE_TIMEOUT_MS = 20000;
    let settleWatchdog = null;   // watchdog timer for the current switch
    let settleAttempt = 0;       // 0 = first load, 1 = after one rebuild
    let playerSettled = false;   // became true on ready/play/time/error/offer
    let probeController = null;  
    let switchBusy = false;      // one accepted switch at a time
    let pendingSwitchWatchdog = false; // consumed by the switch's load

    function clearPlayerTimersAndProbes() {
      if (zokoFailTimer) { clearTimeout(zokoFailTimer); zokoFailTimer = null; }
      if (zokoNoPlayTimer) { clearTimeout(zokoNoPlayTimer); zokoNoPlayTimer = null; }
      if (zokoNoPlaybackTimer) { clearTimeout(zokoNoPlaybackTimer); zokoNoPlaybackTimer = null; }
      if (backupFailTimer) { clearTimeout(backupFailTimer); backupFailTimer = null; }
      if (megaplayFailTimer) { clearTimeout(megaplayFailTimer); megaplayFailTimer = null; }
      if (animeggFailTimer) { clearTimeout(animeggFailTimer); animeggFailTimer = null; }
      if (settleWatchdog) { clearTimeout(settleWatchdog); settleWatchdog = null; }
      if (probeController) {
        try { probeController.abort(); } catch {}
        probeController = null;
      }
    }

    function markPlayerSettled() {
      playerSettled = true;
      switchBusy = false;
      if (settleWatchdog) { clearTimeout(settleWatchdog); settleWatchdog = null; }
    }

    function rebuildIframe() {
      if (!iframe || !iframe.parentNode) return;
      const fresh = document.createElement("iframe");
      fresh.id = iframe.id;
      fresh.className = iframe.className;
      fresh.title = iframe.title;
      fresh.setAttribute("allow", iframe.getAttribute("allow") || "fullscreen; autoplay");
      fresh.setAttribute("allowfullscreen", "");
      
      const sandboxForFresh = Object.prototype.hasOwnProperty.call(PLAYER_IFRAME_SANDBOX_BY_SERVER, activeServer)
        ? PLAYER_IFRAME_SANDBOX_BY_SERVER[activeServer]
        : null;
      if (sandboxForFresh !== null) fresh.setAttribute("sandbox", sandboxForFresh);
      fresh.src = "about:blank";
      iframe.parentNode.replaceChild(fresh, iframe);
      iframe = fresh;
      bindIframeListeners();
    }

    function armSettleWatchdog(token, server, attempt) {
      if (settleWatchdog) { clearTimeout(settleWatchdog); settleWatchdog = null; }
      playerSettled = false;
      settleWatchdog = setTimeout(() => {
        settleWatchdog = null;
        if (token !== loadToken || playerSettled) return;
        if (attempt === 0) {
          
          settleAttempt = 1;
          switchBusy = false;
          rebuildIframe();
          loadEpisode(currentEp, null, false, Math.floor(currentPosition || 0));
          armSettleWatchdog(loadToken, server, 1);
          return;
        }
        
        settleAttempt = 0;
        switchBusy = false;
        if (spinner) spinner.hidden = true;
        if (coverOverlay) coverOverlay.style.display = "none";
        if (server === "backup") showBackupNote("TVplus player isn't responding.");
        else if (server === "megaplay") showMegaPlayFailureOffer("MegaPlay isn't responding.");
        else if (server === ANIMEGG_SERVER_ID) showAnimeggFailureOffer("The animegg player isn't responding.");
        else showFallbackOffer();
      }, SWITCH_SETTLE_TIMEOUT_MS);
    }

    let lastZokoErrorAt = 0;
    const ZOKO_RECOVERY_GUARD_MS = 2000;
    
    let lastMegaPlayErrorAt = 0;
    const MEGAPLAY_RECOVERY_GUARD_MS = 2000;
    const fallbackNote = document.getElementById("zoko-fallback-note");
    const serverSwitcher = document.getElementById("zoko-server-switcher");

    function hideFallbackNote() {
      fallbackOfferVisible = false;
      if (fallbackNote) {
        fallbackNote.hidden = true;
        fallbackNote.innerHTML = "";
      }
    }

    function showFallbackOffer() {
      if (!fallbackNote || activeServer !== "zoko") return;
      fallbackOfferVisible = true;
      fallbackNote.innerHTML = `
        <span class="zoko-fallback-text">Main player isn't responding — Try TVplus player</span>
        <button class="btn-zoro-primary" id="fallback-try-btn" type="button">Try TVplus player</button>
        <button class="fallback-dismiss" id="fallback-dismiss-btn" type="button" aria-label="Dismiss notice">✕</button>`;
      fallbackNote.hidden = false;
      const tryBtn = fallbackNote.querySelector("#fallback-try-btn");
      if (tryBtn) tryBtn.addEventListener("click", () => switchServer("backup"));
      const dismissBtn = fallbackNote.querySelector("#fallback-dismiss-btn");
      if (dismissBtn) dismissBtn.addEventListener("click", hideFallbackNote);
    }

    function showBackupNote(message) {
      if (!fallbackNote) return;
      fallbackOfferVisible = false;
      fallbackNote.innerHTML = `
        <span class="zoko-fallback-text">${escapeHtml(message)}</span>
        <button class="btn-zoro-primary" id="fallback-back-btn" type="button">Back to Zoko</button>
        <button class="fallback-dismiss" id="fallback-dismiss-btn" type="button" aria-label="Dismiss notice">✕</button>`;
      fallbackNote.hidden = false;
      const backBtn = fallbackNote.querySelector("#fallback-back-btn");
      if (backBtn) backBtn.addEventListener("click", () => switchServer("zoko"));
      const dismissBtn = fallbackNote.querySelector("#fallback-dismiss-btn");
      if (dismissBtn) dismissBtn.addEventListener("click", hideFallbackNote);
    }

    function showMegaPlayFailureOffer(message) {
      if (!fallbackNote || activeServer !== "megaplay") return;
      fallbackOfferVisible = true;
      fallbackNote.innerHTML = `
        <span class="zoko-fallback-text">${escapeHtml(message)}</span>
        <button class="btn-zoro-primary" id="fallback-try-btn" type="button">Try Zoko player</button>
        <button class="fallback-dismiss" id="fallback-dismiss-btn" type="button" aria-label="Dismiss notice">✕</button>`;
      fallbackNote.hidden = false;
      const tryBtn = fallbackNote.querySelector("#fallback-try-btn");
      if (tryBtn) tryBtn.addEventListener("click", () => switchServer("zoko"));
      const dismissBtn = fallbackNote.querySelector("#fallback-dismiss-btn");
      if (dismissBtn) dismissBtn.addEventListener("click", hideFallbackNote);
    }

    function showAnimeggFailureOffer(message) {
      if (!fallbackNote || activeServer !== ANIMEGG_SERVER_ID) return;
      fallbackOfferVisible = true;
      fallbackNote.innerHTML = `
        <span class="zoko-fallback-text">${escapeHtml(message)}</span>
        <button class="btn-zoro-primary" id="fallback-try-btn" type="button">Try Zoko player</button>
        <button class="fallback-dismiss" id="fallback-dismiss-btn" type="button" aria-label="Dismiss notice">✕</button>`;
      fallbackNote.hidden = false;
      const tryBtn = fallbackNote.querySelector("#fallback-try-btn");
      if (tryBtn) tryBtn.addEventListener("click", () => switchServer("zoko"));
      const dismissBtn = fallbackNote.querySelector("#fallback-dismiss-btn");
      if (dismissBtn) dismissBtn.addEventListener("click", hideFallbackNote);
    }

    function showAnimeggUnavailableNote(message) {
      if (!fallbackNote || activeServer !== ANIMEGG_SERVER_ID) return;
      fallbackOfferVisible = false;
      fallbackNote.innerHTML = `
        <span class="zoko-fallback-text">${escapeHtml(message)}</span>
        <button class="btn-zoro-primary" id="fallback-back-btn" type="button">Back to Zoko</button>
        <button class="fallback-dismiss" id="fallback-dismiss-btn" type="button" aria-label="Dismiss notice">✕</button>`;
      fallbackNote.hidden = false;
      const backBtn = fallbackNote.querySelector("#fallback-back-btn");
      if (backBtn) backBtn.addEventListener("click", () => switchServer("zoko"));
      const dismissBtn = fallbackNote.querySelector("#fallback-dismiss-btn");
      if (dismissBtn) dismissBtn.addEventListener("click", hideFallbackNote);
    }

    function armZokoFailureDetection(streamUrl, token) {
      if (zokoFailTimer) clearTimeout(zokoFailTimer);
      zokoFailTimer = setTimeout(() => {
        zokoFailTimer = null;
        if (token !== loadToken || activeServer !== "zoko" || playerReady) return;
        
        markPlayerSettled();
        if (spinner) spinner.hidden = true;
        if (coverOverlay) coverOverlay.style.display = "none";
        showFallbackOffer();
      }, ZOKO_NO_READY_TIMEOUT_MS);
      
      if (zokoNoPlaybackTimer) clearTimeout(zokoNoPlaybackTimer);
      zokoNoPlaybackTimer = setTimeout(() => {
        zokoNoPlaybackTimer = null;
        if (token !== loadToken || activeServer !== "zoko" || playbackEvidenceForLoad) return;
        markPlayerSettled();
        if (zokoNoPlayTimer) { clearTimeout(zokoNoPlayTimer); zokoNoPlayTimer = null; }
        if (spinner) spinner.hidden = true;
        if (coverOverlay) coverOverlay.style.display = "none";
        showFallbackOffer();
      }, ZOKO_NO_PLAYBACK_DEADLINE_MS);
      
      if (probeController) {
        try { probeController.abort(); } catch {}
      }
      const ctl = new AbortController();
      probeController = ctl;
      const abortTimer = setTimeout(() => ctl.abort(), ZOKO_PROBE_ABORT_MS);
      fetch(streamUrl, { mode: "no-cors", credentials: "omit", cache: "no-store", signal: ctl.signal })
        .then(() => {
          clearTimeout(abortTimer);
          if (probeController === ctl) probeController = null;
        })
        .catch((err) => {
          clearTimeout(abortTimer);
          if (probeController === ctl) probeController = null;
          if (err && err.name === "AbortError") return; // slow != failed
          if (token !== loadToken || activeServer !== "zoko" || playerReady) return;
          showFallbackOffer();
        });
    }

    function armBackupFailureDetection(token) {
      if (backupFailTimer) clearTimeout(backupFailTimer);
      backupFailTimer = setTimeout(() => {
        backupFailTimer = null;
        if (token !== loadToken || activeServer !== "backup" || playerReady) return;
        
        markPlayerSettled();
        if (spinner) spinner.hidden = true;
        if (coverOverlay) coverOverlay.style.display = "none";
        showBackupNote("TVplus player isn't responding.");
      }, BACKUP_NO_READY_TIMEOUT_MS);
    }

    function armMegaPlayFailureDetection(token) {
      if (megaplayFailTimer) clearTimeout(megaplayFailTimer);
      megaplayFailTimer = setTimeout(() => {
        megaplayFailTimer = null;
        if (token !== loadToken || activeServer !== "megaplay" || playerReady) return;
        
        markPlayerSettled();
        if (spinner) spinner.hidden = true;
        if (coverOverlay) coverOverlay.style.display = "none";
        showMegaPlayFailureOffer("MegaPlay isn't responding.");
      }, MEGAPLAY_NO_PLAY_TIMEOUT_MS);
    }

    function armAnimeggFailureDetection(token) {
      if (animeggFailTimer) clearTimeout(animeggFailTimer);
      animeggFailTimer = setTimeout(() => {
        animeggFailTimer = null;
        if (token !== loadToken || activeServer !== ANIMEGG_SERVER_ID) return;
        markPlayerSettled();
        if (spinner) spinner.hidden = true;
        if (coverOverlay) coverOverlay.style.display = "none";
        showAnimeggFailureOffer("The animegg player isn't responding.");
      }, ANIMEGG_NO_PLAY_TIMEOUT_MS);
    }

    function switchServer(server) {
      if (server !== "zoko" && server !== "backup" && server !== ANIMEGG_SERVER_ID) return;
      if (server === activeServer) return;
      
      loadToken++;
      loadInFlight = false;
      switchBusy = false;
      settleAttempt = 0;
      const pos = Math.floor(currentPosition || 0);
      activeServer = server;
      
      applyIframeSandbox(server);
      try { sessionStorage.setItem(SS_SERVER_KEY, server); } catch {}
      clearPlayerTimersAndProbes();
      hideResumeNote();
      playerReady = false;
      playerEp = null;
      megaPlayFrameLoaded = false;
      lastZokoErrorAt = 0;
      lastMegaPlayErrorAt = 0;
      playerSettled = false;
      
      clearPlayerToasts();
      applyServerUI();
      
      hideFallbackNote();
      pendingSwitchWatchdog = true;
      loadEpisode(currentEp, null, false, pos);
    }

    function applyServerUI() {
      const onBackup = activeServer === "backup";
      const onMegaPlay = activeServer === "megaplay";
      const onAnimegg = activeServer === ANIMEGG_SERVER_ID;
      if (serverSwitcher) {
        serverSwitcher.querySelectorAll(".server-pill").forEach((p) => {
          p.classList.toggle("active", p.dataset.server === activeServer);
          
          if (p.dataset.server === ANIMEGG_SERVER_ID) {
            const off = animeggState === "unavailable";
            p.disabled = off;
            p.classList.toggle("is-disabled", off);
            p.title = off
              ? "animegg doesn't carry this episode"
              : "animegg — sub only, SD. Manual fallback; no track switch.";
          }        });
      }
      if (iframe) {
        iframe.title = onMegaPlay ? "MegaPlay player"
          : onBackup ? "TVplus player"
          : onAnimegg ? "animegg player"
          : "ZokoAnime player";
      }
      if (trackSwitcher) {
        trackSwitcher.querySelectorAll(".server-pill").forEach((p) => {
          const t = p.dataset.track || "sub";
          if (onBackup) {
            
            p.classList.toggle("active", t === "sub");
            p.disabled = t !== "sub";
            p.classList.toggle("is-disabled", t !== "sub");
            p.title = t === "dub" ? "Track switching isn't available on TVplus — audio depends on the source file"
                    : t === "hsub" ? "Track switching isn't available on TVplus — subs depend on the source file"
                    : "";
          } else if (onAnimegg) {
            
            p.classList.toggle("active", t === "sub");
            p.disabled = t !== "sub";
            p.classList.toggle("is-disabled", t !== "sub");
            p.title = t === "dub" ? "animegg is sub only — there is no English dub track"
                    : t === "hsub" ? "animegg is sub only — hard-sub isn't available either"
                    : "";
          } else if (onMegaPlay) {
            
            p.disabled = t === "hsub";
            p.classList.toggle("is-disabled", t === "hsub");
            p.title = t === "hsub" ? "Hard-sub isn't a MegaPlay track — choose Sub or Dub" : "";
          } else {
            p.disabled = false;
            p.classList.remove("is-disabled");
            p.title = "";
          }
        });
        if (onMegaPlay) applyTrackPill(currentTrack === "dub" ? "dub" : "sub");
        else if (!onBackup && !onAnimegg) applyTrackPill(currentTrack);
      }
      if (settingToggles) {
        settingToggles.querySelectorAll("input[data-setting]").forEach((cb) => {
          
          const key = cb.dataset.setting;
          const disabled = onBackup || onAnimegg || (onMegaPlay && key !== "autonext");
          cb.disabled = disabled;
          const label = cb.closest(".zoko-toggle");
          if (label) {
            label.classList.toggle("is-disabled", disabled);
            label.title = !disabled ? ""
              : onBackup ? "Not available on the TVplus player"
              : onAnimegg ? "Not available on the animegg player"
              : key === "autoplay" ? "MegaPlay always auto-plays"
              : "Not available on the MegaPlay player";
          }
        });
      }
      const coverBadge = document.getElementById("player-cover-badge");
      if (coverBadge) {
        coverBadge.innerHTML = onMegaPlay
          ? '<span class="text-zoro-lime">⚡</span> Stream with MegaPlay (Auto-Play)'
          : onBackup
          ? '<span class="text-zoro-lime">⚡</span> Stream with TVplus (press Play)'
          : onAnimegg
          ? '<span class="text-zoro-lime">⚡</span> Stream with animegg (Sub, SD)'
          : '<span class="text-zoro-lime">⚡</span> Stream with ZokoAnime (Auto-Skip)';
      }
      updateTrackLabel();
    }

    if (serverSwitcher) {
      serverSwitcher.querySelectorAll(".server-pill").forEach((pill) => {
        pill.addEventListener("click", () => switchServer(pill.dataset.server));
      });
    }

    function readProgressMap() {
      try {
        return JSON.parse(localStorage.getItem(LS_PROGRESS_KEY) || "{}");
      } catch {
        return {};
      }
    }
    function readLocalProgress(slug, ep) {
      const row = readProgressMap()[`${slug}:${ep}`];
      return row && typeof row.t === "number" ? row : null;
    }
    function writeLocalProgress(slug, ep, pos, dur) {
      try {
        const map = readProgressMap();
        map[`${slug}:${ep}`] = { t: Math.floor(pos), d: Math.floor(dur || 0), at: Date.now() };
        
        const keys = Object.keys(map);
        if (keys.length > 200) {
          keys.sort((a, b) => (map[a].at || 0) - (map[b].at || 0));
          for (const k of keys.slice(0, keys.length - 200)) delete map[k];
        }
        localStorage.setItem(LS_PROGRESS_KEY, JSON.stringify(map));
      } catch {}
    }
    function clearLocalProgress(slug, ep) {
      try {
        const map = readProgressMap();
        delete map[`${slug}:${ep}`];
        localStorage.setItem(LS_PROGRESS_KEY, JSON.stringify(map));
      } catch {}
    }
    
    function resumablePosition(pos, dur) {
      const d = dur > 0 ? dur : 1440;
      return typeof pos === "number" && pos >= 5 && pos < d - 20 && pos / d <= 0.95;
    }

    // seek/settings commands would be fake controls there.
    function sendPlayerCommand(cmd) {
      if (activeServer !== "zoko") return;
      if (cmd && cmd.type === "seek") seekCommandThisLoad = true;
      if (iframe && iframe.contentWindow) {
        iframe.contentWindow.postMessage(
          Object.assign({ channel: "zokoanime" }, cmd),
          "https://zokoanime.video"
        );
      }
    }

    // Helper: Format seconds to MM:SS
    function formatTime(s) {
      const sec = Math.floor(Math.max(0, s));
      const m = Math.floor(sec / 60);
      const remainingSec = sec % 60;
      return `${String(m).padStart(2, "0")}:${String(remainingSec).padStart(2, "0")}`;
    }

    // Spec-compliant embed URL builder (ZokoAnime spec only).
    
    function getEmbedUrl(malId, epNum, track, opts = {}) {
      const source = opts.source === "anilist" ? "anilist" : "mal";
      const id = opts.id != null ? opts.id : malId;
      if (!id) {
        showToast("No anime id mapped for this title");
        return null;
      }
      
      if (source === "anilist") {
        return null;
      }
      const color = "cae962";
      const ap = opts.autoplay ? 1 : 0;
      const as = opts.autoskip ? 1 : 0;
      const an = opts.autonext ? 1 : 0;
      let url = `https://zokoanime.video/stream/${source}/${id}/${epNum}/${track}?color=${color}&autoplay=${ap}&autoskip=${as}&autonext=${an}`;
      if (opts.startTime && opts.startTime > 0) {
        
        const startSec = Math.floor(opts.startTime);
        url += `&t=${startSec}&time=${startSec}`;
      }
      if (opts.noResume) {
        
        url += "&resume=0";
      }
      return url;
    }

    function showDataError(message, onRetry) {
      if (!dataError) return;
      if (dataErrorText) dataErrorText.textContent = message;
      if (dataErrorRetry) {
        dataErrorRetry.hidden = false;
        dataErrorRetry.onclick = () => {
          hideDataError();
          if (typeof onRetry === "function") onRetry();
        };
      }
      dataError.hidden = false;
    }

    function hideDataError() {
      if (dataError) dataError.hidden = true;
    }

    function showNotFoundState(message) {
      if (animeTitle) animeTitle.textContent = "Title not found";
      if (animeTitleH1) animeTitleH1.textContent = "Title not found";
      if (epSubtitle) epSubtitle.textContent = "Title not found";
      if (animeDesc) animeDesc.textContent = "";
      if (timeText) timeText.textContent = "00:00 / --:--";
      if (epGrid) epGrid.innerHTML = `<p class="ep-grid-status">Title not found.</p>`;
      if (rangeTabs) rangeTabs.innerHTML = "";
      if (spinner) spinner.hidden = true;
      const bigPlay = document.querySelector(".player-big-play");
      if (bigPlay) bigPlay.style.display = "none";
      const badge = document.getElementById("player-cover-badge");
      if (badge) badge.hidden = true;
      showDataError(message, startWatch);
      markContentReady();
    }

    function showPlaceholder(message) {
      if (animeTitle) animeTitle.textContent = "Loading…";
      if (animeTitleH1) animeTitleH1.textContent = "Loading…";
      if (epSubtitle) epSubtitle.textContent = message;
      if (animeDesc) animeDesc.textContent = "Loading synopsis…";
      if (timeText) timeText.textContent = "00:00 / --:--";
      if (epGrid && !epGrid.querySelector(".ep-btn")) {
        epGrid.innerHTML = `<p class="ep-grid-status">Loading episodes…</p>`;
      }
    }

    function totalEpisodes() {
      if (isLive) return liveAiredCount;
      return (titleData && titleData.episodes) || episodesList.length || 0;
    }

    async function loadWatchRecommendations() {
      const wrap = document.getElementById("detail-recommendations");
      if (!wrap) return;
      if (isLive) {
        const recs = (titleData && Array.isArray(titleData.recommendations)) ? titleData.recommendations : [];
        fillRecommendations(recs.filter((r) => r && !r.isAdult));
        return;
      }
      const res = await fetchTitles(100);
      if (res.ok && res.data && Array.isArray(res.data.titles)) {
        fillRecommendations(sameGenreRecommendations(res.data.titles, currentSlug, titleData && titleData.genres));
      } else {
        fillRecommendations([]);
      }
    }

    async function loadLiveTitleData() {
      hideDataError();
      const res = await api(`/api/live/${encodeURIComponent(liveId)}`);
      if (!res.ok || !res.data || !res.data.title) {
        showNotFoundState(
          res.status === 404
            ? "This title is not available."
            : res.status === 502
            ? "Service is busy — try again in a moment."
            : "This title could not be loaded from the server."
        );
        return false;
      }

      const t = res.data.title;
      titleData = t;

      const next = t.nextAiringEpisode || null;
      const isFilm = t.format === "MOVIE";
      if (isFilm) {
        liveAiredCount = 1;
      } else if (next && next.episode) {
        liveAiredCount = Math.max(0, Number(next.episode) - 1);
      } else if (t.episodes != null) {
        liveAiredCount = Number(t.episodes);
      } else {
        liveAiredCount = 0;
      }
      liveEpisodesUnknown = !isFilm && t.episodes == null && !next;
      episodesList = [];
      for (let n = 1; n <= liveAiredCount; n++) {
        episodesList.push({ ep_num: n, title: `Episode ${n}` });
      }

      if (animeTitle) animeTitle.textContent = titleData.name;
      if (animeTitleH1) animeTitleH1.textContent = titleData.name;
      if (animeDesc) animeDesc.textContent = titleData.synopsis || "";

      const badgesEl = document.getElementById("watch-anime-badges");
      if (badgesEl) {
        badgesEl.innerHTML = t.is18plus
          ? `<span class="badge badge-18plus">18+</span>`
          : "";
        badgesEl.hidden = !t.is18plus;
      }

      const setText = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
      };
      setText("watch-detail-status", liveStatusLabel(titleData));
      setText("watch-detail-studios", (titleData.studios || []).join(", ") || "—");
      setText("watch-detail-aired", liveAiredRange(titleData.startDate, titleData.endDate) || "—");
      const liveSeason = liveSeasonLabel(titleData.season);
      setText("watch-detail-season", liveSeason || "—");
      const seasonRow = document.getElementById("watch-detail-season-row");
      if (seasonRow) seasonRow.hidden = !liveSeason;
      setText("watch-detail-year", titleData.year || "—");
      setText("watch-detail-score", scoreLabel(titleData) ? `★ ${scoreLabel(titleData)} / 10` : "—");
      setText("watch-detail-episodes", titleData.episodes != null ? titleData.episodes : "—");
      setText("watch-detail-duration", titleData.runtimeMin ? `${titleData.runtimeMin}m per ep` : "—");
      setText("watch-detail-next", next ? `Ep ${next.episode} on ${formatAiringDate(next.airingAt)}` : "—");
      const nextRow = document.getElementById("watch-detail-next-row");
      if (nextRow) nextRow.hidden = !next;
      const detailLink = document.getElementById("watch-detail-link");
      if (detailLink) detailLink.href = liveDetailHref(titleData);
      if (coverOverlay) coverOverlay.style.backgroundImage = `url('${bannerOf(titleData)}')`;

      if (wlBtn) wlBtn.hidden = true;
      const discussion = document.getElementById("watch-discussion");
      if (discussion) discussion.hidden = true;

      renderEpisodesGrid();
      updateEpisodeNavState();
      loadWatchRecommendations();
      markContentReady();
      return true;
    }

    /* Load Title Details (retryable) */
    async function loadTitleData() {
      if (isLive) return loadLiveTitleData();
      hideDataError();
      
      if (!currentSlug) {
        showNotFoundState("No title specified. Browse the catalog to pick an anime.");
        return false;
      }
      const titleRes = await api(`/api/titles/${encodeURIComponent(currentSlug)}`);
      if (!titleRes.ok || !titleRes.data || !titleRes.data.title) {
        showNotFoundState(
          titleRes.status === 404
            ? `We couldn't find a title for "${currentSlug}". Browse the catalog to pick an anime.`
            : titleRes.error === "Request timed out"
            ? "The server took too long to respond. Check your connection and retry."
            : "This title could not be loaded from the server."
        );
        return false;
      }

      const data = titleRes.data;
      titleData = data.title;
      episodesList = Array.isArray(data.episodes) ? data.episodes : [];
      
      seedDubAvailability(data);

      if (animeTitle) animeTitle.textContent = titleData.name;
      if (animeTitleH1) animeTitleH1.textContent = titleData.name;
      if (animeDesc) animeDesc.textContent = titleData.synopsis || titleData.tagline || "";

      const setText = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
      };
      setText("watch-detail-status", statusLabel(titleData.status));
      setText("watch-detail-studios", titleData.studios || titleData.studio || "—");
      setText("watch-detail-year", titleData.year || "—");
      setText("watch-detail-score", scoreLabel(titleData) ? `★ ${scoreLabel(titleData)} / 10` : "—");
      setText("watch-detail-episodes", titleData.episodes || episodesList.length || "—");
      
      setText("watch-detail-duration", titleData.runtimeMin ? `${titleData.runtimeMin}m per ep` : "—");
      const detailLink = document.getElementById("watch-detail-link");
      if (detailLink) detailLink.href = detailHref(currentSlug);
      if (coverOverlay) coverOverlay.style.backgroundImage = `url('${bannerOf(titleData)}')`;

      // Watchlist Button State
      if (wlBtn && data.userState) {
        updateWatchlistBtn(data.userState.inWatchlist);
      }

      renderEpisodesGrid();
      updateEpisodeNavState();
      
      loadWatchRecommendations();
      markContentReady();
      return true;
    }

    // Build episodes grid
    function renderEpisodesGrid() {
      if (!epGrid) return;

      const totalEps = totalEpisodes();
      if (!totalEps) {
        if (isLive && liveEpisodesUnknown) {
          
          epGrid.innerHTML = `
            <p class="ep-grid-status">Episode list unavailable for this title.</p>
            <button class="ep-btn" data-ep="1" type="button" title="Episode 1"><span class="ep-btn-num">001</span><span class="ep-btn-title">Episode 1</span></button>`;
        } else {
          epGrid.innerHTML = `<p class="ep-grid-status">No episodes available for this title.</p>`;
        }
        bindEpisodeGridEvents();
        return;
      }

      if (rangeTabs) {
        const maxEpStr = String(totalEps).padStart(3, "0");
        rangeTabs.innerHTML = `<button class="ep-tab-btn active" type="button">001 - ${maxEpStr}</button>`;
      }

      const epMap = new Map();
      episodesList.forEach((e) => {
        if (e && e.ep_num != null) {
          epMap.set(Number(e.ep_num), e.title);
        }
      });

      let html = "";
      for (let i = 1; i <= totalEps; i++) {
        const epPadded = String(i).padStart(3, "0");
        const isActive = i === currentEp;
        const rawTitle = epMap.get(i) || `Episode ${i}`;
        const safeTitle = escapeHtml(rawTitle);
        html += `<button class="ep-btn ${isActive ? "active" : ""}" data-ep="${i}" data-title="${safeTitle.toLowerCase()}" type="button" title="Episode ${i}: ${safeTitle}"><span class="ep-btn-num">${epPadded}</span><span class="ep-btn-title">${safeTitle}</span></button>`;
      }
      epGrid.innerHTML = html;

      const searchInput = document.getElementById("ep-search-input");
      if (searchInput && searchInput.dataset.searchBound !== "true") {
        searchInput.dataset.searchBound = "true";
        searchInput.addEventListener("input", () => {
          const q = searchInput.value.trim().toLowerCase();
          const buttons = epGrid.querySelectorAll(".ep-btn");
          let visibleCount = 0;
          buttons.forEach((btn) => {
            const epNum = btn.dataset.ep;
            const epTitle = btn.dataset.title || "";
            const match = !q || epNum === q || epNum.padStart(3, "0") === q || epTitle.includes(q);
            btn.style.display = match ? "flex" : "none";
            if (match) visibleCount++;
          });
          let noMatchEl = epGrid.querySelector(".ep-no-search-match");
          if (visibleCount === 0) {
            if (!noMatchEl) {
              noMatchEl = document.createElement("p");
              noMatchEl.className = "ep-no-search-match";
              noMatchEl.style.cssText = "color: var(--text-muted); font-size: 0.85rem; padding: 12px 0; text-align: center;";
              noMatchEl.textContent = "No episodes match your search.";
              epGrid.appendChild(noMatchEl);
            }
          } else if (noMatchEl) {
            noMatchEl.remove();
          }
        });
      }

      bindEpisodeGridEvents();
    }

    function bindEpisodeGridEvents() {
      if (!epGrid || epGrid.dataset.delegatedBound === "true") return;
      epGrid.dataset.delegatedBound = "true";
      epGrid.addEventListener("click", (e) => {
        const btn = e.target.closest(".ep-btn");
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        const epNum = parseInt(btn.dataset.ep, 10);
        if (epNum && epNum !== currentEp) {
          loadEpisode(epNum);
        }
      });
    }

    function updateEpisodeNavState() {
      const totalEps = totalEpisodes();
      const prevBtn = document.getElementById("btn-prev-ep");
      const nextBtn = document.getElementById("btn-next-ep");
      // Movies / single-episode titles have no previous or next episode:
      // hide both buttons entirely instead of showing them greyed out.
      const isSingleEp = totalEps === 1;
      if (prevBtn) {
        prevBtn.style.display = isSingleEp ? "none" : "";
        prevBtn.disabled = currentEp <= 1;
        prevBtn.style.opacity = currentEp <= 1 ? "0.5" : "1";
      }
      if (nextBtn) {
        nextBtn.style.display = isSingleEp ? "none" : "";
        const atEnd = totalEps > 0 && currentEp >= totalEps;
        
        const cont = atEnd ? titleContinuation() : null;
        nextBtn.disabled = (atEnd && !cont) || totalEps === 0;
        nextBtn.style.opacity = nextBtn.disabled ? "0.5" : "1";
        nextBtn.textContent = cont ? `Next: ${cont.short || cont.name} ›` : "Next Ep ›";
      }
    }

    // Episode subtitle updater
    async function updateEpisodeSubtitle(epNum, prefetched) {
      const epRes = await (prefetched || fetchEpisodeData(epNum));
      
      const isCurrent = Number(epNum) === Number(currentEp);
      if (epRes.ok && epRes.data && epRes.data.episode) {
        const ep = epRes.data.episode;
        
        if (epSubtitle && isCurrent) {
          epSubtitle.textContent = isLive
            ? `Episode ${ep.epNum}`
            : `Episode ${ep.epNum}: ${ep.title}`;
        }
        return ep;
      } else {
        if (epSubtitle && isCurrent) epSubtitle.textContent = `Episode ${epNum}`;
        return null;
      }
    }

    /* Load an episode */
    
    function fetchEpisodeData(epNum) {
      
      if (isLive) {
        const runtime = (titleData && titleData.runtimeMin) ? titleData.runtimeMin : 24;
        const saved = readLocalProgress(progressKey, epNum);
        return Promise.resolve({
          ok: true,
          status: 200,
          error: null,
          data: {
            episode: {
              epNum,
              title: `Episode ${epNum}`,
              durationSec: runtime * 60,
              savedPositionSec: saved && typeof saved.t === "number" ? saved.t : 0,
            },
          },
        });
      }
      return api(`/api/titles/${encodeURIComponent(currentSlug)}/episodes/${epNum}`);
    }

    function showResumeNote(seconds) {
      if (!resumeNote) return;
      if (resumeNoteTimer) {
        clearTimeout(resumeNoteTimer);
        resumeNoteTimer = null;
      }
      resumeNoteShownForLoad = true;
      resumeNoteArmOnPlay = true;
      
      const restartBtnHtml = (activeServer === "megaplay" || activeServer === ANIMEGG_SERVER_ID) ? "" :
        `<button class="btn-zoro-primary btn-resume-restart" id="resume-restart-btn" type="button">Restart</button>`;
      resumeNote.innerHTML = `
        Resumed from ${formatTime(seconds)}
        ${restartBtnHtml}
        <button class="btn-resume-dismiss" id="resume-dismiss-btn" type="button" aria-label="Dismiss resume notice">✕</button>
      `;
      resumeNote.hidden = false;
      const restartBtn = resumeNote.querySelector("#resume-restart-btn");
      if (restartBtn) {
        restartBtn.addEventListener("click", () => {
          hideResumeNote();
          
          loadEpisode(currentEp, null, true);
        });
      }
      const dismissBtn = resumeNote.querySelector("#resume-dismiss-btn");
      if (dismissBtn) dismissBtn.addEventListener("click", hideResumeNote);
    }
    function hideResumeNote() {
      if (resumeNoteTimer) {
        clearTimeout(resumeNoteTimer);
        resumeNoteTimer = null;
      }
      resumeNoteArmOnPlay = false;
      if (resumeNote) {
        resumeNote.hidden = true;
        resumeNote.innerHTML = "";
      }
    }
    
    function armResumeNoteAutoHide() {
      if (!resumeNoteArmOnPlay) return;
      resumeNoteArmOnPlay = false;
      if (resumeNoteTimer) clearTimeout(resumeNoteTimer);
      resumeNoteTimer = setTimeout(hideResumeNote, 6000);
    }

    async function loadEpisode(epNum, prefetched, startFromBeginning = false, positionOverride = null) {
      if (!titleData) {
        loadInFlight = false;
        if (spinner) spinner.hidden = true;
        const bigPlay = document.querySelector(".player-big-play");
        if (bigPlay) bigPlay.style.display = "none";
        return;
      }
      currentEp = epNum;
      activeEpisode = epNum;
      loadInFlight = true;
      loadToken++;
      const token = loadToken;
      
      clearPlayerTimersAndProbes();
      if (activeServer !== "backup") hideFallbackNote();
      
      hideResumeNote();
      resumeNoteShownForLoad = false;
      resumeTimeForLoad = 0;
      loadStartedAt = Date.now();
      playbackEvidenceForLoad = false;
      skippedThisLoad = false;
      seekCommandThisLoad = false;
      lastZokoErrorAt = 0;
      lastMegaPlayErrorAt = 0;
      megaPlayFrameLoaded = false;
      durationIsReal = false;
      playerReady = false;
      playerSettled = false;
      
      animeggState = "unknown";
      animeggLoadToken++;

      if (iframe && iframe.src && iframe.src !== "about:blank") {
        iframe.src = "about:blank";
      }

      const knownAvail = dubAvailability.get(Number(epNum));
      if (activeServer === "backup") {
        
        currentTrack = "sub";
        applyTrackPill("sub");
        updateTrackLabel();
      } else if (activeServer === ANIMEGG_SERVER_ID) {
        
        currentTrack = "sub";
        applyTrackPill("sub");
        updateTrackLabel();
      } else if (activeServer === "megaplay") {
        
        const storedTrack = readPreferredTrack();
        currentTrack = megaPlayTrack || (storedTrack === "dub" ? "dub" : "sub");
        applyTrackPill(currentTrack);
        updateTrackLabel();
      } else if (isLive) {
        
        currentTrack = preferredTrack === "hsub" ? "hsub" : preferredTrack;
        applyTrackPill(currentTrack);
        updateTrackLabel();
      } else {
        const optimisticTrack = preferredTrack === "dub"
          ? (knownAvail === true ? "dub" : "sub")
          : (preferredTrack === "hsub" ? "hsub" : "sub");
        currentTrack = optimisticTrack;
        applyTrackPill(optimisticTrack);
        updateTrackLabel();
      }

      const probePromise = activeServer === "zoko" && !isLive ? probeDubAvailability(epNum) : null;

      if (activeServer !== ANIMEGG_SERVER_ID) {
        const bgToken = animeggLoadToken;
        probeAnimegg(epNum).then(() => {
          if (bgToken === animeggLoadToken) applyAnimeggPill();
        }).catch(() => {});
      }

      const epSearchInput = document.getElementById("ep-search-input");
      if (epSearchInput && epSearchInput.value) {
        epSearchInput.value = "";
      }
      if (epGrid) {
        epGrid.querySelectorAll(".ep-btn").forEach((btn) => {
          btn.style.display = "flex";
        });
        const noMatchEl = epGrid.querySelector(".ep-no-search-match");
        if (noMatchEl) noMatchEl.remove();
      }

      const cachedEp = episodesList.find((e) => Number(e.ep_num ?? e.epNum) === Number(epNum));
      if (epSubtitle) {
        epSubtitle.textContent = cachedEp
          ? `Episode ${epNum}: ${cachedEp.title}`
          : `Episode ${epNum}`;
      }

      if (overlay) overlay.hidden = true;
      if (spinner) spinner.hidden = false;

      const newUrl = isLive
        ? `watch.html?live=${encodeURIComponent(liveId)}&ep=${epNum}`
        : `watch.html?slug=${encodeURIComponent(currentSlug)}&ep=${epNum}`;
      window.history.replaceState({ slug: currentSlug, ep: epNum }, "", newUrl);

      // Highlight active episode button
      document.querySelectorAll("#zoro-episodes-grid .ep-btn").forEach((btn) => {
        btn.classList.toggle("active", parseInt(btn.dataset.ep, 10) === epNum);
      });
      const activeBtn = epGrid ? epGrid.querySelector(`.ep-btn[data-ep="${epNum}"]`) : null;
      if (activeBtn) {
        activeBtn.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }

      updateEpisodeNavState();

      // Check saved position for resume
      const epData = await updateEpisodeSubtitle(epNum, prefetched);
      
      if (token !== loadToken) return;
      if (currentEp !== epNum) return;
      if (!epData) {
        
        // leaving stale placeholder text on screen.
        loadInFlight = false;
        if (spinner) spinner.hidden = true;
        if (overlay) {
          overlay.hidden = false;
          if (overlayTitle) overlayTitle.textContent = "Could not load episode";
          if (overlayText) overlayText.textContent = "The episode list could not be loaded from the server. Use Retry to try again.";
        }
        showDataError("This episode could not be loaded from the server.", () => loadEpisode(epNum));
        return;
      }
      hideDataError();

      let resumeTime = 0;
      if (startFromBeginning) {
        
        clearLocalProgress(progressKey, epNum);
      } else if (positionOverride != null) {
        
        resumeTime = positionOverride >= 1 ? Math.floor(positionOverride) : 0;
      } else if (isLive) {
        
        const epDur = epData.durationSec || 1440;
        const lp = readLocalProgress(progressKey, epNum);
        if (lp && resumablePosition(lp.t, lp.d || epDur)) {
          resumeTime = Math.floor(lp.t);
        }
      } else {
        const epDur = epData.durationSec || 1440;
        if (typeof epData.savedPositionSec === "number" && resumablePosition(epData.savedPositionSec, epDur)) {
          
          resumeTime = Math.floor(epData.savedPositionSec);
        } else if (!currentUser) {
          
          const lp = readLocalProgress(currentSlug, epNum);
          if (lp && resumablePosition(lp.t, lp.d || epDur)) {
            resumeTime = Math.floor(lp.t);
          }
        }
      }
      
      if (activeServer === "megaplay") resumeTime = 0;
      
      if (activeServer === ANIMEGG_SERVER_ID) resumeTime = 0;
      resumeTimeForLoad = resumeTime;
      
      if (resumeTime >= 5) showResumeNote(resumeTime);

      currentPosition = activeServer === "megaplay" && positionOverride != null
        ? Math.floor(positionOverride)
        : resumeTime;
      if (epData.durationSec) duration = epData.durationSec;
      if (progressFill && duration > 0) {
        progressFill.style.width = `${Math.min((resumeTime / duration) * 100, 100)}%`;
      }
      if (timeText) {
        timeText.textContent = `${formatTime(resumeTime)} / ${durationIsReal && duration > 0 ? formatTime(duration) : "--:--"}`;
      }

      if (activeServer === "zoko") {
        if (isLive) {
          
          currentTrack = preferredTrack === "hsub" ? "hsub" : preferredTrack;
          applyTrackPill(currentTrack);
        } else if (preferredTrack === "dub") {
          
          const avail = typeof knownAvail === "boolean" ? knownAvail : await probePromise;
          if (token !== loadToken || currentEp !== epNum) return; // superseded while probing
          currentTrack = avail === true ? "dub" : "sub";
          applyTrackPill(currentTrack);
        } else {
          
          currentTrack = preferredTrack === "hsub" ? "hsub" : "sub";
          applyTrackPill(currentTrack);
        }
        updateTrackLabel();
      }

      let streamUrl;
      if (activeServer === "backup") {
        streamUrl = getBackupEmbedUrl(currentEp, resumeTime, startFromBeginning === true);
      } else if (activeServer === "megaplay") {
        streamUrl = getMegaPlayEmbedUrl(currentEp, currentTrack);
      } else if (activeServer === ANIMEGG_SERVER_ID) {
        
        const url = await resolveAnimeggStreamUrl(currentEp);
        if (token !== loadToken || currentEp !== epNum) return; // superseded while resolving
        if (!url) {
          
          loadInFlight = false;
          animeggState = "unavailable";
          applyAnimeggPill();
          if (spinner) spinner.hidden = true;
          if (coverOverlay) coverOverlay.style.display = "none";
          showAnimeggUnavailableNote("This episode isn't available on the animegg player.");
          return;
        }
        streamUrl = url;
      } else {
        
        const useAnilistRoute = isLive && !(titleData && titleData.malId);
        if (useAnilistRoute) {
          streamUrl = getBackupEmbedUrl(currentEp, resumeTime, startFromBeginning === true);
        } else {
          const playerId = getCustomMalId(progressKey) || (titleData && titleData.malId);
          streamUrl = getEmbedUrl(playerId, currentEp, currentTrack, {
            source: "mal",
            autoplay: playerSettings.autoplay,
            autoskip: playerSettings.autoskip,
            autonext: playerSettings.autonext,
            startTime: resumeTime,
            
            noResume: startFromBeginning === true || resumeTime === 0,
          });
        }
      }

      if (!streamUrl) {
        loadInFlight = false;
        if (spinner) spinner.hidden = true;
        if (overlay) {
          overlay.hidden = false;
          if (overlayTitle) overlayTitle.textContent = "Stream unavailable";
          if (overlayText) overlayText.textContent = isLive
            ? "This title is not available on any player."
            : "No MAL ID mapped for this title, so the stream cannot be loaded.";
        }
        return;
      }

      if (iframe) {
        iframe.src = streamUrl;
        iframe.title = activeServer === "megaplay" ? "MegaPlay player"
          : activeServer === "backup" ? "TVplus player"
          : activeServer === ANIMEGG_SERVER_ID ? "animegg player"
          : "ZokoAnime player";
        
      }
      
      loadInFlight = false;
      
      if (activeServer === "zoko") {
        armZokoFailureDetection(streamUrl, token);
      } else if (activeServer === "megaplay") {
        armMegaPlayFailureDetection(token);
      } else if (activeServer === ANIMEGG_SERVER_ID) {
        armAnimeggFailureDetection(token);
      } else {
        armBackupFailureDetection(token);
      }
      
      if (pendingSwitchWatchdog) {
        pendingSwitchWatchdog = false;
        armSettleWatchdog(token, activeServer, 0);
      }
      if (spinner) {
        spinner.hidden = false;
        
        spinner.style.pointerEvents = "none";
      }
      if (coverOverlay) {
        
        coverOverlay.style.display = "";
        coverOverlay.style.pointerEvents = "none";
        const bigPlay = coverOverlay.querySelector(".player-big-play");
        if (bigPlay) bigPlay.style.display = "none";
      }

      // Reload comments for this episode
      if (reloadComments) reloadComments(true);
    }

    // Support browser back/forward history without full reload
    window.addEventListener("popstate", () => {
      const p = new URLSearchParams(window.location.search);
      const epParam = parseInt(p.get("ep"), 10);
      if (epParam && epParam !== currentEp) {
        loadEpisode(epParam);
      }
    });

    // Play big play button
    const bigPlayBtn = document.querySelector(".player-big-play");
    if (bigPlayBtn) {
      bigPlayBtn.addEventListener("click", () => {
        loadEpisode(currentEp);
      });
    }

    // Track switcher buttons (sub, hsub, dub)
    const trackSwitcher = document.getElementById("zoko-track-switcher");

    const dubAvailability = new Map(); // ep -> true | false | null
    const dubProbes = new Map();        // ep -> Promise<true | false | null>

    function seedDubAvailability(data) {
      if (!data) return;
      const confirmed = Array.isArray(data.dubEpisodes) ? data.dubEpisodes : [];
      const denied = Array.isArray(data.noDubEpisodes) ? data.noDubEpisodes : [];
      for (const ep of confirmed) {
        const key = Number(ep);
        if (Number.isFinite(key) && !dubAvailability.has(key)) dubAvailability.set(key, true);
      }
      for (const ep of denied) {
        const key = Number(ep);
        if (Number.isFinite(key) && !dubAvailability.has(key)) dubAvailability.set(key, false);
      }
      updateTrackLabel();
    }

    function probeDubAvailability(epNum) {
      const key = Number(epNum);
      if (dubProbes.has(key)) return dubProbes.get(key);
      const p = api(`/api/dub-availability/${encodeURIComponent(currentSlug)}/${key}`).then((res) => {
        const avail =
          res.ok && res.data && typeof res.data.available === "boolean" ? res.data.available : null;
        dubAvailability.set(key, avail);
        if (key === Number(currentEp)) updateTrackLabel();
        return avail;
      });
      dubProbes.set(key, p);
      return p;
    }

    function applyTrackPill(track) {
      if (!trackSwitcher) return;
      const active = track || "sub";
      trackSwitcher.querySelectorAll(".server-pill").forEach((p) => {
        p.classList.toggle("active", (p.dataset.track || "sub") === active);
      });
    }

    function applyAnimeggPill() {
      if (!serverSwitcher) return;
      const pill = serverSwitcher.querySelector('.server-pill[data-server="animegg"]');
      if (!pill) return;
      const off = animeggState === "unavailable";
      pill.disabled = off;
      pill.classList.toggle("is-disabled", off);
      pill.title = off
        ? "animegg doesn't carry this episode"
        : "animegg — sub only, SD. Manual fallback; no track switch.";
    }

    function updateTrackLabel() {
      const label = document.getElementById("track-label");
      if (!label) return;
      
      if (activeServer === ANIMEGG_SERVER_ID) {
        label.textContent = "SUB";
        return;
      }
      if (activeServer === "backup" || activeServer === "megaplay") {
        label.textContent = "—";
        return;
      }
      
      if (isLive) {
        label.textContent = "SUB / DUB";
        return;
      }
      const avail = dubAvailability.get(Number(currentEp));
      label.textContent = avail === true ? "SUB / DUB" : "SUB";
    }

    if (trackSwitcher) {
      trackSwitcher.querySelectorAll(".server-pill").forEach((pill) => {
        pill.addEventListener("click", async () => {
          
          if (activeServer === "backup" || activeServer === ANIMEGG_SERVER_ID) return;
          const requestedTrack = pill.dataset.track || "sub";
          const epAtClick = currentEp;

          if (activeServer === "megaplay") {
            
            if (requestedTrack === "hsub") return; // disabled-pill guard
            if (requestedTrack === currentTrack) return;
            megaPlayTrack = requestedTrack;
            currentTrack = requestedTrack;
            applyTrackPill(currentTrack);
            updateTrackLabel();
            showToast(`Switched audio track to ${currentTrack.toUpperCase()}`);
            
            if (loadInFlight) return;
            if (iframe && iframe.src && iframe.src !== "about:blank") {
              const newUrl = getMegaPlayEmbedUrl(epAtClick, currentTrack);
              if (newUrl) {
                
                megaPlayFrameLoaded = false;
                iframe.src = newUrl;
              }
            }
            return;
          }

          if (requestedTrack === "dub" && !isLive) {
            let avail = dubAvailability.get(Number(epAtClick));
            if (avail === undefined || avail === null) {
              showToast("Checking dub availability…", "⏳", 2500);
              avail = await probeDubAvailability(epAtClick);
            }
            updateTrackLabel();
            
            if (currentEp !== epAtClick) return;
            if (avail !== true) {
              showToast(
                avail === false
                  ? "English dub not available for this episode"
                  : "Could not verify dub availability — staying on the current track",
                "!",
                3500
              );
              
              applyTrackPill(currentTrack);
              return;
            }
          }

          preferredTrack = requestedTrack;
          
          if (!isLive) writePreferredTrack(preferredTrack);
          const changed = requestedTrack !== currentTrack;
          currentTrack = requestedTrack;
          applyTrackPill(currentTrack);
          if (!changed) return; // already playing this track: no toast, no reload

          showToast(`Switched audio track to ${currentTrack.toUpperCase()}`);
          
          if (loadInFlight) return;
          if (iframe && iframe.src && iframe.src !== "about:blank") {

            const resumePos = Math.floor(currentPosition || 0);
            
            const newUrl = activeServer === "backup"
              ? getBackupEmbedUrl(currentEp, resumePos, false)
              : getEmbedUrl(getCustomMalId(progressKey) || (titleData && titleData.malId), currentEp, currentTrack, {
                  source: "mal",
                  autoplay: true,
                  autoskip: playerSettings.autoskip,
                  autonext: playerSettings.autonext,
                  startTime: resumePos > 0 ? resumePos : undefined,
                });
            if (newUrl) iframe.src = newUrl;
          }
        });
      });
    }

    const settingToggles = document.getElementById("zoko-setting-toggles");
    if (settingToggles) {
      settingToggles.querySelectorAll("input[data-setting]").forEach((cb) => {
        const key = cb.dataset.setting;
        if (key in playerSettings) {
          cb.checked = !!playerSettings[key];
        }
        cb.addEventListener("change", () => {
          playerSettings[key] = cb.checked;
          try {
            localStorage.setItem(LS_SETTINGS_KEY, JSON.stringify(playerSettings));
          } catch {}
          sendPlayerCommand({ type: key, on: cb.checked });
          showToast(`${key.toUpperCase()}: ${cb.checked ? "ON" : "OFF"}`);
        });
      });
    }

    const prevBtn = document.getElementById("btn-prev-ep");
    if (prevBtn && prevBtn.dataset.bound !== "true") {
      prevBtn.dataset.bound = "true";
      prevBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (currentEp > 1) loadEpisode(currentEp - 1);
      });
    }
    const nextBtn = document.getElementById("btn-next-ep");
    if (nextBtn && nextBtn.dataset.bound !== "true") {
      nextBtn.dataset.bound = "true";
      nextBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const totalEps = totalEpisodes();
        if (totalEps > 0 && currentEp < totalEps) {
          loadEpisode(currentEp + 1);
          return;
        }
        
        if (totalEps > 0 && currentEp >= totalEps) {
          const cont = titleContinuation();
          if (cont && cont.live) {
            window.location.href = `watch.html?live=${encodeURIComponent(cont.live)}&ep=1`;
          }
        }
      });
    }

    const LS_THEATER_KEY = "av_theater_mode";
    const watchLayout = document.querySelector(".watch-layout");
    const theaterBtn = document.getElementById("btn-theater-mode");
    function applyTheaterMode(on) {
      if (watchLayout) watchLayout.classList.toggle("theater-mode", on);
      if (theaterBtn) {
        theaterBtn.classList.toggle("active", on);
        theaterBtn.setAttribute("aria-pressed", on ? "true" : "false");
      }
    }
    try {
      applyTheaterMode(localStorage.getItem(LS_THEATER_KEY) === "1");
    } catch {}
    if (theaterBtn) {
      theaterBtn.addEventListener("click", () => {
        const on = !(watchLayout && watchLayout.classList.contains("theater-mode"));
        applyTheaterMode(on);
        try { localStorage.setItem(LS_THEATER_KEY, on ? "1" : "0"); } catch {}
        showToast(on ? "Theater mode on" : "Theater mode off");
      });
    }

    // Play/Pause button
    if (playPauseBtn) {
      playPauseBtn.addEventListener("click", () => {
        sendPlayerCommand({ type: isPaused ? "play" : "pause" });
      });
    }

    function reportFullscreenError(action, err) {
      const reason = (err && (err.message || err.name)) || "unknown error";
      console.error(`Fullscreen ${action} rejected:`, err);
      let hint = "";
      if (document.visibilityState !== "visible") {
        hint = " — bring this tab to the front and try again";
      } else if (/gesture|activation|user/i.test(String(reason))) {
        hint = " — the browser needs a direct click/keypress";
      }
      showToast(`Fullscreen ${action} failed: ${reason}${hint}`, "!", 5000);
    }
    function toggleFullscreen() {
      if (!playerWrap) {
        reportFullscreenError("enter", new Error("player wrapper not found"));
        return;
      }
      if (document.fullscreenElement) {
        document.exitFullscreen().catch((err) => reportFullscreenError("exit", err));
      } else {
        if (document.fullscreenEnabled === false) {
          reportFullscreenError("enter", new Error("fullscreen is disabled in this browser/context"));
          return;
        }
        playerWrap.requestFullscreen().catch((err) => reportFullscreenError("enter", err));
      }
    }

    let debugEnabled = new URLSearchParams(window.location.search).get("debug") === "1";
    try {
      debugEnabled = debugEnabled || localStorage.getItem("av_debug") === "1";
    } catch {}
    let customMalBtn = document.getElementById("btn-custom-mal-id");
    if (!customMalBtn && debugEnabled && trackSwitcher && trackSwitcher.parentElement) {
      customMalBtn = document.createElement("button");
      customMalBtn.className = "genre-chip-zoro";
      customMalBtn.id = "btn-custom-mal-id";
      customMalBtn.type = "button";
      customMalBtn.style.cssText = "margin-left: auto; font-size: 0.75rem; padding: 2px 8px;";
      customMalBtn.textContent = "Switch Anime MAL ID";
      trackSwitcher.parentElement.appendChild(customMalBtn);
    }
    if (customMalBtn) {
      customMalBtn.addEventListener("click", () => {
        
        if (isLive) {
          showToast("The MAL id override applies to catalog titles only.", "!");
          return;
        }
        const currentMalId = getCustomMalId(currentSlug) || (titleData && titleData.malId) || "";
        const inputId = prompt(
          `Enter the MyAnimeList id for this title (current: ${currentMalId}).\n` +
            `The id is the number in myanimelist.net/anime/<id>/...`,
          currentMalId
        );
        if (!inputId || isNaN(inputId)) return;
        const newMalId = parseInt(inputId, 10);
        setCustomMalId(currentSlug, newMalId);
        showToast(`MAL ID set to ${newMalId}. Reloading stream...`);
        loadEpisode(currentEp);
      });
    }

    // Overlay Retry Action
    const overlayAction = document.getElementById("zoko-overlay-action");
    if (overlayAction) {
      overlayAction.addEventListener("click", () => {
        if (overlay) overlay.hidden = true;
        loadEpisode(currentEp);
      });
    }

    window.addEventListener("message", async (event) => {
      
      if (event.origin === MEGAPLAY_ORIGIN) {
        if (activeServer !== "megaplay") return;
        let mdata = event.data;
        if (typeof mdata === "string") {
          try { mdata = JSON.parse(mdata); } catch { return; }
        }
        if (!mdata || typeof mdata !== "object") return;
        const isWatchingLog = mdata.type === "watching-log";
        if (!isWatchingLog && mdata.channel !== "megacloud") return;
        const mev = mdata.event || mdata.type;

        if (mev !== "error" && !megaPlayFrameLoaded && playerEp === currentEp) return;

        if (mev === "time" || isWatchingLog) {
          markPlayerSettled();
          if (playerEp == null) return;
          const cur = typeof mdata.time === "number" ? mdata.time
                    : typeof mdata.currentTime === "number" ? mdata.currentTime : 0;
          const hasRealDuration = typeof mdata.duration === "number" && mdata.duration > 0;
          const dur = hasRealDuration ? mdata.duration : duration;
          const now = Date.now();
          
          if (currentUser && !isLive && cur > 0 && now - lastProgressSync > 5000) {
            lastProgressSync = now;
            api("/api/progress", {
              method: "POST",
              body: {
                slug: currentSlug,
                episode: playerEp,
                positionSec: Math.floor(cur),
                durationSec: Math.floor(dur),
              },
            });
          }
          
          if ((!currentUser || isLive) && cur > 0 && now - lastLocalSave > 5000) {
            lastLocalSave = now;
            writeLocalProgress(progressKey, playerEp, cur, dur);
          }
          
          if (playerEp !== currentEp) return;
          
          if (!playerReady) {
            playerReady = true;
            if (megaplayFailTimer) { clearTimeout(megaplayFailTimer); megaplayFailTimer = null; }
          }
          currentPosition = cur;
          if (hasRealDuration) {
            duration = mdata.duration;
            durationIsReal = true;
          }
          if (cur > 0) {
            if (spinner) spinner.hidden = true;
            if (coverOverlay) coverOverlay.style.display = "none";
            
            if (Date.now() - lastMegaPlayErrorAt > MEGAPLAY_RECOVERY_GUARD_MS) {
              if (fallbackOfferVisible) hideFallbackNote();
            }
          }
          if (timeText) {
            timeText.textContent = `${formatTime(cur)} / ${durationIsReal && duration > 0 ? formatTime(duration) : "--:--"}`;
          }
          
          if (
            !resumeNoteShownForLoad &&
            resumeTimeForLoad === 0 &&
            !skippedThisLoad &&
            !seekCommandThisLoad &&
            cur > 30 &&
            now - loadStartedAt < 15000
          ) {
            showResumeNote(cur);
          }
          if (
            resumeNote &&
            !resumeNote.hidden &&
            resumeNoteShownForLoad &&
            !skippedThisLoad &&
            !seekCommandThisLoad &&
            now - loadStartedAt < 15000 &&
            Math.abs(cur - resumeTimeForLoad) >= 2
          ) {
            resumeTimeForLoad = Math.floor(cur);
            showResumeNote(cur);
          }
          if (cur > 0) armResumeNoteAutoHide();
          return;
        }

        if (mev === "complete") {
          markPlayerSettled();
          if (playerEp == null || playerEp !== currentEp) return;
          
          const decision = autoNextAction({
            server: "megaplay",
            currentEp,
            totalEps: totalEpisodes(),
            autonext: playerSettings.autonext,
            continuation: titleContinuation(),
          });
          if (decision.action === "next") {
            showToast(`Episode finished! Auto-playing Episode ${decision.nextEp}...`);
            setTimeout(() => loadEpisode(decision.nextEp), 1500);
          } else if (decision.action === "continue") {
            showToast(`Part finished! Continuing to ${decision.name || "the next part"}...`);
            setTimeout(() => { window.location.href = `watch.html?live=${encodeURIComponent(decision.live)}&ep=1`; }, 1500);
          } else if (decision.action === "completed") {
            showToast("You finished this anime!");
          }
          return;
        }

        if (mev === "error") {
          markPlayerSettled();
          lastMegaPlayErrorAt = Date.now();
          if (megaplayFailTimer) { clearTimeout(megaplayFailTimer); megaplayFailTimer = null; }
          
          if (spinner) spinner.hidden = true;
          if (coverOverlay) coverOverlay.style.display = "none";
          showMegaPlayFailureOffer("MegaPlay couldn't play this episode.");
          return;
        }
        return;
      }

      if (event.origin === BACKUP_ORIGIN) {
        if (activeServer !== "backup") return;
        let bdata = event.data;
        if (typeof bdata === "string") {
          try { bdata = JSON.parse(bdata); } catch {}
        }
        if (!bdata || bdata.source !== "animetvplus-embed") return;
        if (bdata.type === "ready") {
          
          if (bdata.episode != null && Number(bdata.episode) !== Number(currentEp)) return;
          playerEp = currentEp;
          playerReady = true;
          markPlayerSettled();
          if (backupFailTimer) { clearTimeout(backupFailTimer); backupFailTimer = null; }
          
          if (spinner) spinner.hidden = true;
          if (coverOverlay) coverOverlay.style.display = "none";
          showToast("TVplus player ready — press Play inside the player", "▶", 4000);
        } else if (bdata.type === "error") {
          markPlayerSettled();
          if (backupFailTimer) { clearTimeout(backupFailTimer); backupFailTimer = null; }
          if (spinner) spinner.hidden = true;
          if (coverOverlay) coverOverlay.style.display = "none";
          
          const msg = bdata.error === "no_episode" ? "This episode isn't available on the TVplus player."
                    : bdata.error === "unknown_title" ? "This title isn't available on the TVplus player."
                    : "The TVplus player couldn't load this episode.";
          showBackupNote(msg);
        } else if (bdata.type === "fullscreen" || bdata.type === "requestFullscreen" || bdata.type === "toggleFullscreen") {
          
          const req = bdata.request;
          if (req === "enter" && !document.fullscreenElement) toggleFullscreen();
          else if (req === "exit" && document.fullscreenElement) toggleFullscreen();
          else if (req == null) toggleFullscreen();
        }
        return;
      }

      if (event.origin !== "https://zokoanime.video") return;
      
      if (activeServer !== "zoko") return;
      let data = event.data;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch {}
      }
      if (!data || data.channel !== "zokoanime") return;

      if (
        data.type !== "ready" &&
        data.type !== "error" &&
        !playerReady &&
        playerEp === currentEp
      ) return;

      const eventIsForCurrentLoad = playerEp != null && playerEp === currentEp;

      // Event: ready
      if (data.type === "ready") {
        
        playerEp = currentEp;
        playerReady = true;
        markPlayerSettled();
        
        if (zokoFailTimer) { clearTimeout(zokoFailTimer); zokoFailTimer = null; }
        if (fallbackOfferVisible) hideFallbackNote();
        
        if (!zokoNoPlayTimer) {
          const readyToken = loadToken;
          zokoNoPlayTimer = setTimeout(() => {
            zokoNoPlayTimer = null;
            if (readyToken !== loadToken || activeServer !== "zoko") return;
            markPlayerSettled();
            if (zokoNoPlaybackTimer) { clearTimeout(zokoNoPlaybackTimer); zokoNoPlaybackTimer = null; }
            if (spinner) spinner.hidden = true;
            if (coverOverlay) coverOverlay.style.display = "none";
            showFallbackOffer();
          }, ZOKO_NO_PLAY_AFTER_READY_MS);
        }
        
        if (spinner) spinner.style.pointerEvents = "none";
        if (overlay) overlay.hidden = true;
        // Report current fullscreen state to player
        sendPlayerCommand({ type: "fullscreen", active: !!document.fullscreenElement });
      }

      // Event: play
      if (data.type === "play") {
        if (!eventIsForCurrentLoad) return;
        markPlayerSettled();
        
        playbackEvidenceForLoad = true;
        if (zokoNoPlayTimer) { clearTimeout(zokoNoPlayTimer); zokoNoPlayTimer = null; }
        if (zokoNoPlaybackTimer) { clearTimeout(zokoNoPlaybackTimer); zokoNoPlaybackTimer = null; }
        isPaused = false;
        if (playPauseBtn) playPauseBtn.textContent = "❚❚";
        
        if (spinner) spinner.hidden = true;
        if (coverOverlay) coverOverlay.style.display = "none";
        
        if (Date.now() - lastZokoErrorAt > ZOKO_RECOVERY_GUARD_MS) {
          if (fallbackOfferVisible) hideFallbackNote();
          if (overlay && !overlay.hidden && lastZokoErrorAt > 0) overlay.hidden = true;
        }
        
        armResumeNoteAutoHide();
      }

      // Event: pause
      if (data.type === "pause") {
        if (!eventIsForCurrentLoad) return;
        isPaused = true;
        if (playPauseBtn) playPauseBtn.textContent = "▶";
      }

      // Event: state
      if (data.type === "state") {
        if (!eventIsForCurrentLoad) return;
        const pos = typeof data.position === "number" ? data.position
                  : typeof data.currentTime === "number" ? data.currentTime
                  : typeof data.time === "number" ? data.time
                  : null;
        if (pos != null) currentPosition = pos;
        if (typeof data.duration === "number" && data.duration > 0) {
          duration = data.duration;
          durationIsReal = true;
        }
        if (typeof data.paused === "boolean") {
          isPaused = data.paused;
          if (playPauseBtn) playPauseBtn.textContent = isPaused ? "▶" : "❚❚";
        }
        
      }

      if (data.type === "watching-log" || data.type === "time") {
        if (playerEp == null) return;
        const cur = typeof data.currentTime === "number" ? data.currentTime
                  : (typeof data.position === "number" ? data.position
                  : (typeof data.time === "number" ? data.time
                  : (typeof data.seconds === "number" ? data.seconds : 0)));
        const hasRealDuration = typeof data.duration === "number" && data.duration > 0;
        const dur = hasRealDuration ? data.duration : duration;
        const now = Date.now();

        if (currentUser && !isLive && cur > 0 && now - lastProgressSync > 5000) {
          lastProgressSync = now;
          api("/api/progress", {
            method: "POST",
            body: {
              slug: currentSlug,
              episode: playerEp,
              positionSec: Math.floor(cur),
              durationSec: Math.floor(dur),
            },
          });
        }
        if ((!currentUser || isLive) && cur > 0 && now - lastLocalSave > 5000) {
          lastLocalSave = now;
          writeLocalProgress(progressKey, playerEp, cur, dur);
        }

        if (playerEp !== currentEp) return;
        markPlayerSettled();
        currentPosition = cur;
        
        if (hasRealDuration) {
          duration = data.duration;
          durationIsReal = true;
        }

        if (cur > 0) {
          
          playbackEvidenceForLoad = true;
          if (zokoNoPlayTimer) { clearTimeout(zokoNoPlayTimer); zokoNoPlayTimer = null; }
          if (zokoNoPlaybackTimer) { clearTimeout(zokoNoPlaybackTimer); zokoNoPlaybackTimer = null; }
          if (spinner) spinner.hidden = true;
          if (coverOverlay) coverOverlay.style.display = "none";
          
          if (Date.now() - lastZokoErrorAt > ZOKO_RECOVERY_GUARD_MS) {
            if (fallbackOfferVisible) hideFallbackNote();
            if (overlay && !overlay.hidden && lastZokoErrorAt > 0) overlay.hidden = true;
          }
        }

        if (timeText) {
          timeText.textContent = `${formatTime(cur)} / ${durationIsReal && duration > 0 ? formatTime(duration) : "--:--"}`;
        }

        if (
          !resumeNoteShownForLoad &&
          resumeTimeForLoad === 0 &&
          !skippedThisLoad &&
          !seekCommandThisLoad &&
          cur > 30 &&
          now - loadStartedAt < 15000
        ) {
          showResumeNote(cur);
        }
        if (
          resumeNote &&
          !resumeNote.hidden &&
          resumeNoteShownForLoad &&
          !skippedThisLoad &&
          !seekCommandThisLoad &&
          now - loadStartedAt < 15000 &&
          Math.abs(cur - resumeTimeForLoad) >= 2
        ) {
          resumeTimeForLoad = Math.floor(cur);
          showResumeNote(cur);
        }
        if (cur > 0) armResumeNoteAutoHide();
      }

      if (data.type === "skipped") {
        if (!eventIsForCurrentLoad) return;
        skippedThisLoad = true;
        const segment = data.name === "outro" ? "outro" : "intro";
        showToast(`Skipped ${segment}`);
      }

      // Event: error
      if (data.type === "error") {
        markPlayerSettled();
        
        if (zokoNoPlayTimer) { clearTimeout(zokoNoPlayTimer); zokoNoPlayTimer = null; }
        if (zokoNoPlaybackTimer) { clearTimeout(zokoNoPlaybackTimer); zokoNoPlaybackTimer = null; }
        
        if (spinner) spinner.hidden = true;
        if (overlay) {
          overlay.hidden = false;
          if (overlayTitle) overlayTitle.textContent = "Stream error";
          if (overlayText) {
            if (data.reason === "sandboxed") {
              overlayText.textContent = "Player blocked: remove sandbox attribute from iframe.";
            } else {
              overlayText.textContent = data.message || data.reason || "The player could not load this stream.";
            }
          }
        }
        
        lastZokoErrorAt = Date.now();
        showFallbackOffer();
      }

      // Event: ended (auto-next is parent-driven)
      if (data.type === "ended") {
        if (!eventIsForCurrentLoad) return;
        markPlayerSettled();
        
        const decision = autoNextAction({
          server: "zoko",
          currentEp,
          totalEps: totalEpisodes(),
          autonext: playerSettings.autonext,
          continuation: titleContinuation(),
        });
        if (decision.action === "next") {
          showToast(`Episode finished! Auto-playing Episode ${decision.nextEp}...`);
          setTimeout(() => loadEpisode(decision.nextEp), 1500);
        } else if (decision.action === "continue") {
          showToast(`Part finished! Continuing to ${decision.name || "the next part"}...`);
          setTimeout(() => { window.location.href = `watch.html?live=${encodeURIComponent(decision.live)}&ep=1`; }, 1500);
        } else if (decision.action === "completed") {
          showToast("You finished this anime!");
        }
      }

      if (data.type === "fullscreen") {
        if (data.request === "enter" && !document.fullscreenElement) {
          toggleFullscreen();
        } else if (data.request === "exit" && document.fullscreenElement) {
          toggleFullscreen();
        }
      }
    });

    const containFocus = () => {
      
      if (activeServer !== "zoko" || !playerWrap) return;
      if (document.activeElement === iframe) {
        playerWrap.focus({ preventScroll: true });
      }
    };

    function bindIframeListeners() {
      if (!iframe) return;
      iframe.addEventListener("load", () => {
        
        if (activeServer === ANIMEGG_SERVER_ID) {
          markPlayerSettled();
          playerEp = currentEp;
          if (animeggFailTimer) { clearTimeout(animeggFailTimer); animeggFailTimer = null; }
          return;
        }
        if (activeServer !== "megaplay") return;
        megaPlayFrameLoaded = true;
        playerEp = currentEp;
      });
      iframe.addEventListener("focus", containFocus);
    }
    bindIframeListeners();
    if (playerWrap) playerWrap.setAttribute("tabindex", "-1");
    
    setInterval(containFocus, 100);

    window.addEventListener("keydown", (e) => {
      const tag = document.activeElement ? document.activeElement.tagName : "";
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (e.code === "KeyF") {
        e.preventDefault();
        toggleFullscreen();
        return;
      }
      
      if (activeServer !== "zoko") return;
      if (e.code === "Space") {
        e.preventDefault();
        sendPlayerCommand({ type: isPaused ? "play" : "pause" });
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        const target = Math.max(0, currentPosition - 10);
        sendPlayerCommand({ type: "seek", time: target });
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        const target = Math.min(duration, currentPosition + 10);
        sendPlayerCommand({ type: "seek", time: target });
      }
      
    });

    // Fullscreenchange event: report state back to player
    document.addEventListener("fullscreenchange", () => {
      sendPlayerCommand({ type: "fullscreen", active: !!document.fullscreenElement });
      
      if (activeServer === "backup" && iframe && iframe.contentWindow) {
        try {
          iframe.contentWindow.postMessage(
            { source: "aniflick", type: "fullscreen", active: !!document.fullscreenElement },
            BACKUP_ORIGIN
          );
        } catch {}
      }
    });

    function updateWatchlistBtn(inList) {
      if (!wlBtn) return;
      wlBtn.setAttribute("data-active", inList ? "true" : "false");
      wlBtn.innerHTML = inList ? "✓ In My List" : "+ Add to List";
      wlBtn.style.color = inList ? "var(--zoro-lime)" : "#fff";
    }

    if (wlBtn) {
      wlBtn.addEventListener("click", async () => {
        
        if (isLive) {
          showToast("This title is not part of your library.", "!");
          return;
        }
        if (!currentUser) {
          openAuthModal("login");
          return;
        }
        const active = wlBtn.getAttribute("data-active") === "true";
        const res = await api(`/api/watchlist/${encodeURIComponent(currentSlug)}`, {
          method: active ? "DELETE" : "POST",
        });
        if (res.ok) {
          updateWatchlistBtn(!active);
          showToast(!active ? "Added to your Watchlist!" : "Removed from Watchlist.");
        } else {
          showToast("Could not update your list. Please try again.", "!");
        }
      });
    }

    async function startWatch() {
      
      if (isLive) {
        const loaded = await loadTitleData();
        if (!loaded) return;
        
        if (!(titleData && titleData.malId)) {
          const tvp = getBackupEmbedUrl(currentEp, 0, true);
          if (tvp) {
            activeServer = "backup";
            applyServerUI();
            showBackupNote("This title has no MAL id, so it streams on the TVplus player (Zoko has no AniList route).");
          }
        }
        await loadEpisode(currentEp, null);
        return;
      }
      
      const episodeDataPromise = fetchEpisodeData(currentEp);
      const loaded = await loadTitleData();
      if (!loaded) {
        episodeDataPromise.catch(() => {});
        return;
      }
      await loadEpisode(currentEp, episodeDataPromise);
    }

    (async () => {
      try {
        showPlaceholder("Loading episode…");
        
        applyServerUI();
        if (activeServer === "backup") {
          showBackupNote("TVplus player active — audio depends on the source file. Press Play inside the player.");
        }
        await startWatch();
      } catch (err) {
        console.error("Watch page init failed:", err);
        showPlaceholder("Could not load episode data");
        showDataError("Something went wrong while loading this episode.", () => startWatch());
      }
    })();

    /* Initialize comments for current episode */
    
    if (!isLive && currentSlug) initComments(currentSlug, currentEp);
    else {
      const discussion = document.getElementById("watch-discussion");
      if (discussion) discussion.hidden = true;
    }
  }

  async function initComments(slug, ep) {
    const list = document.getElementById("comments-list-container");
    const form = document.getElementById("zoro-comment-form");
    const input = document.getElementById("zoro-comment-input");
    const countEl = document.getElementById("comments-count-text");
    activeEpisode = ep;

    let loadedEpisode = null;

    async function loadComments(force = false) {
      if (!list) return;
      if (!force && loadedEpisode === activeEpisode) return;

      const res = await api(`/api/comments/${encodeURIComponent(slug)}/${activeEpisode}`);
      if (res.ok && res.data && res.data.comments) {
        const comments = res.data.comments;
        loadedEpisode = activeEpisode;
        if (countEl) countEl.textContent = `${comments.length} Comments`;
        if (comments.length === 0) {
          list.innerHTML = `<p class="comments-empty-msg">No comments on this episode yet. Be the first to start the discussion!</p>`;
          return;
        }
        list.textContent = "";
        for (const c of comments) list.appendChild(buildCommentNode(c));
      } else {
        if (countEl) countEl.textContent = "Comments unavailable";
        list.innerHTML = `
          <p class="comments-empty-msg">
            Comments could not be loaded.
            <button class="btn-zoro-primary btn-comments-retry" type="button" id="comments-retry-btn">Retry</button>
          </p>`;
        const retryBtn = list.querySelector("#comments-retry-btn");
        if (retryBtn) retryBtn.addEventListener("click", () => loadComments(true));
      }
    }

    if (form && form.dataset.zoroCommentsBound !== "true") {
      form.dataset.zoroCommentsBound = "true";
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const text = input ? input.value.trim() : "";
        if (!text) return;

        const payload = { content: text };
        const nameInput = document.getElementById("zoro-comment-name");
        if (!currentUser) {
          const guestName = nameInput ? nameInput.value.trim() : "";
          if (!guestName) {
            showToast("Please enter a name to comment.", "!", 3000);
            if (nameInput) nameInput.focus();
            return;
          }
          payload.name = guestName;
        }

        const res = await api(`/api/comments/${encodeURIComponent(slug)}/${activeEpisode}`, {
          method: "POST",
          body: payload,
        });

        if (res.ok) {
          input.value = "";
          if (nameInput) nameInput.value = "";
          loadComments(true);
          showToast("Comment published!");
        } else {
          const msg = res.data && res.data.error && res.data.error.message;
          showToast(msg || "Could not post your comment.", "!", 4000);
        }
      });
    }

    const submitBtn = form ? form.querySelector('button[type="submit"]') : null;
    function applyCommentAuthState() {
      if (!form || !input) return;
      const signedIn = !!currentUser;
      const nameInput = document.getElementById("zoro-comment-name");
      if (nameInput) nameInput.hidden = signedIn;
      form.classList.toggle("is-guest", !signedIn);
      input.disabled = false;
      input.placeholder = "Join the discussion... Share your thoughts about this episode!";
      if (submitBtn) submitBtn.textContent = "Post Comment";
    }
    applyCommentAuthState();
    if (form && form.dataset.zoroCommentAuthBound !== "true") {
      form.dataset.zoroCommentAuthBound = "true";
      window.addEventListener("zoro:auth", applyCommentAuthState);
    }

    reloadComments = loadComments;
    loadComments();
  }

  async function initLiveDetail(liveId) {
    const loadingEl = document.getElementById("detail-loading");
    const errorEl = document.getElementById("detail-error");
    const contentEl = document.getElementById("detail-content");

    function showError(msg) {
      if (loadingEl) loadingEl.hidden = true;
      if (contentEl) contentEl.hidden = true;
      if (errorEl) {
        errorEl.hidden = false;
        const t = errorEl.querySelector(".detail-error-text");
        if (t) t.textContent = msg;
      }
      markContentReady();
    }

    const res = await api(`/api/live/${encodeURIComponent(liveId)}`);
    if (!res.ok || !res.data || !res.data.title) {
      showError(
        res.status === 404
          ? "This title is not available."
          : res.status === 502
          ? "Service is busy — try again in a moment."
          : "This title could not be loaded from the server."
      );
      return;
    }

    const t = res.data.title;
    const next = t.nextAiringEpisode || null;
    const isFilm = t.format === "MOVIE";
    
    const airedCount = next && next.episode
      ? Math.max(0, Number(next.episode) - 1)
      : (t.episodes != null ? Number(t.episodes) : 0);
    const episodesUnknown = t.episodes == null && !next;

    const backdrop = document.getElementById("detail-backdrop");
    if (backdrop) backdrop.style.backgroundImage = `url('${bannerOf(t)}')`;
    const cover = document.getElementById("detail-cover");
    if (cover) {
      cover.src = coverOf(t);
      cover.alt = t.name;
      
      cover.referrerPolicy = "no-referrer";
      cover.onerror = function () {
        cover.onerror = null;
        cover.src = LIVE_POSTER_FALLBACK;
      };
    }
    const titleEl = document.getElementById("detail-title");
    if (titleEl) titleEl.textContent = t.name;
    const altEl = document.getElementById("detail-alt-titles");
    if (altEl) {
      const parts = [];
      if (t.romajiTitle && t.romajiTitle !== t.name) parts.push(t.romajiTitle);
      if (t.nativeTitle) parts.push(t.nativeTitle);
      altEl.textContent = parts.join("  •  ");
      altEl.hidden = parts.length === 0;
    }

    const badges = document.getElementById("detail-badges");
    if (badges) {
      badges.innerHTML = `
        ${subCount(t) ? `<span class="badge badge-sub">SUB ${subCount(t)}</span>` : ""}
        ${t.is18plus ? `<span class="badge badge-18plus">18+</span>` : ""}
        <span class="badge badge-type">${escapeHtml(liveFormatLabel(t))}</span>
        <span class="badge badge-hd">HD</span>
        ${scoreLabel(t) ? `<span class="badge badge-score">★ ${scoreLabel(t)}</span>` : ""}
      `;
    }
    const trackLabel = document.getElementById("detail-track-label");
    
    if (trackLabel) trackLabel.textContent = "SUB";

    const meta = document.getElementById("detail-meta");
    if (meta) {
      const aired = liveAiredRange(t.startDate, t.endDate);
      const season = liveSeasonLabel(t.season);
      meta.innerHTML = `
        <span><strong>Year:</strong> ${t.year || "—"}</span>
        <span><strong>Aired:</strong> ${escapeHtml(aired || "—")}</span>
        ${season ? `<span><strong>Season:</strong> ${escapeHtml(season)}</span>` : ""}
        <span><strong>Status:</strong> ${escapeHtml(liveStatusLabel(t))}</span>
        <span><strong>Episodes:</strong> ${t.episodes != null ? t.episodes : (airedCount || "—")}</span>
        <span><strong>Format:</strong> ${escapeHtml(liveFormatLabel(t))}</span>
        <span><strong>Studios:</strong> ${escapeHtml((t.studios || []).join(", ") || "—")}</span>
        <span><strong>Duration:</strong> ${t.runtimeMin ? t.runtimeMin + "m" : "—"}</span>
        ${next ? `<span><strong>Next episode:</strong> Ep ${next.episode} on ${escapeHtml(formatAiringDate(next.airingAt))}</span>` : ""}
      `;
    }
    const genresEl = document.getElementById("detail-genres");
    if (genresEl) {
      genresEl.innerHTML = (t.genres || [])
        .map((g) => `<a class="genre-chip-zoro" href="browse.html?genre=${encodeURIComponent(g)}">${escapeHtml(genreLabel(g))}</a>`)
        .join("");
      
      const tagChips = (t.tags || [])
        .filter((tag) => tag && tag.name)
        .map((tag) => `<a class="genre-chip-zoro" href="browse.html?tags=${encodeURIComponent(tag.name)}">${escapeHtml(tag.name)}</a>`)
        .join("");
      if (tagChips) genresEl.innerHTML += tagChips;
    }
    const syn = document.getElementById("detail-synopsis");
    if (syn) syn.textContent = t.synopsis || "";
    const watchNow = document.getElementById("detail-watch-now");
    if (watchNow) {
      
      const hasEpisodes = subCount(t) != null || airedCount > 0;
      if (hasEpisodes) {
        watchNow.href = liveWatchHref(t, 1);
        watchNow.hidden = false;
      } else {
        watchNow.hidden = true;
        watchNow.removeAttribute("href");
      }
    }
    document.title = `${t.name} - AniFlick`;

    const listBtn = document.getElementById("detail-add-list");
    if (listBtn) listBtn.hidden = true;

    if (titleNeedsReminder(t.status)) {
      wireDetailRemindButton(document.getElementById("detail-remind"), `live-${liveId}`, t.name);
    }

    /* Episode list: only the AIRED episodes. */
    const epList = document.getElementById("detail-episode-list");
    if (epList) {
      if (episodesUnknown) {
        epList.innerHTML = `<p class="ep-empty-msg">Episode list unavailable for this title.</p>`;
      } else if (!airedCount) {
        epList.innerHTML = `<p class="ep-empty-msg">No episodes have aired yet${next ? ` — Ep ${next.episode} airs on ${escapeHtml(formatAiringDate(next.airingAt))}.` : "."}</p>`;
      } else {
        const rows = [];
        for (let n = 1; n <= airedCount; n++) {
          const padded = String(n).padStart(3, "0");
          rows.push(`
            <a class="detail-episode-row" href="${liveWatchHref(t, n)}">
              <span class="detail-episode-num">${padded}</span>
              <span class="detail-episode-title">Episode ${n}</span>
              <span class="detail-episode-duration">${t.runtimeMin ? t.runtimeMin + "m" : "—"}</span>
              <span class="detail-episode-play">▶</span>
            </a>`);
        }
        epList.innerHTML = rows.join("");
      }
      epList.classList.toggle("single-episode", airedCount === 1);
    }

    const castSection = document.getElementById("detail-cast-section");
    const castGrid = document.getElementById("detail-cast-grid");
    const cast = liveCharacters(t.characters);
    if (castSection && castGrid) {
      if (cast.length) {
        castGrid.innerHTML = cast.map((c) => `
          <div class="live-cast-card">
            <img src="${escapeHtml(c.image || LIVE_POSTER_FALLBACK)}" alt="${escapeHtml(c.name || "")}" loading="lazy" decoding="async" ${livePosterAttrs()}>
            <div>
              <div class="live-cast-name">${escapeHtml(c.name || "")}</div>
              <div class="live-cast-va">${c.voiceActor && c.voiceActor.name ? `<strong>VA:</strong> ${escapeHtml(c.voiceActor.name)}` : ""}</div>
            </div>
          </div>`).join("");
        castSection.hidden = false;
      } else {
        castSection.hidden = true;
      }
    }

    const relationCard = (r) => {
      const href = r.anilistId != null
        ? `detail.html?live=${encodeURIComponent(r.anilistId)}`
        : "browse.html";
      return `
        <a class="live-relation-card" href="${href}">
          <img src="${escapeHtml(r.cover || LIVE_POSTER_FALLBACK)}" alt="${escapeHtml(r.name || "")}" loading="lazy" decoding="async" ${livePosterAttrs()}>
          <div class="live-relation-name">${escapeHtml(r.name || "")}</div>
          <div class="live-relation-type">${escapeHtml(liveRelationLabel(r.relationType))}</div>
        </a>`;
    };

    const moreSeasonsSection = document.getElementById("detail-more-seasons-section");
    const moreSeasonsGrid = document.getElementById("detail-more-seasons-grid");
    const moreSeasons = liveMoreSeasons(t.relations);
    if (moreSeasonsSection && moreSeasonsGrid) {
      if (moreSeasons.length) {
        moreSeasonsGrid.innerHTML = moreSeasons.map(relationCard).join("");
        moreSeasonsSection.hidden = false;
      } else {
        moreSeasonsSection.hidden = true;
      }
    }

    const relatedSection = document.getElementById("detail-related-section");
    const relatedGrid = document.getElementById("detail-related-grid");
    const related = liveRelatedAnime(t.relations);
    if (relatedSection && relatedGrid) {
      if (related.length) {
        relatedGrid.innerHTML = related.map(relationCard).join("");
        relatedSection.hidden = false;
      } else {
        relatedSection.hidden = true;
      }
    }

    fillRecommendations(t.recommendations);

    if (loadingEl) loadingEl.hidden = true;
    if (errorEl) errorEl.hidden = true;
    if (contentEl) contentEl.hidden = false;
    markContentReady();
  }

  async function initDetailPage() {
    const stage = document.getElementById("detail-stage");
    if (!stage) return;

    const params = new URLSearchParams(window.location.search);

    const liveParam = params.get("live");
    if (liveParam) {
      const liveId = parseInt(liveParam, 10);
      if (!Number.isFinite(liveId) || liveId <= 0) {
        const errorEl = document.getElementById("detail-error");
        const loadingEl = document.getElementById("detail-loading");
        const contentEl = document.getElementById("detail-content");
        if (loadingEl) loadingEl.hidden = true;
        if (contentEl) contentEl.hidden = true;
        if (errorEl) {
          errorEl.hidden = false;
          const t = errorEl.querySelector(".detail-error-text");
          if (t) t.textContent = "This title is not available.";
        }
        markContentReady();
        return;
      }
      await initLiveDetail(liveId);
      return;
    }

    const rawId = (params.get("slug") || params.get("id") || "").trim();
    const loadingEl = document.getElementById("detail-loading");
    const errorEl = document.getElementById("detail-error");
    const contentEl = document.getElementById("detail-content");

    function showError(msg) {
      if (loadingEl) loadingEl.hidden = true;
      if (contentEl) contentEl.hidden = true;
      if (errorEl) {
        errorEl.hidden = false;
        const t = errorEl.querySelector(".detail-error-text");
        if (t) t.textContent = msg;
      }
    }

    if (!rawId) {
      showError("No title specified. Browse the catalog to pick an anime.");
      return;
    }

    const compactKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    let targetSlug = rawId;
    let res = await api(`/api/titles/${encodeURIComponent(rawId)}`);
    if (!res.ok && res.status === 404) {
      const aliasRes = await api(`/api/titles?limit=100`);
      if (aliasRes.ok && aliasRes.data && Array.isArray(aliasRes.data.titles)) {
        const needle = compactKey(rawId);
        const matched = aliasRes.data.titles.find((t) =>
          [t.slug, t.name, t.realTitle, t.romajiTitle].some((v) => compactKey(v) === needle)
        );
        if (matched) {
          targetSlug = matched.slug;
          res = await api(`/api/titles/${encodeURIComponent(targetSlug)}`);
        }
      }
    }
    if (!res.ok || !res.data || !res.data.title) {
      showError(
        res.status === 404
          ? `We couldn't find a title for "${rawId}". Browse the catalog to pick an anime.`
          : "This title could not be loaded from the server."
      );
      return;
    }
    
    // links, watchlist calls) — never the raw ?id= value.
    const slug = targetSlug;
    const t = res.data.title;
    const episodes = Array.isArray(res.data.episodes) ? res.data.episodes : [];
    const userState = res.data.userState;
    const epCount = t.episodes || episodes.length || 0;

    // Hero backdrop + cover (local art primary).
    const backdrop = document.getElementById("detail-backdrop");
    if (backdrop) backdrop.style.backgroundImage = `url('${bannerOf(t)}')`;
    const cover = document.getElementById("detail-cover");
    if (cover) {
      cover.src = coverOf(t);
      cover.alt = t.name;
    }
    const titleEl = document.getElementById("detail-title");
    if (titleEl) titleEl.textContent = t.name;
    const altEl = document.getElementById("detail-alt-titles");
    if (altEl) {
      const parts = [];
      if (t.romajiTitle && t.romajiTitle !== t.name) parts.push(t.romajiTitle);
      if (t.nativeTitle) parts.push(t.nativeTitle);
      altEl.textContent = parts.join("  •  ");
      altEl.hidden = parts.length === 0;
    }

    // dub -> no DUB badge at all.
    const badges = document.getElementById("detail-badges");
    if (badges) {
      badges.innerHTML = `
        <span class="badge badge-sub">SUB ${epCount || 1}</span>
        ${t.dubCount > 0 ? `<span class="badge badge-dub">DUB ${t.dubCount}</span>` : ""}
        <span class="badge badge-type">${t.kind}</span>
        <span class="badge badge-hd">HD</span>
        ${scoreLabel(t) ? `<span class="badge badge-score">★ ${scoreLabel(t)}</span>` : ""}
      `;
    }
    const detailTrackLabel = document.getElementById("detail-track-label");
    if (detailTrackLabel) detailTrackLabel.textContent = t.dubCount > 0 ? "SUB / DUB" : "SUB";
    const meta = document.getElementById("detail-meta");
    if (meta) {
      meta.innerHTML = `
        <span><strong>Year:</strong> ${t.year || "—"}</span>
        <span><strong>Status:</strong> ${statusLabel(t.status)}</span>
        <span><strong>Episodes:</strong> ${epCount}</span>
        <span><strong>Studios:</strong> ${escapeHtml(t.studios || t.studio || "—")}</span>
        <span><strong>Duration:</strong> ${t.runtimeMin ? t.runtimeMin + "m" : "—"}</span>
      `;
    }
    const genresEl = document.getElementById("detail-genres");
    if (genresEl) {
      genresEl.innerHTML = (t.genres || [])
        .map((g) => `<a class="genre-chip-zoro" href="browse.html?genre=${encodeURIComponent(g)}">${escapeHtml(genreLabel(g))}</a>`)
        .join("");
    }
    const syn = document.getElementById("detail-synopsis");
    if (syn) syn.textContent = t.synopsis || t.tagline || "";
    const watchNow = document.getElementById("detail-watch-now");
    if (watchNow) watchNow.href = watchHref(slug, 1);
    document.title = `${t.name} - AniFlick`;

    const listBtn = document.getElementById("detail-add-list");
    function setListBtn(inList) {
      if (!listBtn) return;
      listBtn.dataset.active = inList ? "true" : "false";
      listBtn.textContent = inList ? "✓ In My List" : "+ Add to My List";
      listBtn.style.color = inList ? "var(--zoro-lime)" : "";
    }
    setListBtn(userState ? userState.inWatchlist : false);
    if (listBtn) {
      listBtn.addEventListener("click", async () => {
        if (!currentUser) {
          openAuthModal("login");
          return;
        }
        const active = listBtn.dataset.active === "true";
        const r = await api(`/api/watchlist/${encodeURIComponent(slug)}`, {
          method: active ? "DELETE" : "POST",
        });
        if (r.ok) {
          setListBtn(!active);
          showToast(!active ? "Added to your Watchlist!" : "Removed from Watchlist.");
        } else {
          showToast("Could not update your list. Please try again.", "!");
        }
      });
    }
    window.addEventListener("zoro:auth", async () => {
      const r = await api(`/api/titles/${encodeURIComponent(slug)}`);
      setListBtn(r.ok && r.data && r.data.userState ? r.data.userState.inWatchlist : false);
    });

    if (titleNeedsReminder(t.status)) {
      wireDetailRemindButton(document.getElementById("detail-remind"), slug, t.name);
    }

    const epList = document.getElementById("detail-episode-list");
    if (epList) {
      if (!episodes.length) {
        epList.innerHTML = `<p class="ep-empty-msg">No episodes available for this title.</p>`;
      } else {
        epList.innerHTML = episodes
          .map((e) => {
            const n = e.ep_num;
            const padded = String(n).padStart(3, "0");
            return `
              <a class="detail-episode-row" href="${watchHref(slug, n)}">
                <span class="detail-episode-num">${padded}</span>
                <span class="detail-episode-title">${escapeHtml(e.title || `Episode ${n}`)}</span>
                <span class="detail-episode-duration">${t.runtimeMin ? t.runtimeMin + "m" : "—"}</span>
                <span class="detail-episode-play">▶</span>
              </a>
            `;
          })
          .join("");
      }
      
      epList.classList.toggle("single-episode", episodes.length === 1);
    }

    // page also use.
    const recWrap = document.getElementById("detail-recommendations");
    if (recWrap) {
      const allRes = await api("/api/titles?limit=100");
      if (allRes.ok && allRes.data && Array.isArray(allRes.data.titles)) {
        fillRecommendations(sameGenreRecommendations(allRes.data.titles, slug, t.genres));
      } else {
        fillRecommendations([]);
      }
    }

    if (loadingEl) loadingEl.hidden = true;
    if (errorEl) errorEl.hidden = true;
    if (contentEl) contentEl.hidden = false;
    markContentReady();
  }

  const SCHEDULE_DATA = {
    monday: [
      { time: "20:30", slug: "moonlit-ramen" },
      { time: "22:00", slug: "cobalt-season" },
      { time: "23:45", slug: "deep-frame" },
    ],
    tuesday: [
      { time: "21:00", slug: "sakura-static" },
      { time: "23:15", slug: "ghost-line-9" },
    ],
    wednesday: [
      { time: "20:45", slug: "kagerou-protocol" },
      { time: "22:00", slug: "the-last-train-to-aomori" },
      { time: "23:30", slug: "iron-bloom" },
    ],
    thursday: [
      { time: "21:00", slug: "sea-of-stars" },
      { time: "22:30", slug: "zero-gravity-club" },
    ],
    friday: [
      { time: "20:00", slug: "ronin-of-the-neon-ward" },
      { time: "22:45", slug: "salt-and-cinder" },
    ],
    saturday: [
      { time: "19:30", slug: "the-fox-who-counted-rain" },
      { time: "21:15", slug: "second-wind" },
      { time: "23:00", slug: "corner-store-hours" },
    ],
    sunday: [
      { time: "18:30", slug: "paper-cranes-at-dawn" },
      { time: "20:30", slug: "encore-one-more" },
      { time: "22:15", slug: "the-quiet-ward" },
    ],
  };

  async function initSchedulePage() {
    const timelineEl = document.getElementById("schedule-timeline-container");
    if (!timelineEl) return;

    const titleMap = {};
    try {
      const tRes = await fetchTitles(18);
      if (tRes.ok && tRes.data && Array.isArray(tRes.data.titles)) {
        for (const t of tRes.data.titles) titleMap[t.slug] = t;
      }
    } catch {}

    // Live Tokyo Clock
    const clockEl = document.getElementById("live-jst-clock");
    if (clockEl) {
      function updateJstClock() {
        const now = new Date();
        const jstString = now.toLocaleTimeString("en-US", {
          timeZone: "Asia/Tokyo",
          hour12: false,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        clockEl.textContent = `${jstString} JST`;
      }
      updateJstClock();
      setInterval(updateJstClock, 1000);
    }

    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const nowLocal = new Date();
    const currentDayName = dayNames[nowLocal.getDay()];

    function activeDayKey() {
      const active = document.querySelector(".schedule-day-tab.active");
      return (active && active.dataset.day) || currentDayName;
    }
    function renderReminders() {
      const box = document.getElementById("schedule-reminders");
      if (!box) return;
      const list = readReminders();
      if (!list.length) { box.innerHTML = ""; box.hidden = true; return; }
      
      const slotBySlug = {};
      for (const [day, slots] of Object.entries(SCHEDULE_DATA)) {
        for (const s of slots) slotBySlug[s.slug] = { day, time: s.time };
      }
      const rows = list.map((r) => {
        const s = slotBySlug[r.slug];
        const when = s
          ? `${s.day.charAt(0).toUpperCase() + s.day.slice(1)} ${escapeHtml(s.time)} JST`
          : "Not scheduled this week";
        return `<div class="reminder-row">
          <span class="reminder-name">${escapeHtml(r.name)}</span>
          <span class="reminder-when">${when}</span>
          <a class="btn-zoro-primary reminder-watch" href="${reminderWatchHref(r.slug)}">Watch</a>
          <button class="reminder-remove" type="button" data-slug="${escapeHtml(r.slug)}" aria-label="Remove reminder for ${escapeHtml(r.name)}">✕</button>
        </div>`;
      }).join("");
      box.innerHTML = `<h3 class="surface-title">Your Reminders</h3><div class="reminder-list">${rows}</div>`;
      box.hidden = false;
      box.querySelectorAll(".reminder-remove").forEach((btn) => {
        btn.addEventListener("click", () => {
          writeReminders(readReminders().filter((r) => r.slug !== btn.dataset.slug));
          renderReminders();
          renderScheduleForDay(activeDayKey()); // refresh the slot buttons
          showToast("Reminder removed");
        });
      });
    }
    renderReminders();

    function renderScheduleForDay(dayKey) {
      const slots = SCHEDULE_DATA[dayKey] || [];
      if (!Object.keys(titleMap).length) {
        timelineEl.innerHTML = `<p class="schedule-empty-msg">Schedule is temporarily unavailable — the catalog could not be loaded.</p>`;
        return;
      }
      
      const items = slots
        .map((slot) => ({ slot, real: titleMap[slot.slug] }))
        .filter((x) => x.real && x.real.name);
      if (!items.length) {
        timelineEl.innerHTML = `<p class="schedule-empty-msg">No scheduled releases for this day.</p>`;
        return;
      }

      timelineEl.innerHTML = items.map(({ slot, real }) => {
        const isFilm = (real.kind || "").toLowerCase() === "film";
        const epCount = real.episodes || 1;
        
        const watchEp = isFilm ? 1 : epCount;
        const name = real.name;
        const cover = coverOf(real);
        const studio = real.studio || real.studios || "—";
        const dHref = detailHref(real.slug);
        const wHref = watchHref(real.slug, watchEp);
        const watchLabel = isFilm ? "▶ Watch Film" : `▶ Watch Ep ${watchEp}`;
        return `
        <div class="schedule-item-card">
          <div class="schedule-item-left">
            <div class="schedule-slot-time">${slot.time}</div>
            <a class="schedule-thumb" href="${dHref}">
              <img src="${escapeHtml(cover)}" alt="${escapeHtml(name)}" loading="lazy" ${livePosterAttrs()}>
            </a>
            <div class="schedule-title-block">
              <a class="schedule-title-link" href="${dHref}">${escapeHtml(name)}</a>
              <div class="schedule-meta-badges">
                ${subBadge(real)}
                ${dubBadge(real)}
                <span class="schedule-studio-meta">• ${escapeHtml(studio)}</span>
              </div>
            </div>
          </div>
          <div class="schedule-item-right">
            <button class="btn-remind-slot${isReminded(slot.slug) ? " is-set" : ""}" type="button" data-slug="${escapeHtml(slot.slug)}" data-title="${escapeHtml(name)}">
              ${isReminded(slot.slug) ? "✓ Alert Set" : `${BELL_SVG} Remind Me`}
            </button>
            <a class="btn-zoro-primary btn-schedule-watch" href="${wHref}">
              ${watchLabel}
            </a>
          </div>
        </div>
      `;
      }).join("");

      timelineEl.querySelectorAll(".btn-remind-slot").forEach((btn) => {
        btn.addEventListener("click", () => {
          const slug = btn.dataset.slug;
          const t = btn.dataset.title;
          const added = toggleReminder(slug, t);
          if (added) {
            btn.classList.add("is-set");
            btn.innerHTML = `✓ Alert Set`;
            showToast(`Reminder saved for ${t} — see Your Reminders above.`);
          } else {
            btn.classList.remove("is-set");
            btn.innerHTML = `${BELL_SVG} Remind Me`;
            showToast(`Reminder removed for ${t}`);
          }
          renderReminders();
        });
      });
    }

    // Day tabs
    const dayTabs = document.querySelectorAll(".schedule-day-tab");
    
    const weekMonday = new Date(nowLocal);
    weekMonday.setDate(nowLocal.getDate() - ((nowLocal.getDay() + 6) % 7));
    dayTabs.forEach((tab, i) => {
      const d = new Date(weekMonday);
      d.setDate(weekMonday.getDate() + i);
      const dateEl = tab.querySelector(".tab-day-date");
      if (dateEl) dateEl.textContent = String(d.getDate());
    });
    dayTabs.forEach((tab) => {
      const tabDay = tab.dataset.day;
      if (tabDay === currentDayName) {
        tab.classList.add("is-today");
      }
      tab.addEventListener("click", () => {
        dayTabs.forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        renderScheduleForDay(tabDay);
      });
    });

    const todayTab = document.querySelector(`.schedule-day-tab[data-day="${currentDayName}"]`) || dayTabs[0];
    if (todayTab) {
      dayTabs.forEach((t) => t.classList.remove("active"));
      todayTab.classList.add("active");
      renderScheduleForDay(todayTab.dataset.day);
    }

    markContentReady();
  }

  if (document.body) initAizenIntro();

  document.addEventListener("DOMContentLoaded", () => {
    initThemeToggle();
    initMobileDrawer();
    initSearch();

    initSchedulePage();

    const authReady = checkAuthSession();
    initSpotlightSlider();
    initHomeCatalogColumns();
    initTopTenTabs();
    initMainCatalogGrid();
    initLiveRails();
    initGenresPage();
    initWatchPage();
    initDetailPage();
    initAzList();

    authReady.then(() => initContinueWatchingRail());

    const hasDynamicContent = !!(
      document.getElementById("zoro-main-grid") ||
      document.getElementById("spotlight-slider-container") ||
      document.getElementById("schedule-timeline-container") ||
      document.getElementById("zoro-video-stage") ||
      document.getElementById("detail-stage") ||
      document.getElementById("az-grid")
    );
    if (!hasDynamicContent) markContentReady();

    // Replay intro button if exists
    const replayBtn = document.getElementById("btn-replay-intro");
    if (replayBtn) replayBtn.addEventListener("click", () => initAizenIntro(true));

    // Random anime button
    const randomBtn = document.getElementById("btn-random-anime");
    if (randomBtn) {
      randomBtn.addEventListener("click", async () => {
        const res = await api("/api/titles?limit=50");
        if (res.ok && res.data && res.data.titles.length > 0) {
          const rand = res.data.titles[Math.floor(Math.random() * res.data.titles.length)];
          window.location.href = detailHref(rand.slug);
        }
      });
    }

    const backTop = document.createElement("button");
    backTop.type = "button";
    backTop.className = "back-to-top";
    backTop.setAttribute("aria-label", "Back to top");
    backTop.textContent = "↑";
    document.body.appendChild(backTop);
    const toggleBackTop = () => backTop.classList.toggle("is-visible", window.scrollY > 400);
    window.addEventListener("scroll", toggleBackTop, { passive: true });
    toggleBackTop();
    backTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

    document.querySelectorAll(".js-footer-year").forEach((el) => {
      el.textContent = String(new Date().getFullYear());
    });

    // Header scroll background toggle
    const header = document.querySelector(".zoro-header");
    if (header) {
      window.addEventListener("scroll", () => {
        header.classList.toggle("scrolled", window.scrollY > 30);
      });
    }
  });
})();
