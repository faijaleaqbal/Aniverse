(function () {
  "use strict";

  /* ==========================================================================
     DEVTOOLS BLOCKING (user request, 2026-11-28: DevTools must not open)
     Layer 1: block the keyboard shortcuts + the right-click menu.
     Layer 2: detect a DevTools panel opened via the browser menu and blank
     the page. Runs on every page — this script is included site-wide.
     Normal keys (letters, Enter, Space, arrows, Escape) and normal clicks
     are never touched, so playback, search, filters and login keep working.
     ========================================================================== */

  /* Layer 1a — block DevTools keyboard shortcuts. Capture phase so the
     event is stopped before any other handler sees it. */
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

  /* Layer 1b — block the right-click context menu site-wide, so "Inspect"
     cannot be reached from it. */
  document.addEventListener("contextmenu", (e) => e.preventDefault(), true);

  /* Layer 2 — detect a DevTools panel opened via the browser menu (which
     keyboard/contextmenu blocking cannot stop). A docked DevTools panel
     makes window.outerWidth/outerHeight much larger than the inner size;
     normal browser chrome stays well under the threshold. Two consecutive
     detections are required so a transient resize cannot blank the page.
     The interval is cleared before blanking, so there is no reload loop. */
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


  /* ==========================================================================
     API HELPER & STATE
     ========================================================================== */

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
  /* The API serves comment names/bodies HTML-escaped. Decode the FIVE entities
     the server can emit (in this order, &amp; last) before handing the text to
     textContent — the browser never parses it as markup. */
  function decodeHtml(value) {
    if (value == null) return "";
    return String(value)
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
  }

  /* One comment row, built with DOM APIs ONLY: the name and body are assigned
     via textContent, never innerHTML, so a stored payload can never become
     markup. Lives in this marked block so the tests can render a comment
     against a minimal fake DOM and prove no SCRIPT/IMG element is produced. */
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
  /* Auto-next decision — ONE pure function for every player that reports an
     end-of-episode event (Zoko `ended`, MegaPlay `complete`). The TVplus
     backup and the animegg embed emit no such event, so they never reach
     here. totalEps is the title's real count (the AIRED count for a live
     title); 0 = unknown, and an unknown count must NEVER invent a next
     episode. `continuation` (optional) is a split-cour follow-on
     ({ live, name }): when the last episode of THIS title ends and a
     continuation exists, the decision is "continue" into the follow-on
     title instead of "completed" (Spy x Family Part 1 -> Cour 2). */
  function autoNextAction({ server, currentEp, totalEps, autonext, continuation }) {
    if (server === "backup") return { action: "none" };
    if (server === "animegg") return { action: "none" };
    if (!autonext) return { action: "none" };
    const total = Number(totalEps) || 0;
    const current = Number(currentEp) || 0;
    if (total <= 0) return { action: "none" };
    if (current >= total) {
      /* Split-cour title: the story continues under a DIFFERENT title id,
         so the last episode continues there instead of ending. */
      if (continuation && continuation.live) {
        return { action: "continue", live: continuation.live, name: continuation.name || "" };
      }
      return { action: "completed" };
    }
    return { action: "next", nextEp: current + 1 };
  }
  /* __AUTONEXT_LOGIC_END__ */

  /* ---- Real metadata helpers (Phase 1) ----
     Local cover art is the primary image; the remote URL is only a fallback.
     Title cards/links navigate to the detail page; explicit "Watch"/"Resume"
     actions go straight to the watch page. */
  /* __POSTER_LOGIC_START__ */
  const COVER_FALLBACK = "img/banner.jpg";
  /* AniList's CDN (s4.anilist.co) answers cross-site hotlinked <img> requests
     with 403 when a Referer is sent, so live posters are loaded with
     referrerpolicy="no-referrer". The onerror fallback guarantees a failed
     poster degrades to the local placeholder instead of a broken-image card. */
  const LIVE_POSTER_FALLBACK = "img/banner.jpg";

  /* A catalog title's OWN shipped artwork (img/covers/<slug>.jpg and
     img/banners/<slug>.jpg are real files in the site bundle). A catalog row
     can reach the API with NO cover metadata at all — a fresh seed, or a
     deployment where the metadata fetch never ran — and when every card fell
     back to the ONE shared placeholder, a whole rail rendered the same
     poster for ten different titles. This per-title path is truthful (it is
     that title's real art) and distinct per title. Used ONLY when the API
     gave no artwork at all, so an enriched row behaves exactly as before. */
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
    return `referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='${LIVE_POSTER_FALLBACK}';"`;
  }

  function bannerOf(t) {
    if (!t) return COVER_FALLBACK;
    const known = t.banner || t.bannerLocal || t.cover || t.coverLocal;
    return known || localAssetFor(t, "banners") || COVER_FALLBACK;
  }
  /* __POSTER_LOGIC_END__ */
  /* Truncate at a WORD boundary. The hero's CSS 3-line clamp alone sliced
     mid-word ("romantic lov…") — pre-trimming the synopsis means the clamp
     never has to cut a word. */
  function truncateWords(text, max = 200) {
    const t = String(text || "").trim();
    if (t.length <= max) return t;
    const cut = t.slice(0, max);
    const lastSpace = cut.lastIndexOf(" ");
    const base = lastSpace > 40 ? cut.slice(0, lastSpace) : cut;
    return base.replace(/[\s.,;:!?-]+$/, "") + "…";
  }

  /* ONE badge format on every card: "SUB N" (the title's episode count) and
     "DUB N" (the probe-backed dub count, only when one really exists).
     Pure live titles have no dub probe data, so they NEVER get a DUB badge;
     a live title that IS a catalog twin carries its catalog dubCount from
     the server, so its card agrees with the spotlight/detail cards.
     A badge is NEVER rendered without a count: when the episode count is
     unknown the badge is hidden instead of showing a bare "SUB". */
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
  /* A comma-separated ?tags= list -> array, trimmed, de-duplicated. Kept
     case-sensitive (AniList tags are); the server canonicalises the known
     ones, so the panel can send the display spelling. */
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

  /* Every API call is bounded: a stalled connection must never freeze a page
     on fallback content. GETs are retried once (bodyless = safe to repeat). */
  const API_TIMEOUT_MS = 10000;

  /* Requests that the inline head script already started. Reusing them removes
     a full round trip from the critical path (the API call no longer waits for
     the app script to download). */
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

    /* A request that was already issued by the inline prefetch is adopted
       instead of being sent a second time. */
    const store = prefetchStore();
    if (!options.body && store && store[path]) {
      const pending = store[path];
      delete store[path];
      const pre = await pending;
      if (pre && pre.ok) return pre;
      /* A failed prefetch falls through to the normal path below. */
    }

    /* Per-call timeout override: some routes are legitimately slow on a cold
       lookup (the animegg probe can take 15–25s while Anivexa resolves the
       title). Default stays 10s for everything else. */
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

  /* In-flight request coalescing: several sections ask for the same catalog
     slice at once, so they share one network round trip instead of three. */
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

  /* ==========================================================================
     LIVE CATALOG (AniList) HELPERS
     The browser NEVER calls AniList — it goes through the server endpoints
     (/api/search, /api/browse, /api/live/:id, /api/airing), which enforce
     the content rules and add the is18plus flag.
     ========================================================================== */

  const LIVE_BUSY_MESSAGE = "Service is busy — try again in a moment.";
  const LIVE_LIBRARY_MESSAGE = "Showing your library — live catalog is busy.";
  const LIVE_PAGE_SIZE = 12;

  /* AniList's genre list — the browse filters speak these names. */
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
    /* Phase 2: full-filter browse sorts. az/name both mean TITLE_ROMAJI. */
    az: "Name A-Z",
    name: "Name A-Z",
    episodes: "Most Episodes",
    updated: "Recently Updated",
    favourites: "Most Favourited",
  };

  /* Phase 2 curated tag list for the browse filter panel. These are real
     AniList TAGS (case-sensitive upstream; canonicalTag maps them). No
     age-rating or SUB/DUB tag exists here — AniList has no such data. */
  const BROWSE_TAGS = [
    "Isekai", "CGDCT", "Mahou Shoujo", "Mecha", "Sports", "Supernatural",
    "Thriller", "Vampire", "Military", "Parody", "Space", "Josei",
    "Seinen", "Shounen", "Shoujo", "Time Travel", "Super Power",
    "Strategy Game", "Team Sports", "Urban Fantasy",
  ];

  /* ==========================================================================
     BROWSE YEAR RANGE
     AniList caps a single query's TOTAL at 5,000 titles, so unfiltered Browse
     can only ever show the first ~5,000 of ~20,000 anime. A single year is
     always far below that cap (hundreds at most), which is what makes the
     whole library reachable through its year. The range therefore starts at
     1960 — anime's TV era, and where AniList's own catalog begins — and runs
     through NEXT year (AniList carries upcoming seasonYear ahead of release).
     No per-year counts are fetched; the chips are navigation only.
     Pure helpers, no DOM: server/test/e2e.js extracts this marked block and
     evaluates it directly to test the shipped range.
     ========================================================================== */
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

  /* The local catalog's genre names mapped onto AniList's spelling — the
     genres page and the detail pages link with the local names. */
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

  /* A live title that IS one of the 18 curated catalog titles links to the
     CATALOG detail page (it has the full data: dub badges, episode titles).
     Everything else opens the live detail view. */
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

  /* Live titles have NO dub data (no dub_checks rows) — never show a DUB
     badge or count for them. The 18+ badge comes from the server's
     is18plus flag (Ecchi genre) and nothing else. */
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

  /* ========================================================================
     REMINDERS — real, persisted, this-device only (fix #9, 23 Nov audit).
     Shared by the schedule page AND the detail pages (live-browser defect
     #2, 23 Nov: detail pages had no Remind Me button at all). A reminder is
     a {slug, name} in localStorage; the schedule page lists reminded titles
     with their weekly airing time in the "Your Reminders" section. There is
     NO push/browser notification (no service worker) — the copy promises
     none. Live titles key by "live-<anilistId>" (they have no catalog slug);
     their Watch link goes to watch.html?live=<id>&ep=1.
     ======================================================================== */
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
  /* Toggle: returns true when the reminder was ADDED, false when removed. */
  function toggleReminder(slug, name) {
    const list = readReminders();
    const i = list.findIndex((r) => r.slug === slug);
    if (i >= 0) { list.splice(i, 1); writeReminders(list); return false; }
    list.push({ slug, name });
    writeReminders(list);
    return true;
  }
  /* Watch link for a reminder key: live keys ("live-<anilistId>") go to the
     live watch URL, catalog slugs to the slug watch URL. */
  function reminderWatchHref(key) {
    if (typeof key === "string" && key.startsWith("live-")) {
      const id = key.slice("live-".length);
      return `watch.html?live=${encodeURIComponent(id)}&ep=1`;
    }
    return watchHref(key, 1);
  }
  /* Only titles with something still to air get a reminder: airing or
     upcoming. Finished/cancelled titles have nothing to remind about. */
  function titleNeedsReminder(status) {
    return status === "RELEASING" || status === "NOT_YET_RELEASED";
  }
  /* Wire the detail-page Remind Me button (shared by catalog + live detail
     pages): shows it, paints the current state, toggles on click. The
     button starts `hidden` in the markup and stays hidden for finished
     titles — the caller decides whether to call this at all. */
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

  /* "2 hours ago" / "3 days ago" for the Latest Episodes rail. */
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

  /* ---- "More Like This" (ONE renderer for the catalog AND live detail pages) ----
     A recommendation is a poster card with a link and the SUB/DUB/18+ badges,
     whichever side of the catalog it came from. The section hides itself
     when there is nothing to show — an empty "More Like This" is noise. */
  function renderRecommendationCard(o) {
    if (!o) return "";
    const isCatalog = !!o.slug;
    const href = isCatalog ? detailHref(o.slug) : liveDetailHref(o);
    const cover = coverOf(o);
    const typeLabel = isCatalog ? (o.kind || "Series") : liveFormatLabel(o);
    /* A live recommendation carries no start date in the detail payload, so
       its year is unknown — show the type alone rather than an invented "—". */
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

  /* Catalog "More Like This" — up to 6 same-genre catalog titles. ONE helper
     shared by the catalog detail page and the watch page, so both rails pick
     the same titles in the same order. Live titles use AniList's own
     recommendation edges (already in the /api/live payload), never this. */
  function sameGenreRecommendations(titles, currentSlug, genres) {
    const myGenres = new Set((genres || []).map((g) => String(g).toLowerCase()));
    return (Array.isArray(titles) ? titles : [])
      .filter((o) => o && o.slug && o.slug !== currentSlug && !o.isAdult)
      .map((o) => ({ o, shared: (o.genres || []).filter((g) => myGenres.has(String(g).toLowerCase())).length }))
      .filter((x) => x.shared > 0)
      .sort((a, b) => b.shared - a.shared || (b.o.score || 0) - (a.o.score || 0))
      .map((x) => x.o);
  }

  /* One live card — same markup/style as the catalog cards. */
  function renderLiveCard(t, opts = {}) {
    if (!t) return "";
    /* Catalog rows (the DUBBED shelf) carry a slug + kind instead of an
       AniList id + format. Same card, but the link must open the catalog
       detail page and the type label reads the catalog's own kind. */
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
            <span>${escapeHtml(typeLabel)}</span> • <span>${escapeHtml(String(year))}</span>${score ? ` • <span style="color: var(--zoro-lime);">★ ${score}</span>` : ""}
          </div>
          ${opts.submeta ? `<div class="zoro-card-submeta live-ep-time">${opts.submeta}</div>` : ""}
        </div>
      </div>
    `;
  }

  /* One row in the search dropdown — works for catalog titles and live
     AniList titles alike. */
  function searchRowHtml(t, href) {
    const isLive = !!(t && t.live);
    const meta = isLive
      ? `<span>${escapeHtml(liveFormatLabel(t))}</span> • <span>${escapeHtml(String(t.year || "—"))}</span> • <span style="color: var(--zoro-sub);">${t.episodes != null ? `EP ${t.episodes}` : "ONGOING"}</span>`
      : `<span>${t.year || 2025}</span> • <span>${t.kind || "Series"}</span>${subCount(t) ? ` • <span style="color: var(--zoro-sub);">SUB ${subCount(t)}</span>` : ""}`;
    return `
      <a class="search-result-item" href="${href}">
        <img class="search-result-thumb" src="${escapeHtml(coverOf(t))}" alt="${escapeHtml(t.name)}" loading="lazy" ${livePosterAttrs()}>
        <div class="search-result-info">
          <div class="search-result-title">${escapeHtml(t.name)}${t && t.is18plus ? ' <span class="badge-mini-18">18+</span>' : ""}</div>
          <div class="search-result-meta">${meta}</div>
        </div>
      </a>`;
  }

  /* The busy / library-fallback notice above a grid. */
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

  /* ==========================================================================
     1. AIZEN CINEMATIC SHUTTER INTRO
     ========================================================================== */

  /* The intro is a flourish, never a gate: as soon as the real content is on
     screen it steps aside instead of holding the page for its full runtime. */
  let contentReadyDispatched = false;

  function markContentReady() {
    if (contentReadyDispatched) return;
    contentReadyDispatched = true;
    window.dispatchEvent(new CustomEvent("zoro:contentReady"));
  }

  function initAizenIntro(force = false) {
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
          <span style="color: rgba(255,255,255,0.4); font-size: 0.65rem;">ZORO UI × AIZEN CINEMATIC ENGINE</span>
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
      /* The shutter transition runs for 0.6s - remove the overlay after it. */
      setTimeout(() => overlay.remove(), 650);
    }

    /* Real content is ready -> let it through (after a short minimum so the
       intro still reads as an intro). */
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
      /* Wall-clock cap: a throttled background tab must not keep the intro
         (and the page behind it) waiting for the next tick. */
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

  /* ==========================================================================
     TOAST NOTIFICATIONS
     ========================================================================== */

  function showToast(message, icon = "✓", duration = 2000) {
    let container = document.querySelector(".aizen-toast-container");
    if (!container) {
      container = document.createElement("div");
      container.className = "aizen-toast-container";
      document.body.appendChild(container);
    }

    const toast = document.createElement("div");
    toast.className = "aizen-toast";
    /* Escape both slots: callers pass user display names and AniList
       titles, so raw interpolation is an XSS sink (audit M-3). */
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

  /* Server-switch cleanup: transient player toasts ("TVplus player ready —
     press Play inside the player", skip notices, ...) belong to the player
     that was just torn down. Left alone they linger over the NEXT server's
     UI, which is exactly the stray-toast report. */
  function clearPlayerToasts() {
    document.querySelectorAll(".aizen-toast-container, #zoro-toasts").forEach((c) => {
      c.innerHTML = "";
    });
  }

  /* ==========================================================================
     LIGHT / DARK THEME (Phase 3b)
     ========================================================================== */

  const LS_THEME_KEY = "av_theme";

  function currentTheme() {
    return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    const btn = document.getElementById("btn-theme-toggle");
    if (btn) btn.setAttribute("aria-pressed", theme === "light" ? "true" : "false");
  }

  /* The palette itself lives in zoro-aizen.css ([data-theme="light"]); this
     only owns the attribute and the persisted choice. An inline head script
     already set the attribute before first paint, so there is no flash. */
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

  /* ==========================================================================
     MOBILE DRAWER NAVIGATION
     ========================================================================== */

  function initMobileDrawer() {
    const toggleBtns = document.querySelectorAll(".menu-toggle-btn");
    if (!toggleBtns.length) return;

    let backdrop = document.querySelector(".mobile-nav-backdrop");
    /* Single open/close path: the body class lifts the site header (and its
       hamburger toggle) ABOVE the backdrop while the drawer is open, so the
       toggle itself stays clickable and closes the drawer. Without it the
       280px drawer slides over the hamburger and its brand link hijacks the
       click (navigating to index.html instead of closing). */
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
            <a class="zoro-brand" href="index.html">
              <img class="zoro-brand-icon" src="/img/aniflick-icon.png" alt="">
              <span>Ani<span class="verse">Flick</span></span>
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
          </nav>
        </div>
      `;
      document.body.appendChild(backdrop);

      const closeBtn = backdrop.querySelector(".mobile-drawer-close");
      if (closeBtn) closeBtn.addEventListener("click", () => setDrawer(false));
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) setDrawer(false);
      });
      /* Escape closes the drawer (it used to do nothing). */
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && backdrop.classList.contains("is-open")) {
          setDrawer(false);
        }
      });
    }

    toggleBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        /* Toggle: clicking the hamburger again closes the drawer. */
        setDrawer(!backdrop.classList.contains("is-open"));
      });
    });
  }

  /* ==========================================================================
     2. AUTH MODAL & NAVBAR USER PILL
     ========================================================================== */

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
        <div id="modal-error-msg" style="display: none; padding: 8px 12px; margin-bottom: 12px; background: rgba(255,80,80,0.15); border: 1px solid #ff5050; border-radius: 6px; font-size: 0.8rem; color: #ff8080;"></div>
        <form id="zoro-auth-form">
          <div class="input-field-group" id="group-auth-name" style="display: none;">
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
          <button class="btn-zoro-primary" id="btn-auth-submit" type="submit" style="width: 100%; justify-content: center; margin-top: 1rem; padding: 0.75rem;">Sign In</button>
        </form>
        <div id="zoro-forgot-view" style="display: none;">
          <h3 style="margin: 0 0 0.5rem; font-size: 1.1rem;">Reset your password</h3>
          <p style="margin: 0 0 1.25rem; color: var(--text-sub); font-size: 0.9rem; line-height: 1.5;">Enter the email address for your account and we'll send you a link to set a new password.</p>
          <div id="forgot-msg" style="display: none; padding: 8px 12px; margin-bottom: 12px; background: rgba(202,233,98,0.12); border: 1px solid #cae962; border-radius: 6px; font-size: 0.8rem; color: #d9f99d;"></div>
          <form id="zoro-forgot-form">
            <div class="input-field-group">
              <label for="forgot-email">Email Address</label>
              <input id="forgot-email" name="email" type="email" placeholder="Your email address" required>
            </div>
            <button class="btn-zoro-primary" id="btn-forgot-submit" type="submit" style="width: 100%; justify-content: center; margin-top: 1rem; padding: 0.75rem;">Send reset link</button>
          </form>
          <button class="forgot-password-link" id="btn-forgot-back" type="button" style="margin-top: 1rem;">&larr; Back to sign in</button>
        </div>
        <div id="zoro-social-block" style="display: none;">
          <div class="social-login-divider"><span>or continue with</span></div>
          <div id="zoro-social-logins" class="social-login-list"></div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    /* Social logins (Google / Discord / MAL / AniList): the server says
       which providers are configured — unconfigured providers never render
       a button. Fetched once per page load; the modal reuses the result. */
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

    /* Forgot password: the modal swaps the sign-in form for a small email
       form. The server answers the SAME generic message whether or not the
       email is registered, and the modal shows exactly that message — never
       a hint about whether the account exists. */
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
      /* The server's message is the same for every email — show it
         verbatim. A 429 (too many requests) shows the rate-limit message
         instead, in the red style. */
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
    renderAuthModal();
    const modal = document.querySelector(".aizen-modal-backdrop");
    if (modal) {
      modal.classList.add("is-active");
      const tabBtn = modal.querySelector(`.modal-tab-btn[data-tab="${tab}"]`);
      if (tabBtn) tabBtn.click();
    }
  }

  /* Social-login buttons for the auth modal. The list comes from the
     server (GET /api/auth/providers) and is cached for the page's life —
     a provider with no credentials configured simply has no button. Each
     button is a plain link to /auth/<provider> (full navigation, as OAuth
     requires); `next` returns the user to the page they signed in from. */
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
          <span class="user-caret" style="color: var(--text-muted); font-size: 0.7rem; margin-left: 4px;">▼</span>
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
      slot.innerHTML = `
        <button class="btn-zoro-primary" id="btn-open-signin" type="button">Sign In</button>
      `;
      slot.querySelector("#btn-open-signin").addEventListener("click", () => openAuthModal("login"));
    }
  }

  async function checkAuthSession() {
    renderAuthModal();
    const res = await api("/api/auth/me");
    if (res.ok && res.data && res.data.user) {
      currentUser = res.data.user;
    } else {
      currentUser = null;
    }
    updateHeaderUser();
  }

  /* ==========================================================================
     3. ZORO AUTOCOMPLETE SEARCH
     ========================================================================== */

  function initSearch() {
    const input = document.getElementById("zoro-search-input");
    const dropdown = document.getElementById("zoro-search-dropdown");
    if (!input || !dropdown) return;

    let debounceTimer = null;
    let searchToken = 0;

    input.addEventListener("input", () => {
      const q = input.value.trim();
      clearTimeout(debounceTimer);

      /* The header search ONLY drives the suggestion dropdown. It must never
         live-filter a page content grid (typing "Naruto" on Home used to shrink
         the Latest Episodes grid to one card). Filtering happens on submit:
         Enter navigates to browse.html?q=… (or applies the query there). */

      if (!q) {
        dropdown.classList.remove("is-open");
        dropdown.innerHTML = "";
        return;
      }

      /* Minimum 2 characters — a single letter matches thousands of titles
         and burns the AniList rate limit for nothing. */
      if (q.length < 2) {
        dropdown.innerHTML = `<div style="padding: 12px; font-size: 0.8rem; color: var(--text-muted); text-align: center;">Type at least 2 characters</div>`;
        dropdown.classList.add("is-open");
        return;
      }

      dropdown.innerHTML = `<div style="padding: 12px; font-size: 0.8rem; color: var(--text-muted); text-align: center;">Searching…</div>`;
      dropdown.classList.add("is-open");

      const token = ++searchToken;
      debounceTimer = setTimeout(async () => {
        const res = await api(`/api/search?q=${encodeURIComponent(q)}&page=1`);
        /* A newer keystroke won the race — this answer is stale. */
        if (token !== searchToken) return;

        const local = (res.ok && res.data && Array.isArray(res.data.local)) ? res.data.local : [];
        const more = (res.ok && res.data && Array.isArray(res.data.results)) ? res.data.results : [];

        if (!res.ok) {
          /* AniList is down: the LOCAL catalog still searches. */
          const localRes = await api(`/api/titles?q=${encodeURIComponent(q)}&limit=6`);
          if (token !== searchToken) return;
          const localTitles = (localRes.ok && localRes.data && Array.isArray(localRes.data.titles))
            ? localRes.data.titles : [];
          dropdown.innerHTML = localTitles.length
            ? `<div style="padding: 6px 12px; font-size: 0.7rem; color: var(--zoro-dub);">${escapeHtml(LIVE_BUSY_MESSAGE)}</div>` +
              localTitles.map((t) => searchRowHtml(t, detailHref(t.slug))).join("")
            : `<div style="padding: 12px; font-size: 0.8rem; color: var(--text-muted); text-align: center;">${escapeHtml(LIVE_BUSY_MESSAGE)}</div>`;
          dropdown.classList.add("is-open");
          return;
        }

        if (!local.length && !more.length) {
          dropdown.innerHTML = `<div style="padding: 12px; font-size: 0.8rem; color: var(--text-muted); text-align: center;">No anime found for "${escapeHtml(q)}"</div>`;
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

    // Submit on Enter, close on Escape (the dropdown used to survive Escape
    // and only closed on navigation).
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitSearch();
      } else if (e.key === "Escape") {
        dropdown.classList.remove("is-open");
        dropdown.innerHTML = "";
        input.value = "";
        input.blur();
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

  /* ==========================================================================
     4. ZORO SPOTLIGHT HERO CAROUSEL WITH AIZEN TRANSITION
     ========================================================================== */

  async function initSpotlightSlider() {
    const sliderContainer = document.getElementById("spotlight-slider-container");
    if (!sliderContainer) return;

    let currentSlide = 0;
    let rendered = false;
    const pendingDirs = [];
    let autoInterval = null;
    let drainTimer = null;

    /* Backdrops are multi-hundred-KB images: only pull the one on screen.
       The rest are fetched when their slide becomes active. */
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

    /* Auto rotate every 6s. ANY manual navigation must clear AND restart the
       timer — a click landing just before a scheduled tick used to advance
       two slides at once (only mouseleave reset the interval before). */
    function startAutoRotate() {
      if (autoInterval) clearInterval(autoInterval);
      autoInterval = setInterval(() => goToSlide(currentSlide + 1), 6000);
    }
    function manualGoTo(n) {
      goToSlide(n);
      startAutoRotate();
    }

    /* Arrow handlers bind IMMEDIATELY — before the catalog fetch. Clicks that
       arrive before the dynamic slides render (a window of seconds on slow
       connections) are queued and replayed one step at a time, so rapid input
       is never swallowed. There is NO transition lock: every click advances
       exactly one slide, whenever it lands. */
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
      /* Keep the static fallback slide; the arrows work on whatever exists. */
      rendered = true;
      applyBackdrop(sliderContainer.querySelector(".spotlight-slide"));
      startAutoRotate();
      if (pendingDirs.length) drainTimer = setTimeout(drainPending, 150);
      return;
    }

    /* Every catalog title gets a spotlight slide with the SAME probe-backed
       SUB/DUB badges as the detail page and cards (DUB hidden at 0). The
       static JJK fallback is patched probe-backed by index.html's inline
       prefetch for the pre-render window. */
    const titles = res.data.titles;

    sliderContainer.innerHTML = titles
      .map((t, idx) => `
        <div class="spotlight-slide ${idx === 0 ? "is-active" : ""}" data-index="${idx}" data-poster="${bannerOf(t)}">
          <div class="spotlight-backdrop"></div>
          <div class="spotlight-overlay"></div>
          <div class="spotlight-content">
            <span class="spotlight-rank">🔥 #${idx + 1} Spotlight</span>
            <h1 class="spotlight-title"><a href="${detailHref(t.slug)}" style="color:inherit;text-decoration:none;">${escapeHtml(t.name)}</a></h1>
            <div class="spotlight-badges">
              ${subCount(t) ? `<span class="badge badge-sub">SUB ${subCount(t)}</span>` : ""}
              ${t.dubCount > 0 ? `<span class="badge badge-dub">DUB ${t.dubCount}</span>` : ""}
              <span class="badge badge-type">${t.kind}</span>
              <span class="badge badge-hd">HD</span>
              <span style="font-size: 0.8rem; color: var(--text-sub); margin-left: 6px;">${t.year} • ${t.runtimeMin}m</span>
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
    /* Replay any clicks that landed before the slides existed — one step each. */
    if (pendingDirs.length) drainTimer = setTimeout(drainPending, 150);
  }

  /* ==========================================================================
     4.5 CONTINUE WATCHING RAIL (SERVER-BACKED)
     ========================================================================== */

  async function initContinueWatchingRail() {
    const section = document.getElementById("continue-watching-section");
    if (!section) return;
    const row = document.getElementById("continue-watching-row");
    if (!row) return;

    // If user is logged out, keep section hidden
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
          // Resume keeps going straight to the saved episode (correct behaviour).
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
                <div class="zoro-card-submeta" style="margin-bottom: 6px;">
                  <span>Episode ${epNum}</span> • <span>${pct}%</span>
                </div>
                <div class="progress-track-zoro" style="height: 4px; margin-bottom: 8px;" title="${timeLabel} (${pct}%)">
                  <div class="progress-fill-zoro" style="width: ${pct}%;"></div>
                </div>
                <a class="btn-zoro-primary" href="${resumeHref}" style="width: 100%; justify-content: center; padding: 0.45rem 0.8rem; font-size: 0.8rem; margin-top: auto; text-decoration: none;">
                  ▶ Resume
                </a>
              </div>
            </div>
          `;
        })
        .join("");

      section.hidden = false;
      section.style.display = "";
    } catch (err) {
      console.error("Failed to load continue watching rail:", err);
      section.hidden = true;
      section.style.display = "none";
    }
  }

  // Refresh Continue Watching rail when auth state changes (login / logout)
  window.addEventListener("zoro:auth", () => {
    initContinueWatchingRail();
  });

  /* ==========================================================================
     5. HOME 4-COLUMN SECTIONS (curated catalog)
     ========================================================================== */

  async function initHomeCatalogColumns() {
    const airingList = document.getElementById("col-airing-list");
    const popularList = document.getElementById("col-popular-list");
    const favoriteList = document.getElementById("col-favorite-list");
    const completedList = document.getElementById("col-completed-list");

    /* First paint: skeleton placeholders hold the column layout while the
       catalog API answers — never empty dark boxes (Bug 9). */
    for (const list of [airingList, popularList, favoriteList, completedList]) {
      if (list && !list.querySelector(".col-item")) {
        list.innerHTML = Array.from({ length: 5 }, () => `
          <div class="col-item col-item-skeleton" aria-hidden="true">
            <div class="col-thumb skeleton-shimmer"></div>
            <div class="col-item-details">
              <div class="skeleton-line skeleton-shimmer" style="width: 90%;"></div>
              <div class="skeleton-line skeleton-shimmer" style="width: 55%;"></div>
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

  /* ==========================================================================
     5B. HOME TOP 10 TABS (live AniList)
     One rail, three honest tabs — Trending / Most Popular / Top Rated.
     AniList has NO historical trending window, so the tabs are named after
     what the sort actually is (never "Today / This Week / This Month").
     Data comes from /api/browse with perPage=10, the same endpoint Browse
     uses — the numbered cards are the site's real top ten.
     ========================================================================== */

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

    /* The rail scroll arrows behave exactly like the old trending rail:
       whole-card jumps, flush at the end. */
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
              <div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 2px;">
                ${subCount(t) ? `<span style="color: var(--zoro-sub);">SUB ${subCount(t)}</span>` : ""}<span>${t.year}</span>
              </div>
            </div>
          </div>
        </a>
      `).join("");
      markContentReady();
    }

    await load();
  }

  /* ==========================================================================
     6. MAIN ANIME CARD GRID & AIZEN HOVER TOOLTIPS
     ========================================================================== */

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

  // Dismiss preview on click outside, mouse movement over empty space, or scroll (Bug 1)
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

    /* Browse is now the FULL live catalog (AniList, ~20k titles). The home
       page keeps its curated local grid untouched. */
    if (isBrowse) {
      initLiveBrowse();
      return;
    }

    /* First paint must never be a blank dark grid: skeleton cards hold the
       layout until the catalog API answers (~1s), then real posters replace
       them. Above-the-fold posters load eagerly (see renderCards). */
    if (!grid.querySelector(".zoro-card")) {
      grid.innerHTML = Array.from({ length: 12 }, () => `
        <div class="zoro-card zoro-card-skeleton" aria-hidden="true">
          <div class="zoro-card-poster skeleton-shimmer"></div>
          <div class="zoro-card-info">
            <div class="skeleton-line skeleton-shimmer" style="width: 85%;"></div>
            <div class="skeleton-line skeleton-shimmer" style="width: 55%;"></div>
          </div>
        </div>
      `).join("");
    }

    /* URL state is read BEFORE any await so the sort dropdown, heading and
       nav highlight never flash the wrong default (the sort select used to
       show "Popularity" for a full fetch round-trip before correcting to
       "Release date" on ?sort=newest). */
    const urlParams = new URLSearchParams(window.location.search);
    const initialGenre = urlParams.get("genre");
    const initialQ = urlParams.get("q");
    const initialSort = urlParams.get("sort");
    const initialKind = (urlParams.get("kind") || "").toLowerCase();
    /* Top Airing is a VIEW, not a sort: ?view=top-airing keeps the heading
       and nav highlight on "Top Airing" no matter which sort the viewer
       picks. Plain Browse sorted by Release date stays "Explore Anime
       Shelf" (the old sort-keyed heading renamed the page on every sort). */
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

    /* Browse page modes: search results (?q=), Movies (?kind=film), Top
       Airing (?view=top-airing) or the plain shelf. Heading AND header nav
       highlight follow the mode — never the sort order. */
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
      /* A genre filter names the shelf and shows the result count, like
         search does ("Action (7 titles)") — in every non-search mode. */
      const genreFiltered = currentGenre && currentGenre !== "all";
      if (mode === "search") {
        const countPart = count == null ? "" : ` (${count} ${count === 1 ? "result" : "results"})`;
        /* One outer span = one flex item: .section-title is display:flex
           with a gap, so bare text nodes + the accent span became separate
           flex items and the gap rendered as stray spaces inside the
           quotes ("Results for ' Naruto '"). */
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
    /* Set heading + nav synchronously (count lands with the first render). */
    updateHeading(null);

    /* Genre chips are rendered from GET /api/genres so EVERY genre that has
       titles gets a working chip. The pills persist across searches — they
       are never collapsed down to just "All". */
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

      // 1. Filter by search query — REAL titles only (english/romaji/native).
      // The fictional placeholder name (oldTitle) must not match: searching
      // "Ronin" used to surface One Piece. Synopsis/genres are not titles.
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

      // 4. Sort by popularity, release date, or A-Z
      if (currentSort === "newest") {
        list.sort((a, b) => (b.year || 0) - (a.year || 0) || (b.created_at || 0) - (a.created_at || 0));
      } else if (currentSort === "az") {
        list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      } else if (currentSort === "popularity") {
        // default catalog order (popularity)
      }

      return list;
    }

    /* Client-side pagination: Browse shows 12 titles per page; the controls
       render only when the filtered list spans MORE than one page. Home
       keeps its full "Latest Episodes" shelf (no pagination). */
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
        /* Tight layout: the empty state sits naturally above the footer
           instead of leaving the full-grid bottom padding as a dead gap. */
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
        /* Home's "Latest Episodes" shelf jumps STRAIGHT into the latest
           episode (watch.html?slug=X&ep=N); Browse cards keep opening the
           detail page. */
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
      /* The card grid is the page's real content: release the intro. */
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

    // Pagination controls (delegated; re-rendered on every page change)
    if (paginationWrap) {
      paginationWrap.addEventListener("click", (e) => {
        const btn = e.target.closest(".page-btn");
        if (!btn || btn.disabled) return;
        const p = Number(btn.dataset.page);
        if (!Number.isFinite(p) || p === currentPage) return;
        currentPage = p;
        renderCards(filteredList());
        /* Bring the grid top back into view (below the sticky header). */
        const top = grid.getBoundingClientRect().top + window.scrollY - 90;
        window.scrollTo({ top: Math.max(0, top), behavior: "instant" });
      });
    }

    // Hook up live search on Browse ONLY. On Home the same grid exists, but
    // the header search must never filter it (it only suggests + navigates).
    if (isBrowse) {
      window.__onSearchLiveFilter = (q) => {
        currentSearch = (q || "").trim();
        applyFilterAndSort();
      };
    }
  }

  /* ==========================================================================
     BROWSE TOTAL / PAGINATION LABEL LOGIC
     Pure helpers shared by updateHeading() and renderPagination(). A filtered
     browse below AniList's 5,000-title cap has a REAL total and a REAL last
     page, so it must show exact numbers (a single year is always in this
     regime). Only a capped total keeps the "5,000+" / "Page X of Y+" floor
     treatment. No DOM: server/test/e2e.js extracts this marked block to test
     the shipped logic against sample years.
     ========================================================================== */
  /* __BROWSE_LABEL_LOGIC_START__ */
  const ANILIST_TOTAL_CAP = 5000;

  function browseCountLabel(pageInfo, count, searchMode) {
    const rawTotal = pageInfo && Number.isFinite(Number(pageInfo.total)) ? Number(pageInfo.total) : null;
    if (rawTotal == null) {
      return count != null && searchMode ? `${count} ${count === 1 ? "title" : "titles"}` : "";
    }
    /* AniList caps the reported total at 5,000 — say "5,000+" rather than
       pretending that is the exact number. */
    return rawTotal >= ANILIST_TOTAL_CAP
      ? `5,000+ ${rawTotal === 1 ? "title" : "titles"}`
      : `${rawTotal.toLocaleString()} ${rawTotal === 1 ? "title" : "titles"}`;
  }

  /* True only for a CAPPED FILTERED browse — the one view whose end AniList
     will not reveal. A year view (or any filtered view under the cap) knows
     its own last page, exactly like unfiltered Browse. */
  function browsePaginationBounds(hasFilter, pageInfo, current) {
    const bounded = !!(hasFilter && pageInfo && Number(pageInfo.total) >= ANILIST_TOTAL_CAP);
    const last = bounded
      ? (pageInfo.hasNextPage ? current + 1 : current)
      : ((pageInfo && Number(pageInfo.lastPage)) || current);
    return { bounded, last };
  }
  /* __BROWSE_LABEL_LOGIC_END__ */

  /* ==========================================================================
     6C. LIVE BROWSE — the full AniList catalog on browse.html
     One grid, two modes:
       - search  (?q=…): "On AniFlick" (the curated catalog) first, then
                         "More results" (the live catalog).
       - browse  (no q): the live catalog with genre / format / status /
                         sort / year filters and AniList pagination.
     If AniList is down, the page falls back to the local library with a
     notice — it never shows an empty grid or a stack trace.
     ========================================================================== */

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
    /* Top Airing and Top Upcoming are VIEWS with a fixed status preset (a
       view's status comes from the URL only as an override; the preset wins
       so ?view=top-upcoming can never silently mean "finished"). */
    const viewIsTopAiring = view === "top-airing";
    const viewIsTopUpcoming = view === "top-upcoming";
    /* Phase 3a browse presets. subbed = the whole catalog (every title plays
       SUB); dubbed = only catalog titles with a VERIFIED dub (the server
       reads dub_checks, so live titles never appear here); the type views are
       format presets. `kind=film` is the old Movies link and still works. */
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
      /* Phase 2 filters. minScore is the AniList 0-100 floor; maxScore the
         ceiling. startAfter/startBefore are YYYY (or YYYY-MM / YYYY-MM-DD)
         and reach AniList as startDate_greater / startDate_lesser. */
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

    /* ---- skeleton (never an empty dark grid, and never a stale one) ---- */
    function renderGridSkeleton() {
      grid.innerHTML = Array.from({ length: LIVE_PAGE_SIZE }, () => `
        <div class="zoro-card zoro-card-skeleton" aria-hidden="true">
          <div class="zoro-card-poster skeleton-shimmer"></div>
          <div class="zoro-card-info">
            <div class="skeleton-line skeleton-shimmer" style="width: 85%;"></div>
            <div class="skeleton-line skeleton-shimmer" style="width: 55%;"></div>
          </div>
        </div>`).join("");
    }
    renderGridSkeleton();

    /* ---- genre chips (the FULL AniList genre list) ----
       The server's /api/genres answers with AniList's own GenreCollection
       (cached 24 h). The hardcoded 17 stay as the immediate paint and as the
       fallback, so the chips never regress and never wait on the network. */
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

    /* ---- year select (the full library range) ---- */
    function renderYears() {
      if (!yearSelect) return;
      let html = `<option value="">All years</option>`;
      for (const y of browseYearRange()) {
        html += `<option value="${y}">${y}</option>`;
      }
      yearSelect.innerHTML = html;
      yearSelect.value = state.year || "";
    }

    /* ---- Phase 2 full filters ----
       The panel is populated from the SAME year range as the year dropdown
       (start/end year are date-range bounds, not the seasonYear filter) and
       the curated AniList tag list. Every control writes state and the URL on
       Apply, so a filtered view is shareable and survives a reload. */
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

    /* The panel is open when it carries any filter (so a shared filtered URL
       never hides its own controls), and starts closed otherwise. */
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

    /* ---- "Browse by Year" chips, grouped by decade ----
       AniList caps a single query's total at 5,000 titles, so unfiltered
       Browse cannot reach the whole catalog. A single YEAR is always far
       below the cap, which makes every title reachable through its year.
       Chips are navigation only: no per-year counts are fetched (that would
       mean ~65 AniList calls and would trip the rate limit). */
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

    /* The dropdown and the chips are two views of ONE filter: they must never
       disagree about which year is active. */
    function syncYearUI() {
      if (yearSelect) yearSelect.value = state.year || "";
      if (yearDecadesWrap) {
        yearDecadesWrap.querySelectorAll(".browse-year-chip").forEach((chip) => {
          chip.classList.toggle("active", String(chip.dataset.year) === String(state.year || ""));
        });
      }
    }

    /* ---- URL sync (so the filters survive a reload / share) ---- */
    function updateUrl() {
      const p = new URLSearchParams();
      if (state.q) p.set("q", state.q);
      if (state.sort !== "trending") p.set("sort", state.sort);
      if (state.genre) p.set("genre", state.genre);
      if (state.format) p.set("format", state.format);
      if (state.status) p.set("status", state.status);
      if (state.year) p.set("year", state.year);
      /* Phase 2 filters: tags is a comma list, the rest single values. */
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

    /* ---- heading: active filter + result count ---- */
    function updateHeading(count, pageInfo) {
      if (!headingEl) return;
      /* The total comes from the server and is STABLE: the same number for
         every page of the same query. A filtered browse total below the
         5,000 cap is real and shown exactly; a capped total (>= 5,000) is
         shown as "5,000+". */
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
      /* Phase 2 filters read as human labels in the heading. */
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

    /* ---- the honest per-view note ----
       Subbed and Dubbed make claims about audio that the catalog has to back,
       so each says exactly what is true: every title streams with subtitles;
       dub availability is VERIFIED for catalog titles only (a live title has
       no dub data and is never listed as dubbed). */
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

    /* ---- pagination (AniList page numbers, windowed) ---- */
    function renderPagination(pageInfo) {
      if (!paginationWrap) return;
      const current = (pageInfo && Number(pageInfo.currentPage)) || state.page;
      const hasFilter = !!(state.genre || state.format || state.status || state.year || hasPhase2Filters());
      /* Only a CAPPED filtered browse has an unknown end. A search has a real
         lastPage (the snapshot is a fixed size), and any filtered browse below
         the 5,000 cap — a single year always — knows its own last page too. */
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
          html += `<span class="page-btn" style="border:none; background:none; cursor:default;">…</span>`;
        } else {
          html += `<button class="page-btn${p === current ? " active" : ""}" type="button" data-page="${p}"${p === current ? ' aria-current="page"' : ""}>${p}</button>`;
        }
      }
      html += `<button class="page-btn" type="button" data-page="${current + 1}"${current >= last ? " disabled" : ""} aria-label="Next page">Next ›</button>`;
      /* "Page X of Y" whenever the last page is really known. A bounded
         (filtered + capped) view still gets a label, but the "+" marks the
         last page as a FLOOR, not an exact count — AniList caps the total
         at 5,000, so the true end is at least pageInfo.lastPage. */
      if (bounded) {
        const lastFloor = (pageInfo && Number(pageInfo.lastPage)) || last;
        html += `<span class="page-btn" style="border:none; background:none; cursor:default;" aria-live="polite">Page ${current} of ${lastFloor}+</span>`;
      } else if (last > 1) {
        html += `<span class="page-btn" style="border:none; background:none; cursor:default;" aria-live="polite">Page ${current} of ${last}</span>`;
      }
      paginationWrap.innerHTML = html;
      paginationWrap.hidden = false;
    }

    /* ---- the local library fallback (AniList is down) ---- */
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
      /* Page/filter change: clear the stale grid IMMEDIATELY and hold the
         layout with skeletons. The old page-1 cards used to stay on screen
         for the whole network round trip, reading as "page 2 is broken". */
      renderGridSkeleton();
      updateHeading(null, null);
      let path;
      if (isSearch()) {
        path = `/api/search?q=${encodeURIComponent(state.q)}&page=${state.page}`;
      } else {
        const qs = new URLSearchParams();
        qs.set("sort", state.sort);
        /* The view preset must ride the request: ?view=dubbed is a DIFFERENT
           shelf (catalog titles with a verified dub), not a sorted AniList
           list. */
        if (view) qs.set("view", view);
        if (kind) qs.set("kind", kind);
        if (state.genre) qs.set("genre", state.genre);
        if (state.format) qs.set("format", state.format);
        if (state.status) qs.set("status", state.status);
        if (state.year) qs.set("year", state.year);
        /* Phase 2 filters ride the same /api/browse call. */
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
        /* 502 = AniList is busy / down → the local library keeps the page
           usable. Any other error → same graceful fallback. */
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
        /* The genre chip refines the live results client-side (the search
           endpoint itself is a pure SEARCH_MATCH query). */
        const filtered = state.genre
          ? more.filter((t) => (t.genres || []).some((g) => g.toLowerCase() === state.genre.toLowerCase()))
          : more;

        if (!local.length && !filtered.length) {
          renderEmptyState();
          updateHeading(0, pageInfo);
          return;
        }
        /* The group count reports the results on this page out of the
           server's STABLE total for the whole query (the snapshot is one
           immutable set, so the total never moves between pages). */
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
    /* A year chip does exactly what picking that year in the dropdown does:
       same state.year, same ?year= URL param, same /api/browse call. */
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

    /* Pagination (delegated; re-rendered on every page change). */
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
      /* Toggle a tag: the chip is a filter, not a single-select, so a tag can
         be added and removed without losing the others. */
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

    /* The header search drives this page live. */
    window.__onSearchLiveFilter = (q) => {
      state.q = (q || "").trim();
      state.page = 1;
      if (searchInput) searchInput.value = state.q;
      /* Search mode has no server-side sort/format/status/year filters —
         only the genre chip refines the results. */
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

  /* ==========================================================================
     PHASE 2 — LIVE DETAIL METADATA HELPERS
     Pure functions (no DOM) so server/test/e2e.js can extract and test the
     exact formatting the page renders: date ranges, season labels, relation
     grouping and section visibility.
     ========================================================================== */
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

  /* "Jan 7 – Mar 31, 2024"; "Jan 7, 2024 –" when the end date is unknown
     (an airing title); a single date when both ends match. */
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

  /* The top 6 characters, already sliced server-side. */
  function liveCharacters(characters) {
    return (Array.isArray(characters) ? characters : []).slice(0, 6);
  }
  /* __LIVE_DETAIL_LOGIC_END__ */

  /* ==========================================================================
     6E. A-Z LIST — az-list.html
     One letter = one immutable snapshot from /api/az (AniList has no prefix
     search, so the server filters a SEARCH_MATCH candidate pool by title
     prefix). "All" is the plain TITLE_ROMAJI browse. A snapshot that hit the
     server's fetch cap reports pageInfo.capped, and the total is a FLOOR —
     the heading shows "N+ titles" and never presents the partial set as the
     whole letter.
     ========================================================================== */

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
            <div class="skeleton-line skeleton-shimmer" style="width: 85%;"></div>
            <div class="skeleton-line skeleton-shimmer" style="width: 55%;"></div>
          </div>
        </div>`).join("");
    }

    /* The heading shows the letter and the REAL total. A capped snapshot
       reports a floor, so it gets a "+" (the same convention browse uses for
       its 5,000 cap). */
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

    /* Pagination: same windowed controls as browse. A letter's last page is
       always known (the snapshot is a fixed set), so no "+" floor mark here —
       the capped "+" belongs to the TOTAL only.

       The controls are rendered ONLY from data the server has confirmed:
       `pageInfo` is never invented, so a letter load never flashes a total
       the data has not backed (no placeholder "Page 1 of N"). */
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
          html += `<span class="page-btn" style="border:none; background:none; cursor:default;">…</span>`;
        } else {
          html += `<button class="page-btn${p === current ? " active" : ""}" type="button" data-page="${p}"${p === current ? ' aria-current="page"' : ""}>${p}</button>`;
        }
      }
      html += `<button class="page-btn" type="button" data-page="${current + 1}"${current >= last ? " disabled" : ""} aria-label="Next page">Next ›</button>`;
      if (last > 1) {
        html += `<span class="page-btn" style="border:none; background:none; cursor:default;" aria-live="polite">Page ${current} of ${last}</span>`;
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
      /* A new load invalidates the previous letter's pagination: clear it
         BEFORE the round trip so a stale "Page 1 of N" never survives into
         the loading state (the container stays empty until real data lands). */
      if (paginationWrap) {
        paginationWrap.hidden = true;
        paginationWrap.innerHTML = "";
      }
      /* "All" is the plain A-Z browse; a letter is served by /api/az. */
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

  /* ==========================================================================
     6D. HOME LIVE RAILS (AniList)
     Top Airing / Trending Now / Top Rated / Latest Episodes. A rail that
     fails is simply hidden — the curated catalog keeps working.
     ========================================================================== */

  async function initLiveRails() {
    const rails = [
      { id: "live-top-airing-grid", path: "/api/browse?sort=popular&status=RELEASING&page=1", mode: "browse" },
      { id: "live-top-upcoming-grid", path: "/api/browse?sort=popular&status=NOT_YET_RELEASED&page=1", mode: "browse" },
      { id: "live-trending-grid", path: "/api/browse?sort=trending&page=1", mode: "browse" },
      { id: "live-top-rated-grid", path: "/api/browse?sort=top&page=1", mode: "browse" },
      /* New On AniFlick: the most recently STARTED titles. Distinct from
         Latest Episodes (the airing schedule) — this is a title list, not an
         episode feed. */
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
            <div class="skeleton-line skeleton-shimmer" style="width: 85%;"></div>
            <div class="skeleton-line skeleton-shimmer" style="width: 55%;"></div>
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
        /* Latest Episodes: the card opens the watch page at THAT episode. */
        el.innerHTML = results.map((row) => {
          const media = row.media || {};
          const aired = timeSinceLabel(row.airingAt);
          return renderLiveCard(media, {
            href: liveWatchHref(media, row.episode),
            /* The episode number belongs with the air time, not a separate
               "Ep N" badge span — every card uses the same SUB/DUB format. */
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
      /* Live cards have no catalog slug — the tooltip fetches the catalog
         title by slug, so it simply does not apply to them. */
      if (!card.dataset.slug) return;
      card.addEventListener("mouseenter", async (e) => {
        const slug = card.dataset.slug;
        activeHoverSlug = slug;

        const res = await api(`/api/titles/${encodeURIComponent(slug)}`);
        // If mouse left the card or another card hovered in the meantime, abort (Bug 1)
        if (activeHoverSlug !== slug || !card.matches(":hover")) return;
        if (!res.ok || !res.data) return;

        const t = res.data.title;
        const rating = scoreLabel(t);
        tip.innerHTML = `
          <div class="tooltip-title">${escapeHtml(t.name)}</div>
          <div class="tooltip-rating">${rating ? `★ ${rating} <span style="color: var(--text-muted); font-size: 0.75rem;">(AniList)</span>` : `<span style="color: var(--text-muted); font-size: 0.75rem;">Not yet rated</span>`}</div>
          <div class="tooltip-synopsis">${escapeHtml(t.synopsis || t.tagline)}</div>
          <div class="tooltip-meta-rows">
            <span><strong>Type:</strong> ${t.kind}</span>
            <span><strong>Studio:</strong> ${escapeHtml(t.studio)}</span>
            <span><strong>Genres:</strong> ${t.genres ? t.genres.map(genreLabel).join(", ") : "Action"}</span>
          </div>
          <a class="btn-zoro-primary" href="${watchHref(t.slug, 1)}" style="width: 100%; justify-content: center; margin-top: 10px; padding: 6px;">▶ Watch Now</a>
        `;

        const rect = card.getBoundingClientRect();
        let left = rect.right + 12;
        if (left + 330 > window.innerWidth) {
          left = rect.left - 332;
        }
        if (left < 10) left = 10;

        // Position: MUST NEVER cover the header (header is height 70px)
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

  /* ==========================================================================
     6B. GENRES PAGE DYNAMIC SHELF COUNTS
     ========================================================================== */

  /* Genre display metadata (icon / kanji / flavour). Cards themselves are
     rendered from GET /api/genres so every genre in the catalog — including
     Adventure — appears automatically with its honest title count. */
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

  /* Display labels for the rest of AniList's genre list. GENRE_META already
     carries the catalog's own shelves (icon / kanji / flavour); this covers
     the genres AniList has beyond them, spelled the way AniList spells them
     ("Sci-Fi", "Mahou Shoujo", "Slice of Life"). */
  const GENRE_LABELS = {
    action: "Action", adventure: "Adventure", comedy: "Comedy", drama: "Drama",
    ecchi: "Ecchi", fantasy: "Fantasy", horror: "Horror", "mahou shoujo": "Mahou Shoujo",
    mecha: "Mecha", music: "Music", mystery: "Mystery", psychological: "Psychological",
    romance: "Romance", "sci-fi": "Sci-Fi", "slice of life": "Slice of Life",
    sports: "Sports", supernatural: "Supernatural", thriller: "Thriller",
  };

  /* One display label per genre everywhere: the curated label when known
     ("life" -> "Slice of Life"), otherwise capitalised ("drama" -> "Drama").
     Raw lowercase keys must never leak into chips/tooltips. */
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
    /* EVERY AniList genre (GenreCollection, cached server-side). The local
       counts are the fallback list, so the page still renders while AniList
       is unreachable. */
    const all = Array.isArray(res.data.allGenres) && res.data.allGenres.length
      ? res.data.allGenres
      : Object.keys(counts);
    /* The local catalog spells one genre "life" where AniList says "Slice of
       Life" — that count is real, so it is attached to the AniList spelling
       instead of being dropped. A genre with no local count shows no number
       at all (never an invented one). */
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

  /* ==========================================================================
     7. ZORO WATCH PAGE: ZOKOANIME EMBED PLAYER
     ========================================================================== */

  /* Episode currently loaded in the player (comments follow it). */
  let activeEpisode = 1;
  let reloadComments = null;

  async function initWatchPage() {
    const watchStage = document.getElementById("zoro-video-stage");
    if (!watchStage) return;

    const params = new URLSearchParams(window.location.search);
    /* ?slug= is canonical; ?id= is the same alias the detail page accepts.
       An UNKNOWN or MISSING slug must resolve to a not-found state — never
       silently fall back to a catalog title (the old `|| "kagerou-protocol"`
       loaded Jujutsu Kaisen for any garbage id). */
    const currentSlug = (params.get("slug") || params.get("id") || "").trim();
    let currentEp = parseInt(params.get("ep"), 10) || 1;

    /* LIVE MODE — watch.html?live=<anilistId>&ep=<n>
       A title from the FULL AniList catalog (not one of the 18 curated
       titles): the metadata comes from /api/live/:id, the episode list from
       the AIRED episode count, and the player from the MAL id — or the
       AniList id when the title has no MAL id. Progress lives under its own
       "live-<id>" key namespace so live progress never collides with the
       catalog slugs. */
    const liveParam = params.get("live");
    const liveId = liveParam ? parseInt(liveParam, 10) : null;
    const isLive = !!liveId && Number.isFinite(liveId) && liveId > 0;
    const progressKey = isLive ? `live-${liveId}` : currentSlug;
    /* Live titles have no dub data at all (no dub_checks rows), so the
       episode list is derived from the AIRED episode count. */
    let liveAiredCount = 0;
    let liveEpisodesUnknown = false;
    /* currentTrack  = the track of the stream that is actually loaded in the
       player right now. The highlighted pill ALWAYS mirrors it.
       preferredTrack = the viewer's audio choice. It survives episode
       switches for the rest of the session and is NEVER destroyed by an
       episode that happens to lack the track (that episode falls back to
       Sub for itself only — the preference comes back on the next episode
       that really has the preferred track). */
    let currentTrack = "sub";
    let preferredTrack = "sub";
    /* True while an episode load is in flight (from the load's first line
       until the iframe src is assigned). A track switch requested during a
       load must NOT swap the iframe src a second time — tearing the embed
       down mid-load races its own stream fetch (the live "Unable to play
       media. 24 seconds of 0 seconds" flash). The in-flight load simply
       picks the new track up. */
    let loadInFlight = false;

    /* The iframe node is rebuilt by the switch watchdog when a player never
       settles, so the reference is mutable (listeners are re-bound in
       bindIframeListeners). */
    /* __PLAYER_IFRAME_SANDBOX_START__ */
    /* Sandbox value for the shared #zoko-embed-frame iframe. The sandbox is
       PER PLAYER: Zoko (the default) REFUSES to run inside a sandboxed iframe
       ("EMBED BLOCKED: This player does not run inside a sandboxed iframe"),
       so it must get NO sandbox attribute at all; TVplus (backup), MegaPlay
       and animegg run fine sandboxed and keep the popup-blocking value (no
       allow-popups / allow-top-navigation / allow-modals / allow-downloads —
       the popup-ad vector). PLAYER_IFRAME_SANDBOX is the source of truth for
       the sandboxed players; watch.html ships the iframe unsandboxed and the
       per-player map below decides at runtime. */
    const PLAYER_IFRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-presentation";
    /* Per-player sandbox map. A null value means: remove the sandbox attribute
       entirely (Zoko's hard requirement). */
    const PLAYER_IFRAME_SANDBOX_BY_SERVER = {
      zoko: null,
      backup: PLAYER_IFRAME_SANDBOX,
      megaplay: PLAYER_IFRAME_SANDBOX,
      animegg: PLAYER_IFRAME_SANDBOX,
    };
    /* __PLAYER_IFRAME_SANDBOX_END__ */
    let iframe = document.getElementById("zoko-embed-frame");
    /* Apply the per-player sandbox to the resolved iframe node: set the
       attribute from the map, or REMOVE it when the map value is null (Zoko
       hard-refuses a sandboxed iframe). The sandbox only takes effect when
       the iframe navigates, so this must run before any src assignment. */
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

    /* All elements are resolved once, up front. Declaring them here (instead of
       re-declaring inside a block below) keeps every binding out of the
       temporal dead zone, which used to abort the whole page init. */
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
    /* The seeded runtime (24m) is only a resume-math fallback — it is NOT the
       stream's real duration. The time readout must show --:-- until the player
       itself reports a duration, never a placeholder that later "corrects". */
    let durationIsReal = false;
    /* The episode whose events the player is currently emitting. It flips
       only when the NEW player's `ready` event arrives — NOT at the src swap:
       the old document keeps playing (and emitting time events) until the
       navigation commits, and those in-flight events belong to the OLD
       episode. Attributing them to the new episode leaked ep 1's position
       into ep 2's saved progress and armed the resume notice's auto-hide
       before the new episode even started. */
    let playerEp = null;
    let playerReady = false;
    let isPaused = true;
    let lastProgressSync = 0;
    let lastLocalSave = 0;
    /* Resume-notice lifecycle: the note must stay up until dismissed or a few
       seconds AFTER playback actually starts — never a flat timer from page
       load (the player has not even begun then, so nobody ever saw it). */
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

    /* Signed-out resume: the server only stores progress for signed-in users,
       so for everyone else the site keeps its own per-episode position in
       localStorage. Without this, resume still happened (the EMBED keeps an
       internal osp:pos store) but the site never knew about it — no "Resumed
       from…" notice, no Restart button. Mirrors the embed's own rules:
       ignore <5s, ignore the last 20s / >95% (counts as finished). */
    const LS_PROGRESS_KEY = "av_zoko_progress";

    /* Signed-out audio preference (one GLOBAL viewer choice, not per-title).
       It lives next to the resume store above, same "av_zoko_*" naming. The
       in-memory variable alone died with the page, so a reload forgot a
       selected Dub (verified live: watch?slug=second-wind&ep=2 came back on
       Sub). Every SUCCESSFUL track change writes it immediately; a refused
       Dub click (episode has no dub) never touches it. */
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
    /* Restore BEFORE the first loadEpisode: the bootstrap at the bottom of
       this function is what starts the player, and the optimistic pill reads
       `preferredTrack` on its very first line. */
    preferredTrack = readPreferredTrack();

    /* ------------------------------------------------------------------
       SERVER STATE — Zoko is PRIMARY; TVplus and animegg are
       alternates the viewer chooses (never auto-switched to). The choice is
       session-scoped (sessionStorage): a fresh tab always starts on Zoko,
       a reload inside the same tab keeps the choice. ?player=backup /
       ?player=animegg are harmless test hooks
       (loadEpisode's replaceState strips the param from the URL after load).
       NOTE: MegaPlay was removed as a player option (dead upstream, HTTP
       410) — it is no longer offered in the switcher and is not accepted
       as a stored or ?player= choice; such a choice falls back to Zoko.
       ------------------------------------------------------------------ */
    const SS_SERVER_KEY = "av_player_server";
    const BACKUP_ORIGIN = "https://embed.animetvplus.site";
    const MEGAPLAY_ORIGIN = "https://megaplay.buzz";
    /* animegg needs no origin constant: its URL is handed over by the server
       route (a live /watch call per view, rotating token), so the client
       never builds one itself. */
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
    /* activeServer is now fully resolved (default + sessionStorage + ?player=
       hook): apply its sandbox before the first load assigns the iframe src.
       Zoko (the default) gets no sandbox — it refuses sandboxed iframes. */
    applyIframeSandbox(activeServer);
    /* MegaPlay session state:
       megaPlayTrack — the last explicit track choice made ON MegaPlay.
       Session-only, NEVER persisted to av_zoko_track: MegaPlay's dub
       availability differs from Zoko's probe data, so its choices must not
       rewrite the Zoko preference. Carries the choice across episode
       switches while MegaPlay is active.
       megaPlayFrameLoaded — attribution gate. MegaPlay has no reliable
       pre-playback ready event (its PLAYER_READY can arrive AFTER the first
       time events on a resumed load — live-verified), so the iframe load
       commit is the boundary: until the NEW document has loaded, same-
       episode events belong to the dying player and are ignored. */
    let megaPlayTrack = null;
    let megaPlayFrameLoaded = false;

    /* ------------------------------------------------------------------
       animegg (4th server, manual-only fallback). Its URL is NOT built
       client-side: the server proxies the self-hosted Anivexa-API and
       resolves a LIVE /watch on every request, because the returned
       `?for=` token rotates per call. The client only ever holds the URL
       for the current load — never a cache, never sessionStorage.

       animeggState: "unknown" | "available" | "unavailable" per episode, so
       the pill can be honest before the viewer asks for it. No URL is kept
       here — the stream URL is resolved per load and lives only in the
       caller's local variable.
       ------------------------------------------------------------------ */
    let animeggState = "unknown";
    let animeggLoadToken = 0;
    let animeggFailTimer = null;
    const ANIMEGG_NO_PLAY_TIMEOUT_MS = 20000;

    /* Playback kill-switch (2026-11-23): the embed player never starts in
       live-browser checks — it hangs on "Please wait", then "Could not load
       player" — even though the mp4 files are alive, so the pill must not be
       offered as available until playback is confirmed on a real device.
       Server routes stay live; flip this to true to re-enable. */
    const ANIMEGG_ENABLED = false;

    /* The AniList id this page's title carries (live: the ?live id; catalog:
       titleData.anilistId). Null = the server cannot be asked. */
    function animeggAniListId() {
      if (isLive) return liveId || null;
      return (titleData && titleData.anilistId) || null;
    }

    /* Resolve the stream URL for THIS load's episode. One place, so the
       animegg route is hit exactly once per load and never from the pill's
       background probe (that probe only feeds the pill). The URL is
       deliberately NOT stored: the `?for=` token rotates per /watch call, so
       a later episode or a reload must resolve a fresh one.

       @returns {Promise<string|null>} the URL to hand to the iframe, or null
       when the provider has no stream for this episode. */
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

    /* GET /api/animegg/:anilistId/:ep — availability + (when available) a
       freshly resolved stream URL. Never auto-switches anything; the caller
       only learns whether the pill should be offered. */
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
        /* 45s budget: the server resolves availability (up to 25s on a cold
           Anivexa lookup) and then a live /watch (up to 20s) in sequence.
           The generic 10s api() timeout aborts both attempts on a cold
           lookup and wrongly marks the title unavailable. */
        const res = await api(`/api/animegg/${encodeURIComponent(id)}/${encodeURIComponent(epNum)}`, { timeoutMs: 45000 });
        const d = res && res.data;
        const ok = !!(d && d.available && (d.embedUrl || d.url));
        animeggState = ok ? "available" : "unavailable";
        /* The URL is returned to the caller, never stored: it carries a
           rotating token and belongs to exactly one load. */
        return ok ? (d.embedUrl || d.url) : null;
      } catch {
        animeggState = "unavailable";
        return null;
      }
    }

    /* animeTVplus embed URLs. IDs come from the catalog (titleData.malId /
       titleData.anilistId) — never invented — with three LIVE-VERIFIED
       exceptions (tested 2026-11-19), pinned here so a future catalog
       "correction" cannot silently break the backup: */
    const BACKUP_ID_EXCEPTIONS = {
      /* Kaguya-sama: Love is War –Ultra Romantic–: the MAL route (43608)
         hangs on a black spinner; the AniList route (125367) plays the same
         file. Force the AniList route for this title. */
      "encore-one-more": { route: "anilist", id: 125367 },
      /* UPSTREAM MAPPING BUG: animeTVplus swaps the MAL ids of A Silent
         Voice and ERASED — its "A Silent Voice" entry lives at mal 28851
         (ERASED's real MAL id) and its "ERASED" entry at mal 31043 (A Silent
         Voice's real MAL id); both routes resolve to the same swapped
         entries. So A Silent Voice is served via ERASED's id. The catalog
         already carries the provider-space id; this pin documents it.
         TODO: re-check upstream periodically and drop the pin if fixed. */
      "paper-cranes-at-dawn": { route: "mal", id: 28851 },
      /* Same upstream swap, other direction: ERASED is served via A Silent
         Voice's id (31043). TODO: re-check upstream periodically. */
      "the-quiet-ward": { route: "mal", id: 31043 },
      /* Attack on Titan S1 (16498) is FLAKY on animeTVplus (played once,
         black spinner another time) — deliberately NO special handling. */
    };

    /* Split-cour continuations: a catalog title whose later episodes stream
       under a DIFFERENT title id. Spy x Family Part 1 (MAL 50265) is 12 eps
       on every player — eps 13-25 are "SPY x FAMILY Cour 2" (AniList 142838,
       MAL 50602, verified streaming on Zoko 2026-11-23). Without this pin,
       Next Ep on ep 12 looked broken (disabled at the "last" episode) even
       though the story continues. The continuation is a LIVE title, so Next
       Ep / auto-next navigate to watch.html?live=<id>&ep=1. `short` is the
       button label (the full name is too long for the episode row). */
    const TITLE_CONTINUATIONS = {
      "corner-store-hours": { live: 142838, name: "SPY x FAMILY Cour 2", short: "Cour 2" },
    };
    function titleContinuation() {
      if (isLive) return null;
      return (currentSlug && TITLE_CONTINUATIONS[currentSlug]) || null;
    }

    function getBackupEmbedUrl(epNum, startTime, restart) {
      /* The pinned exceptions are CATALOG titles — a live title never uses
         them (it has no catalog slug). */
      const ex = isLive ? null : BACKUP_ID_EXCEPTIONS[currentSlug];
      let route, id;
      if (ex) {
        route = ex.route;
        id = ex.id;
      } else {
        /* Catalog ids only. The Zoko debug MAL override (av_zoko_ids) is
           deliberately NOT applied to the backup — it is a Zoko tool. */
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
      /* accent matches the site lime. No autoplay/mute params exist (the
         embed ignores them); no nav=1 — the site has its own episode list. */
      let url = `${BACKUP_ORIGIN}/home/embed/${route}/${id}/${epNum}?accent=cae962`;
      /* t = whole seconds 1..86400, applied when the viewer presses Play;
         it takes priority over Uqload's own remembered position. Restart
         uses t=1: the embed has no resume=0-style switch, and t=1 is the
         only documented way to override the remembered position. */
      let t = Math.floor(startTime || 0);
      if (restart) t = 1;
      if (t >= 1 && t <= 86400) url += `&t=${t}`;
      return url;
    }

    /* MegaPlay embed URLs (third server). The catalog MAL id is used
       DIRECTLY — all 18 catalog titles verified playing with their catalog
       ids (2026-11-19), including the ASV/ERASED pair: MegaPlay's upstream
       mapping is swapped the SAME way the catalog is, so the catalog ids
       serve the correct content with NO pins (no exceptions table here).
       The Zoko debug MAL override (av_zoko_ids) is deliberately not applied
       — it is a Zoko tool.
       RESUME: ?t= was live-tested (t=60 on Solo ep1 started playback at
       0.13s; t=0 and resume=0 also failed to override the provider's own
       internal resume) — MegaPlay ignores start-offset params, so NO t= is
       emitted. The provider keeps its OWN internal per-video resume store
       (verified: a reload resumed at the previous position); the site can
       neither query nor disable it, and surfaces it honestly via the
       fallback resume notice. Position tracking still runs on MegaPlay, so
       a switch back to Zoko resumes from the stored position. */
    function getMegaPlayEmbedUrl(epNum, track) {
      const lang = track === "dub" ? "dub" : "sub";
      if (titleData && titleData.malId) {
        return `${MEGAPLAY_ORIGIN}/stream/mal/${titleData.malId}/${epNum}/${lang}`;
      }
      /* Live titles without a MAL id use MegaPlay's AniList route. */
      if (titleData && titleData.anilistId) {
        return `${MEGAPLAY_ORIGIN}/stream/ani/${titleData.anilistId}/${epNum}/${lang}`;
      }
      return null;
    }

    /* ------------------------------------------------------------------
       ZOKO FAILURE DETECTION (diagnosed against the live embed core JS)
       1. REAL error signal: the embed emits {channel:'zokoanime',
          type:'error', message} on JW Player errors ("Unable to play
          media" arrives this way) and on video-element errors. The embed
          may still self-heal (edge-host failover), so an error OFFERS the
          backup — it never auto-switches — and the offer hides again if
          playback demonstrably recovers (ready/play/time events).
       2. DEAD provider (domain down / blocked / error-state page): NO
          events arrive at all. Two honest signals:
          a) a no-cors fetch of the EXACT embed URL rejects only on a real
             network failure (blocked/DNS/connection refused) — a slow
             response still resolves (opaque), so slowness never triggers
             it. An aborted probe (20s) is UNKNOWN, not failure.
          b) backstop: 45s without `ready`. A slow-but-working load emits
             ready/play/time long before that (AoT S1 took ~16s with a
             Zoko-side loading screen and played fine — ready arrived in
             under a second). Elapsed time alone never fires while the
             player is alive.
       3. LOAD-START NO-PLAYBACK DEADLINE (23 Nov, live-browser defect #1):
          the 30s ready-without-playback backstop is armed ONLY in the
          `ready` handler — but a 404ing player (Doraemon) serves a static
          error page with NO scripts, so `ready` never fires and that timer
          never starts. The 45s no-ready timer above SHOULD have caught it,
          but the live browser still saw the spinner minutes later (the
          exact mechanism could not be reproduced from the VM). So a third
          timer is armed when the load STARTS (in armZokoFailureDetection,
          called from loadEpisode right after the src assignment): if no
          playback evidence (play / first time event with a real position)
          arrives within 45s of the src assignment, the spinner hides and
          the fallback offer shows — ready or not. `ready` must NEVER retire
          this deadline; only playback evidence, an error, or a teardown
          does. 45s matches the no-ready threshold; a slow-but-real start
          (Paper Cranes class) self-corrects when playback begins — the
          play/time handlers withdraw the stale offer.
       ------------------------------------------------------------------ */
    const ZOKO_NO_READY_TIMEOUT_MS = 45000;
    /* Backstop for ready-without-playback (fix #1, 23 Nov audit): the embed
       reported `ready` but never plays or errors (Doraemon). `ready` clears
       every other timer, so without this the spinner stays forever. 30s: a
       healthy embed starts within seconds. Armed ONCE per load: a retrying
       embed that fires `ready` repeatedly must not keep resetting the
       window (that was a second way the spinner could stick forever). */
    const ZOKO_NO_PLAY_AFTER_READY_MS = 30000;
    /* Load-start no-playback deadline (live-browser defect #1, 23 Nov):
       armed in armZokoFailureDetection — i.e. at load start, not on ready.
       Fires only on NO playback evidence within 45s of the src assignment. */
    const ZOKO_NO_PLAYBACK_DEADLINE_MS = 45000;
    const ZOKO_PROBE_ABORT_MS = 20000;
    const BACKUP_NO_READY_TIMEOUT_MS = 45000;
    /* MegaPlay emits no reliable pre-play signal; a dead file (the 410 page)
       produces no events at all. A healthy embed reports its first time event
       within a few seconds, so 12s is a safe "no playback evidence" backstop —
       long enough for a slow start, short enough not to trap the viewer. */
    const MEGAPLAY_NO_PLAY_TIMEOUT_MS = 12000;
    let loadToken = 0;
    let zokoFailTimer = null;
    let zokoNoPlayTimer = null; // backstop: ready fired but playback never started
    let zokoNoPlaybackTimer = null; // load-start deadline: no playback evidence at all
    let playbackEvidenceForLoad = false; // play / first time event with cur > 0
    let backupFailTimer = null;
    let megaplayFailTimer = null;
    let fallbackOfferVisible = false;

    /* ------------------------------------------------------------------
       SWITCH HARDENING — teardown + idempotency + settle watchdog.
       A server switch used to flip `activeServer` and assign a new iframe
       src with NO teardown of the dying document: its backstops, its
       reachability probe and its per-load flags survived into the new
       load, a still-in-flight loadEpisode from the old server could resume
       after the swap and touch the player again, and if the new document
       never reported ready/play/time the page just sat on the spinner
       forever. Everything player-side is now cleared in ONE place before
       every switch, stale loads are invalidated by token, and a watchdog
       rebuilds the iframe on the target server if nothing settles in time.
       ------------------------------------------------------------------ */
    const SWITCH_SETTLE_TIMEOUT_MS = 20000;
    let settleWatchdog = null;   // watchdog timer for the current switch
    let settleAttempt = 0;       // 0 = first load, 1 = after one rebuild
    let playerSettled = false;   // became true on ready/play/time/error/offer
    let probeController = null;  // AbortController of the live Zoko probe
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

    /* Rebuild the iframe element itself: replacing the node guarantees the
       stuck document (TVplus/Uqload, a half-dead Zoko load) is gone, not
       merely re-navigated. Listener re-binding happens in
       bindIframeListeners; the focus poller reads `iframe` dynamically. */
    function rebuildIframe() {
      if (!iframe || !iframe.parentNode) return;
      const fresh = document.createElement("iframe");
      fresh.id = iframe.id;
      fresh.className = iframe.className;
      fresh.title = iframe.title;
      fresh.setAttribute("allow", iframe.getAttribute("allow") || "fullscreen; autoplay");
      fresh.setAttribute("allowfullscreen", "");
      /* The fresh node must carry the CURRENT server's sandbox: the sandbox
         only takes effect on navigation, and this rebuild immediately
         re-navigates in loadEpisode. */
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
          /* First strike: tear the player area down and rebuild the iframe
             on the target server, then reload the episode once. */
          settleAttempt = 1;
          switchBusy = false;
          rebuildIframe();
          loadEpisode(currentEp, null, false, Math.floor(currentPosition || 0));
          armSettleWatchdog(loadToken, server, 1);
          return;
        }
        /* Second strike: stop recovering and surface the honest state. */
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

    /* When the last Zoko error event arrived. Recovery (offer/overlay hide)
       requires playback evidence MORE than 2s after the error: the old
       document keeps emitting in-flight time events for ~0.5s after a fatal
       error, and a single stale event must not withdraw the offer. */
    let lastZokoErrorAt = 0;
    const ZOKO_RECOVERY_GUARD_MS = 2000;
    /* Same recovery guard for MegaPlay's failure offer. */
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

    /* The failure OFFER (Zoko context only). The viewer chooses; nothing
       switches automatically. */
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

    /* Backup-context notice: status after a switch, or a backup failure.
       Always offers the way back to the primary player. */
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

    /* MegaPlay-context failure OFFER: the same notice component as the Zoko
       failure offer, but the way out is back to the PRIMARY player. The
       viewer chooses; nothing switches automatically. */
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

    /* animegg-context failure OFFER: same component and same rule (manual
       only — the viewer picks the way back, nothing auto-switches). */
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

    /* animegg status note when the episode simply is not on the provider: the
       honest not-available state, offering the way back. */
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
        /* Failure is detected: release the switch lock (so the offer's
           button actually works) and clear the loading overlays instead of
           leaving them stacked over the error. */
        markPlayerSettled();
        if (spinner) spinner.hidden = true;
        if (coverOverlay) coverOverlay.style.display = "none";
        showFallbackOffer();
      }, ZOKO_NO_READY_TIMEOUT_MS);
      /* Load-start no-playback deadline (live-browser defect #1): armed
         HERE — at load start, not on ready — so a player that emits nothing
         at all (Doraemon's static 404 page: no scripts, no ready, no error)
         still gets a spinner-hide + fallback offer. The guard deliberately
         does NOT check playerReady: `ready` must never retire this
         deadline — only playback evidence, an error, or a teardown does.
         If the 30s ready-without-play timer already fired, this is a no-op
         re-render of the same offer (harmless). */
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
      /* Reachability probe of the exact embed URL (see detection notes).
         The previous switch's probe is aborted first: probes must never
         stack up across switches. */
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
        /* Release the switch lock so "Back to Zoko" works immediately. */
        markPlayerSettled();
        if (spinner) spinner.hidden = true;
        if (coverOverlay) coverOverlay.style.display = "none";
        showBackupNote("TVplus player isn't responding.");
      }, BACKUP_NO_READY_TIMEOUT_MS);
    }

    /* MegaPlay failure detection: an error event OR 45s without a single
       time/watching-log event (the documented alive signal — PLAYER_READY
       does not count). NO reachability probe here: direct access to a
       MegaPlay stream URL returns HTTP 410 BY DESIGN (embed-only block),
       so a no-cors probe would false-positive on healthy titles. */
    function armMegaPlayFailureDetection(token) {
      if (megaplayFailTimer) clearTimeout(megaplayFailTimer);
      megaplayFailTimer = setTimeout(() => {
        megaplayFailTimer = null;
        if (token !== loadToken || activeServer !== "megaplay" || playerReady) return;
        /* Failure detected: release the switch lock (the offer's "Try Zoko
           player" must work), clear the loading overlays and offer the way
           back. The dead file's own 410 page stays visible inside the frame. */
        markPlayerSettled();
        if (spinner) spinner.hidden = true;
        if (coverOverlay) coverOverlay.style.display = "none";
        showMegaPlayFailureOffer("MegaPlay isn't responding.");
      }, MEGAPLAY_NO_PLAY_TIMEOUT_MS);
    }

    /* animegg failure detection: the embed emits no documented postMessage
       events, so the ONLY honest signal is elapsed time without the iframe
       producing anything. 20s: the embed is a plain page (animegg.org embed)
       that loads its player quickly; the site never auto-switches. */
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

    /* Swap the iframe in place — no page reload, no lost comment draft, no
       lost resume notice. The last observable position travels with the
       switch (Zoko and MegaPlay report time events; TVplus exposes none, so
       this captured position is also what a later switch BACK resumes from).

       Idempotent + teardown-first: every player-side timer/probe from the
       dying document is cleared before the new load, per-load flags are reset
       (playerEp is nulled so stale events can't be attributed to the new
       document), server toasts are dropped, and a settle watchdog arms for
       the new load.

       A manual switch is NEVER swallowed: it works while a load is in flight
       (the pending load is invalidated by token, so it cannot re-assign the
       iframe src after the swap) and while a previous switch is still
       settling (the settle lock exists to serialize recovery, not to block
       the viewer's own click — that lock used to make the server pills dead
       for up to 40s on a failed MegaPlay load). */
    function switchServer(server) {
      if (server !== "zoko" && server !== "backup" && server !== ANIMEGG_SERVER_ID) return;
      if (server === activeServer) return;
      /* Cancel the in-flight load/probes BEFORE swapping: the token bump
         makes every awaiting loadEpisode abort at its next guard. */
      loadToken++;
      loadInFlight = false;
      switchBusy = false;
      settleAttempt = 0;
      const pos = Math.floor(currentPosition || 0);
      activeServer = server;
      /* Sandbox FIRST, before loadEpisode assigns the iframe src: the
         sandbox attribute only takes effect when the iframe navigates, so it
         must be in place for the navigation this switch triggers. */
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
      /* The stream URL is resolved per load; nothing to clear here beyond
         the state (loadEpisode re-resolves it). */
      clearPlayerToasts();
      applyServerUI();
      /* The note is recomputed by loadEpisode for the server now active:
         backup shows its status note, animegg re-resolves availability and
         shows the honest state, Zoko/MegaPlay clear it. */
      hideFallbackNote();
      pendingSwitchWatchdog = true;
      loadEpisode(currentEp, null, false, pos);
    }

    /* One place owns the server-dependent UI: pills, track availability,
       Zoko-only settings, cover badge. preferredTrack / av_zoko_track are
       NEVER written here — the viewer's Dub choice survives the alternates. */
    function applyServerUI() {
      const onBackup = activeServer === "backup";
      const onMegaPlay = activeServer === "megaplay";
      const onAnimegg = activeServer === ANIMEGG_SERVER_ID;
      if (serverSwitcher) {
        serverSwitcher.querySelectorAll(".server-pill").forEach((p) => {
          p.classList.toggle("active", p.dataset.server === activeServer);
          /* animegg is offered ONLY for an episode the provider actually
             lists: the pill is disabled with an honest tooltip otherwise,
             exactly like the other players' unavailable states. Unknown
             (probe still in flight) stays enabled but unhighlighted — the
             click itself re-resolves and shows the honest state. */
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
            /* The backup exposes no track control: the audio/subtitle track
               is whatever the source file carries, and the site cannot
               choose or switch it. Pills stay disabled (honest — no site
               track switch exists here); the wording no longer claims the
               file is "Sub only", which the site cannot know. */
            p.classList.toggle("active", t === "sub");
            p.disabled = t !== "sub";
            p.classList.toggle("is-disabled", t !== "sub");
            p.title = t === "dub" ? "Track switching isn't available on TVplus — audio depends on the source file"
                    : t === "hsub" ? "Track switching isn't available on TVplus — subs depend on the source file"
                    : "";
          } else if (onAnimegg) {
            /* animegg is SUB-ONLY (verified: 0 dub episodes across the
               covered titles). Same treatment as the backup: Sub active,
               Dub/Hard-sub disabled with an honest tooltip, and the stored
               av_zoko_track preference is never touched — it returns when
               the viewer goes back to Zoko. */
            p.classList.toggle("active", t === "sub");
            p.disabled = t !== "sub";
            p.classList.toggle("is-disabled", t !== "sub");
            p.title = t === "dub" ? "animegg is sub only — there is no English dub track"
                    : t === "hsub" ? "animegg is sub only — hard-sub isn't available either"
                    : "";
          } else if (onMegaPlay) {
            /* MegaPlay serves REAL dubs and its availability differs from
               Zoko's probe data — Sub and Dub stay enabled ALWAYS (never
               disabled from dub_checks). A truly missing dub surfaces as a
               player error → the failure notice handles it. Hard-sub is not
               a MegaPlay track: disabled with an honest tooltip. */
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
          /* Zoko embed settings stay disabled on the alternates — except
             auto-next on MegaPlay, which is SITE-driven (the complete event
             loads the next episode), so that toggle genuinely works there.
             MegaPlay always auto-plays and has no intro/outro skip.
             animegg has no documented postMessage control bridge and no
             parent-driven end event, so all three toggles are disabled. */
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
          ? '<span style="color: var(--zoro-lime);">⚡</span> Stream with MegaPlay (Auto-Play)'
          : onBackup
          ? '<span style="color: var(--zoro-lime);">⚡</span> Stream with TVplus (press Play)'
          : onAnimegg
          ? '<span style="color: var(--zoro-lime);">⚡</span> Stream with animegg (Sub, SD)'
          : '<span style="color: var(--zoro-lime);">⚡</span> Stream with ZokoAnime (Auto-Skip)';
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
        // Keep the store bounded: drop the oldest entries past 200.
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
    /* Same "watched enough to resume, not finished" window the embed uses. */
    function resumablePosition(pos, dur) {
      const d = dur > 0 ? dur : 1440;
      return typeof pos === "number" && pos >= 5 && pos < d - 20 && pos / d <= 0.95;
    }

    // Helper: Send postMessage commands to ZokoAnime embed player.
    // Zoko-only: the backup embed accepts just goto/info — site play/pause/
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
    /* `source` is always "mal": Zoko's /stream/anilist/ route is dead upstream
       (HTTP 404 for every id probed), so this builder never emits one. */
    function getEmbedUrl(malId, epNum, track, opts = {}) {
      const source = opts.source === "anilist" ? "anilist" : "mal";
      const id = opts.id != null ? opts.id : malId;
      if (!id) {
        showToast("No anime id mapped for this title");
        return null;
      }
      /* Zoko's /stream/anilist/... route does not exist upstream (HTTP 404 for
         every id probed). Never build one: a caller that still asks for the
         anilist route gets null, and the caller routes the title to the
         working TVplus AniList route instead. */
      if (source === "anilist") {
        return null;
      }
      const color = "cae962";
      const ap = opts.autoplay ? 1 : 0;
      const as = opts.autoskip ? 1 : 0;
      const an = opts.autonext ? 1 : 0;
      let url = `https://zokoanime.video/stream/${source}/${id}/${epNum}/${track}?color=${color}&autoplay=${ap}&autoskip=${as}&autonext=${an}`;
      if (opts.startTime && opts.startTime > 0) {
        /* The live embed reads the start offset from `time=` (verified: `t=`
           alone is ignored and playback starts at 0). Emit both. */
        const startSec = Math.floor(opts.startTime);
        url += `&t=${startSec}&time=${startSec}`;
      }
      if (opts.noResume) {
        /* The embed keeps its OWN per-video resume store (localStorage
           osp:pos:<id>) and applies it whenever no explicit start point is
           given — so time=0 alone does NOT restart an episode. `resume=0`
           is the provider's documented switch that disables that internal
           resume (verified against the embed payload: resume:false). */
        url += "&resume=0";
      }
      return url;
    }

    /* ------------------------------------------------------------------
       Visible states: the page must never sit silently on placeholder
       text pretending to be real data.
       ------------------------------------------------------------------ */
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

    /* Total episode count, or 0 while the title is unknown. */
    function totalEpisodes() {
      if (isLive) return liveAiredCount;
      return (titleData && titleData.episodes) || episodesList.length || 0;
    }

    /* "More Like This" rail under the player (Phase 3b).
       Live titles: the recommendation edges are ALREADY in the /api/live
       payload — no second query. Catalog titles: the same same-genre shelf
       the catalog detail page renders. Empty -> fillRecommendations hides the
       section, so a title with no recommendations shows nothing at all. */
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

    /* LIVE title details — /api/live/:anilistId.
       The episode list comes from the AIRED episode count: an airing title
       has aired (nextAiringEpisode.episode - 1) episodes, a finished title
       has all of them, a film has one. A title with an unannounced episode
       count shows "Episode list unavailable" but can still play Ep 1. */
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

      /* Live titles have no dub data — the 18+ tag comes from the server. */
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

      /* No watchlist row and no comments for live titles — neither exists in
         the catalog DB, and this feature must not write to it. */
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
      /* Missing/unknown slug: an honest not-found state. The watch page must
         never invent a title (the old default silently played Jujutsu Kaisen
         for any ?id= garbage). */
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
      /* Seed per-episode dub availability BEFORE the first loadEpisode runs:
         the optimistic pill then knows the answer on a cold episode and never
         flashes Sub → Dub. Runs after every title load, so a retry re-seeds. */
      seedDubAvailability(data);

      if (animeTitle) animeTitle.textContent = titleData.name;
      if (animeTitleH1) animeTitleH1.textContent = titleData.name;
      if (animeDesc) animeDesc.textContent = titleData.synopsis || titleData.tagline || "";

      // Real metadata in the sidebar details card + the player cover backdrop.
      const setText = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
      };
      setText("watch-detail-status", statusLabel(titleData.status));
      setText("watch-detail-studios", titleData.studios || titleData.studio || "—");
      setText("watch-detail-year", titleData.year || "—");
      setText("watch-detail-score", scoreLabel(titleData) ? `★ ${scoreLabel(titleData)} / 10` : "—");
      setText("watch-detail-episodes", titleData.episodes || episodesList.length || "—");
      /* Runtime has ONE source of truth: the catalog's runtimeMin (same
         value the spotlight/cards show). Never fabricate a 24m fallback —
         a missing runtime renders as "—", not a number that later
         "corrects" itself. */
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
      /* The episode list is the watch page's real content. */
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
          /* The episode count is unannounced — say so honestly, but Ep 1 is
             still playable. */
          epGrid.innerHTML = `
            <p class="ep-grid-status">Episode list unavailable for this title.</p>
            <button class="ep-btn" data-ep="1" type="button" title="Episode 1"><span class="ep-btn-num">001</span><span class="ep-btn-title">Episode 1</span></button>`;
        } else {
          epGrid.innerHTML = `<p class="ep-grid-status">No episodes available for this title.</p>`;
        }
        bindEpisodeGridEvents();
        return;
      }

      // Update range tabs label (Bug 7)
      if (rangeTabs) {
        const maxEpStr = String(totalEps).padStart(3, "0");
        rangeTabs.innerHTML = `<button class="ep-tab-btn active" type="button">001 - ${maxEpStr}</button>`;
      }

      // Build map of episode titles (Bug 8)
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

      // Filter episodes by search box (Bug 8)
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

      // Delegated click listener for episodes grid (ensures in-page swap without navigation)
      bindEpisodeGridEvents();
    }

    /* The episode grid is re-rendered on every title/episode change, so the
       delegated listener is bound ONCE and survives the re-render. */
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

    // Prev / Next button states (also used before the title has loaded)
    function updateEpisodeNavState() {
      const totalEps = totalEpisodes();
      const prevBtn = document.getElementById("btn-prev-ep");
      const nextBtn = document.getElementById("btn-next-ep");
      if (prevBtn) {
        prevBtn.disabled = currentEp <= 1;
        prevBtn.style.opacity = currentEp <= 1 ? "0.5" : "1";
      }
      if (nextBtn) {
        const atEnd = totalEps > 0 && currentEp >= totalEps;
        /* A split-cour continuation turns the dead end into a door: Next
           stays enabled at the last episode and is labelled with where it
           goes (Spy x Family ep 12 -> Cour 2). */
        const cont = atEnd ? titleContinuation() : null;
        nextBtn.disabled = (atEnd && !cont) || totalEps === 0;
        nextBtn.style.opacity = nextBtn.disabled ? "0.5" : "1";
        nextBtn.textContent = cont ? `Next: ${cont.short || cont.name} ›` : "Next Ep ›";
      }
    }

    // Episode subtitle updater
    async function updateEpisodeSubtitle(epNum, prefetched) {
      const epRes = await (prefetched || fetchEpisodeData(epNum));
      /* A newer episode switch may have started while this fetch was in
         flight: the stale answer must not overwrite the new episode's title. */
      const isCurrent = Number(epNum) === Number(currentEp);
      if (epRes.ok && epRes.data && epRes.data.episode) {
        const ep = epRes.data.episode;
        /* Live titles have generic episode names — "Episode 1: Episode 1"
           says nothing, so the subtitle stays clean. */
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
    /* Episode metadata only needs the slug + episode number, so it is fetched
       in parallel with the title instead of after it. */
    function fetchEpisodeData(epNum) {
      /* Live titles have no episode rows (no DB write for them): the episode
         metadata is derived from the title's own runtime, and the resume
         position comes from the local store under the live key. */
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

    /* Resume notice — shown on BOTH resume paths (signed-in server position
       AND signed-out localStorage position), plus a fallback for the embed's
       own internal resume that the site cannot know about up front. Stays
       visible until dismissed, or 6s after playback actually starts. */
    function showResumeNote(seconds) {
      if (!resumeNote) return;
      if (resumeNoteTimer) {
        clearTimeout(resumeNoteTimer);
        resumeNoteTimer = null;
      }
      resumeNoteShownForLoad = true;
      resumeNoteArmOnPlay = true;
      /* Restart stays on Zoko/TVplus only: MegaPlay's internal resume store
         cannot be disabled (?t=0 / resume=0 live-tested — both ignored), so
         a Restart button there would be a fake control. animegg is the same
         (no documented start-offset param, its own player chrome). */
      const restartBtnHtml = (activeServer === "megaplay" || activeServer === ANIMEGG_SERVER_ID) ? "" :
        `<button class="btn-zoro-primary" id="resume-restart-btn" type="button" style="margin-left: 0.5rem; font-size: 0.75rem;">Restart</button>`;
      resumeNote.innerHTML = `
        Resumed from ${formatTime(seconds)}
        ${restartBtnHtml}
        <button id="resume-dismiss-btn" type="button" aria-label="Dismiss resume notice" style="margin-left: 0.35rem; background: none; border: none; color: var(--zoro-lime); font-size: 0.9rem; cursor: pointer; line-height: 1;">✕</button>
      `;
      resumeNote.hidden = false;
      const restartBtn = resumeNote.querySelector("#resume-restart-btn");
      if (restartBtn) {
        restartBtn.addEventListener("click", () => {
          hideResumeNote();
          /* loadEpisode's third argument is a BOOLEAN. Passing an object
             here only ever worked by accident (truthy). */
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
    /* Called from the player's play / first time event: only NOW does the
       auto-hide countdown start (a few seconds after playback begins). */
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
      /* New load: retire any previous failure-detection timers and (on Zoko
         or MegaPlay) the previous failure offer. A backup-status note stays
         — the viewer is still on the backup player. */
      clearPlayerTimersAndProbes();
      if (activeServer !== "backup") hideFallbackNote();
      /* New load: retire any previous resume notice and its timers. */
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
      /* New episode: animegg availability is re-resolved (the pill's probe
         runs in the background below; an animegg load resolves its own URL). */
      animeggState = "unknown";
      animeggLoadToken++;

      /* TEARDOWN-FIRST (fix #2, 23 Nov audit): stop the OLD player in this
         same frame, BEFORE any await. The new stream URL is only resolved
         after async fetches below (episode data, subtitles, dub probe) —
         without this the old document keeps PLAYING (audio included)
         through the whole gap, and longest when the new player never loads
         at all (switching to a dead player). Blanking the src kills it
         immediately; the new src is assigned later in this same load. The
         initial page load is a no-op (src is already about:blank). */
      if (iframe && iframe.src && iframe.src !== "about:blank") {
        iframe.src = "about:blank";
      }

      /* ------------------------------------------------------------------
         TRACK RESET — IMMEDIATELY, BEFORE ANY AWAIT.
         The old code awaited the episode fetch AND the dub probe before it
         touched the pills, so the PREVIOUS episode's highlight survived the
         switch for seconds (verified live: switching from a dubbed episode
         to an episode without a dub left DUB highlighted for a few seconds
         and only then corrected itself to SUB).
         Rule from here on: the pill shows the track that is loaded / being
         loaded on THIS episode, and it is correct within the first frame of
         the switch. While the answer is still unknown we show SUB — the
         only track that is guaranteed to exist — and correct it the moment
         the probe lands. The viewer's PREFERENCE is a separate variable and
         is never destroyed by this fallback.
         ------------------------------------------------------------------ */
      const knownAvail = dubAvailability.get(Number(epNum));
      if (activeServer === "backup") {
        /* The backup exposes no track choice — the source file decides the
           audio. currentTrack stays "sub" as internal state only (the site
           cannot know the file's track); preferredTrack / av_zoko_track are
           deliberately untouched so the viewer's Dub choice returns when
           they go back to Zoko. */
        currentTrack = "sub";
        applyTrackPill("sub");
        updateTrackLabel();
      } else if (activeServer === ANIMEGG_SERVER_ID) {
        /* animegg is SUB-ONLY, so the track is forced to Sub (no dub claim,
           no preference write — av_zoko_track keeps the viewer's choice for
           the return to Zoko). */
        currentTrack = "sub";
        applyTrackPill("sub");
        updateTrackLabel();
      } else if (activeServer === "megaplay") {
        /* MegaPlay: Sub and Dub are ALWAYS offered — its dub availability
           differs from Zoko's probe data, so there is NO dub_checks gate
           here (a missing dub surfaces as a player error → failure notice).
           An explicit MegaPlay choice (megaPlayTrack) carries across
           episodes; otherwise the STORED preference maps over (hsub → sub:
           MegaPlay has no hard-sub track). The stored value is read here on
           purpose: `preferredTrack` also changes when the viewer picks a
           track on a LIVE title, and those clicks deliberately do NOT touch
           av_zoko_track. Mapping the volatile variable made MegaPlay open
           Dub while the stored preference was still Sub (live-title click
           leak). av_zoko_track remains never written from MegaPlay. */
        const storedTrack = readPreferredTrack();
        currentTrack = megaPlayTrack || (storedTrack === "dub" ? "dub" : "sub");
        applyTrackPill(currentTrack);
        updateTrackLabel();
      } else if (isLive) {
        /* LIVE titles: dub availability is UNKNOWN (there are no dub_checks
           rows for them, and this feature must not write any). Sub AND Dub
           stay enabled and the viewer's stored preference is honoured as-is
           — a track that does not exist surfaces as a player error and the
           existing failure notice handles it. */
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

      /* New episode: re-probe dub availability in the background (the Dub
         pill awaits this probe if it is still running when clicked). The
         fresh entry starts unknown, so the previous episode's answer can
         never leak into this one. Zoko-only: the backup has no dub.
         Live titles are never probed — they have no dub data at all. */
      const probePromise = activeServer === "zoko" && !isLive ? probeDubAvailability(epNum) : null;

      /* New episode: re-resolve animegg availability in the background, so
         the pill is honest (offered only when the provider lists the
         episode) without blocking the load. Only the pill state is fed from
         here — the URL used for an actual animegg load is resolved again in
         the stream-URL step below (never reused). Never auto-switches. */
      if (activeServer !== ANIMEGG_SERVER_ID) {
        const bgToken = animeggLoadToken;
        probeAnimegg(epNum).then(() => {
          if (bgToken === animeggLoadToken) applyAnimeggPill();
        }).catch(() => {});
      }

      // Clear episode-search filter and input box on every episode change (Bug 5)
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
      // Optimistically update the episode heading from the already-cached
      // episode list so it tracks the URL instantly instead of lagging ~1-2s
      // behind while the episode fetch runs. The fetch below confirms it.
      const cachedEp = episodesList.find((e) => Number(e.ep_num ?? e.epNum) === Number(epNum));
      if (epSubtitle) {
        epSubtitle.textContent = cachedEp
          ? `Episode ${epNum}: ${cachedEp.title}`
          : `Episode ${epNum}`;
      }

      // Reset overlay and show spinner
      if (overlay) overlay.hidden = true;
      if (spinner) spinner.hidden = false;

      // Update URL without reload
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

      // Update Prev / Next button states
      updateEpisodeNavState();

      // Check saved position for resume
      const epData = await updateEpisodeSubtitle(epNum, prefetched);
      /* A newer episode/server load started while this one was fetching: this
         load is stale and must not touch the player, the URL or the pills.
         The old check only compared the episode number, so a SERVER switch
         (same episode) let the previous load resume after the swap and
         re-assign the iframe src — the src-swap race behind the switch hang. */
      if (token !== loadToken) return;
      if (currentEp !== epNum) return;
      if (!epData) {
        // Episode metadata could not be loaded: show a retry state instead of
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
        /* Restart: forget the saved position so the next reload does not
           resume again, and tell the embed to skip its own resume store. */
        clearLocalProgress(progressKey, epNum);
      } else if (positionOverride != null) {
        /* Server switch: carry the last observable position across servers
           (Zoko time events -> backup t= param, and back). */
        resumeTime = positionOverride >= 1 ? Math.floor(positionOverride) : 0;
      } else if (isLive) {
        /* Live titles have no server-side progress (no catalog row) — the
           site's own local store under the "live-<id>" namespace is the only
           source of truth. */
        const epDur = epData.durationSec || 1440;
        const lp = readLocalProgress(progressKey, epNum);
        if (lp && resumablePosition(lp.t, lp.d || epDur)) {
          resumeTime = Math.floor(lp.t);
        }
      } else {
        const epDur = epData.durationSec || 1440;
        if (typeof epData.savedPositionSec === "number" && resumablePosition(epData.savedPositionSec, epDur)) {
          /* Signed-in path: position saved on the server. */
          resumeTime = Math.floor(epData.savedPositionSec);
        } else if (!currentUser) {
          /* Signed-out path: position saved by this page in localStorage.
             (The embed also resumes internally; the watching-log fallback
             below catches any resume the site did not initiate.) */
          const lp = readLocalProgress(currentSlug, epNum);
          if (lp && resumablePosition(lp.t, lp.d || epDur)) {
            resumeTime = Math.floor(lp.t);
          }
        }
      }
      /* MegaPlay ignores start-offset params (?t= live-tested: playback
         started at 0 regardless; t=0 / resume=0 cannot override its internal
         resume either). The site therefore never claims a resume it cannot
         deliver: as far as the site is concerned the load starts from the
         episode start, and the provider's OWN internal resume (if any) is
         surfaced honestly by the fallback resume notice. Position tracking
         still runs on MegaPlay, so switching back to Zoko resumes correctly. */
      if (activeServer === "megaplay") resumeTime = 0;
      /* animegg ignores start-offset params too (the embed keeps its own
         position), so the site never claims a resume it cannot deliver —
         same honest treatment as MegaPlay. */
      if (activeServer === ANIMEGG_SERVER_ID) resumeTime = 0;
      resumeTimeForLoad = resumeTime;
      /* The notice is for a MEANINGFUL resume only (>=5s — the same floor
         the resumable window uses). A server switch carrying a 1-4s
         position still resumes there, but re-showing "Resumed from 00:03"
         on every switch was noise. */
      if (resumeTime >= 5) showResumeNote(resumeTime);

      // Reflect the resumed position in the UI before the player reports back
      /* MegaPlay exception: a carried switch position stays the "last known"
         position until MegaPlay's own time events report the real one — a
         quick switch back to Zoko must not lose it (MegaPlay may not have
         emitted a single event yet). */
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

      /* Re-resolve the track for THIS episode (probe-gated, Zoko only).
         The preference is honoured when the episode really has that track;
         when it does not, THIS episode falls back to Sub — and only this
         episode. `preferredTrack` is deliberately left untouched, so the
         moment the viewer reaches an episode that HAS the preferred track it
         comes back automatically, with no click (verified live: the old
         code overwrote the choice with "sub" and the dub never returned).
         On the backup the stream is always Sub — no probe, no preference
         write; the stored Dub choice waits for the return to Zoko. */
      if (activeServer === "zoko") {
        if (isLive) {
          /* Live titles: the dub track is UNKNOWN, never probed and never
             written to dub_checks. Both Sub and Dub stay enabled; the
             viewer's stored preference plays as-is. */
          currentTrack = preferredTrack === "hsub" ? "hsub" : preferredTrack;
          applyTrackPill(currentTrack);
        } else if (preferredTrack === "dub") {
          /* A dub needs proof: wait for this episode's probe before handing
             the dub URL to the embed. An answer already in the cache — a warm
             visit OR the seed from the title payload — IS that proof, so it is
             used immediately (no cold-load Sub→Dub flicker, no needless wait). */
          const avail = typeof knownAvail === "boolean" ? knownAvail : await probePromise;
          if (token !== loadToken || currentEp !== epNum) return; // superseded while probing
          currentTrack = avail === true ? "dub" : "sub";
          applyTrackPill(currentTrack);
        } else {
          /* Sub and hard-sub exist for every episode — no probe gate. */
          currentTrack = preferredTrack === "hsub" ? "hsub" : "sub";
          applyTrackPill(currentTrack);
        }
        updateTrackLabel();
      }

      // Build the stream URL for the ACTIVE server (Zoko primary, TVplus / MegaPlay / animegg alternates)
      let streamUrl;
      if (activeServer === "backup") {
        streamUrl = getBackupEmbedUrl(currentEp, resumeTime, startFromBeginning === true);
      } else if (activeServer === "megaplay") {
        streamUrl = getMegaPlayEmbedUrl(currentEp, currentTrack);
      } else if (activeServer === ANIMEGG_SERVER_ID) {
        /* animegg: the URL comes from the server route, resolved LIVE for
           THIS load (the `?for=` token rotates per /watch call). No resume
           offset is applied — the embed keeps its own position and the site
           surfaces that honestly rather than claiming a resume it cannot
           deliver. */
        const url = await resolveAnimeggStreamUrl(currentEp);
        if (token !== loadToken || currentEp !== epNum) return; // superseded while resolving
        if (!url) {
          /* Honest not-available state, same notice component as the other
             players. Manual only: no auto-switch. */
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
        /* Determine the player id: the MAL id is preferred (it is what every
           player maps best). A live title WITHOUT a MAL id can never be served
           by Zoko (its /stream/anilist/... route is dead upstream), so such a
           title starts on the WORKING TVplus AniList route — the initial
           server for a title Zoko cannot serve, not an auto-switch away from
           a failing player. The viewer can still pick any server manually,
           and getEmbedUrl() refuses to build a Zoko anilist URL at all. */
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
            /* The site's per-(slug,episode) store is the single source of truth
               for resume. With no saved position, `resume=0` disables the embed's
               OWN internal resume store so it can never start this episode at a
               position the site does not know about. With a saved position the
               explicit time= offset wins (the embed skips its internal resume
               whenever a start point is given). */
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
        /* playerEp flips when the NEW player reports `ready` — until then,
           in-flight events from the old document still belong to playerEp. */
      }
      /* The src is assigned: the load is over, so a track switch from now on
         swaps the src itself (exactly once). */
      loadInFlight = false;
      /* Arm failure detection for the server actually loading. */
      if (activeServer === "zoko") {
        armZokoFailureDetection(streamUrl, token);
      } else if (activeServer === "megaplay") {
        armMegaPlayFailureDetection(token);
      } else if (activeServer === ANIMEGG_SERVER_ID) {
        armAnimeggFailureDetection(token);
      } else {
        armBackupFailureDetection(token);
      }
      /* Switch settle watchdog: a switch that produces no ready/play/time,
         no error and no failure offer within N seconds is recovered by
         rebuilding the iframe on the target server. */
      if (pendingSwitchWatchdog) {
        pendingSwitchWatchdog = false;
        armSettleWatchdog(token, activeServer, 0);
      }
      if (spinner) {
        spinner.hidden = false;
        /* The loading overlay must never intercept clicks — keep it
           click-through so nothing under it (the embed's own play button,
           or any overlapping control) is ever blocked while loading. */
        spinner.style.pointerEvents = "none";
      }
      if (coverOverlay) {
        /* The title's OWN poster stays up as the loading backdrop (under the
           spinner) until playback actually starts — never a stock photo and
           never a black hole while the stream buffers. Click-through so the
           embed's own play button stays reachable if autoplay is blocked. */
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

    /* Dub availability for the current episode, probed by the server (Zoko
       serves the sub file under /dub for some titles — switching blindly used
       to play Japanese while claiming Dub). Results are cached PER EPISODE
       for the whole session: revisiting an episode resolves instantly, and a
       slow probe for episode A can never clobber episode B's answer (the old
       single shared `dubProbe` variable let ep5's late "true" overwrite
       ep1's "false"). null = unknown / probe failed. */
    const dubAvailability = new Map(); // ep -> true | false | null
    const dubProbes = new Map();        // ep -> Promise<true | false | null>

    /* Seed the per-episode cache from the title payload the watch page already
       fetches (/api/titles/:slug), whose per-episode rows come from the same
       persisted probe results (dub_checks) as the DUB counts everywhere else.
       This is what kills the cold-load pill flicker: without it the first
       visit to an episode has no answer, so the optimistic pill had to show
       Sub and flip to Dub when the probe landed (verified live). A seed is
       only used for episodes the map does not already know, and unknown /
       failed probes stay unknown — the conservative Sub rule is unchanged. */
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

    /* The ONE place that owns the pill UI. The highlighted pill is always the
       track of the stream that is loaded (or being loaded) — never a leftover
       from the previous episode. */
    function applyTrackPill(track) {
      if (!trackSwitcher) return;
      const active = track || "sub";
      trackSwitcher.querySelectorAll(".server-pill").forEach((p) => {
        p.classList.toggle("active", (p.dataset.track || "sub") === active);
      });
    }

    /* animegg server pill state — the "offered only when the episode is
       listed" rule lives here (the same single owner as the track pill). */
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

    /* Update the track label in the episode list header to reflect the true
       state of dub availability for the current episode. */
    function updateTrackLabel() {
      const label = document.getElementById("track-label");
      if (!label) return;
      /* On the alternates the site cannot know the file's audio track —
         never advertise a specific track (SUB or DUB) there. TVplus: the
         source file decides. MegaPlay: both tracks are always offered, but
         per-episode availability differs from Zoko's probes and is unknown
         to the site (a miss surfaces via the failure notice). animegg is
         SUB-ONLY, so the label says exactly that (no dub claim). */
      if (activeServer === ANIMEGG_SERVER_ID) {
        label.textContent = "SUB";
        return;
      }
      if (activeServer === "backup" || activeServer === "megaplay") {
        label.textContent = "—";
        return;
      }
      /* Live titles have no dub data: both tracks stay offered. */
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
          /* On the backup the Dub/Hard-sub pills are disabled; this guard
             keeps any stray activation from touching the track state.
             animegg is sub-only for the same reason. */
          if (activeServer === "backup" || activeServer === ANIMEGG_SERVER_ID) return;
          const requestedTrack = pill.dataset.track || "sub";
          const epAtClick = currentEp;

          if (activeServer === "megaplay") {
            /* MegaPlay track switch = rebuild the iframe URL with the other
               language (same shape as Zoko's track switch). NO dub probe:
               MegaPlay's dub availability differs from Zoko's probe data —
               a truly missing dub surfaces as a player error → the failure
               notice handles it. NO preference write: av_zoko_track stays
               the Zoko choice; megaPlayTrack carries the MegaPlay choice
               across episodes for this session only. */
            if (requestedTrack === "hsub") return; // disabled-pill guard
            if (requestedTrack === currentTrack) return;
            megaPlayTrack = requestedTrack;
            currentTrack = requestedTrack;
            applyTrackPill(currentTrack);
            updateTrackLabel();
            showToast(`Switched audio track to ${currentTrack.toUpperCase()}`);
            /* While a load is in flight the src must not be swapped a second
               time — the in-flight load picks the new track up. */
            if (loadInFlight) return;
            if (iframe && iframe.src && iframe.src !== "about:blank") {
              const newUrl = getMegaPlayEmbedUrl(epAtClick, currentTrack);
              if (newUrl) {
                /* Same-episode swap: gate events until the NEW document
                   loads (the dying one keeps emitting for ~0.5s). */
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
            /* The viewer may have switched episodes while the probe ran —
               never apply a stale answer to a different episode. */
            if (currentEp !== epAtClick) return;
            if (avail !== true) {
              showToast(
                avail === false
                  ? "English dub not available for this episode"
                  : "Could not verify dub availability — staying on the current track",
                "!",
                3500
              );
              /* Keep the pill UI honest: the current track stays active, and
                 the viewer's Dub PREFERENCE is left alone — this episode
                 simply has no dub; the choice must survive it. */
              applyTrackPill(currentTrack);
              return;
            }
          }

          /* An explicit click is a statement of preference: it becomes the
             track that plays now AND the track every later episode tries to
             play (as far as that episode actually has it). Persist it
             immediately so a full page reload keeps the choice — this line is
             only reachable AFTER the Dub gate above, so a refused Dub click
             (episode has no dub) never overwrites the stored preference. */
          preferredTrack = requestedTrack;
          /* LIVE titles never overwrite the stored Dub preference: the
             preference belongs to the catalog titles, and a live title's
             track availability is unknown. */
          if (!isLive) writePreferredTrack(preferredTrack);
          const changed = requestedTrack !== currentTrack;
          currentTrack = requestedTrack;
          applyTrackPill(currentTrack);
          if (!changed) return; // already playing this track: no toast, no reload

          showToast(`Switched audio track to ${currentTrack.toUpperCase()}`);
          /* While an episode load is still in flight the iframe src must NOT
             be swapped a second time — tearing the embed down mid-load races
             its own stream fetch (the live "Unable to play media. 24 seconds
             of 0 seconds" flash). The in-flight load picks the new track up
             when it assigns the src. */
          if (loadInFlight) return;
          if (iframe && iframe.src && iframe.src !== "about:blank") {
            // Read current playback position BEFORE swapping the iframe src (Bug 5).
            // The embed honours time= (t= alone is ignored), so every track
            // switch resumes where the viewer was — dub included.
            const resumePos = Math.floor(currentPosition || 0);
            /* A live title with no MAL id is on the TVplus player (Zoko has
               no anilist route); a track switch there rebuilds the TVplus URL,
               never a Zoko anilist one. */
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

    // Initialize toggle checkboxes from localStorage
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

    // Prev / Next Ep buttons (in-page swap with preventDefault to guarantee zero reload)
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
        /* Last episode of a split-cour title: continue into the next part.
           The continuation is a DIFFERENT title id, so this is a full
           navigation to its watch page — not an in-page episode swap. */
        if (totalEps > 0 && currentEp >= totalEps) {
          const cont = titleContinuation();
          if (cont && cont.live) {
            window.location.href = `watch.html?live=${encodeURIComponent(cont.live)}&ep=1`;
          }
        }
      });
    }

    /* ---- Theater mode (Phase 3b) ----
       Layout only: the player column takes the full content width and the
       episode sidebar is hidden. The iframe is never touched, so this behaves
       identically on Zoko, TVplus and MegaPlay. The choice is persisted per
       browser (localStorage) and restored before the first paint of the page
       logic. */
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

    /* Fullscreen: ONE shared path for the F key and the embed's own
       fullscreen request. A user-facing action must never fail silently:
       rejections are logged AND shown (the old `.catch(() => {})` swallowed
       every refusal — e.g. a click without user activation or a background
       tab — leaving zero trace of why fullscreen "did nothing"). */
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

    /* The site control bar (-10s / +10s / fullscreen button) was removed from
       watch.html — every control duplicated the embed's own bar. Fullscreen
       is still driven by the F key and the embed's fullscreen request; the
       arrow keys still seek. No dead bindings for removed buttons remain. */

    /* "Switch Anime MAL ID" is a debug tool, not a user feature: the button
       was removed from watch.html. It is only recreated when a local debug
       flag is set (?debug=1 or localStorage av_debug="1") — off by default. */
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
        /* The override is keyed by the catalog slug — a live title has no
           slug, so the debug tool does not apply to it. */
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

    // Bi-directional postMessage listener: MegaPlay + animeTVplus + ZokoAnime
    window.addEventListener("message", async (event) => {
      /* ---- MegaPlay (third server) -------------------------------------
         Documented events (megaplay.buzz/api), live-verified 2026-11-20:
         {channel:"megacloud", event:"time", time, duration, percent},
         {event:"complete"}, {event:"error"}, and {type:"watching-log",
         currentTime, duration} (no channel field). The player also emits
         PLAYER_READY / PIP_STATE / getFullscreenState — PLAYER_READY can
         arrive AFTER the first time events on a resumed load, so it is NOT
         the ready gate; the iframe load commit is (see the load listener
         below). Origin is checked before anything is trusted. */
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

        /* Same-episode swap gate (Restart / track switch / switch-back):
           the OLD document keeps emitting time events until the navigation
           commits. Until the NEW document has loaded, same-episode events
           belong to the dying player — ignore them (they would re-save a
           just-cleared position / re-arm a stale resume notice). Cross-
           episode events still flow: progress saves under playerEp. Errors
           stay ungated so pre-load failures surface. */
        if (mev !== "error" && !megaPlayFrameLoaded && playerEp === currentEp) return;

        // Events: time / watching-log → position tracking (same store as Zoko)
        if (mev === "time" || isWatchingLog) {
          markPlayerSettled();
          if (playerEp == null) return;
          const cur = typeof mdata.time === "number" ? mdata.time
                    : typeof mdata.currentTime === "number" ? mdata.currentTime : 0;
          const hasRealDuration = typeof mdata.duration === "number" && mdata.duration > 0;
          const dur = hasRealDuration ? mdata.duration : duration;
          const now = Date.now();
          /* Progress is ALWAYS attributed to playerEp — the episode actually
             playing in the iframe — under the SAME store as Zoko
             (av_zoko_progress signed-out, /api/progress signed-in), so a
             switch back to Zoko resumes where MegaPlay left off. */
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
          /* Live titles have no catalog row — their progress lives ONLY in
             the site's local store, under the "live-<id>" namespace. */
          if ((!currentUser || isLive) && cur > 0 && now - lastLocalSave > 5000) {
            lastLocalSave = now;
            writeLocalProgress(progressKey, playerEp, cur, dur);
          }
          /* UI below is for the episode the page shows — stale events from
             the previous episode must not touch it. */
          if (playerEp !== currentEp) return;
          /* First live time event = playback observed: retire the 45s
             no-play backstop (a time event — not PLAYER_READY — is the
             documented alive signal). */
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
            /* Sustained playback >2s after an error = genuine recovery (the
               same guard as Zoko): withdraw the failure offer. In-flight
               events from the dying document must not clear a real failure. */
            if (Date.now() - lastMegaPlayErrorAt > MEGAPLAY_RECOVERY_GUARD_MS) {
              if (fallbackOfferVisible) hideFallbackNote();
            }
          }
          if (timeText) {
            timeText.textContent = `${formatTime(cur)} / ${durationIsReal && duration > 0 ? formatTime(duration) : "--:--"}`;
          }
          /* Fallback resume notice: MegaPlay keeps its OWN internal per-video
             resume store (live-verified) that the site can neither query nor
             disable. When it resumes a load the site started at 0, surface
             that honestly — same window and guards as Zoko's fallback. */
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

        // Event: complete → auto-next (parent-driven, same as Zoko's ended)
        if (mev === "complete") {
          markPlayerSettled();
          if (playerEp == null || playerEp !== currentEp) return;
          /* totalEpisodes() is the AIRED count for live titles — auto-next
             must never jump to an episode that has not aired yet. */
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

        // Event: error → failure notice offering the way back to Zoko
        if (mev === "error") {
          markPlayerSettled();
          lastMegaPlayErrorAt = Date.now();
          if (megaplayFailTimer) { clearTimeout(megaplayFailTimer); megaplayFailTimer = null; }
          /* The embed shows its own error UI inside the frame — retire the
             site overlays rather than stacking on top. Never auto-switch. */
          if (spinner) spinner.hidden = true;
          if (coverOverlay) coverOverlay.style.display = "none";
          showMegaPlayFailureOffer("MegaPlay couldn't play this episode.");
          return;
        }
        return;
      }

      /* ---- animeTVplus backup embed ----------------------------------
         Docs-verified events: ready {mal, anilist, episode}, error {error,
         available}, info (reply to an info request), fullscreen (the embed
         asks the parent to drive fullscreen — handled below). There are NO
         time / play / pause / ended events — so the backup gets no auto-next
         and its playback position is not observable (resume-back uses the
         last stored position). Every message carries
         source:"animetvplus-embed". */
      if (event.origin === BACKUP_ORIGIN) {
        if (activeServer !== "backup") return;
        let bdata = event.data;
        if (typeof bdata === "string") {
          try { bdata = JSON.parse(bdata); } catch {}
        }
        if (!bdata || bdata.source !== "animetvplus-embed") return;
        if (bdata.type === "ready") {
          /* The backup reports the episode it loaded — ignore a stale ready
             from a previous swap (same ready-gate pattern as Zoko). */
          if (bdata.episode != null && Number(bdata.episode) !== Number(currentEp)) return;
          playerEp = currentEp;
          playerReady = true;
          markPlayerSettled();
          if (backupFailTimer) { clearTimeout(backupFailTimer); backupFailTimer = null; }
          /* No autoplay on the backup: reveal the player so the viewer can
             press Play INSIDE it. Our overlays must never block that click. */
          if (spinner) spinner.hidden = true;
          if (coverOverlay) coverOverlay.style.display = "none";
          showToast("TVplus player ready — press Play inside the player", "▶", 4000);
        } else if (bdata.type === "error") {
          markPlayerSettled();
          if (backupFailTimer) { clearTimeout(backupFailTimer); backupFailTimer = null; }
          if (spinner) spinner.hidden = true;
          if (coverOverlay) coverOverlay.style.display = "none";
          /* The embed shows its own error screen inside the frame; the site
             adds the honest way back to the primary player. */
          const msg = bdata.error === "no_episode" ? "This episode isn't available on the TVplus player."
                    : bdata.error === "unknown_title" ? "This title isn't available on the TVplus player."
                    : "The TVplus player couldn't load this episode.";
          showBackupNote(msg);
        } else if (bdata.type === "fullscreen" || bdata.type === "requestFullscreen" || bdata.type === "toggleFullscreen") {
          /* Fullscreen request from the embed (the Zoko bridge pattern): the
             embed's own button flips to "Exit Fullscreen" and asks the
             PARENT to fullscreen the player wrapper. Before this handler
             existed the request was silently dropped here — the label
             flipped but the page never entered fullscreen. Same shared
             toggleFullscreen path (with its error toast) as Zoko and the
             F key. A bare message with no direction is a toggle. */
          const req = bdata.request;
          if (req === "enter" && !document.fullscreenElement) toggleFullscreen();
          else if (req === "exit" && document.fullscreenElement) toggleFullscreen();
          else if (req == null) toggleFullscreen();
        }
        return;
      }

      // Hard origin check per spec (Zoko)
      if (event.origin !== "https://zokoanime.video") return;
      /* While the backup is active, stale events from the old Zoko document
         (it keeps emitting until the navigation commits) are ignored. */
      if (activeServer !== "zoko") return;
      let data = event.data;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch {}
      }
      if (!data || data.channel !== "zokoanime") return;

      /* Same-episode swap (Restart / track switch / switch-back to Zoko):
         the OLD document keeps emitting time/state events for ~0.5s after
         the src swap. Those in-flight events belong to the dying player —
         acting on them re-showed the stale "Resumed from …" notice right
         after Restart (playback at 0:00, notice still at the old position)
         and could re-save the just-cleared position. Ignore same-episode
         events until the NEW player reports ready. `ready` and `error` stay
         ungated (ready flips the gate; pre-ready failures must surface).
         Cross-episode attribution is untouched: while a NEW episode loads,
         playerEp !== currentEp, so the old episode's final events still
         save progress under the old episode. */
      if (
        data.type !== "ready" &&
        data.type !== "error" &&
        !playerReady &&
        playerEp === currentEp
      ) return;

      /* Ignore player events until the first episode is actually loaded, and
         ignore events from the PREVIOUS episode while a new one is loading
         (the old iframe keeps emitting until its src is replaced). */
      const eventIsForCurrentLoad = playerEp != null && playerEp === currentEp;

      // Event: ready
      if (data.type === "ready") {
        /* The NEW player initialised: from this moment its events belong to
           the episode being loaded. (Before this, in-flight events from the
           previous document are still attributed to the previous episode.) */
        playerEp = currentEp;
        playerReady = true;
        markPlayerSettled();
        /* The player is demonstrably alive: retire the no-ready backstop and
           any failure offer (a slow load is NOT a failure). */
        if (zokoFailTimer) { clearTimeout(zokoFailTimer); zokoFailTimer = null; }
        if (fallbackOfferVisible) hideFallbackNote();
        /* Arm the ready-without-playback backstop (fix #1): if no play /
           time event arrives within 30s, the embed is up but the stream is
           not — hide the spinner and offer the fallback instead of sitting
           on "Loading stream…" forever. Cleared on play, first time event,
           error, and every teardown. Armed ONCE per load: a retrying embed
           that fires `ready` repeatedly must not keep resetting the window
           (a second way the spinner could stick forever). */
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
        /* "ready" means the player chrome is up — NOT that the stream is
           playing. Keep the loading overlay until playback actually starts
           (play / first time event) so the embed's placeholder duration is
           never visible. Make the overlay click-through so the viewer can
           still reach the embed's own play button if autoplay is blocked. */
        if (spinner) spinner.style.pointerEvents = "none";
        if (overlay) overlay.hidden = true;
        // Report current fullscreen state to player
        sendPlayerCommand({ type: "fullscreen", active: !!document.fullscreenElement });
      }

      // Event: play
      if (data.type === "play") {
        if (!eventIsForCurrentLoad) return;
        markPlayerSettled();
        /* Playback started — retire the ready-without-playback backstop AND
           the load-start no-playback deadline. */
        playbackEvidenceForLoad = true;
        if (zokoNoPlayTimer) { clearTimeout(zokoNoPlayTimer); zokoNoPlayTimer = null; }
        if (zokoNoPlaybackTimer) { clearTimeout(zokoNoPlaybackTimer); zokoNoPlaybackTimer = null; }
        isPaused = false;
        if (playPauseBtn) playPauseBtn.textContent = "❚❚";
        /* Playback has actually started: the stream (and its real duration)
           is live — retire the loading overlay AND the loading poster. */
        if (spinner) spinner.hidden = true;
        if (coverOverlay) coverOverlay.style.display = "none";
        /* Zoko recovered (e.g. after a transient edge-failover error):
           withdraw the failure offer AND the error overlay — but only on
           playback evidence >2s after the error (in-flight events from the
           dying document must not clear a real failure). */
        if (Date.now() - lastZokoErrorAt > ZOKO_RECOVERY_GUARD_MS) {
          if (fallbackOfferVisible) hideFallbackNote();
          if (overlay && !overlay.hidden && lastZokoErrorAt > 0) overlay.hidden = true;
        }
        /* Begin the resume notice's auto-hide countdown now (not at page load). */
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
        /* Note: the embed reports `muted` here, but exposes NO postMessage
           command to change it (its dispatcher only accepts seek/play/pause/
           autoplay/autoskip/autonext/state). The site therefore ships no mute
           control — the embed's own volume control is the real one. */
      }

      // Event: time or watching-log
      if (data.type === "watching-log" || data.type === "time") {
        if (playerEp == null) return;
        const cur = typeof data.currentTime === "number" ? data.currentTime
                  : (typeof data.position === "number" ? data.position
                  : (typeof data.time === "number" ? data.time
                  : (typeof data.seconds === "number" ? data.seconds : 0)));
        const hasRealDuration = typeof data.duration === "number" && data.duration > 0;
        const dur = hasRealDuration ? data.duration : duration;
        const now = Date.now();

        /* Progress is ALWAYS attributed to the episode actually playing in
           the iframe (playerEp). During an episode switch the old player
           keeps reporting its position until the src swap lands — that
           position belongs to the OLD episode and must be saved under it,
           never under the episode being loaded (that leak made ep 2 "resume"
           from ep 1's position). Applies to BOTH the signed-in server path
           and the signed-out localStorage path. */
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

        /* Everything below is UI for the episode the page is showing — stale
           events from the previous episode must not touch it. */
        if (playerEp !== currentEp) return;
        markPlayerSettled();
        currentPosition = cur;
        /* Only the PLAYER's own duration is real. The seeded runtime is a
           resume-math fallback, never a displayed value — showing it first
           and "correcting" it later was the duration flicker. */
        if (hasRealDuration) {
          duration = data.duration;
          durationIsReal = true;
        }

        /* Playback is demonstrably running (real position from the player):
           the loading overlay AND the loading poster are done. */
        if (cur > 0) {
          /* First time event with a real position — retire the
             ready-without-playback backstop AND the load-start
             no-playback deadline. */
          playbackEvidenceForLoad = true;
          if (zokoNoPlayTimer) { clearTimeout(zokoNoPlayTimer); zokoNoPlayTimer = null; }
          if (zokoNoPlaybackTimer) { clearTimeout(zokoNoPlaybackTimer); zokoNoPlaybackTimer = null; }
          if (spinner) spinner.hidden = true;
          if (coverOverlay) coverOverlay.style.display = "none";
          /* Sustained playback after an error = genuine recovery (see the
             guard note above): withdraw the offer and the error overlay. */
          if (Date.now() - lastZokoErrorAt > ZOKO_RECOVERY_GUARD_MS) {
            if (fallbackOfferVisible) hideFallbackNote();
            if (overlay && !overlay.hidden && lastZokoErrorAt > 0) overlay.hidden = true;
          }
        }

        // Update time text strictly driven by player events — --:-- until the
        // real duration arrives (never a placeholder that later corrects).
        if (timeText) {
          timeText.textContent = `${formatTime(cur)} / ${durationIsReal && duration > 0 ? formatTime(duration) : "--:--"}`;
        }

        /* Fallback: the embed resumed from ITS internal store (no site-side
           position was known at load). Surface that resume honestly instead
           of silently continuing. Only early in the load, and never after an
           auto-skip jump or a viewer seek (those are not resumes). */
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

      // Event: skipped (intro or outro)
      if (data.type === "skipped") {
        if (!eventIsForCurrentLoad) return;
        skippedThisLoad = true;
        const segment = data.name === "outro" ? "outro" : "intro";
        showToast(`Skipped ${segment}`);
      }

      // Event: error
      if (data.type === "error") {
        markPlayerSettled();
        /* An error is a definitive answer — retire the
           ready-without-playback backstop AND the load-start
           no-playback deadline. */
        if (zokoNoPlayTimer) { clearTimeout(zokoNoPlayTimer); zokoNoPlayTimer = null; }
        if (zokoNoPlaybackTimer) { clearTimeout(zokoNoPlaybackTimer); zokoNoPlaybackTimer = null; }
        /* Errors are always surfaced — including failures while the new
           player is still initialising (before `ready` flips playerEp). */
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
        /* A real error signal (JW/video error, e.g. "Unable to play media"):
           OFFER the backup inline. Never auto-switch — the embed may still
           self-heal via edge failover, and the offer hides if playback
           demonstrably recovers (>2s of continued events). Viewer decides. */
        lastZokoErrorAt = Date.now();
        showFallbackOffer();
      }

      // Event: ended (auto-next is parent-driven)
      if (data.type === "ended") {
        if (!eventIsForCurrentLoad) return;
        markPlayerSettled();
        /* totalEpisodes() is the AIRED count for live titles — auto-next must
           never jump to an episode that has not aired yet, and an unknown
           count (0) must never invent one. */
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

      // Event: fullscreen request from embed (same shared path + error path)
      if (data.type === "fullscreen") {
        if (data.request === "enter" && !document.fullscreenElement) {
          toggleFullscreen();
        } else if (data.request === "exit" && document.fullscreenElement) {
          toggleFullscreen();
        }
      }
    });

    /* Keyboard focus containment: shortcuts (F / Space / arrows) are handled
       by THIS page, but clicking inside the cross-origin embed moves focus
       into it and the parent never sees the keys (the embed's player does not
       handle F at all — that is why F "did nothing" while Space/arrows worked
       inside the player). With out-of-process iframes the parent gets NO
       focus/blur event when that happens, so poll activeElement and keep
       keyboard focus on the player wrapper. Mouse clicks inside the embed
       still work normally; Space/arrows/F are served by this page's handler
       via the embed's postMessage control bridge. */
    const containFocus = () => {
      /* Zoko-only: the site serves Space/arrows/F via the postMessage
         bridge, so focus must stay on the wrapper. On the backup there
         are no site shortcuts — let focus stay INSIDE Uqload's player so
         its own keyboard controls work. */
      if (activeServer !== "zoko" || !playerWrap) return;
      if (document.activeElement === iframe) {
        playerWrap.focus({ preventScroll: true });
      }
    };

    /* Iframe-scoped listeners, re-bound whenever the watchdog rebuilds the
       iframe element (a replaced node carries no listeners). The MegaPlay
       attribution boundary is the iframe load commit: from here player
       events belong to the episode being shown. PLAYER_READY is NOT used
       for this because on a resumed load it arrives AFTER the first time
       events (live-verified). Zoko/TVplus keep their ready-event
       attribution. */
    function bindIframeListeners() {
      if (!iframe) return;
      iframe.addEventListener("load", () => {
        /* The iframe load commit is the attribution boundary for the
           players that emit no reliable ready event (MegaPlay) — and for
           animegg, whose embed page emits no documented postMessage events
           at all. Nothing is auto-switched either way. */
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
    /* The poller reads `iframe` dynamically, so it survives a rebuild. It is
       started ONCE — never per switch. */
    setInterval(containFocus, 100);

    // Keyboard Shortcuts (only when activeElement is not an input/textarea)
    window.addEventListener("keydown", (e) => {
      const tag = document.activeElement ? document.activeElement.tagName : "";
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (e.code === "KeyF") {
        e.preventDefault();
        toggleFullscreen();
        return;
      }
      /* Space/arrows drive the ZOKO postMessage bridge only. On the backup
         they are left to Uqload's own player (no fake site controls). */
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
      /* No M shortcut: the Zoko embed exposes no mute/volume postMessage
         command (verified against its live command dispatcher), so a site
         mute control would be fake. The embed's own volume control is the
         real mute path. */
    });

    // Fullscreenchange event: report state back to player
    document.addEventListener("fullscreenchange", () => {
      sendPlayerCommand({ type: "fullscreen", active: !!document.fullscreenElement });
      /* TVplus: report the state back too, so its fullscreen icon stays in
         sync with reality (the embed ignores messages it doesn't
         understand, so this is harmless if it never asked). */
      if (activeServer === "backup" && iframe && iframe.contentWindow) {
        try {
          iframe.contentWindow.postMessage(
            { source: "aniflick", type: "fullscreen", active: !!document.fullscreenElement },
            BACKUP_ORIGIN
          );
        } catch {}
      }
    });

    // Watchlist Toggle (wlBtn is resolved at the top of initWatchPage)
    function updateWatchlistBtn(inList) {
      if (!wlBtn) return;
      wlBtn.setAttribute("data-active", inList ? "true" : "false");
      wlBtn.innerHTML = inList ? "✓ In My List" : "+ Add to List";
      wlBtn.style.color = inList ? "var(--zoro-lime)" : "#fff";
    }

    if (wlBtn) {
      wlBtn.addEventListener("click", async () => {
        /* Live titles are not catalog rows — they are never added to the
           watchlist (this feature writes nothing to the catalog). */
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

    /* Bootstrap: load the title, then start the episode from the URL.
       Starting the episode here is what makes Resume land on the saved
       episode at the saved position (the saved offset is applied through
       the embed's &t= parameter). */
    async function startWatch() {
      /* LIVE titles: the episode metadata depends on the title (runtime),
         so the title loads FIRST — the episode is then derived from it. */
      if (isLive) {
        const loaded = await loadTitleData();
        if (!loaded) return;
        /* A live title with NO MAL id cannot play on Zoko at all (its
           /stream/anilist/ route is dead upstream). Start it on the WORKING
           TVplus AniList route instead — this is the initial server for a
           title Zoko cannot serve, not an auto-switch away from a failing
           player, and the viewer can still pick any server manually.
           sessionStorage is deliberately NOT written here: that store is the
           viewer's own server choice, and a title-level default must not leak
           onto the next title they open. */
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
      /* Title and episode metadata are independent: fetch both at once. */
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
        /* Reflect the session's server choice (or the ?player=backup /
           ?player=megaplay / ?player=animegg test hook) BEFORE the first
           load: pills, toggles and badge must be honest from the first
           frame. The note itself is recomputed by loadEpisode — animegg
           needs a live availability answer before it can say anything. */
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
    /* Live titles have no catalog slug — comments are a catalog feature. */
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
          list.innerHTML = `<p style="color: var(--text-muted); font-size: 0.85rem; padding: 12px 0;">No comments on this episode yet. Be the first to start the discussion!</p>`;
          return;
        }
        list.textContent = "";
        for (const c of comments) list.appendChild(buildCommentNode(c));
      } else {
        if (countEl) countEl.textContent = "Comments unavailable";
        list.innerHTML = `
          <p style="color: var(--text-muted); font-size: 0.85rem; padding: 12px 0;">
            Comments could not be loaded.
            <button class="btn-zoro-primary" type="button" id="comments-retry-btn" style="padding: 0.3rem 0.8rem; font-size: 0.75rem; margin-left: 6px;">Retry</button>
          </p>`;
        const retryBtn = list.querySelector("#comments-retry-btn");
        if (retryBtn) retryBtn.addEventListener("click", () => loadComments(true));
      }
    }

    // Bind the form only once - the episode can change without a reload.
    if (form && form.dataset.zoroCommentsBound !== "true") {
      form.dataset.zoroCommentsBound = "true";
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const text = input ? input.value.trim() : "";
        if (!text) return;

        /* Guests post with a display name; a signed-in user's name is their
           account name (the server ignores `name` when a session is present). */
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

    /* Guest comments: the box is ALWAYS usable. Signed out, a name field
       appears above the textarea; signed in, it is hidden and the account
       name is used. (The old signed-out state disabled the textarea and
       forced a sign-in — Phase 3b removes that gate.) */
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

  /* ==========================================================================
     DETAIL PAGE (Phase 1): real metadata hero, episode list, recommendations
     ========================================================================== */

  /* ==========================================================================
     LIVE DETAIL PAGE — detail.html?live=<anilistId>
     Same layout as the catalog detail page, fed by /api/live/:id. No DB
     write, no catalog import: a live title is never added to the catalog.
     ========================================================================== */

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
    /* Aired episodes: an airing title's last aired episode is the next one
       minus one; a finished title has all of them. */
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
      /* Live posters come from AniList's CDN, which 403s hotlinked requests
         carrying a Referer; a failed poster falls back instead of collapsing. */
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

    /* Badges: the 18+ tag comes from the SERVER flag (Ecchi genre). Live
       titles have no dub data at all — never a DUB badge or count. The SUB
       count is the ONE canonical episode count the server sent for this
       title (the same number the cards show); when even that is unknown the
       badge is hidden rather than shown without a number. */
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
    /* A live title has no dub data (AniList knows nothing about dubs), so the
       track label must never claim SUB / DUB. */
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
      /* AniList TAGS (not genres) are a separate list; they link to the same
         tag filter the browse panel uses. No tags -> nothing is appended. */
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
      /* No episodes (a title with no episode list) has nothing to watch —
         the button is hidden instead of leading to an empty player. */
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

    /* No watchlist row for live titles — the catalog is never written to. */
    const listBtn = document.getElementById("detail-add-list");
    if (listBtn) listBtn.hidden = true;

    /* Remind Me (live-browser defect #2): airing + upcoming live titles get
       the same persisted reminder as the schedule page (keyed live-<id>,
       listed in the schedule page's "Your Reminders"). Finished titles
       have nothing to remind about, so the button stays hidden for them. */
    if (titleNeedsReminder(t.status)) {
      wireDetailRemindButton(document.getElementById("detail-remind"), `live-${liveId}`, t.name);
    }

    /* Episode list: only the AIRED episodes. */
    const epList = document.getElementById("detail-episode-list");
    if (epList) {
      if (episodesUnknown) {
        epList.innerHTML = `<p style="color:var(--text-muted);padding:12px 0;">Episode list unavailable for this title.</p>`;
      } else if (!airedCount) {
        epList.innerHTML = `<p style="color:var(--text-muted);padding:12px 0;">No episodes have aired yet${next ? ` — Ep ${next.episode} airs on ${escapeHtml(formatAiringDate(next.airingAt))}.` : "."}</p>`;
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

    /* Phase 2 live metadata. Every section is HIDDEN until it has data — an
       empty studios list or an anime with no relations renders nothing. */
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

    /* "More Like This": AniList's own recommendation edges, already fetched
       with the detail payload and adult-screened server-side. ONE renderer
       shared with the catalog detail page; an empty set hides the section. */
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

    /* Live titles (?live=<anilistId>) reuse this layout but are fed by
       /api/live/:id — never by the local catalog. */
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

    // ?slug= is the canonical key; ?id= is accepted as an alias for stable
    // deep-linking (watchlist/progress/history keys all live under slugs).
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

    /* ?id= may carry a slug OR a real title ("solo-leveling", "Solo Leveling",
       "naruto"). Resolve deterministically: a direct slug hit wins; otherwise
       match the value against the slugified name / real_title / romaji of
       every catalog title (punctuation- and case-insensitive, so spaces and
       hyphens are interchangeable). No fuzzy substring matching — that could
       land on the wrong show. */
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
    // Everything below keys off the RESOLVED slug (Watch Now links, episode
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
    // Detail page badges: the DUB count comes from the server's per-episode
    // dub probes (dub_checks), never a copy of the SUB count. No confirmed
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

    // Add to My List (reuses the existing watchlist API).
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

    /* Remind Me (live-browser defect #2): the same persisted reminder as
       the schedule page, keyed by slug. Only airing/upcoming titles get
       it — finished catalog titles keep the button hidden. */
    if (titleNeedsReminder(t.status)) {
      wireDetailRemindButton(document.getElementById("detail-remind"), slug, t.name);
    }

    // Episode list (all episodes, each links to the watch page).
    const epList = document.getElementById("detail-episode-list");
    if (epList) {
      if (!episodes.length) {
        epList.innerHTML = `<p style="color:var(--text-muted);padding:12px 0;">No episodes available for this title.</p>`;
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
      /* A film's single row spans the full list width (2-col grid otherwise). */
      epList.classList.toggle("single-episode", episodes.length === 1);
    }

    // Recommendations: up to 6 same-genre catalog titles, rendered by the
    // ONE shared "More Like This" renderer the live detail page and the watch
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

  /* ==========================================================================
     SCHEDULE PAGE LOGIC
     ========================================================================== */

  /* Broadcast slots carry ONLY the time + catalog slug. Episode counts,
     kind, studio and cover art are derived from the LIVE catalog at render
     time — the old static ep/kind/studio/img filler drifted from the real
     counts (Chainsaw Man "Ep 22" vs 12, Naruto "Ep 24" vs 220, Frieren
     "Ep 25" vs 28, films labelled with week-long episode numbers). */
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

    // Real titles + local covers come from the catalog (coalesced/prefetched),
    // so the schedule never shows the old placeholder names or stock photos.
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

    // Determine current day of week by visitor's LOCAL date (Bug 6)
    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const nowLocal = new Date();
    const currentDayName = dayNames[nowLocal.getDay()];

    /* REMINDERS — the store helpers (readReminders / writeReminders /
       isReminded / toggleReminder) and BELL_SVG live in the SHARED section
       near liveStatusLabel: the detail pages use the same store (defect #2,
       23 Nov). This page owns only the schedule-specific rendering below. */
    function activeDayKey() {
      const active = document.querySelector(".schedule-day-tab.active");
      return (active && active.dataset.day) || currentDayName;
    }
    function renderReminders() {
      const box = document.getElementById("schedule-reminders");
      if (!box) return;
      const list = readReminders();
      if (!list.length) { box.innerHTML = ""; box.hidden = true; return; }
      /* Airing day/time come from the same weekly grid as the timeline. */
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
        timelineEl.innerHTML = `<p style="color: var(--text-muted); padding: 2rem; text-align: center;">Schedule is temporarily unavailable — the catalog could not be loaded.</p>`;
        return;
      }
      /* Only real catalog entries render — never placeholder filler. */
      const items = slots
        .map((slot) => ({ slot, real: titleMap[slot.slug] }))
        .filter((x) => x.real && x.real.name);
      if (!items.length) {
        timelineEl.innerHTML = `<p style="color: var(--text-muted); padding: 2rem; text-align: center;">No scheduled releases for this day.</p>`;
        return;
      }

      timelineEl.innerHTML = items.map(({ slot, real }) => {
        const isFilm = (real.kind || "").toLowerCase() === "film";
        const epCount = real.episodes || 1;
        /* Series link to their LATEST available episode (the catalog count);
           films are a single feature. */
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
                <span style="color: var(--text-muted); font-size: 0.75rem;">• ${escapeHtml(studio)}</span>
              </div>
            </div>
          </div>
          <div class="schedule-item-right">
            <button class="btn-remind-slot${isReminded(slot.slug) ? " is-set" : ""}" type="button" data-slug="${escapeHtml(slot.slug)}" data-title="${escapeHtml(name)}">
              ${isReminded(slot.slug) ? "✓ Alert Set" : `${BELL_SVG} Remind Me`}
            </button>
            <a class="btn-zoro-primary" href="${wHref}" style="padding: 0.55rem 1rem;">
              ${watchLabel}
            </a>
          </div>
        </div>
      `;
      }).join("");

      // Remind buttons — toggle a real persisted reminder (fix #9)
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
    /* The date numbers follow the CURRENT week (Monday-start) — the old
       static 16–22 were filler that went stale every week. */
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

    // Activate today's tab initially (or first tab)
    const todayTab = document.querySelector(`.schedule-day-tab[data-day="${currentDayName}"]`) || dayTabs[0];
    if (todayTab) {
      dayTabs.forEach((t) => t.classList.remove("active"));
      todayTab.classList.add("active");
      renderScheduleForDay(todayTab.dataset.day);
    }

    /* The schedule is static content: it is ready as soon as it is rendered. */
    markContentReady();
  }

  /* ==========================================================================
     LIFECYCLE INITIALIZATION
     ========================================================================== */

  /* The intro is started as soon as the script runs. Waiting for
     DOMContentLoaded delayed it by the full asset load, which pushed the
     first paint of every session past the intro's own runtime. */
  if (document.body) initAizenIntro();

  document.addEventListener("DOMContentLoaded", () => {
    initThemeToggle();
    initMobileDrawer();
    initSearch();

    /* The schedule is static data: render it first so it never waits on the API. */
    initSchedulePage();

    /* Everything below is independent, so it all starts at once instead of
       queueing behind one another (that chain was the 15s "empty boxes"). */
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

    /* The continue-watching rail needs the resolved auth state. */
    authReady.then(() => initContinueWatchingRail());

    /* Pages whose content is plain HTML (Genres) have nothing to wait for. */
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

    /* Back-to-top button (every page): appears after scrolling down and
       returns to the top on click. */
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

    /* Footer (c) year follows the current year. */
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
