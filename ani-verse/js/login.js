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

  var signinError = document.getElementById("signin-error");
  var registerError = document.getElementById("register-error");
  var forgotMsg = document.getElementById("forgot-msg");

  var btnSigninSubmit = document.getElementById("btn-signin-submit");
  var btnRegisterSubmit = document.getElementById("btn-register-submit");
  var btnForgotSubmit = document.getElementById("btn-forgot-submit");

  var turnstileEnabled = false;

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

  function setMode(mode) {
    var isRegister = mode === "register";
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
        window.turnstile.reset();
      } catch (e) {}
    }
  }

  if (signinForm) {
    signinForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      clearAlert(signinError);

      var email = (signinForm.email.value || "").trim();
      var password = signinForm.password.value || "";
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
    });
  }

  if (registerForm) {
    registerForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      clearAlert(registerError);

      var name = (registerForm.name.value || "").trim();
      var email = (registerForm.email.value || "").trim();
      var password = registerForm.password.value || "";

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
    });
  }

  if (forgotForm) {
    forgotForm.addEventListener("submit", async function (e) {
      e.preventDefault();
      clearAlert(forgotMsg);
      var email = (forgotForm.email.value || "").trim();
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
    });
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
          var a = document.createElement("a");
          a.className = "social-btn social-btn--" + String(p.id || "").replace(/[^a-z0-9_-]/gi, "");
          a.href = "/auth/" + encodeURIComponent(p.id) + "?next=" + next;
          var dot = document.createElement("span");
          dot.className = "social-dot";
          dot.setAttribute("aria-hidden", "true");
          var label = document.createElement("span");
          label.textContent = String(p.name || p.id || "");
          a.appendChild(dot);
          a.appendChild(label);
          target.list.appendChild(a);
        });
        target.block.hidden = false;
      });
    } catch (e) {
      /* Hide OAuth row gracefully if providers endpoint fails */
    }
  }

  async function loadTurnstile() {
    try {
      var res = await fetch("/api/auth/turnstile-key", { credentials: "same-origin" });
      if (!res.ok) return;
      var data = await res.json().catch(function () { return null; });
      if (!data || !data.enabled || !data.siteKey) return;

      turnstileEnabled = true;
      var slots = [
        document.getElementById("signin-turnstile"),
        document.getElementById("register-turnstile"),
      ];
      slots.forEach(function (slot) {
        if (!slot) return;
        slot.className = "turnstile-slot cf-turnstile";
        slot.setAttribute("data-sitekey", data.siteKey);
        slot.setAttribute("data-theme", "light");
        slot.hidden = false;
      });

      var script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js";
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
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
