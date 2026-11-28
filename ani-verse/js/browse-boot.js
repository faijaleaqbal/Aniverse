(function () {
  function fillSelect(select, items) {
    if (!select) return;
    items.forEach(function (item) {
      var opt = document.createElement("option");
      opt.value = item[0];
      opt.textContent = item[1];
      select.appendChild(opt);
    });
  }

  var p = new URLSearchParams(location.search);
  var s = p.get("sort");
  var viewParam = (p.get("view") || "").toLowerCase();
  var genreParam = (p.get("genre") || "").trim();
  var el = document.getElementById("catalog-sort-select");
  fillSelect(el, [
    ["trending", "Trending"],
    ["popular", "Most Popular"],
    ["top", "Top Rated"],
    ["newest", "Newest"],
    ["az", "Name A-Z"],
    ["episodes", "Most Episodes"],
    ["updated", "Recently Updated"],
    ["favourites", "Most Favourited"],
  ]);
  if (el && ["trending", "popular", "top", "newest", "az", "name", "episodes", "updated", "favourites"].indexOf(s) >= 0) {
    el.value = s;
  } else if (el && !s && (genreParam || viewParam === "subbed" || viewParam === "top-airing" || viewParam === "top-upcoming")) {
    el.value = "popular";
  }

  var fmt = document.getElementById("browse-format-select");
  fillSelect(fmt, [
    ["TV", "TV"],
    ["MOVIE", "Movie"],
    ["OVA", "OVA"],
    ["ONA", "ONA"],
    ["SPECIAL", "Special"],
  ]);
  var fmtVal = (p.get("format") || "").toUpperCase();
  if (fmt && ["TV", "MOVIE", "OVA", "ONA", "SPECIAL"].indexOf(fmtVal) >= 0) fmt.value = fmtVal;

  var st = document.getElementById("browse-status-select");
  fillSelect(st, [
    ["RELEASING", "Airing"],
    ["FINISHED", "Finished"],
    ["NOT_YET_RELEASED", "Upcoming"],
  ]);
  var stVal = (p.get("status") || "").toUpperCase();
  if (st && ["RELEASING", "FINISHED", "NOT_YET_RELEASED"].indexOf(stVal) >= 0) st.value = stVal;

  var score = document.getElementById("browse-score-select");
  fillSelect(score, [
    ["90", "90+"],
    ["80", "80+"],
    ["70", "70+"],
    ["60", "60+"],
    ["50", "50+"],
  ]);
  var scoreVal = p.get("minScore") || "";
  if (score && ["90", "80", "70", "60", "50"].indexOf(scoreVal) >= 0) score.value = scoreVal;

  var season = document.getElementById("browse-season-select");
  fillSelect(season, [
    ["WINTER", "Winter"],
    ["SPRING", "Spring"],
    ["SUMMER", "Summer"],
    ["FALL", "Fall"],
  ]);
  var seasonVal = (p.get("season") || "").toUpperCase();
  if (season && ["WINTER", "SPRING", "SUMMER", "FALL"].indexOf(seasonVal) >= 0) season.value = seasonVal;

  var startYear = document.getElementById("browse-start-year");
  if (startYear && /^\d{4}$/.test(p.get("startAfter") || "")) startYear.value = p.get("startAfter");
  var endYear = document.getElementById("browse-end-year");
  if (endYear && /^\d{4}$/.test(p.get("startBefore") || "")) endYear.value = p.get("startBefore");
  var h = document.getElementById("browse-heading");
  var sub = document.getElementById("browse-subheading");
  var q = (p.get("q") || "").trim();
  var view = (p.get("view") || "").toLowerCase();
  var kind = (p.get("kind") || "").toLowerCase();
  var mode = q ? "search"
    : view === "subbed" ? "subbed"
    : view === "dubbed" ? "dubbed"
    : (view === "movie" || kind === "film") ? "movies"
    : view === "ona" ? "ona"
    : view === "special" ? "special"
    : view === "tv" ? "tv"
    : view === "top-airing" ? "topairing"
    : view === "top-upcoming" ? "topupcoming"
    : "browse";
  if (h) {
    if (mode === "search") {
      h.innerHTML = "<span>Results for '<span class=\"accent\"></span>'</span>";
      h.querySelector(".accent").textContent = q;
      if (sub) sub.textContent = "Searching the full AniList catalog — your curated shelf comes first.";
    } else if (mode === "movies") {
      h.innerHTML = "Movies";
      if (sub) sub.textContent = "Every film in the live catalog — feature-length titles ready to stream.";
    } else if (mode === "ona") {
      h.innerHTML = "ONAs";
      if (sub) sub.textContent = "Original Net Animations — titles made for online release.";
    } else if (mode === "special") {
      h.innerHTML = "Specials";
      if (sub) sub.textContent = "Special episodes and one-off productions from the live catalog.";
    } else if (mode === "tv") {
      h.innerHTML = "TV";
      if (sub) sub.textContent = "Television series in the live catalog.";
    } else if (mode === "subbed") {
      h.innerHTML = "Subbed";
      if (sub) sub.textContent = "Lists everything in the catalog with subtitles — all titles stream with subs.";
    } else if (mode === "dubbed") {
      h.innerHTML = "Dubbed";
      if (sub) sub.textContent = "Catalog titles with a verified English dub.";
    } else if (mode === "topairing") {
      h.innerHTML = "Top <span class=\"accent\">Airing</span>";
      if (sub) sub.textContent = "Currently airing anime, ranked by popularity.";
    } else if (mode === "topupcoming") {
      h.innerHTML = "Top <span class=\"accent\">Upcoming</span>";
      if (sub) sub.textContent = "The most anticipated unreleased anime, ranked by popularity.";
    }
  }
  var note = document.getElementById("browse-view-note");
  if (note) {
    if (mode === "subbed") { note.textContent = "Lists everything in the catalog with subtitles."; note.hidden = false; }
    else if (mode === "dubbed") { note.textContent = "Dub status is verified for catalog titles only."; note.hidden = false; }
    else { note.textContent = ""; note.hidden = true; }
  }
  var wantHref = mode === "movies" ? "browse.html?view=movie"
    : mode === "ona" ? "browse.html?view=ona"
    : mode === "special" ? "browse.html?view=special"
    : mode === "tv" ? "browse.html?view=tv"
    : mode === "subbed" ? "browse.html?view=subbed"
    : mode === "dubbed" ? "browse.html?view=dubbed"
    : mode === "topairing" ? "browse.html?view=top-airing"
    : mode === "topupcoming" ? "browse.html?view=top-upcoming"
    : "browse.html";
  document.querySelectorAll(".header-nav .nav-link").forEach(function (a) {
    a.classList.toggle("active", a.getAttribute("href") === wantHref);
  });
})();
