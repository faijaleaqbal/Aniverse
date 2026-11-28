import fs from "node:fs";
import path from "node:path";
import { SITE_ROOT } from "./config.js";
import { cleanText, escapeHtml } from "./utils.js";

export const CANONICAL_ORIGIN = (
  process.env.CANONICAL_ORIGIN || "https://aniflick.duckdns.org"
).replace(/\/+$/, "");

export function stripHtml(value) {
  return cleanText(String(value || "").replace(/<[^>]*>/g, " "));
}

export function truncateDescription(text, max = 155) {
  const clean = stripHtml(text);
  if (!clean) return "";
  if (clean.length <= max) return clean;
  const sliced = clean.slice(0, max - 3);
  const lastSpace = sliced.lastIndexOf(" ");
  const cut = lastSpace > Math.floor((max - 3) * 0.6) ? sliced.slice(0, lastSpace) : sliced;
  return `${cut.replace(/[.,;:!?\s-]+$/, "")}...`;
}

function formatGenres(title) {
  const raw = Array.isArray(title.anilistGenres) && title.anilistGenres.length
    ? title.anilistGenres
    : (Array.isArray(title.genres) ? title.genres : []);
  return raw
    .map((g) => cleanText(g))
    .filter(Boolean)
    .map((g) => g.replace(/\b\w/g, (c) => c.toUpperCase()));
}

export function buildDetailSeo(title, { canonicalOrigin = CANONICAL_ORIGIN } = {}) {
  const origin = String(canonicalOrigin || CANONICAL_ORIGIN).replace(/\/+$/, "");
  const displayName = cleanText(title.name) || "Anime";
  const pageTitle = `Watch ${displayName} English Sub/Dub Online — AniFlick`;
  const rawDesc = stripHtml(title.synopsis || title.tagline || "");
  const description = truncateDescription(
    rawDesc || `Watch ${displayName} online in HD with English sub and dub on AniFlick.`,
    155
  );
  const canonicalUrl = `${origin}/anime/${encodeURIComponent(title.slug)}`;

  const isFilm =
    String(title.kind || "").toLowerCase() === "film" ||
    String(title.format || "").toUpperCase() === "MOVIE";
  const schemaType = isFilm ? "Movie" : "TVSeries";

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": schemaType,
    name: displayName,
    url: canonicalUrl,
    description,
  };

  const genre = formatGenres(title);
  if (genre.length) {
    jsonLd.genre = genre;
  }

  const epCount = Number(title.episodes);
  if (schemaType === "TVSeries" && Number.isFinite(epCount) && epCount > 0) {
    jsonLd.numberOfEpisodes = epCount;
  }

  if (title.cover) {
    const coverStr = String(title.cover);
    jsonLd.image = /^https?:\/\//i.test(coverStr)
      ? coverStr
      : `${origin}/${coverStr.replace(/^\/+/, "")}`;
  }

  return { pageTitle, description, canonicalUrl, jsonLd };
}

export function renderDetailHtml(title, opts = {}) {
  const templatePath = path.join(SITE_ROOT, "detail.html");
  let html = fs.readFileSync(templatePath, "utf8");
  const seo = buildDetailSeo(title, opts);
  const jsonLdText = JSON.stringify(seo.jsonLd).replace(/</g, "\\u003c");

  html = html.replace(
    /<title>[\s\S]*?<\/title>/i,
    `<title>${escapeHtml(seo.pageTitle)}</title>`
  );
  html = html.replace(
    /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/i,
    `<meta name="description" content="${escapeHtml(seo.description)}">`
  );
  html = html.replace(
    /<\/head>/i,
    `  <link rel="canonical" href="${escapeHtml(seo.canonicalUrl)}">\n  <script type="application/ld+json">${jsonLdText}</script>\n</head>`
  );

  return html;
}
