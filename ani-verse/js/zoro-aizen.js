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
            <a class="mobile-drawer-link" href="browse.html?sort=newest">⭐ Top Airing</a>
          </nav>
        </div>
      `;
      document.body.appendChild(backdrop);

      const closeBtn = backdrop.querySelector(".mobile-drawer-close");
      if (closeBtn) closeBtn.addEventListener("click", () => backdrop.classList.remove("is-open"));
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) backdrop.classList.remove("is-open");
      });
      /* Escape closes the drawer (it used to do nothing). */
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && backdrop.classList.contains("is-open")) {
          backdrop.classList.remove("is-open");
        }
      });
    }

    toggleBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        /* Toggle: clicking the hamburger again closes the drawer. */
        backdrop.classList.toggle("is-open");
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

      // Live filter Browse grid if currently on browse page (Bug 11)
      if (typeof window.__onSearchLiveFilter === "function") {
        window.__onSearchLiveFilter(q);
      }

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

    const res = await fetchTitles(18);
    if (!res.ok || !res.data || !res.data.titles || res.data.titles.length === 0) return;

    const titles = res.data.titles.slice(0, 5);

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
              <span class="badge badge-dub">DUB ${t.episodes || 1}</span>
              <span class="badge badge-type">${t.kind}</span>
              <span class="badge badge-hd">HD</span>
              <span style="font-size: 0.8rem; color: var(--text-sub); margin-left: 6px;">${t.year} • ${t.runtimeMin}m</span>
            </div>
            <p class="spotlight-desc">${escapeHtml(t.synopsis || t.tagline)}</p>
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

    let currentSlide = 0;
    const slides = sliderContainer.querySelectorAll(".spotlight-slide");

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
      slides[currentSlide].classList.remove("is-active");
      currentSlide = (n + slides.length) % slides.length;
      slides[currentSlide].classList.add("is-active");
      applyBackdrop(slides[currentSlide]);
    }

    applyBackdrop(slides[0]);

    const prevBtn = document.getElementById("spotlight-prev");
    const nextBtn = document.getElementById("spotlight-next");
    if (prevBtn) prevBtn.addEventListener("click", () => goToSlide(currentSlide - 1));
    if (nextBtn) nextBtn.addEventListener("click", () => goToSlide(currentSlide + 1));

    // Auto rotate every 6s
    let autoInterval = setInterval(() => goToSlide(currentSlide + 1), 6000);
    sliderContainer.addEventListener("mouseenter", () => clearInterval(autoInterval));
    sliderContainer.addEventListener("mouseleave", () => {
      clearInterval(autoInterval);
      autoInterval = setInterval(() => goToSlide(currentSlide + 1), 6000);
    });
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
      if (trendingPrev && trendingPrev.dataset.bound !== "true") {
        trendingPrev.dataset.bound = "true";
        trendingPrev.addEventListener("click", () => {
          const item = trendingRail.querySelector(".trending-item");
          const step = item ? item.offsetWidth + 20 : 200;
          trendingRail.scrollBy({ left: -step * 2, behavior: "smooth" });
        });
      }
      if (trendingNext && trendingNext.dataset.bound !== "true") {
        trendingNext.dataset.bound = "true";
        trendingNext.addEventListener("click", () => {
          const item = trendingRail.querySelector(".trending-item");
          const step = item ? item.offsetWidth + 20 : 200;
          trendingRail.scrollBy({ left: step * 2, behavior: "smooth" });
        });
      }
    }

    // 2. 4 Columns
    function renderColItems(container, items) {
      if (!container) return;
      container.innerHTML = items.map((t) => `
        <a class="col-item" href="${detailHref(t.slug)}">
          <img class="col-thumb" src="${coverOf(t)}" alt="${escapeHtml(t.name)}" loading="lazy" decoding="async" fetchpriority="low">
          <div class="col-item-details">
            <div class="col-item-title">${escapeHtml(t.name)}</div>
            <div class="col-item-meta">
              <span class="badge-mini-sub">SUB</span>
              <span class="badge-mini-dub">DUB</span>
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

    const res = await fetchTitles(18);
    if (!res.ok || !res.data || !res.data.titles) return;

    const titles = res.data.titles;

    function renderCards(list) {
      hideHoverTooltip();
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
        markContentReady();
        return;
      }

      grid.innerHTML = list.map((t) => `
        <div class="zoro-card" data-slug="${t.slug}" data-genres="${t.genres ? t.genres.join(" ") : ""}" data-title="${escapeHtml(t.name)}">
          <a class="zoro-card-poster" href="${detailHref(t.slug)}">
            <img src="${coverOf(t)}" alt="${escapeHtml(t.name)}" loading="lazy" decoding="async" fetchpriority="low">
            <div class="zoro-play-overlay">
              <div class="zoro-play-circle">▶</div>
            </div>
            <div class="zoro-poster-badges">
              <div class="badges-left">
                <span class="badge-mini-sub">SUB</span>
                <span class="badge-mini-dub">DUB</span>
              </div>
              <span class="badge-mini-ep">Ep ${t.episodes || 1}</span>
            </div>
          </a>
          <div class="zoro-card-info">
            <a class="zoro-card-title" href="${detailHref(t.slug)}">${escapeHtml(t.name)}</a>
            <div class="zoro-card-submeta">
              <span>${t.kind}</span> • <span>${t.runtimeMin}m</span>
            </div>
          </div>
        </div>
      `).join("");

      attachTooltipListeners();
      /* The card grid is the page's real content: release the intro. */
      markContentReady();
    }

    // Check URL parameters
    const urlParams = new URLSearchParams(window.location.search);
    const initialGenre = urlParams.get("genre");
    const initialQ = urlParams.get("q");
    const initialSort = urlParams.get("sort");

    const chipsWrap = document.getElementById("genre-chips-container");
    const sortSelect = document.getElementById("catalog-sort-select");

    let currentGenre = (initialGenre || "all").toLowerCase();
    let currentSearch = (initialQ || "").trim();
    let currentSort = initialSort || (sortSelect ? sortSelect.value : "popularity");

    if (chipsWrap && currentGenre !== "all") {
      const match = chipsWrap.querySelector(`[data-genre="${currentGenre}"]`);
      if (match) {
        chipsWrap.querySelectorAll(".genre-chip-zoro").forEach((c) => c.classList.remove("active"));
        match.classList.add("active");
      }
    }

    if (sortSelect && currentSort) {
      sortSelect.value = currentSort;
    }

    const searchInput = document.getElementById("zoro-search-input");
    if (searchInput && initialQ) {
      searchInput.value = initialQ;
    }

    function applyFilterAndSort() {
      hideHoverTooltip();
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

      // 2. Filter by genre
      if (currentGenre && currentGenre !== "all") {
        list = list.filter(
          (t) => t.genres && t.genres.some((g) => g.toLowerCase() === currentGenre)
        );
      }

      // 3. Sort by popularity, release date, or A-Z (Bug 7)
      if (currentSort === "newest") {
        list.sort((a, b) => (b.year || 0) - (a.year || 0) || (b.created_at || 0) - (a.created_at || 0));
      } else if (currentSort === "az") {
        list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      } else if (currentSort === "popularity") {
        // default catalog order (popularity)
      }

      renderCards(list);
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

    // Sort dropdown change (Bug 7)
    if (sortSelect) {
      sortSelect.addEventListener("change", () => {
        currentSort = sortSelect.value;
        applyFilterAndSort();
      });
    }

    // Hook up live search on Browse (Bug 11)
    window.__onSearchLiveFilter = (q) => {
      currentSearch = (q || "").trim();
      applyFilterAndSort();
    };
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
            <span><strong>Genres:</strong> ${t.genres ? t.genres.join(", ") : "Action"}</span>
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
    let currentTrack = "sub";

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
    let isPaused = true;
    let lastProgressSync = 0;

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

    // Helper: Send postMessage commands to ZokoAnime embed player
    function sendPlayerCommand(cmd) {
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
      setText("watch-detail-duration", `${titleData.runtimeMin || 24}m per ep`);
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
      if (epRes.ok && epRes.data && epRes.data.episode) {
        const ep = epRes.data.episode;
        if (epSubtitle) epSubtitle.textContent = `Episode ${ep.epNum}: ${ep.title}`;
        return ep;
      } else {
        if (epSubtitle) epSubtitle.textContent = `Episode ${epNum}`;
        return null;
      }
    }

    // Load an episode
    /* Episode metadata only needs the slug + episode number, so it is fetched
       in parallel with the title instead of after it. */
    function fetchEpisodeData(epNum) {
      return api(`/api/titles/${encodeURIComponent(currentSlug)}/episodes/${epNum}`);
    }

    async function loadEpisode(epNum, prefetched) {
      currentEp = epNum;
      activeEpisode = epNum;

      /* New episode: re-probe dub availability in the background (the Dub
         pill awaits this probe if it is still running when clicked). */
      dubAvailable = null;
      probeDubAvailability(epNum);

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
      if (!epData) {
        // Episode metadata could not be loaded: show a retry state instead of
        // leaving stale placeholder text on screen.
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
      if (typeof epData.savedPositionSec === "number") {
        const epDur = epData.durationSec || 1440;
        if (epData.savedPositionSec > 0 && epData.savedPositionSec < epDur - 10) {
          resumeTime = epData.savedPositionSec;
          if (resumeNote) {
            resumeNote.textContent = `Resumed from ${formatTime(resumeTime)}`;
            resumeNote.hidden = false;
            setTimeout(() => {
              if (resumeNote) resumeNote.hidden = true;
            }, 5000);
          }
        }
      }

      // Reflect the resumed position in the UI before the player reports back
      currentPosition = resumeTime;
      if (epData.durationSec) duration = epData.durationSec;
      if (progressFill && duration > 0) {
        progressFill.style.width = `${Math.min((resumeTime / duration) * 100, 100)}%`;
      }
      if (timeText) {
        timeText.textContent = `${formatTime(resumeTime)} / ${formatTime(duration)}`;
      }

      // Determine MAL ID (check custom override first, then title's malId)
      const malId = getCustomMalId(currentSlug) || (titleData && titleData.malId);
      const streamUrl = getEmbedUrl(malId, currentEp, currentTrack, {
        autoplay: playerSettings.autoplay,
        autoskip: playerSettings.autoskip,
        autonext: playerSettings.autonext,
        startTime: resumeTime,
      });

      if (!streamUrl) {
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
      }
      if (coverOverlay) {
        coverOverlay.style.display = "none";
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
       to play Japanese while claiming Dub). null = unknown / not probed yet. */
    let dubAvailable = null;
    let dubProbePromise = null;
    function probeDubAvailability(epNum) {
      dubProbePromise = api(`/api/dub-availability/${encodeURIComponent(currentSlug)}/${epNum}`).then((res) => {
        dubAvailable = res.ok && res.data && typeof res.data.available === "boolean" ? res.data.available : null;
        return dubAvailable;
      });
      return dubProbePromise;
    }

    if (trackSwitcher) {
      trackSwitcher.querySelectorAll(".server-pill").forEach((pill) => {
        pill.addEventListener("click", async () => {
          const requestedTrack = pill.dataset.track || "sub";
          if (requestedTrack === currentTrack) return;

          if (requestedTrack === "dub") {
            let avail = dubAvailable;
            if (avail === null) {
              showToast("Checking dub availability…", "⏳", 2500);
              avail = await (dubProbePromise || probeDubAvailability(currentEp));
            }
            if (avail !== true) {
              showToast(
                avail === false
                  ? "English dub not available for this episode"
                  : "Could not verify dub availability — staying on the current track",
                "!",
                3500
              );
              /* Keep the pill UI honest: the current track stays active. */
              trackSwitcher.querySelectorAll(".server-pill").forEach((p) => {
                p.classList.toggle("active", (p.dataset.track || "sub") === currentTrack);
              });
              return;
            }
          }

          trackSwitcher.querySelectorAll(".server-pill").forEach((p) => p.classList.remove("active"));
          pill.classList.add("active");
          currentTrack = requestedTrack;
          showToast(`Switched audio track to ${currentTrack.toUpperCase()}`);
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

    // Fullscreen button
    const fsBtn = document.getElementById("btn-fullscreen");
    if (fsBtn && playerWrap) {
      fsBtn.addEventListener("click", () => {
        if (!document.fullscreenElement) {
          playerWrap.requestFullscreen().catch(() => {});
        } else {
          document.exitFullscreen().catch(() => {});
        }
      });
    }

    // Skip buttons: Absolute seek clamped to [0, duration] sent to official origin
    const skipBack = document.getElementById("btn-skip-back");
    if (skipBack) {
      skipBack.addEventListener("click", () => {
        const target = Math.max(0, currentPosition - 10);
        sendPlayerCommand({ type: "seek", time: target });
      });
    }
    const skipForward = document.getElementById("btn-skip-forward");
    if (skipForward) {
      skipForward.addEventListener("click", () => {
        const target = Math.min(duration, currentPosition + 10);
        sendPlayerCommand({ type: "seek", time: target });
      });
    }

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

    // Bi-directional postMessage listener from ZokoAnime embed
    window.addEventListener("message", async (event) => {
      // Hard origin check per spec
      if (event.origin !== "https://zokoanime.video") return;
      let data = event.data;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch {}
      }
      if (!data || data.channel !== "zokoanime") return;

      // Event: ready
      if (data.type === "ready") {
        if (spinner) spinner.hidden = true;
        if (overlay) overlay.hidden = true;
        // Report current fullscreen state to player
        sendPlayerCommand({ type: "fullscreen", active: !!document.fullscreenElement });
      }

      // Event: play
      if (data.type === "play") {
        isPaused = false;
        if (playPauseBtn) playPauseBtn.textContent = "❚❚";
      }

      // Event: pause
      if (data.type === "pause") {
        isPaused = true;
        if (playPauseBtn) playPauseBtn.textContent = "▶";
      }

      // Event: state
      if (data.type === "state") {
        const pos = typeof data.position === "number" ? data.position
                  : typeof data.currentTime === "number" ? data.currentTime
                  : typeof data.time === "number" ? data.time
                  : null;
        if (pos != null) currentPosition = pos;
        if (typeof data.duration === "number" && data.duration > 0) duration = data.duration;
        if (typeof data.paused === "boolean") {
          isPaused = data.paused;
          if (playPauseBtn) playPauseBtn.textContent = isPaused ? "▶" : "❚❚";
        }
      }

      // Event: time or watching-log
      if (data.type === "watching-log" || data.type === "time") {
        const cur = typeof data.currentTime === "number" ? data.currentTime
                  : (typeof data.position === "number" ? data.position
                  : (typeof data.time === "number" ? data.time
                  : (typeof data.seconds === "number" ? data.seconds : 0)));
        const dur = typeof data.duration === "number" && data.duration > 0 ? data.duration : duration;
        currentPosition = cur;
        duration = dur;

        // Update time text strictly driven by player events (Bug 10)
        if (timeText) {
          timeText.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
        }
        if (timeText) {
          timeText.textContent = `${formatTime(cur)} / ${formatTime(dur)}`;
        }

        // Save progress to server (throttled every 5 seconds)
        const now = Date.now();
        if (currentUser && cur > 0 && now - lastProgressSync > 5000) {
          lastProgressSync = now;
          api("/api/progress", {
            method: "POST",
            body: {
              slug: currentSlug,
              episode: currentEp,
              positionSec: Math.floor(cur),
              durationSec: Math.floor(dur),
            },
          });
        }
      }

      // Event: skipped (intro or outro)
      if (data.type === "skipped") {
        const segment = data.name === "outro" ? "outro" : "intro";
        showToast(`Skipped ${segment}`);
      }

      // Event: error
      if (data.type === "error") {
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
      }

      // Event: ended (auto-next is parent-driven)
      if (data.type === "ended") {
        const totalEps = (titleData && titleData.episodes) || episodesList.length || 12;
        if (playerSettings.autonext && currentEp < totalEps) {
          showToast(`Episode finished! Auto-playing Episode ${currentEp + 1}...`);
          setTimeout(() => loadEpisode(currentEp + 1), 1500);
        } else if (currentEp >= totalEps) {
          showToast("You finished this anime!");
        }
      }

      // Event: fullscreen request from embed
      if (data.type === "fullscreen" && playerWrap) {
        if (data.request === "enter" && !document.fullscreenElement) {
          playerWrap.requestFullscreen().catch(() => {});
        } else if (data.request === "exit" && document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
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
        if (document.activeElement === iframe) {
          playerWrap.focus({ preventScroll: true });
        }
      };
      iframe.addEventListener("focus", containFocus);
      setInterval(containFocus, 250);
    }

    // Keyboard Shortcuts (only when activeElement is not an input/textarea)
    window.addEventListener("keydown", (e) => {
      const tag = document.activeElement ? document.activeElement.tagName : "";
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      if (e.code === "Space") {
        e.preventDefault();
        sendPlayerCommand({ type: isPaused ? "play" : "pause" });
      } else if (e.code === "KeyF") {
        e.preventDefault();
        if (!document.fullscreenElement && playerWrap) {
          playerWrap.requestFullscreen().catch(() => {});
        } else if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
        }
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
    const slug = params.get("slug");
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

    if (!slug) {
      showError("No title specified. Browse the catalog to pick an anime.");
      return;
    }

    const res = await api(`/api/titles/${encodeURIComponent(slug)}`);
    if (!res.ok || !res.data || !res.data.title) {
      showError("This title could not be loaded from the server.");
      return;
    }
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
    const badges = document.getElementById("detail-badges");
    if (badges) {
      badges.innerHTML = `
        <span class="badge badge-sub">SUB ${epCount || 1}</span>
        <span class="badge badge-dub">DUB ${epCount || 1}</span>
        <span class="badge badge-type">${t.kind}</span>
        <span class="badge badge-hd">HD</span>
        ${scoreLabel(t) ? `<span class="badge badge-score">★ ${scoreLabel(t)}</span>` : ""}
      `;
    }
    const meta = document.getElementById("detail-meta");
    if (meta) {
      meta.innerHTML = `
        <span><strong>Year:</strong> ${t.year || "—"}</span>
        <span><strong>Status:</strong> ${statusLabel(t.status)}</span>
        <span><strong>Episodes:</strong> ${epCount}</span>
        <span><strong>Studios:</strong> ${escapeHtml(t.studios || t.studio || "—")}</span>
        <span><strong>Duration:</strong> ${t.runtimeMin || 24}m</span>
      `;
    }
    const genresEl = document.getElementById("detail-genres");
    if (genresEl) {
      genresEl.innerHTML = (t.genres || [])
        .map((g) => `<a class="genre-chip-zoro" href="browse.html?genre=${encodeURIComponent(g)}">${escapeHtml(g)}</a>`)
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
                <span class="detail-episode-duration">${Math.round((e.duration_sec || 1440) / 60)}m</span>
                <span class="detail-episode-play">▶</span>
              </a>
            `;
          })
          .join("");
      }
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
                      <div class="badges-left"><span class="badge-mini-sub">SUB</span><span class="badge-mini-dub">DUB</span></div>
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

  const SCHEDULE_DATA = {
    monday: [
      { time: "20:30", title: "Moonlit Ramen", slug: "moonlit-ramen", ep: 12, kind: "Series", studio: "CloverWorks", img: "img/photo1.jpg" },
      { time: "22:00", title: "Cobalt Season", slug: "cobalt-season", ep: 25, kind: "Series", studio: "Madhouse", img: "img/photo2.jpg" },
      { time: "23:45", title: "Deep Frame", slug: "deep-frame", ep: 22, kind: "Series", studio: "MAPPA", img: "img/photo3.jpg" },
    ],
    tuesday: [
      { time: "21:00", title: "Sakura Static", slug: "sakura-static", ep: 12, kind: "Series", studio: "A-1 Pictures", img: "img/photo4.jpg" },
      { time: "23:15", title: "Ghost Line 9", slug: "ghost-line-9", ep: 10, kind: "Series", studio: "Wit Studio", img: "img/narutoposter.jpg" },
    ],
    wednesday: [
      { time: "20:45", title: "Kagerou Protocol", slug: "kagerou-protocol", ep: 12, kind: "Series", studio: "MAPPA", img: "img/onepiece.jpg" },
      { time: "22:00", title: "The Last Train to Aomori", slug: "the-last-train-to-aomori", ep: 13, kind: "Series", studio: "CloverWorks", img: "img/photo1.jpg" },
      { time: "23:30", title: "Iron Bloom", slug: "iron-bloom", ep: 13, kind: "Series", studio: "Bones", img: "img/photo2.jpg" },
    ],
    thursday: [
      { time: "21:00", title: "Sea of Stars", slug: "sea-of-stars", ep: 24, kind: "Series", studio: "Pierrot", img: "img/narutoposter.jpg" },
      { time: "22:30", title: "Zero Gravity Club", slug: "zero-gravity-club", ep: 12, kind: "Series", studio: "Eight Bit", img: "img/photo3.jpg" },
    ],
    friday: [
      { time: "20:00", title: "Ronin of the Neon Ward", slug: "ronin-of-the-neon-ward", ep: 24, kind: "Series", studio: "Toei Animation", img: "img/onepiece.jpg" },
      { time: "22:45", title: "Salt and Cinder", slug: "salt-and-cinder", ep: 16, kind: "Series", studio: "Pierrot", img: "img/photo4.jpg" },
    ],
    saturday: [
      { time: "19:30", title: "The Fox Who Counted Rain", slug: "the-fox-who-counted-rain", ep: 1, kind: "Film", studio: "ufotable", img: "img/photo2.jpg" },
      { time: "21:15", title: "Second Wind", slug: "second-wind", ep: 12, kind: "Series", studio: "A-1 Pictures", img: "img/photo1.jpg" },
      { time: "23:00", title: "Corner Store Hours", slug: "corner-store-hours", ep: 14, kind: "Series", studio: "Wit Studio", img: "img/photo3.jpg" },
    ],
    sunday: [
      { time: "18:30", title: "Paper Cranes at Dawn", slug: "paper-cranes-at-dawn", ep: 1, kind: "Film", studio: "Kyoto Animation", img: "img/photo4.jpg" },
      { time: "20:30", title: "Encore, One More", slug: "encore-one-more", ep: 1, kind: "Film", studio: "A-1 Pictures", img: "img/narutoposter.jpg" },
      { time: "22:15", title: "The Quiet Ward", slug: "the-quiet-ward", ep: 8, kind: "Series", studio: "A-1 Pictures", img: "img/photo2.jpg" },
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
      const items = SCHEDULE_DATA[dayKey] || [];
      if (!items.length) {
        timelineEl.innerHTML = `<p style="color: var(--text-muted); padding: 2rem; text-align: center;">No scheduled releases for this day.</p>`;
        return;
      }

      timelineEl.innerHTML = items.map((item) => {
        const real = titleMap[item.slug] || {};
        const name = real.name || item.title;
        const cover = real.cover || item.img;
        const studio = real.studio || item.studio;
        const dHref = detailHref(item.slug);
        const wHref = `watch.html?slug=${encodeURIComponent(item.slug)}&ep=${item.ep}`;
        return `
        <div class="schedule-item-card">
          <div class="schedule-item-left">
            <div class="schedule-slot-time">${item.time}</div>
            <a class="schedule-thumb" href="${dHref}">
              <img src="${cover}" alt="${escapeHtml(name)}" loading="lazy">
            </a>
            <div class="schedule-title-block">
              <a class="schedule-title-link" href="${dHref}">${escapeHtml(name)}</a>
              <div class="schedule-meta-badges">
                <span class="badge-mini-sub">SUB</span>
                <span class="badge-mini-dub">DUB</span>
                <span class="badge-mini-ep">Ep ${item.ep}</span>
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
              ▶ Watch Ep ${item.ep}
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

    // Header scroll background toggle
    const header = document.querySelector(".zoro-header");
    if (header) {
      window.addEventListener("scroll", () => {
        header.classList.toggle("scrolled", window.scrollY > 30);
      });
    }
  });
})();
