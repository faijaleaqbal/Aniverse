(function () {
  "use strict";

  /* ==========================================================================
     API HELPER & STATE
     ========================================================================== */

  let currentUser = null;

  async function api(path, options = {}) {
    options.headers = options.headers || {};
    if (options.body && typeof options.body === "object") {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(options.body);
    }
    options.credentials = "same-origin";

    try {
      const res = await fetch(path, options);
      const data = await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, data };
    } catch (err) {
      console.error("API error:", err);
      return { ok: false, status: 0, data: null };
    }
  }

  /* ==========================================================================
     1. AIZEN CINEMATIC SHUTTER INTRO
     ========================================================================== */

  function initAizenIntro(force = false) {
    if (!force && sessionStorage.getItem("aizen_intro_seen")) {
      return;
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
    const bar = overlay.querySelector("#aizen-bar");
    const statusText = overlay.querySelector("#aizen-status-text");

    const timer = setInterval(() => {
      progress += Math.floor(Math.random() * 12) + 6;
      if (progress >= 100) {
        progress = 100;
        clearInterval(timer);
        bar.style.width = "100%";
        statusText.textContent = "SYSTEM READY • 100%";

        setTimeout(() => {
          overlay.classList.add("is-exiting");
          sessionStorage.setItem("aizen_intro_seen", "true");
          setTimeout(() => overlay.remove(), 900);
        }, 350);
      } else {
        bar.style.width = `${progress}%`;
        statusText.textContent = `INITIALIZING RESOURCES... ${progress}%`;
      }
    }, 60);

    // Allow skip on click
    overlay.addEventListener("click", () => {
      clearInterval(timer);
      overlay.classList.add("is-exiting");
      sessionStorage.setItem("aizen_intro_seen", "true");
      setTimeout(() => overlay.remove(), 500);
    });
  }

  /* ==========================================================================
     TOAST NOTIFICATIONS
     ========================================================================== */

  function showToast(message, icon = "✓", duration = 3000) {
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
            <a class="mobile-drawer-link" href="genres.html">📑 12 Genres</a>
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
    }

    toggleBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        backdrop.classList.add("is-open");
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

    if (currentUser) {
      slot.innerHTML = `
        <button class="user-badge-btn" id="btn-user-profile" type="button">
          <span class="user-avatar-circle">${(currentUser.name || "U")[0].toUpperCase()}</span>
          <span>${currentUser.name}</span>
          <span style="color: var(--text-muted); font-size: 0.7rem; margin-left: 4px;">▼</span>
        </button>
      `;
      slot.querySelector("#btn-user-profile").addEventListener("click", async () => {
        if (confirm(`Logged in as ${currentUser.name}. Do you want to sign out?`)) {
          await api("/api/auth/logout", { method: "POST" });
          currentUser = null;
          updateHeaderUser();
          window.dispatchEvent(new CustomEvent("zoro:auth", { detail: null }));
        }
      });
    } else {
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
              <a class="search-result-item" href="watch.html?slug=${encodeURIComponent(t.slug)}&ep=1">
                <img class="search-result-thumb" src="img/narutoposter.jpg" alt="${t.name}">
                <div class="search-result-info">
                  <div class="search-result-title">${t.name}</div>
                  <div class="search-result-meta">
                    <span>${t.year}</span> • <span>${t.kind}</span> • <span style="color: var(--zoro-sub);">SUB ${t.episodes || 1}</span>
                  </div>
                </div>
              </a>
            `)
            .join("");
          dropdown.classList.add("is-open");
        } else {
          dropdown.innerHTML = `<div style="padding: 12px; font-size: 0.8rem; color: var(--text-muted); text-align: center;">No anime found for "${q}"</div>`;
          dropdown.classList.add("is-open");
        }
      }, 250);
    });

    // Close dropdown on outside click
    document.addEventListener("click", (e) => {
      if (!input.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.classList.remove("is-open");
      }
    });

    // Submit on Enter
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const q = input.value.trim();
        if (q) window.location.href = `browse.html?q=${encodeURIComponent(q)}`;
      }
    });
  }

  /* ==========================================================================
     4. ZORO SPOTLIGHT HERO CAROUSEL WITH AIZEN TRANSITION
     ========================================================================== */

  async function initSpotlightSlider() {
    const sliderContainer = document.getElementById("spotlight-slider-container");
    if (!sliderContainer) return;

    const res = await api("/api/titles?limit=5");
    if (!res.ok || !res.data || !res.data.titles || res.data.titles.length === 0) return;

    const titles = res.data.titles;
    const posters = ["img/banner.png", "img/photo1.jpg", "img/photo2.jpg", "img/photo3.jpg", "img/photo4.jpg"];

    sliderContainer.innerHTML = titles
      .map((t, idx) => `
        <div class="spotlight-slide ${idx === 0 ? "is-active" : ""}" data-index="${idx}">
          <div class="spotlight-backdrop" style="background-image: url('${posters[idx % posters.length]}');"></div>
          <div class="spotlight-overlay"></div>
          <div class="spotlight-content">
            <span class="spotlight-rank">🔥 #${idx + 1} Spotlight</span>
            <h1 class="spotlight-title">${t.name}</h1>
            <div class="spotlight-badges">
              <span class="badge badge-sub">SUB ${t.episodes || 1}</span>
              <span class="badge badge-dub">DUB ${t.episodes || 1}</span>
              <span class="badge badge-type">${t.kind}</span>
              <span class="badge badge-hd">HD</span>
              <span style="font-size: 0.8rem; color: var(--text-sub); margin-left: 6px;">${t.year} • ${t.runtimeMin}m</span>
            </div>
            <p class="spotlight-desc">${t.synopsis || t.tagline}</p>
            <div class="spotlight-actions">
              <a class="btn-watch-now" href="watch.html?slug=${encodeURIComponent(t.slug)}&ep=1">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>
                Watch Now
              </a>
              <button class="btn-detail btn-add-watchlist" data-slug="${t.slug}" type="button">+ Detail</button>
            </div>
          </div>
        </div>
      `)
      .join("");

    let currentSlide = 0;
    const slides = sliderContainer.querySelectorAll(".spotlight-slide");

    function goToSlide(n) {
      slides[currentSlide].classList.remove("is-active");
      currentSlide = (n + slides.length) % slides.length;
      slides[currentSlide].classList.add("is-active");
    }

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
     5. ZORO TRENDING RAIL & 4-COLUMN SECTIONS
     ========================================================================== */

  async function initTrendingAndColumns() {
    const trendingRail = document.getElementById("trending-rail-container");
    const airingList = document.getElementById("col-airing-list");
    const popularList = document.getElementById("col-popular-list");
    const favoriteList = document.getElementById("col-favorite-list");
    const completedList = document.getElementById("col-completed-list");

    const res = await api("/api/titles?limit=18");
    if (!res.ok || !res.data || !res.data.titles) return;
    const allTitles = res.data.titles;

    const sampleImages = ["img/onepiece.jpg", "img/narutoposter.jpg", "img/photo1.jpg", "img/photo2.jpg", "img/photo3.jpg", "img/photo4.jpg"];

    // 1. Trending Top 10
    if (trendingRail) {
      trendingRail.innerHTML = allTitles.slice(0, 10).map((t, i) => `
        <a class="trending-item" href="watch.html?slug=${encodeURIComponent(t.slug)}&ep=1">
          <div class="trending-poster-wrap">
            <img src="${sampleImages[i % sampleImages.length]}" alt="${t.name}">
            <div class="trending-rank-num">${(i + 1 < 10 ? "0" : "") + (i + 1)}</div>
            <div class="trending-info-overlay">
              <div class="trending-anime-title">${t.name}</div>
              <div style="font-size: 0.7rem; color: var(--text-muted); margin-top: 2px;">
                <span style="color: var(--zoro-sub);">SUB ${t.episodes || 1}</span> • <span>${t.year}</span>
              </div>
            </div>
          </div>
        </a>
      `).join("");
    }

    // 2. 4 Columns
    function renderColItems(container, items) {
      if (!container) return;
      container.innerHTML = items.map((t, idx) => `
        <a class="col-item" href="watch.html?slug=${encodeURIComponent(t.slug)}&ep=1">
          <img class="col-thumb" src="${sampleImages[(idx + 2) % sampleImages.length]}" alt="${t.name}">
          <div class="col-item-details">
            <div class="col-item-title">${t.name}</div>
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

  function createHoverTooltip() {
    if (tooltipEl) return tooltipEl;
    tooltipEl = document.createElement("div");
    tooltipEl.className = "zoro-tooltip";
    document.body.appendChild(tooltipEl);
    return tooltipEl;
  }

  async function initMainCatalogGrid() {
    const grid = document.getElementById("zoro-main-grid");
    if (!grid) return;

    const res = await api("/api/titles?limit=18");
    if (!res.ok || !res.data || !res.data.titles) return;

    const titles = res.data.titles;
    const sampleImages = ["img/photo1.jpg", "img/photo2.jpg", "img/photo3.jpg", "img/photo4.jpg", "img/narutoposter.jpg", "img/onepiece.jpg"];

    function renderCards(list) {
      grid.innerHTML = list.map((t, i) => `
        <div class="zoro-card" data-slug="${t.slug}" data-genres="${t.genres ? t.genres.join(" ") : ""}" data-title="${t.name}">
          <a class="zoro-card-poster" href="watch.html?slug=${encodeURIComponent(t.slug)}&ep=1">
            <img src="${sampleImages[i % sampleImages.length]}" alt="${t.name}" loading="lazy">
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
            <a class="zoro-card-title" href="watch.html?slug=${encodeURIComponent(t.slug)}&ep=1">${t.name}</a>
            <div class="zoro-card-submeta">
              <span>${t.kind}</span> • <span>${t.runtimeMin}m</span>
            </div>
          </div>
        </div>
      `).join("");

      attachTooltipListeners();
    }

    // Check URL parameters
    const urlParams = new URLSearchParams(window.location.search);
    const initialGenre = urlParams.get("genre");
    const initialQ = urlParams.get("q");

    const chipsWrap = document.getElementById("genre-chips-container");

    if (initialQ) {
      const qLower = initialQ.toLowerCase();
      const filtered = titles.filter(
        (t) =>
          t.name.toLowerCase().includes(qLower) ||
          (t.synopsis && t.synopsis.toLowerCase().includes(qLower)) ||
          (t.genres && t.genres.some((g) => g.toLowerCase().includes(qLower)))
      );
      renderCards(filtered);
      const searchInput = document.getElementById("zoro-search-input");
      if (searchInput) searchInput.value = initialQ;
    } else if (initialGenre) {
      if (chipsWrap) {
        const matchingChip = chipsWrap.querySelector(`[data-genre="${initialGenre.toLowerCase()}"]`);
        if (matchingChip) {
          chipsWrap.querySelectorAll(".genre-chip-zoro").forEach((c) => c.classList.remove("active"));
          matchingChip.classList.add("active");
        }
      }
      const filtered = titles.filter(
        (t) => t.genres && t.genres.some((g) => g.toLowerCase() === initialGenre.toLowerCase())
      );
      renderCards(filtered.length ? filtered : titles);
    } else {
      renderCards(titles);
    }

    // Genre filter chips
    if (chipsWrap) {
      chipsWrap.addEventListener("click", (e) => {
        const chip = e.target.closest(".genre-chip-zoro");
        if (!chip) return;
        chipsWrap.querySelectorAll(".genre-chip-zoro").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");

        const selected = chip.dataset.genre;
        if (selected === "all") {
          renderCards(titles);
        } else {
          const filtered = titles.filter((t) => t.genres && t.genres.some((g) => g.toLowerCase() === selected.toLowerCase()));
          renderCards(filtered);
        }
      });
    }
  }

  function attachTooltipListeners() {
    const tip = createHoverTooltip();
    const cards = document.querySelectorAll(".zoro-card");

    cards.forEach((card) => {
      card.addEventListener("mouseenter", async (e) => {
        const slug = card.dataset.slug;
        const res = await api(`/api/titles/${encodeURIComponent(slug)}`);
        if (!res.ok || !res.data) return;

        const t = res.data.title;
        tip.innerHTML = `
          <div class="tooltip-title">${t.name}</div>
          <div class="tooltip-rating">★ 8.89 <span style="color: var(--text-muted); font-size: 0.75rem;">(Zoro Community)</span></div>
          <div class="tooltip-synopsis">${t.synopsis || t.tagline}</div>
          <div class="tooltip-meta-rows">
            <span><strong>Type:</strong> ${t.kind}</span>
            <span><strong>Studio:</strong> ${t.studio}</span>
            <span><strong>Genres:</strong> ${t.genres ? t.genres.join(", ") : "Action"}</span>
          </div>
          <a class="btn-zoro-primary" href="watch.html?slug=${encodeURIComponent(t.slug)}&ep=1" style="width: 100%; justify-content: center; margin-top: 10px; padding: 6px;">▶ Watch Now</a>
        `;

        const rect = card.getBoundingClientRect();
        let left = rect.right + 12;
        if (left + 330 > window.innerWidth) {
          left = rect.left - 332;
        }
        let top = rect.top + window.scrollY;

        tip.style.left = `${left}px`;
        tip.style.top = `${top}px`;
        tip.classList.add("is-visible");
      });

      card.addEventListener("mouseleave", () => {
        tip.classList.remove("is-visible");
      });
    });
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
    const currentEp = parseInt(params.get("ep"), 10) || 1;

    const playerApi = window.ZokoPlayer || null;
    const watchApi = window.ZokoWatchUI || null;

    // Embed origin + defaults come from the server config (never hardcoded here).
    const cfgRes = await api("/api/player/config");
    if (playerApi && cfgRes.ok && cfgRes.data && cfgRes.data.embed) {
      playerApi.setEmbedConfig(cfgRes.data.embed);
    }

    let title = null;
    let episodes = [];

    // Load Title Details
    const titleRes = await api(`/api/titles/${encodeURIComponent(currentSlug)}`);
    if (titleRes.ok && titleRes.data) {
      const data = titleRes.data;
      title = data.title;
      episodes = Array.isArray(data.episodes) ? data.episodes : [];

      const h1 = document.getElementById("watch-anime-title");
      if (h1) h1.textContent = title.name;
      const h1Top = document.getElementById("watch-anime-title-h1");
      if (h1Top) h1Top.textContent = title.name;
      const descEl = document.getElementById("watch-anime-desc");
      if (descEl) descEl.textContent = title.synopsis;

      // Watchlist Button State
      const wlBtn = document.getElementById("watch-add-list-btn");
      if (wlBtn && data.userState) {
        updateWatchlistBtn(data.userState.inWatchlist);
      }
    }

    // ZokoAnime embed player (iframe + postMessage protocol + watch page UI)
    let player = null;
    if (watchApi) {
      player = watchApi.init({
        slug: currentSlug,
        episode: currentEp,
        title: title,
        episodes: episodes,
        iframe: document.getElementById("zoko-embed-frame"),
        onEpisodeChange: (episode) => {
          // Comments follow the episode without a page reload.
          activeEpisode = episode;
          if (reloadComments) reloadComments();
        },
        onProgress: async (position, duration) => {
          // Keep the signed-in account progress in sync too.
          if (!currentUser || !position) return;
          await api("/api/progress", {
            method: "POST",
            body: {
              slug: currentSlug,
              episode: player ? player.episode : currentEp,
              positionSec: Math.floor(position),
              durationSec: Math.floor(duration),
            },
          });
        },
      });
    }

    // Custom MAL ID button (ids are never guessed - the user sets them)
    const customMalBtn = document.getElementById("btn-custom-mal-id");
    if (customMalBtn) {
      const currentMalId = (title && title.malId) || "";
      customMalBtn.addEventListener("click", () => {
        const inputId = prompt(
          `Enter the MyAnimeList id for this title (current: ${currentMalId}).\n` +
            `The id is the number in myanimelist.net/anime/<id>/...`,
          currentMalId
        );
        if (!inputId || isNaN(inputId)) return;
        const malId = parseInt(inputId, 10);
        if (playerApi) playerApi.setIdOverride(currentSlug, malId);
        if (player) player.loadEpisode(player.episode);
        showToast(`MAL ID set to ${malId}.`);
      });
    }

    // Watchlist Toggle
    const wlBtn = document.getElementById("watch-add-list-btn");
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
        }
      });
    }

    // Discussion / Comments
    initComments(currentSlug, currentEp);
  }

  async function initComments(slug, ep) {
    const list = document.getElementById("comments-list-container");
    const form = document.getElementById("zoro-comment-form");
    const input = document.getElementById("zoro-comment-input");
    const countEl = document.getElementById("comments-count-text");
    activeEpisode = ep;

    async function loadComments() {
      if (!list) return;
      const res = await api(`/api/comments/${encodeURIComponent(slug)}/${activeEpisode}`);
      if (res.ok && res.data && res.data.comments) {
        const comments = res.data.comments;
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
          loadComments();
          showToast("Comment published!");
        }
      });
    }

    reloadComments = loadComments;
    loadComments();
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

  function initSchedulePage() {
    const timelineEl = document.getElementById("schedule-timeline-container");
    if (!timelineEl) return;

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

    // Determine current day of week in JST
    const dayNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    const nowJst = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
    const currentDayName = dayNames[nowJst.getDay()];

    function renderScheduleForDay(dayKey) {
      const items = SCHEDULE_DATA[dayKey] || [];
      if (!items.length) {
        timelineEl.innerHTML = `<p style="color: var(--text-muted); padding: 2rem; text-align: center;">No scheduled releases for this day.</p>`;
        return;
      }

      timelineEl.innerHTML = items.map((item) => `
        <div class="schedule-item-card">
          <div class="schedule-item-left">
            <div class="schedule-slot-time">${item.time}</div>
            <a class="schedule-thumb" href="watch.html?slug=${encodeURIComponent(item.slug)}&ep=${item.ep}">
              <img src="${item.img}" alt="${item.title}" loading="lazy">
            </a>
            <div class="schedule-title-block">
              <a class="schedule-title-link" href="watch.html?slug=${encodeURIComponent(item.slug)}&ep=${item.ep}">${item.title}</a>
              <div class="schedule-meta-badges">
                <span class="badge-mini-sub">SUB</span>
                <span class="badge-mini-dub">DUB</span>
                <span class="badge-mini-ep">Ep ${item.ep}</span>
                <span style="color: var(--text-muted); font-size: 0.75rem;">• ${item.studio}</span>
              </div>
            </div>
          </div>
          <div class="schedule-item-right">
            <button class="btn-remind-slot" type="button" data-title="${item.title}">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
              Remind Me
            </button>
            <a class="btn-zoro-primary" href="watch.html?slug=${encodeURIComponent(item.slug)}&ep=${item.ep}" style="padding: 0.55rem 1rem;">
              ▶ Watch Ep ${item.ep}
            </a>
          </div>
        </div>
      `).join("");

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
  }

  /* ==========================================================================
     LIFECYCLE INITIALIZATION
     ========================================================================== */

  document.addEventListener("DOMContentLoaded", async () => {
    initAizenIntro();
    await checkAuthSession();
    initMobileDrawer();
    initSearch();
    initSpotlightSlider();
    initTrendingAndColumns();
    initMainCatalogGrid();
    initWatchPage();
    initSchedulePage();

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
          window.location.href = `watch.html?slug=${encodeURIComponent(rand.slug)}&ep=1`;
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
