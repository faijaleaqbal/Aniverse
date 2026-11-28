(function () {
  var params = new URLSearchParams(location.search);
  var live = params.get("live");
  var slug = params.get("slug") || params.get("id") || "";
  var path = live ? "/api/live/" + encodeURIComponent(live)
                  : slug ? "/api/titles/" + encodeURIComponent(slug) : null;
  window.__zoroPrefetch = window.__zoroPrefetch || {};
  if (!path) return;
  var ctl = new AbortController();
  var to = setTimeout(function () { ctl.abort(); }, 10000);
  window.__zoroPrefetch[path] = fetch(path, { credentials: "same-origin", signal: ctl.signal })
    .then(function (r) {
      clearTimeout(to);
      return r.json().then(function (d) {
        var t = (d && d.title) || null;
        var art = t && (t.banner || t.bannerLocal || t.cover || t.coverLocal);
        var el = document.getElementById("video-cover-overlay");
        if (el && art) el.style.backgroundImage = "url('" + art + "')";
        return { ok: r.ok, status: r.status, data: d, error: null };
      });
    })
    .catch(function (e) {
      clearTimeout(to);
      return { ok: false, status: 0, data: null, error: String((e && e.message) || e) };
    });
})();
