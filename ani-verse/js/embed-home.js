/**
 * Home page "Continue Watching" row.
 *
 * Reads the local watch-progress store written by the watch page player
 * (ani-verse/js/zoko-player.js) and renders a resume rail.
 */
(function (global) {
  "use strict";

  const Z = global.ZokoPlayer;

  const POSTERS = [
    "img/onepiece.jpg",
    "img/narutoposter.jpg",
    "img/photo1.jpg",
    "img/photo2.jpg",
    "img/photo3.jpg",
    "img/photo4.jpg",
  ];

  function isResumable(entry) {
    const pos = Number(entry.position) || 0;
    const dur = Number(entry.duration) || 0;
    if (pos < 30) return false;
    if (dur > 0 && pos >= dur * 0.95) return false;
    return true;
  }

  function render() {
    const section = document.getElementById("continue-watching-section");
    const row = document.getElementById("continue-watching-row");
    if (!section || !row) return;

    if (!Z) {
      section.hidden = true;
      return;
    }

    const entries = Z.listProgress().filter(isResumable).slice(0, 12);

    if (!entries.length) {
      section.hidden = true;
      row.innerHTML = "";
      return;
    }

    section.hidden = false;
    row.innerHTML = entries
      .map((entry, i) => {
        const pos = Number(entry.position) || 0;
        const dur = Number(entry.duration) || 0;
        const percent = dur > 0 ? Math.min(100, Math.round((pos / dur) * 100)) : 0;
        const title = entry.name || entry.slug;
        const epLabel = `Episode ${entry.episode}${entry.episodeTitle ? ` • ${entry.episodeTitle}` : ""}`;
        const poster = POSTERS[i % POSTERS.length];
        const href = `watch.html?slug=${encodeURIComponent(entry.slug)}&ep=${encodeURIComponent(entry.episode)}`;

        return `
          <a class="zoro-card zoko-continue-card" href="${href}">
            <div class="zoro-card-poster">
              <img src="${poster}" alt="${title}" loading="lazy">
              <div class="zoko-continue-badge">${percent}%</div>
              <div class="zoko-continue-bar"><span style="width: ${percent}%"></span></div>
            </div>
            <div class="zoro-card-info">
              <div class="zoro-card-title">${title}</div>
              <div class="zoro-card-submeta">${epLabel} • ${Z.formatSecs(pos)}</div>
            </div>
          </a>
        `;
      })
      .join("");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }

  global.ZokoHome = { render };
})(window);
