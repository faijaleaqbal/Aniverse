(function () {
  var card = document.getElementById("auth-card");
  var signinPanel = document.getElementById("signin-panel");
  var registerPanel = document.getElementById("register-panel");
  var overlayToRegister = document.getElementById("overlay-to-register");
  var overlayToSignin = document.getElementById("overlay-to-signin");

  var btnShowRegister = document.getElementById("btn-show-register");
  var btnShowSignin = document.getElementById("btn-show-signin");
  var mobileTabSignin = document.getElementById("mobile-tab-signin");
  var mobileTabRegister = document.getElementById("mobile-tab-register");
  var mobileTitle = document.getElementById("mobile-accent-title");
  var mobileSub = document.getElementById("mobile-accent-sub");

  var signinFormWrap = document.getElementById("signin-form-wrap");
  var forgotFormWrap = document.getElementById("forgot-form-wrap");
  var btnForgotOpen = document.getElementById("btn-forgot-open");
  var btnForgotBack = document.getElementById("btn-forgot-back");

  var signinForm = document.getElementById("signin-form");
  var registerForm = document.getElementById("register-form");
  var forgotForm = document.getElementById("forgot-form");

  var signinEmail = document.getElementById("signin-email");
  var signinPassword = document.getElementById("signin-password");
  var registerName = document.getElementById("register-name");
  var registerEmail = document.getElementById("register-email");
  var registerPassword = document.getElementById("register-password");
  var forgotEmail = document.getElementById("forgot-email");

  var signinError = document.getElementById("signin-error");
  var registerError = document.getElementById("register-error");
  var forgotMsg = document.getElementById("forgot-msg");

  var btnSigninSubmit = document.getElementById("btn-signin-submit");
  var btnRegisterSubmit = document.getElementById("btn-register-submit");
  var btnForgotSubmit = document.getElementById("btn-forgot-submit");

  var turnstileEnabled = false;
  var turnstileSiteKey = "";
  var turnstileApiLoaded = false;
  var turnstileLoadFailed = false;
  var currentMode = "signin";
  var turnstileWidgets = { signin: null, register: null };
  /* Turnstile widget error codes that mean the widget is misconfigured for
     this hostname — they NEVER resolve by retrying or refreshing:
     110200 domain not authorized for this sitekey, 110100/110110 invalid or
     unknown sitekey, 400020/400021 invalid sitekey / sitekey domain
     mismatch, 400070 sitekey disabled. For 110200 the widget itself renders
     "Unable to connect to website" with a Troubleshoot link, which is why
     the failure looked like a network problem. The fix is in the Cloudflare
     dashboard: the widget's hostname list must include the hostname in the
     browser's address bar (the login page always lands on
     aniflick.duckdns.org — vyapora.me 301-redirects there). */
  var TURNSTILE_CONFIG_ERRORS = {
    110200: true,
    110100: true,
    110110: true,
    400020: true,
    400021: true,
    400070: true,
  };
  var turnstileConfigError = null;
  var turnstileSlots = {
    signin: document.getElementById("signin-turnstile"),
    register: document.getElementById("register-turnstile"),
  };
  var turnstileNotes = { signin: null, register: null };

  function bindSubmitControls(container, submitBtn, handler) {
    if (!container || !submitBtn) return;
    submitBtn.addEventListener("click", handler);
    container.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && e.target && e.target.tagName === "INPUT") {
        e.preventDefault();
        handler();
      }
    });
  }

  function getSafeNext() {
    var params = new URLSearchParams(window.location.search);
    var raw = (params.get("next") || params.get("redirect") || "").trim();
    if (!raw) return "/";
    if (!raw.startsWith("/") || raw.includes("//") || raw.includes("\\")) return "/";
    try {
      var parsed = new URL(raw, window.location.origin);
      if (parsed.origin !== window.location.origin) return "/";
      return parsed.pathname + parsed.search + parsed.hash;
    } catch (e) {
      return "/";
    }
  }

  function showAlert(el, message, isSuccess) {
    if (!el) return;
    el.textContent = message;
    el.classList.toggle("is-success", Boolean(isSuccess));
    el.hidden = false;
  }

  function clearAlert(el) {
    if (!el) return;
    el.textContent = "";
    el.classList.remove("is-success");
    el.hidden = true;
  }

  function ensureTurnstileNote(mode) {
    if (turnstileNotes[mode]) return turnstileNotes[mode];
    var slot = turnstileSlots[mode];
    if (!slot || !slot.parentNode) return null;
    var note = document.createElement("p");
    note.className = "turnstile-note";
    note.hidden = true;
    slot.insertAdjacentElement("afterend", note);
    turnstileNotes[mode] = note;
    return note;
  }

  function showTurnstileLoadFailure() {
    turnstileLoadFailed = true;
    ["signin", "register"].forEach(function (m) {
      if (turnstileConfigError) return; /* config-error note stays put */
      var slot = turnstileSlots[m];
      if (slot) slot.hidden = true;
      var note = ensureTurnstileNote(m);
      if (note) {
        note.textContent = "Bot check could not load — please refresh";
        note.hidden = false;
      }
    });
  }

  /* Widget reported a configuration error (e.g. 110200: this hostname is
     not on the sitekey's allowed list). Retrying cannot help — hide the
     broken Cloudflare error box and say plainly what is wrong and what
     fixes it. OAuth sign-in below is unaffected (it never uses Turnstile). */
  function showTurnstileConfigError(mode, code) {
    turnstileConfigError = { mode: mode, code: String(code) };
    var slot = turnstileSlots[mode];
    if (slot) {
      slot.hidden = true;
      slot.setAttribute("data-turnstile-error", String(code));
    }
    var note = ensureTurnstileNote(mode);
    if (note) {
      note.textContent =
        "Bot check is not set up for this address (code " +
        code +
        "). Email sign-in is paused until the site owner adds this address to the Turnstile widget's hostname list in the Cloudflare dashboard. You can still sign in with Google, Discord, MAL or AniList below.";
      note.hidden = false;
    }
  }

  /* Transient widget error (network, timeout, …): Turnstile auto-retries
     with retry:auto, so keep the slot visible and show a per-mode note. */
  function showTurnstileWidgetError(mode, code) {
    var note = ensureTurnstileNote(mode);
    if (note) {
      note.textContent = "Bot check failed (code " + code + ") — please refresh the page and try again.";
      note.hidden = false;
    }
  }

  function renderTurnstileForMode(mode) {
    if (!turnstileEnabled || !turnstileApiLoaded || turnstileLoadFailed) return;
    if (!window.turnstile || typeof window.turnstile.render !== "function") return;
    /* A config error (e.g. 110200) applies to every mode — same sitekey,
       same hostname — so never re-render once it is known. */
    if (turnstileConfigError) {
      showTurnstileConfigError(mode, turnstileConfigError.code);
      return;
    }
    var slot = turnstileSlots[mode];
    if (!slot) return;
    slot.hidden = false;
    var note = turnstileNotes[mode];
    if (note) note.hidden = true;
    if (turnstileWidgets[mode] == null) {
      try {
        turnstileWidgets[mode] = window.turnstile.render(slot, {
          sitekey: turnstileSiteKey,
          theme: "dark",
          "error-callback": function (code) {
            if (TURNSTILE_CONFIG_ERRORS[Number(code)]) showTurnstileConfigError(mode, code);
            else showTurnstileWidgetError(mode, code);
          },
        });
      } catch (e) {}
    } else if (typeof window.turnstile.reset === "function") {
      try {
        window.turnstile.reset(turnstileWidgets[mode]);
      } catch (e) {}
    }
  }

  function setMode(mode) {
    var isRegister = mode === "register";
    currentMode = isRegister ? "register" : "signin";
    if (card) card.classList.toggle("is-register", isRegister);

    if (signinPanel) signinPanel.setAttribute("aria-hidden", isRegister ? "true" : "false");
    if (registerPanel) registerPanel.setAttribute("aria-hidden", isRegister ? "false" : "true");
    if (overlayToRegister) overlayToRegister.setAttribute("aria-hidden", isRegister ? "true" : "false");
    if (overlayToSignin) overlayToSignin.setAttribute("aria-hidden", isRegister ? "false" : "true");

    if (mobileTabSignin) {
      mobileTabSignin.classList.toggle("is-active", !isRegister);
      mobileTabSignin.setAttribute("aria-selected", !isRegister ? "true" : "false");
    }
    if (mobileTabRegister) {
      mobileTabRegister.classList.toggle("is-active", isRegister);
      mobileTabRegister.setAttribute("aria-selected", isRegister ? "true" : "false");
    }
    if (mobileTitle) {
      mobileTitle.textContent = isRegister ? "Create Account" : "Welcome Back";
    }
    if (mobileSub) {
      mobileSub.textContent = isRegister
        ? "Join AniFlick in seconds with your email."
        : "Sign in to continue watching and sync your list.";
    }

    if (!isRegister) showForgot(false);
    clearAlert(signinError);
    clearAlert(registerError);
    renderTurnstileForMode(currentMode);
  }

  function showForgot(show) {
    if (signinFormWrap) signinFormWrap.hidden = show;
    if (forgotFormWrap) forgotFormWrap.hidden = !show;
    clearAlert(signinError);
    clearAlert(forgotMsg);
  }

  if (btnShowRegister) btnShowRegister.addEventListener("click", function () { setMode("register"); });
  if (btnShowSignin) btnShowSignin.addEventListener("click", function () { setMode("signin"); });
  if (mobileTabRegister) mobileTabRegister.addEventListener("click", function () { setMode("register"); });
  if (mobileTabSignin) mobileTabSignin.addEventListener("click", function () { setMode("signin"); });

  if (btnForgotOpen) btnForgotOpen.addEventListener("click", function () { showForgot(true); });
  if (btnForgotBack) btnForgotBack.addEventListener("click", function () { showForgot(false); });

  document.querySelectorAll("[data-toggle-target]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var input = document.getElementById(btn.getAttribute("data-toggle-target"));
      if (!input) return;
      var showing = input.type === "text";
      input.type = showing ? "password" : "text";
      btn.textContent = showing ? "Show" : "Hide";
      btn.setAttribute("aria-label", showing ? "Show password" : "Hide password");
    });
  });

  var initialParams = new URLSearchParams(window.location.search);
  var initialMode = (initialParams.get("mode") || initialParams.get("tab") || "").toLowerCase();
  if (initialMode === "register" || initialMode === "signup" || window.location.hash === "#register") {
    setMode("register");
  } else {
    setMode("signin");
  }

  async function postJson(url, payload) {
    var res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(payload),
    });
    var data = await res.json().catch(function () { return null; });
    return { ok: res.ok, status: res.status, data: data };
  }

  function getTurnstileToken(form) {
    if (!form) return "";
    var input = form.querySelector('input[name="cf-turnstile-response"]');
    return input ? input.value : "";
  }

  function resetTurnstile() {
    if (window.turnstile && typeof window.turnstile.reset === "function") {
      try {
        var wid = turnstileWidgets[currentMode];
        if (wid != null) window.turnstile.reset(wid);
        else window.turnstile.reset();
      } catch (e) {}
    }
  }

  async function handleSignin() {
    clearAlert(signinError);

    var email = (signinEmail ? signinEmail.value : "").trim();
    var password = signinPassword ? signinPassword.value : "";
    if (!email || !password) {
      showAlert(signinError, "Email and password are required.", false);
      return;
    }

    var payload = { email: email, password: password };
    if (turnstileEnabled) {
      var token = getTurnstileToken(signinForm);
      if (!token) {
        showAlert(signinError, "Bot verification failed. Please complete the check and try again.", false);
        return;
      }
      payload["cf-turnstile-response"] = token;
    }

    btnSigninSubmit.disabled = true;
    btnSigninSubmit.textContent = "Signing In...";
    try {
      var res = await postJson("/api/auth/login", payload);
      if (res.ok && res.data && res.data.user) {
        window.location.assign(getSafeNext());
        return;
      }
      showAlert(
        signinError,
        (res.data && res.data.error && res.data.error.message) || "Invalid email or password.",
        false
      );
      resetTurnstile();
    } catch (err) {
      showAlert(signinError, "Network error. Please try again.", false);
      resetTurnstile();
    } finally {
      btnSigninSubmit.disabled = false;
      btnSigninSubmit.textContent = "Sign In";
    }
  }

  async function handleRegister() {
    clearAlert(registerError);

    var name = (registerName ? registerName.value : "").trim();
    var email = (registerEmail ? registerEmail.value : "").trim();
    var password = registerPassword ? registerPassword.value : "";

    if (!name) {
      showAlert(registerError, "Display name is required.", false);
      return;
    }
    if (!email) {
      showAlert(registerError, "A valid email address is required.", false);
      return;
    }
    if (password.length < 8) {
      showAlert(registerError, "Password must be between 8 and 200 characters.", false);
      return;
    }

    var payload = { name: name, email: email, password: password };
    if (turnstileEnabled) {
      var token = getTurnstileToken(registerForm);
      if (!token) {
        showAlert(registerError, "Bot verification failed. Please complete the check and try again.", false);
        return;
      }
      payload["cf-turnstile-response"] = token;
    }

    btnRegisterSubmit.disabled = true;
    btnRegisterSubmit.textContent = "Creating Account...";
    try {
      var res = await postJson("/api/auth/register", payload);
      if (res.ok && res.data && res.data.user) {
        window.location.assign(getSafeNext());
        return;
      }
      /* An existing email answers 200 with a message and no user (audit C4):
         show the message and offer sign-in instead of an error. */
      if (res.ok && res.data && res.data.message) {
        showAlert(registerError, res.data.message, false);
        setMode("signin");
        resetTurnstile();
        return;
      }
      showAlert(
        registerError,
        (res.data && res.data.error && res.data.error.message) || "Could not create account.",
        false
      );
      resetTurnstile();
    } catch (err) {
      showAlert(registerError, "Network error. Please try again.", false);
      resetTurnstile();
    } finally {
      btnRegisterSubmit.disabled = false;
      btnRegisterSubmit.textContent = "Create Account";
    }
  }

  async function handleForgot() {
    clearAlert(forgotMsg);
    var email = (forgotEmail ? forgotEmail.value : "").trim();
    if (!email) {
      showAlert(forgotMsg, "Please enter your email address.", false);
      return;
    }
    btnForgotSubmit.disabled = true;
    btnForgotSubmit.textContent = "Sending...";
    try {
      var res = await postJson("/api/auth/forgot-password", { email: email });
      var message =
        (res.data && (res.data.message || (res.data.error && res.data.error.message))) ||
        "If an account exists for that email, a reset link has been sent.";
      showAlert(forgotMsg, message, res.ok);
    } catch (err) {
      showAlert(forgotMsg, "Network error. Please try again.", false);
    } finally {
      btnForgotSubmit.disabled = false;
      btnForgotSubmit.textContent = "Send Reset Link";
    }
  }

  bindSubmitControls(signinForm, btnSigninSubmit, handleSignin);
  bindSubmitControls(registerForm, btnRegisterSubmit, handleRegister);
  bindSubmitControls(forgotForm, btnForgotSubmit, handleForgot);

  /* Logo-only OAuth buttons: inline SVG per provider (no external images,
     no visible text). aria-label keeps the button accessible. Unknown
     provider ids fall back to a first-letter monogram, still logo-only. */
  var PROVIDER_LOGOS = {
    google:
      '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">' +
      '<path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z"/>' +
      '<path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"/>' +
      '<path fill="#FBBC05" d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z"/>' +
      '<path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z"/>' +
      "</svg>",
    discord:
      '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">' +
      '<path fill="#fff" d="M20.317 4.37a19.79 19.79 0 0 0-4.885 1.515.074.074 0 0 0-.079.037c-.21.375-.444.865-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.475 17.933a.08.08 0 0 0 .032.031 19.98 19.98 0 0 0 5.593 1.534.077.077 0 0 0 .084-.045c.406-.652.773-1.348 1.098-2.075a.077.077 0 0 0-.026-.092 16.3 16.3 0 0 1-1.378-.659.077.077 0 0 1-.006-.13c.093-.072.186-.147.276-.221a.077.077 0 0 1 .086-.01 19.2 19.2 0 0 0 16.437 0 .077.077 0 0 1 .086.01c.09.074.183.149.276.221a.077.077 0 0 1-.006.13 16.5 16.5 0 0 1-1.378.659.077.077 0 0 0-.025.092c.325.727.692 1.423 1.098 2.075a.077.077 0 0 0 .084.044 19.97 19.97 0 0 0 5.588-1.534.08.08 0 0 0 .032-.032c.498-5.044-.838-9.422-3.557-13.524a.07.07 0 0 0-.032-.027ZM8.02 15.331c-1.183 0-2.157-1.086-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.419 0 1.333-.956 2.419-2.157 2.419Zm7.975 0c-1.183 0-2.157-1.086-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.419 0 1.333-.946 2.419-2.157 2.419Z"/>' +
      "</svg>",
    anilist:
      '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">' +
      '<path fill="#fff" fill-rule="evenodd" d="M12 2.8 20.5 21.2h-3.6l-1.6-3.9H8.7l-1.6 3.9H3.5L12 2.8Zm-2.5 11.4h5l-2.5-6-2.5 6Z"/>' +
      "</svg>",
    mal:
      '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">' +
      '<text x="12" y="17.5" text-anchor="middle" font-family="Outfit, Arial, sans-serif" font-size="15" font-weight="800" fill="#fff">M</text>' +
      "</svg>",
  };

  function providerLogoSvg(p) {
    var id = String(p.id || "").toLowerCase();
    if (PROVIDER_LOGOS[id]) return PROVIDER_LOGOS[id];
    var initial = String(p.name || p.id || "?").charAt(0).toUpperCase();
    return (
      '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">' +
      '<text x="12" y="17.5" text-anchor="middle" font-family="Outfit, Arial, sans-serif" font-size="15" font-weight="800" fill="#fff">' +
      initial.replace(/[<>&"]/g, "") +
      "</text></svg>"
    );
  }

  async function loadProviders() {
    var blocks = [
      { block: document.getElementById("signin-social-block"), list: document.getElementById("signin-social-list") },
      { block: document.getElementById("register-social-block"), list: document.getElementById("register-social-list") },
    ];
    try {
      var res = await fetch("/api/auth/providers", { credentials: "same-origin" });
      if (!res.ok) return;
      var data = await res.json().catch(function () { return null; });
      var providers = data && Array.isArray(data.providers) ? data.providers : [];
      if (!providers.length) return;

      var next = encodeURIComponent(getSafeNext());
      blocks.forEach(function (target) {
        if (!target.block || !target.list) return;
        target.list.innerHTML = "";
        providers.forEach(function (p) {
          var name = String(p.name || p.id || "");
          var a = document.createElement("a");
          a.className = "social-btn social-btn--" + String(p.id || "").replace(/[^a-z0-9_-]/gi, "");
          a.href = "/auth/" + encodeURIComponent(p.id) + "?next=" + next;
          a.setAttribute("aria-label", "Continue with " + name);
          a.setAttribute("title", "Continue with " + name);
          a.innerHTML = providerLogoSvg(p);
          target.list.appendChild(a);
        });
        target.block.hidden = false;
      });
    } catch (e) {
      /* Hide OAuth row gracefully if providers endpoint fails */
    }
  }

  function loadTurnstileScript(attempt) {
    var done = false;
    var timer = null;
    var script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;

    function cleanup() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }

    function onFailure() {
      if (done) return;
      done = true;
      cleanup();
      if (script.parentNode) script.parentNode.removeChild(script);
      if (attempt < 1) {
        setTimeout(function () {
          loadTurnstileScript(attempt + 1);
        }, 2000);
      } else {
        showTurnstileLoadFailure();
      }
    }

    script.onload = function () {
      if (done) return;
      if (window.turnstile && typeof window.turnstile.render === "function") {
        done = true;
        cleanup();
        turnstileApiLoaded = true;
        renderTurnstileForMode(currentMode);
      } else if (typeof window.turnstile !== "undefined" && window.turnstile.ready) {
        done = true;
        cleanup();
        window.turnstile.ready(function () {
          turnstileApiLoaded = true;
          renderTurnstileForMode(currentMode);
        });
      } else {
        onFailure();
      }
    };

    script.onerror = onFailure;
    timer = setTimeout(function () {
      if (!done && !turnstileApiLoaded) onFailure();
    }, 8000);

    document.head.appendChild(script);
  }

  async function loadTurnstile() {
    try {
      var res = await fetch("/api/auth/turnstile-key", { credentials: "same-origin" });
      if (!res.ok) return;
      var data = await res.json().catch(function () { return null; });
      if (!data || !data.enabled || !data.siteKey) return;

      turnstileEnabled = true;
      turnstileSiteKey = data.siteKey;
      ["signin", "register"].forEach(function (m) {
        var slot = turnstileSlots[m];
        if (!slot) return;
        slot.className = "turnstile-slot";
        slot.removeAttribute("data-sitekey");
        slot.removeAttribute("data-theme");
        slot.hidden = m !== currentMode;
      });

      loadTurnstileScript(0);
    } catch (e) {
      /* Keep forms functional if Turnstile key lookup fails */
    }
  }

  async function checkCurrentSession() {
    var banner = document.getElementById("already-signed-in");
    if (!banner) return;
    try {
      var res = await fetch("/api/auth/me", { credentials: "same-origin" });
      if (!res.ok) return;
      var data = await res.json().catch(function () { return null; });
      if (!data || !data.user) return;
      var text = document.getElementById("session-banner-text");
      var continueLink = document.getElementById("session-continue-link");
      var logoutBtn = document.getElementById("session-logout-btn");
      if (text) text.textContent = "Signed in as " + (data.user.name || data.user.email || "your account") + ".";
      if (continueLink) continueLink.href = getSafeNext();
      if (logoutBtn) {
        logoutBtn.addEventListener("click", async function () {
          await postJson("/api/auth/logout", {});
          banner.hidden = true;
        });
      }
      banner.hidden = false;
    } catch (e) {}
  }

  loadProviders();
  loadTurnstile();
  checkCurrentSession();
})();
