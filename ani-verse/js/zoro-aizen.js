(function () {
  "use strict";

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

  /* ---- Real metadata helpers (Phase 1) ----
     Local cover art is the primary image; the remote URL is only a fallback.
     Title cards/links navigate to the detail page; explicit "Watch"/"Resume"
     actions go straight to the watch page. */
  const COVER_FALLBACK = "img/banner.jpg";
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

  function coverOf(t) {
    return (t && (t.cover || t.coverLocal)) || COVER_FALLBACK;
  }
  function bannerOf(t) {
    return (t && (t.banner || t.bannerLocal || t.cover || t.coverLocal)) || COVER_FALLBACK;
  }
  function detailHref(slug) {
    return `detail.html?slug=${encodeURIComponent(slug)}`;
  }
  function watchHref(slug, ep) {
    return `watch.html?slug=${encodeURIComponent(slug)}&ep=${encodeURIComponent(ep == null ? 1 : ep)}`;
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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

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
    toast.innerHTML = `
      <div class="aizen-toast-icon">${icon}</div>
      <span>${message}</span>
    `;

    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add("toast-leave");
      setTimeout(() => toast.remove(), 260);
    }, duration);
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
              <div class="zoro-brand-icon">Z</div>
              <span>Ani<span class="verse">Verse</span></span>
            </a>
            <button class="mobile-drawer-close" type="button" aria-label="Close Menu">&times;</button>
          </div>
          <nav class="mobile-drawer-links">
            <a class="mobile-drawer-link" href="index.html">🏠 Home</a>
            <a class="mobile-drawer-link" href="browse.html">🔍 Browse Catalog</a>
            <a class="mobile-drawer-link" href="genres.html">📑 All Genres</a>
            <a class="mobile-drawer-link" href="schedule.html">📅 Broadcast Schedule</a>
            <a class="mobile-drawer-link" href="browse.html?genre=action">🔥 Action Anime</a>
            <a class="mobile-drawer-link" href="browse.html?genre=fantasy">✨ Fantasy & Isekai</a>
            <a class="mobile-drawer-link" href="browse.html?view=top-airing&sort=newest">⭐ Top Airing</a>
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
            <input id="reg-email" name="email" type="email" placeholder="you@domain.com" required>
          </div>
          <div class="input-field-group">
            <label for="reg-password">Password</label>
            <input id="reg-password" name="password" type="password" placeholder="At least 8 characters" required>
          </div>
          <button class="btn-zoro-primary" id="btn-auth-submit" type="submit" style="width: 100%; justify-content: center; margin-top: 1rem; padding: 0.75rem;">Sign In</button>
        </form>
        <button class="btn-demo-quick" id="btn-quick-demo" type="button">⚡ Quick Demo Login (Akihiro)</button>
      </div>
    `;

    document.body.appendChild(modal);

    let activeTab = "login";
    const form = modal.querySelector("#zoro-auth-form");
    const nameGroup = modal.querySelector("#group-auth-name");
    const submitBtn = modal.querySelector("#btn-auth-submit");
    const errorBox = modal.querySelector("#modal-error-msg");
    const tabBtns = modal.querySelectorAll(".modal-tab-btn");
    const closeBtn = modal.querySelector(".modal-close-cross");
    const demoBtn = modal.querySelector("#btn-quick-demo");

    function setTab(tab) {
      activeTab = tab;
      errorBox.style.display = "none";
      tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
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

    demoBtn.addEventListener("click", async () => {
      errorBox.style.display = "none";
      demoBtn.disabled = true;
      demoBtn.textContent = "Logging in...";
      const res = await api("/api/auth/login", {
        method: "POST",
        body: { email: "demo@aniverse.io", password: "password123" },
      });
      demoBtn.disabled = false;
      demoBtn.textContent = "⚡ Quick Demo Login (Akihiro)";
      if (res.ok && res.data.user) {
        currentUser = res.data.user;
        modal.classList.remove("is-active");
        updateHeaderUser();
        window.dispatchEvent(new CustomEvent("zoro:auth", { detail: currentUser }));
      } else {
        errorBox.textContent = (res.data && res.data.error && res.data.error.message) || "Login failed";
        errorBox.style.display = "block";
      }
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

      debounceTimer = setTimeout(async () => {
        const res = await api(`/api/titles?q=${encodeURIComponent(q)}&limit=5`);
        if (res.ok && res.data && res.data.titles && res.data.titles.length > 0) {
          dropdown.innerHTML = res.data.titles
            .map((t) => `
              <a class="search-result-item" href="${detailHref(t.slug)}">
                <img class="search-result-thumb" src="${coverOf(t)}" alt="${escapeHtml(t.name)}" loading="lazy">
                <div class="search-result-info">
                  <div class="search-result-title">${escapeHtml(t.name)}</div>
                  <div class="search-result-meta">
                    <span>${t.year || 2025}</span> • <span>${t.kind || "Series"}</span> • <span style="color: var(--zoro-sub);">SUB ${t.episodes || 1}</span>
                  </div>
                </div>
              </a>
            `)
            .join("");
          dropdown.classList.add("is-open");
        } else {
          dropdown.innerHTML = `<div style="padding: 12px; font-size: 0.8rem; color: var(--text-muted); text-align: center;">No anime found for "${escapeHtml(q)}"</div>`;
          dropdown.classList.add("is-open");
        }
      }, 200);
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
      if (window.location.pathname.endsWith("browse.html")) {
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

    // Submit on Enter
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitSearch();
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
      if (slides[currentSlide]) slides[currentSlide].classList.remove("is-active");
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
              <span class="badge badge-sub">SUB ${t.episodes || 1}</span>
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
                    <span class="badge-mini-sub">SUB</span>
                  </div>
                  <span class="badge-mini-ep">Ep ${epNum}</span>
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
     5. ZORO TRENDING RAIL & 4-COLUMN SECTIONS
     ========================================================================== */

  async function initTrendingAndColumns() {
    const trendingRail = document.getElementById("trending-rail-container");
    const airingList = document.getElementById("col-airing-list");
    const popularList = document.getElementById("col-popular-list");
    const favoriteList = document.getElementById("col-favorite-list");
    const completedList = document.getElementById("col-completed-list");

    /* First paint: skeleton placeholders hold the rail/column layout while
       the catalog API answers — never empty dark boxes (Bug 9). */
    if (trendingRail && !trendingRail.querySelector(".trending-item")) {
      trendingRail.innerHTML = Array.from({ length: 7 }, () => `
        <div class="trending-item trending-item-skeleton" aria-hidden="true">
          <div class="trending-poster-wrap skeleton-shimmer"></div>
        </div>
      `).join("");
    }
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

    // 1. Trending Top 10
    if (trendingRail) {
      trendingRail.innerHTML = allTitles.slice(0, 10).map((t, i) => `
        <a class="trending-item" href="${detailHref(t.slug)}">
          <div class="trending-poster-wrap">
            <img src="${coverOf(t)}" alt="${escapeHtml(t.name)}" loading="lazy" decoding="async" fetchpriority="low">
            <div class="trending-rank-num">${(i + 1 < 10 ? "0" : "") + (i + 1)}</div>
            <div class="trending-info-overlay">
              <div class="trending-anime-title">${escapeHtml(t.name)}</div>
              <div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 2px;">
                <span style="color: var(--zoro-sub);">SUB ${t.episodes || 1}</span> • <span>${t.year}</span>
              </div>
            </div>
          </div>
        </a>
      `).join("");

      const trendingPrev = document.getElementById("trending-prev");
      const trendingNext = document.getElementById("trending-next");
      /* Jump by WHOLE cards, landing exactly on a card boundary. Instant
         (not smooth) so no card is ever sliced mid-scroll; manual wheel/touch
         scrolling still settles whole via scroll-snap. The landing is
         computed from live FRACTIONAL rects (card edge -> rail edge), never
         from rounded scrollWidth/clientWidth integers — integer math let
         Chrome's device-pixel rounding shave a sub-pixel sliver off the edge
         card. At the end, the LAST card's right edge aligns flush instead. */
      const scrollTrendingBy = (dirCards) => {
        const items = Array.from(trendingRail.querySelectorAll(".trending-item"));
        if (!items.length) return;
        const railRect = trendingRail.getBoundingClientRect();
        const gap = parseFloat(getComputedStyle(trendingRail).columnGap) || 20;
        const step = items[0].getBoundingClientRect().width + gap;
        const visibleCount = Math.max(1, Math.round(railRect.width / step));
        const lastStartIdx = Math.max(0, items.length - visibleCount);
        const idx = Math.round(trendingRail.scrollLeft / step);
        const targetIdx = Math.min(lastStartIdx, Math.max(0, idx + dirCards));
        let target;
        if (targetIdx >= lastStartIdx && items.length > visibleCount) {
          const lastRect = items[items.length - 1].getBoundingClientRect();
          target = trendingRail.scrollLeft + (lastRect.right - railRect.right);
        } else {
          const cardRect = items[targetIdx].getBoundingClientRect();
          target = trendingRail.scrollLeft + (cardRect.left - railRect.left);
        }
        trendingRail.scrollTo({ left: Math.max(0, target), behavior: "instant" });
      };
      if (trendingPrev && trendingPrev.dataset.bound !== "true") {
        trendingPrev.dataset.bound = "true";
        trendingPrev.addEventListener("click", () => scrollTrendingBy(-2));
      }
      if (trendingNext && trendingNext.dataset.bound !== "true") {
        trendingNext.dataset.bound = "true";
        trendingNext.addEventListener("click", () => scrollTrendingBy(2));
      }
    }

    // 2. 4 Columns
    function renderColItems(container, items) {
      if (!container) return;
      container.innerHTML = items.map((t) => `
        <a class="col-item" href="${detailHref(t.slug)}">
          <img class="col-thumb" src="${coverOf(t)}" alt="${escapeHtml(t.name)}" loading="lazy" decoding="async" fetchpriority="low">
          <div class="col-item-details">
            <div class="col-item-title" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</div>
            <div class="col-item-meta">
              <span class="badge-mini-sub">SUB</span>
              ${t.dubCount > 0 ? `<span class="badge-mini-dub">DUB ${t.dubCount}</span>` : ""}
              <span>Ep ${t.episodes || 1}</span>
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

    const isBrowse = window.location.pathname.endsWith("browse.html");
    const PAGE_SIZE = 12;

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
                <span class="badge-mini-sub">SUB</span>
                ${t.dubCount > 0 ? `<span class="badge-mini-dub">DUB ${t.dubCount}</span>` : ""}
              </div>
              <span class="badge-mini-ep">Ep ${t.episodes || 1}</span>
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

  function attachTooltipListeners() {
    const tip = createHoverTooltip();
    const cards = document.querySelectorAll(".zoro-card");

    cards.forEach((card) => {
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

  /* One display label per genre everywhere: the curated label when known
     ("life" -> "Slice of Life"), otherwise capitalised ("drama" -> "Drama").
     Raw lowercase keys must never leak into chips/tooltips. */
  function genreLabel(g) {
    const k = String(g || "").toLowerCase();
    return (GENRE_META[k] && GENRE_META[k].label) || k.charAt(0).toUpperCase() + k.slice(1);
  }

  async function initGenresPage() {
    const grid = document.querySelector(".genres-shelf-grid");
    if (!grid) return;

    const res = await api("/api/genres");
    if (!res.ok || !res.data || !res.data.counts) return;
    const counts = res.data.counts;

    const keys = Object.keys(counts).sort(
      (a, b) => counts[b] - counts[a] || a.localeCompare(b)
    );

    grid.innerHTML = keys
      .map((key) => {
        const meta = GENRE_META[key] || {
          icon: "🎬",
          kanji: "棚",
          label: key.charAt(0).toUpperCase() + key.slice(1),
          desc: "Explore this curated shelf of titles.",
        };
        const cnt = counts[key];
        return `
          <a class="genre-shelf-card" href="browse.html?genre=${encodeURIComponent(key)}" data-genre="${key}">
            <div class="genre-card-watermark">${meta.kanji}</div>
            <div class="genre-card-top">
              <div class="genre-card-icon-pill">${meta.icon}</div>
              <span class="genre-card-count">${cnt} ${cnt === 1 ? "Title" : "Titles"}</span>
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
    const currentSlug = params.get("slug") || "kagerou-protocol";
    let currentEp = parseInt(params.get("ep"), 10) || 1;
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

    const iframe = document.getElementById("zoko-embed-frame");
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
       SERVER STATE — Zoko is PRIMARY; animeTVplus is a fallback only.
       The choice is session-scoped (sessionStorage): a fresh tab always
       starts on Zoko, a reload inside the same tab keeps the choice.
       ?player=backup is a harmless test hook that starts on the backup.
       ------------------------------------------------------------------ */
    const SS_SERVER_KEY = "av_player_server";
    const BACKUP_ORIGIN = "https://embed.animetvplus.site";
    let activeServer = "zoko";
    try {
      if (sessionStorage.getItem(SS_SERVER_KEY) === "backup") activeServer = "backup";
    } catch {}
    if (params.get("player") === "backup") {
      activeServer = "backup";
      try { sessionStorage.setItem(SS_SERVER_KEY, "backup"); } catch {}
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

    function getBackupEmbedUrl(epNum, startTime, restart) {
      const ex = BACKUP_ID_EXCEPTIONS[currentSlug];
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
       ------------------------------------------------------------------ */
    const ZOKO_NO_READY_TIMEOUT_MS = 45000;
    const ZOKO_PROBE_ABORT_MS = 20000;
    const BACKUP_NO_READY_TIMEOUT_MS = 45000;
    let loadToken = 0;
    let zokoFailTimer = null;
    let backupFailTimer = null;
    let fallbackOfferVisible = false;
    /* When the last Zoko error event arrived. Recovery (offer/overlay hide)
       requires playback evidence MORE than 2s after the error: the old
       document keeps emitting in-flight time events for ~0.5s after a fatal
       error, and a single stale event must not withdraw the offer. */
    let lastZokoErrorAt = 0;
    const ZOKO_RECOVERY_GUARD_MS = 2000;
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

    function armZokoFailureDetection(streamUrl, token) {
      if (zokoFailTimer) clearTimeout(zokoFailTimer);
      zokoFailTimer = setTimeout(() => {
        zokoFailTimer = null;
        if (token !== loadToken || activeServer !== "zoko" || playerReady) return;
        showFallbackOffer();
      }, ZOKO_NO_READY_TIMEOUT_MS);
      /* Reachability probe of the exact embed URL (see detection notes). */
      const ctl = new AbortController();
      const abortTimer = setTimeout(() => ctl.abort(), ZOKO_PROBE_ABORT_MS);
      fetch(streamUrl, { mode: "no-cors", credentials: "omit", cache: "no-store", signal: ctl.signal })
        .then(() => { clearTimeout(abortTimer); })
        .catch((err) => {
          clearTimeout(abortTimer);
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
        if (spinner) spinner.hidden = true;
        showBackupNote("TVplus player isn't responding.");
      }, BACKUP_NO_READY_TIMEOUT_MS);
    }

    /* Swap the iframe in place — no page reload, no lost comment draft, no
       lost resume notice. The last observable position travels with the
       switch (Zoko reports time events; the backup exposes none, so this
       captured position is also what a later switch BACK resumes from). */
    function switchServer(server) {
      if (server !== "zoko" && server !== "backup") return;
      if (server === activeServer) return;
      const pos = Math.floor(currentPosition || 0);
      activeServer = server;
      try { sessionStorage.setItem(SS_SERVER_KEY, server); } catch {}
      applyServerUI();
      if (server === "backup") {
        showBackupNote("TVplus player active — audio depends on the source file. Press Play inside the player.");
      } else {
        hideFallbackNote();
      }
      loadEpisode(currentEp, null, false, pos);
    }

    /* One place owns the server-dependent UI: pills, track availability,
       Zoko-only settings, cover badge. preferredTrack / av_zoko_track are
       NEVER written here — the viewer's Dub choice survives the backup. */
    function applyServerUI() {
      const onBackup = activeServer === "backup";
      if (serverSwitcher) {
        serverSwitcher.querySelectorAll(".server-pill").forEach((p) => {
          p.classList.toggle("active", p.dataset.server === activeServer);
        });
      }
      if (iframe) iframe.title = onBackup ? "TVplus player" : "ZokoAnime player";
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
          } else {
            p.disabled = false;
            p.classList.remove("is-disabled");
            p.title = "";
          }
        });
        if (!onBackup) applyTrackPill(currentTrack);
      }
      if (settingToggles) {
        settingToggles.querySelectorAll("input[data-setting]").forEach((cb) => {
          cb.disabled = onBackup;
          const label = cb.closest(".zoko-toggle");
          if (label) {
            label.classList.toggle("is-disabled", onBackup);
            label.title = onBackup ? "Not available on the TVplus player" : "";
          }
        });
      }
      const coverBadge = document.getElementById("player-cover-badge");
      if (coverBadge) {
        coverBadge.innerHTML = onBackup
          ? '<span style="color: var(--zoro-lime);">⚡</span> Stream with TVplus (press Play)'
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

    // Spec-compliant embed URL builder (ZokoAnime spec only)
    function getEmbedUrl(malId, epNum, track, opts = {}) {
      if (!malId) {
        showToast("No MAL ID mapped for this title");
        return null;
      }
      const color = "cae962";
      const ap = opts.autoplay ? 1 : 0;
      const as = opts.autoskip ? 1 : 0;
      const an = opts.autonext ? 1 : 0;
      let url = `https://zokoanime.video/stream/mal/${malId}/${epNum}/${track}?color=${color}&autoplay=${ap}&autoskip=${as}&autonext=${an}`;
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
      return (titleData && titleData.episodes) || episodesList.length || 0;
    }

    /* Load Title Details (retryable) */
    async function loadTitleData() {
      hideDataError();
      const titleRes = await api(`/api/titles/${encodeURIComponent(currentSlug)}`);
      if (!titleRes.ok || !titleRes.data || !titleRes.data.title) {
        showPlaceholder("Could not load episode data");
        showDataError(
          titleRes.error === "Request timed out"
            ? "The server took too long to respond. Check your connection and retry."
            : "This title could not be loaded from the server.",
          startWatch
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
      markContentReady();
      return true;
    }

    // Build episodes grid
    function renderEpisodesGrid() {
      if (!epGrid) return;

      const totalEps = totalEpisodes();
      if (!totalEps) {
        epGrid.innerHTML = `<p class="ep-grid-status">No episodes available for this title.</p>`;
        return;
      }

      // Update range tabs label (Bug 7)
      const rangeTabs = document.querySelector(".ep-range-tabs");
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
      if (epGrid.dataset.delegatedBound !== "true") {
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
        nextBtn.disabled = atEnd || totalEps === 0;
        nextBtn.style.opacity = nextBtn.disabled ? "0.5" : "1";
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
        if (epSubtitle && isCurrent) epSubtitle.textContent = `Episode ${ep.epNum}: ${ep.title}`;
        return ep;
      } else {
        if (epSubtitle && isCurrent) epSubtitle.textContent = `Episode ${epNum}`;
        return null;
      }
    }

    // Load an episode
    /* Episode metadata only needs the slug + episode number, so it is fetched
       in parallel with the title instead of after it. */
    function fetchEpisodeData(epNum) {
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
      resumeNote.innerHTML = `
        Resumed from ${formatTime(seconds)}
        <button class="btn-zoro-primary" id="resume-restart-btn" type="button" style="margin-left: 0.5rem; font-size: 0.75rem;">Restart</button>
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
      currentEp = epNum;
      activeEpisode = epNum;
      loadInFlight = true;
      loadToken++;
      const token = loadToken;
      /* New load: retire any previous failure-detection timers and (on Zoko)
         the previous failure offer. A backup-status note stays — the viewer
         is still on the backup player. */
      if (zokoFailTimer) { clearTimeout(zokoFailTimer); zokoFailTimer = null; }
      if (backupFailTimer) { clearTimeout(backupFailTimer); backupFailTimer = null; }
      if (activeServer === "zoko") hideFallbackNote();
      /* New load: retire any previous resume notice and its timers. */
      hideResumeNote();
      resumeNoteShownForLoad = false;
      resumeTimeForLoad = 0;
      loadStartedAt = Date.now();
      skippedThisLoad = false;
      seekCommandThisLoad = false;
      lastZokoErrorAt = 0;
      durationIsReal = false;
      playerReady = false;

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
         never leak into this one. Zoko-only: the backup has no dub. */
      const probePromise = activeServer === "zoko" ? probeDubAvailability(epNum) : null;

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
      const newUrl = `watch.html?slug=${encodeURIComponent(currentSlug)}&ep=${epNum}`;
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
      /* A newer episode switch started while this one was fetching: this
         load is stale and must not touch the player, the URL or the pills. */
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
        clearLocalProgress(currentSlug, epNum);
      } else if (positionOverride != null) {
        /* Server switch: carry the last observable position across servers
           (Zoko time events -> backup t= param, and back). */
        resumeTime = positionOverride >= 1 ? Math.floor(positionOverride) : 0;
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
      resumeTimeForLoad = resumeTime;
      /* The notice is for a MEANINGFUL resume only (>=5s — the same floor
         the resumable window uses). A server switch carrying a 1-4s
         position still resumes there, but re-showing "Resumed from 00:03"
         on every switch was noise. */
      if (resumeTime >= 5) showResumeNote(resumeTime);

      // Reflect the resumed position in the UI before the player reports back
      currentPosition = resumeTime;
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
        if (preferredTrack === "dub") {
          /* A dub needs proof: wait for this episode's probe before handing
             the dub URL to the embed. An answer already in the cache — a warm
             visit OR the seed from the title payload — IS that proof, so it is
             used immediately (no cold-load Sub→Dub flicker, no needless wait). */
          const avail = typeof knownAvail === "boolean" ? knownAvail : await probePromise;
          if (currentEp !== epNum) return; // viewer switched again while probing
          currentTrack = avail === true ? "dub" : "sub";
          applyTrackPill(currentTrack);
        } else {
          /* Sub and hard-sub exist for every episode — no probe gate. */
          currentTrack = preferredTrack === "hsub" ? "hsub" : "sub";
          applyTrackPill(currentTrack);
        }
        updateTrackLabel();
      }

      // Build the stream URL for the ACTIVE server (Zoko primary, backup fallback)
      let streamUrl;
      if (activeServer === "backup") {
        streamUrl = getBackupEmbedUrl(currentEp, resumeTime, startFromBeginning === true);
      } else {
        // Determine MAL ID (check custom override first, then title's malId)
        const malId = getCustomMalId(currentSlug) || (titleData && titleData.malId);
        streamUrl = getEmbedUrl(malId, currentEp, currentTrack, {
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

      if (!streamUrl) {
        loadInFlight = false;
        if (spinner) spinner.hidden = true;
        if (overlay) {
          overlay.hidden = false;
          if (overlayTitle) overlayTitle.textContent = "Stream unavailable";
          if (overlayText) overlayText.textContent = "No MAL ID mapped for this title, so the stream cannot be loaded.";
        }
        return;
      }

      if (iframe) {
        iframe.src = streamUrl;
        iframe.title = activeServer === "backup" ? "TVplus player" : "ZokoAnime player";
        /* playerEp flips when the NEW player reports `ready` — until then,
           in-flight events from the old document still belong to playerEp. */
      }
      /* The src is assigned: the load is over, so a track switch from now on
         swaps the src itself (exactly once). */
      loadInFlight = false;
      /* Arm failure detection for the server actually loading. */
      if (activeServer === "zoko") {
        armZokoFailureDetection(streamUrl, token);
      } else {
        armBackupFailureDetection(token);
      }
      if (spinner) {
        spinner.hidden = false;
        spinner.style.pointerEvents = "";
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

    /* Update the track label in the episode list header to reflect the true
       state of dub availability for the current episode. */
    function updateTrackLabel() {
      const label = document.getElementById("track-label");
      if (!label) return;
      /* On the backup the site cannot know the file's audio track — never
         advertise a specific track (SUB or DUB) there. */
      if (activeServer === "backup") {
        label.textContent = "—";
        return;
      }
      const avail = dubAvailability.get(Number(currentEp));
      label.textContent = avail === true ? "SUB / DUB" : "SUB";
    }

    if (trackSwitcher) {
      trackSwitcher.querySelectorAll(".server-pill").forEach((pill) => {
        pill.addEventListener("click", async () => {
          /* On the backup the Dub/Hard-sub pills are disabled; this guard
             keeps any stray activation from touching the track state. */
          if (activeServer !== "zoko") return;
          const requestedTrack = pill.dataset.track || "sub";
          const epAtClick = currentEp;

          if (requestedTrack === "dub") {
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
          writePreferredTrack(preferredTrack);
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
            const malId = getCustomMalId(currentSlug) || (titleData && titleData.malId);
            // Read current playback position BEFORE swapping the iframe src (Bug 5).
            // The embed honours time= (t= alone is ignored), so every track
            // switch resumes where the viewer was — dub included.
            const resumePos = Math.floor(currentPosition || 0);
            const newUrl = getEmbedUrl(malId, currentEp, currentTrack, {
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
        if (totalEps > 0 && currentEp < totalEps) loadEpisode(currentEp + 1);
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

    // Bi-directional postMessage listener: animeTVplus backup + ZokoAnime primary
    window.addEventListener("message", async (event) => {
      /* ---- animeTVplus backup embed ----------------------------------
         Docs-verified events: ready {mal, anilist, episode}, error {error,
         available}, info (reply to an info request). There are NO time /
         play / pause / ended events — so the backup gets no auto-next and
         its playback position is not observable (resume-back uses the last
         stored position). Every message carries source:"animetvplus-embed". */
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
          if (backupFailTimer) { clearTimeout(backupFailTimer); backupFailTimer = null; }
          /* No autoplay on the backup: reveal the player so the viewer can
             press Play INSIDE it. Our overlays must never block that click. */
          if (spinner) spinner.hidden = true;
          if (coverOverlay) coverOverlay.style.display = "none";
          showToast("TVplus player ready — press Play inside the player", "▶", 4000);
        } else if (bdata.type === "error") {
          if (backupFailTimer) { clearTimeout(backupFailTimer); backupFailTimer = null; }
          if (spinner) spinner.hidden = true;
          if (coverOverlay) coverOverlay.style.display = "none";
          /* The embed shows its own error screen inside the frame; the site
             adds the honest way back to the primary player. */
          const msg = bdata.error === "no_episode" ? "This episode isn't available on the TVplus player."
                    : bdata.error === "unknown_title" ? "This title isn't available on the TVplus player."
                    : "The TVplus player couldn't load this episode.";
          showBackupNote(msg);
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
        /* The player is demonstrably alive: retire the no-ready backstop and
           any failure offer (a slow load is NOT a failure). */
        if (zokoFailTimer) { clearTimeout(zokoFailTimer); zokoFailTimer = null; }
        if (fallbackOfferVisible) hideFallbackNote();
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
        if (currentUser && cur > 0 && now - lastProgressSync > 5000) {
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
        if (!currentUser && cur > 0 && now - lastLocalSave > 5000) {
          lastLocalSave = now;
          writeLocalProgress(currentSlug, playerEp, cur, dur);
        }

        /* Everything below is UI for the episode the page is showing — stale
           events from the previous episode must not touch it. */
        if (playerEp !== currentEp) return;
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
        const totalEps = (titleData && titleData.episodes) || episodesList.length || 12;
        if (playerSettings.autonext && currentEp < totalEps) {
          showToast(`Episode finished! Auto-playing Episode ${currentEp + 1}...`);
          setTimeout(() => loadEpisode(currentEp + 1), 1500);
        } else if (currentEp >= totalEps) {
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
    if (playerWrap) playerWrap.setAttribute("tabindex", "-1");
    if (iframe && playerWrap) {
      const containFocus = () => {
        /* Zoko-only: the site serves Space/arrows/F via the postMessage
           bridge, so focus must stay on the wrapper. On the backup there
           are no site shortcuts — let focus stay INSIDE Uqload's player so
           its own keyboard controls work. */
        if (activeServer !== "zoko") return;
        if (document.activeElement === iframe) {
          playerWrap.focus({ preventScroll: true });
        }
      };
      iframe.addEventListener("focus", containFocus);
      setInterval(containFocus, 100);
    }

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
        /* Reflect the session's server choice (or the ?player=backup test
           hook) BEFORE the first load: pills, toggles and badge must be
           honest from the first frame. */
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

    // Initialize comments for current episode
    initComments(currentSlug, currentEp);
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
        list.innerHTML = comments
          .map((c) => `
            <div class="single-comment">
              <div class="user-comment-avatar">${(c.user_name || "U")[0].toUpperCase()}</div>
              <div style="flex: 1;">
                <div>
                  <span class="comment-user-name">${c.user_name}</span>
                  <span class="comment-date">${new Date(c.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                </div>
                <div class="comment-body-text">${c.content}</div>
              </div>
            </div>
          `)
          .join("");
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
        if (!currentUser) {
          openAuthModal("login");
          return;
        }
        const text = input ? input.value.trim() : "";
        if (!text) return;

        const res = await api(`/api/comments/${encodeURIComponent(slug)}/${activeEpisode}`, {
          method: "POST",
          body: { content: text },
        });

        if (res.ok) {
          input.value = "";
          loadComments(true);
          showToast("Comment published!");
        }
      });
    }

    /* Signed-out state: posting requires sign-in, so the box must LOOK
       unavailable — disabled textarea, "Sign in to comment" placeholder and
       a button that opens the auth modal instead of pretending to post. */
    const submitBtn = form ? form.querySelector('button[type="submit"]') : null;
    function applyCommentAuthState() {
      if (!form || !input) return;
      const signedIn = !!currentUser;
      form.classList.toggle("is-signed-out", !signedIn);
      input.disabled = !signedIn;
      input.placeholder = signedIn
        ? "Join the discussion... Share your thoughts about this episode!"
        : "Sign in to comment";
      if (submitBtn) submitBtn.textContent = signedIn ? "Post Comment" : "Sign in to Comment";
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

  async function initDetailPage() {
    const stage = document.getElementById("detail-stage");
    if (!stage) return;

    const params = new URLSearchParams(window.location.search);
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
    document.title = `${t.name} - Ani Verse`;

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

    // Recommendations: up to 6 same-genre titles.
    const recWrap = document.getElementById("detail-recommendations");
    if (recWrap) {
      const allRes = await api("/api/titles?limit=100");
      if (allRes.ok && allRes.data && Array.isArray(allRes.data.titles)) {
        const myGenres = new Set((t.genres || []).map((g) => g.toLowerCase()));
        const recs = allRes.data.titles
          .filter((o) => o.slug !== slug)
          .map((o) => ({ o, shared: (o.genres || []).filter((g) => myGenres.has(g.toLowerCase())).length }))
          .filter((x) => x.shared > 0)
          .sort((a, b) => b.shared - a.shared || (b.o.score || 0) - (a.o.score || 0))
          .slice(0, 6)
          .map((x) => x.o);
        recWrap.innerHTML = recs.length
          ? recs
              .map((o) => `
                <div class="zoro-card" data-slug="${o.slug}">
                  <a class="zoro-card-poster" href="${detailHref(o.slug)}">
                    <img src="${coverOf(o)}" alt="${escapeHtml(o.name)}" loading="lazy" decoding="async">
                    <div class="zoro-play-overlay"><div class="zoro-play-circle">▶</div></div>
                    <div class="zoro-poster-badges">
                      <div class="badges-left"><span class="badge-mini-sub">SUB</span>${o.dubCount > 0 ? `<span class="badge-mini-dub">DUB ${o.dubCount}</span>` : ""}</div>
                      <span class="badge-mini-ep">Ep ${o.episodes || 1}</span>
                    </div>
                  </a>
                  <div class="zoro-card-info">
                    <a class="zoro-card-title" href="${detailHref(o.slug)}">${escapeHtml(o.name)}</a>
                    <div class="zoro-card-submeta"><span>${o.kind}</span> • <span>${o.year}</span></div>
                  </div>
                </div>
              `)
              .join("")
          : `<p style="color:var(--text-muted);">No similar titles yet.</p>`;
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
        const epBadge = isFilm
          ? `<span class="badge-mini-ep">Film${real.runtimeMin ? " • " + real.runtimeMin + "m" : ""}</span>`
          : `<span class="badge-mini-ep">Ep ${epCount}</span>`;
        const watchLabel = isFilm ? "▶ Watch Film" : `▶ Watch Ep ${watchEp}`;
        return `
        <div class="schedule-item-card">
          <div class="schedule-item-left">
            <div class="schedule-slot-time">${slot.time}</div>
            <a class="schedule-thumb" href="${dHref}">
              <img src="${cover}" alt="${escapeHtml(name)}" loading="lazy">
            </a>
            <div class="schedule-title-block">
              <a class="schedule-title-link" href="${dHref}">${escapeHtml(name)}</a>
              <div class="schedule-meta-badges">
                <span class="badge-mini-sub">SUB</span>
                ${real.dubCount > 0 ? `<span class="badge-mini-dub">DUB ${real.dubCount}</span>` : ""}
                ${epBadge}
                <span style="color: var(--text-muted); font-size: 0.75rem;">• ${escapeHtml(studio)}</span>
              </div>
            </div>
          </div>
          <div class="schedule-item-right">
            <button class="btn-remind-slot" type="button" data-title="${escapeHtml(name)}">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
              Remind Me
            </button>
            <a class="btn-zoro-primary" href="${wHref}" style="padding: 0.55rem 1rem;">
              ${watchLabel}
            </a>
          </div>
        </div>
      `;
      }).join("");

      // Remind buttons
      timelineEl.querySelectorAll(".btn-remind-slot").forEach((btn) => {
        btn.addEventListener("click", () => {
          const t = btn.dataset.title;
          btn.innerHTML = `✓ Alert Set`;
          btn.style.borderColor = "var(--zoro-lime)";
          btn.style.color = "var(--zoro-lime)";
          showToast(`Reminder alert registered for ${t}!`);
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
    initMobileDrawer();
    initSearch();

    /* The schedule is static data: render it first so it never waits on the API. */
    initSchedulePage();

    /* Everything below is independent, so it all starts at once instead of
       queueing behind one another (that chain was the 15s "empty boxes"). */
    const authReady = checkAuthSession();
    initSpotlightSlider();
    initTrendingAndColumns();
    initMainCatalogGrid();
    initGenresPage();
    initWatchPage();
    initDetailPage();

    /* The continue-watching rail needs the resolved auth state. */
    authReady.then(() => initContinueWatchingRail());

    /* Pages whose content is plain HTML (Genres) have nothing to wait for. */
    const hasDynamicContent = !!(
      document.getElementById("zoro-main-grid") ||
      document.getElementById("spotlight-slider-container") ||
      document.getElementById("schedule-timeline-container") ||
      document.getElementById("zoro-video-stage") ||
      document.getElementById("detail-stage")
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
