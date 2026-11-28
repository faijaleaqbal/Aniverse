(function () {
  var scriptEl = document.currentScript;
  var mode = scriptEl && scriptEl.getAttribute("data-prefetch");
  var paths = mode === "auth" ? ["/api/auth/me"] : ["/api/auth/me", "/api/titles?limit=18"];

  window.__zoroPrefetch = window.__zoroPrefetch || {};
  paths.forEach(function (path) {
    var ctl = new AbortController();
    var to = setTimeout(function () { ctl.abort(); }, 10000);
    window.__zoroPrefetch[path] = fetch(path, { credentials: "same-origin", signal: ctl.signal })
      .then(function (r) {
        clearTimeout(to);
        return r.json().then(function (d) { return { ok: r.ok, status: r.status, data: d, error: null }; });
      })
      .catch(function (e) {
        clearTimeout(to);
        return { ok: false, status: 0, data: null, error: String((e && e.message) || e) };
      });
  });

  try {
    var t = localStorage.getItem("av_theme");
    document.documentElement.setAttribute("data-theme", t === "light" ? "light" : "dark");
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "dark");
  }
})();
