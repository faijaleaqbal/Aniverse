(function () {
  var p = new URLSearchParams(location.search);
  var s = p.get("sort");
  var el = document.getElementById("catalog-sort-select");
  if (el && ["trending", "popular", "top", "newest", "az", "name", "episodes", "updated", "favourites"].indexOf(s) >= 0) el.value = s;
  var fmt = document.getElementById("browse-format-select");
  if (fmt && p.get("format")) fmt.value = p.get("format").toUpperCase();
  var st = document.getElementById("browse-status-select");
  if (st && p.get("status")) st.value = p.get("status").toUpperCase();
  var score = document.getElementById("browse-score-select");
  if (score && p.get("minScore")) score.value = p.get("minScore");
  var season = document.getElementById("browse-season-select");
  if (season && p.get("season")) season.value = p.get("season").toUpperCase();
  var startYear = document.getElementById("browse-start-year");
  if (startYear && p.get("startAfter")) startYear.value = p.get("startAfter");
  var endYear = document.getElementById("browse-end-year");
  if (endYear && p.get("startBefore")) endYear.value = p.get("startBefore");
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
      if (sub) sub.textContent = "Every title streams with subtitles.";
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
    if (mode === "subbed") { note.textContent = "Every title streams with subtitles."; note.hidden = false; }
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
