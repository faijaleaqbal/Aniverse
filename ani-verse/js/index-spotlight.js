(function () {
  var path = "/api/titles/kagerou-protocol";
  window.__zoroPrefetch = window.__zoroPrefetch || {};
  var ctl = new AbortController();
  var to = setTimeout(function () { ctl.abort(); }, 10000);
  window.__zoroPrefetch[path] = fetch(path, { credentials: "same-origin", signal: ctl.signal })
    .then(function (r) {
      clearTimeout(to);
      return r.json().then(function (d) {
        var t = d && d.title;
        var staticSlide = document.getElementById("spotlight-static-slide");
        var badges = staticSlide ? staticSlide.querySelector(".spotlight-badges") : null;
        if (t && badges) {
          var rt = document.getElementById("spotlight-static-runtime");
          if (rt && t.runtimeMin) rt.textContent = (t.year ? t.year + " • " : "") + t.runtimeMin + "m";
          var sub = badges.querySelector(".badge-sub");
          if (sub) sub.textContent = "SUB " + (t.episodes || 1);
          var dub = badges.querySelector(".badge-dub");
          if (t.dubCount > 0) {
            if (!dub) {
              dub = document.createElement("span");
              dub.className = "badge badge-dub";
              if (sub) sub.insertAdjacentElement("afterend", dub); else badges.appendChild(dub);
            }
            dub.textContent = "DUB " + t.dubCount;
          } else if (dub) {
            dub.remove();
          }
        }
        return { ok: r.ok, status: r.status, data: d, error: null };
      });
    })
    .catch(function (e) {
      clearTimeout(to);
      return { ok: false, status: 0, data: null, error: String((e && e.message) || e) };
    });
})();
