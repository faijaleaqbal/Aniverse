# AniFlick Security Audit — 2026-11-29

**Scope:** AniFlick web app (repo `faijaleaqbal/Aniverse`, source ref `e62fedf` → fixes at `473208b`), live at https://aniflick.duckdns.org/ (vyapora.me 301-redirects to it).
**Method:** Cloudflare `security-audit-skill`, 6-phase workflow (Reconnaissance, Coverage-led hunting, Candidate validation, Structured output, Independent record verification, Target-neutral reporting). Run files: `~/security-audit-skill/aniflick/run-1/` (coverage ledger: 12 units).
**Context:** OWASP ZAP baseline on 2026-11-28 already reached **0 alerts** (42 URLs). ZAP sees HTTP responses, not logic — this audit hunted what ZAP cannot: auth logic, session handling, OAuth flows, password-reset tokens, rate-limit design, SSRF, CSP/sandboxing, and data lifecycle.
**Result:** 19 confirmed findings (2 HIGH, 5 MEDIUM, 10 LOW, 2 informational/accepted). **All confirmed findings are fixed and deployed.** One candidate (D1) was independently REJECTED as a false positive for this deployment. Test suite: 25/25 smoke + 148/148 E2E (9 new audit regression tests) — green before deploy.

---

## HIGH

### C1 — X-Forwarded-For spoofing defeats ALL IP-based rate limits (FIXED)
- **Where:** `server/src/index.js` — `app.set("trust proxy", true)` + `ANIVERSE_TRUST_PROXY=true` + plain Caddy `reverse_proxy` (appends, never strips XFF).
- **Proof (local throwaway server):** 5 registrations from one spoofed IP → 6th got 429; 6 registrations with rotating spoofed IPs → 201×6. Express used the attacker-controlled *leftmost* XFF entry.
- **Fix:** `app.set("trust proxy", TRUST_PROXY ? 1 : false)` — trust exactly one hop (Caddy); Express now uses the *last* entry, the one Caddy appended.
- **Regression test:** `AUDIT C1` — exhausts the register limiter for one IP, then proves a spoofed leftmost entry (`fresh-IP, exhausted-IP`) is still 429 while the fresh IP alone is 201.
- **Note:** live Caddy appends the real client IP as the last entry; verified by code + test, not by a live spoof probe (that would require creating accounts on the live site).

### C2 — Pre-registration + OAuth link-by-email = account takeover (FIXED)
- **Where:** `server/src/oauth.js` — `linkOrCreateAccount()` links a verified Google/Discord identity into any existing row by email and never touched `password_hash`.
- **Proof (local):** attacker registers `victim@example.com` locally (no email verification on local register); victim's Google login returns the same user id with the attacker's hash intact — attacker keeps password access.
- **Fix:** when OAuth links by email to an account WITH a `password_hash`, the hash is cleared (set NULL). The social identity becomes the sign-in path; the owner recovers password login via forgot-password (which works for NULL-password accounts).
- **Test impact:** e2e test 83 previously asserted "linking NEVER overwrites the local password" — that test enshrined the vulnerable behavior and was updated to assert the hash is cleared and the old password returns 401. Test 84 (social-only accounts can't password-login) still passes.

## MEDIUM

### C3 — Sessions never expire while active; no logout-all (FIXED)
- **Where:** `server/src/index.js` session middleware — sliding refresh extended the 30-day TTL whenever <7 days remained, with no absolute cap. Login never invalidated other sessions; no logout-all endpoint.
- **Proof:** a session with 6 days left was extended to 30 days by one `GET /api/auth/me`.
- **Fix:** refresh is capped at `created_at + SESSION_TTL_DAYS` (absolute lifetime); a session past its cap is deleted. Added `POST /api/auth/logout-all` (deletes all sessions except the caller's).
- **Regression test:** `AUDIT C3/C8` — logout-all kills other sessions, caller's survives.

### D2 / C2-history — Unbounded history growth via POST /api/progress (FIXED)
- **Where:** `server/src/index.js` — `HISTORY_PER_USER_CAP = 500` was defined but never enforced; `POST /api/progress` had no rate limit and inserted a history row per call; the client syncs every 5 s (~288 rows/episode, ~864/user/day).
- **Fix:** per-user rate limit on `POST /api/progress` (60/min — the player posts ~12/min); insert a history row only when this episode has no row with the same completion state within 10 minutes; prune to the 500-row cap after every insert.
- **Regression test:** `AUDIT D2` — 3 same-state syncs leave exactly 1 history row; a completion change adds exactly one more.

### Path traversal out of SITE_ROOT via GET /:page (FIXED)
- **Where:** `server/src/index.js` — `res.sendFile(path.join(SITE_ROOT, page + ".html"))` with no `root` option.
- **Proof (local):** `GET /..%2f..%2f..%2f..%2f..%2ftmp%2faudit-hunter-c%2fescape-target` returned **200** with a file outside the web root. Only `*.html` was reachable; no sensitive `.html` existed outside `ani-verse/` in this checkout — but any future `.html` file placed above the web root would have been served.
- **Fix:** `path.resolve` + `startsWith(SITE_ROOT + path.sep)` check; out-of-root requests fall through to the branded 404.
- **Live verification:** `GET /..%2f..%2fetc%2fpasswd` on the live site now returns **404**.
- **Regression test:** `AUDIT path traversal` — creates a probe `.html` file in the repo root, asserts 404 + no content leak, asserts a real page still serves 200.

### B1 — Sandboxed players carry allow-same-origin + allow-scripts (FIXED)
- **Where:** `ani-verse/js/zoro-aizen.js:3334` — `PLAYER_IFRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-presentation"` applied to TVplus, MegaPlay, animegg, Vidstream-3.
- **Risk:** a compromised/malicious player could self-navigate to an AniFlick URL, regain origin, remove its own sandbox, and access the parent DOM. (No exploit observed; defense-in-depth.)
- **Fix:** sandbox is now `"allow-scripts allow-forms allow-presentation"` — players run in an opaque origin and can still play video, but cannot read cookies, storage, or the parent page. Zoko stays unsandboxed by design (it needs origin access for its fullscreen bridge).
- **Regression tests:** `AUDIT B1` + updated sandbox-literal and Hindi-player assertions.
- **Live check still needed (parent):** play TVplus and Vidstream-3 in a real browser after deploy to confirm playback is unaffected by the opaque origin. If a player breaks, the fallback is to re-add `allow-same-origin` for that one server only.

### C4-cover — /api/cover serves upstream Content-Type verbatim (FIXED)
- **Where:** `server/src/index.js` — the image proxy set `Content-Type` from the upstream response with no allowlist, no in-app `nosniff`, no rate limit, and `fetch()` followed redirects without re-validating the host.
- **Fix:** image-only content-type allowlist (`jpeg/png/gif/webp/avif`, else 502); final URL re-validated against the host allowlist after redirects; per-IP rate limit (120/min); `X-Content-Type-Options: nosniff` now set in-app on all responses (not only in Caddy).

## LOW

### C4 — Register returns 409 EMAIL_IN_USE (account-existence oracle) (FIXED, partial)
- **Where:** `POST /api/auth/register`.
- **Fix:** an existing email now returns **200** `{ ok: true, message: "An account with this email already exists. Please sign in instead." }` — no `EMAIL_IN_USE` code, no user object, no session cookie. `login.js` shows the message and switches to the sign-in panel.
- **Honest limitation:** the 201-vs-200 status still distinguishes a fresh registration from an existing email, so a determined attacker can still distinguish by status. The full fix (identical generic response + no auto-sign-in) would break the auto-sign-in behavior the e2e suite enshrines; recorded as a future option, not silently closed.
- **Regression test:** `AUDIT C4`.

### C5 — Per-account login limiter enables targeted lockout (FIXED)
- **Where:** `POST /api/auth/login` — the per-account limiter (5/15 min) was checked *before* the credential check, so anyone who could solve the public Turnstile widget could lock any account for 15 minutes with 5 attempts.
- **Fix:** the per-IP limiter still counts every attempt up front (flood protection), but the per-account limiter now counts only *failures* and is checked after the credential check. A correct password always succeeds even while the account bucket is tripped; wrong passwords still lock the account after 5 failures.
- **Regression test:** `AUDIT C5` — 5 wrong logins from 5 IPs (401×5), 6th wrong → 429, correct password → 200.
- **Verified against existing tests 58/59:** 5 wrong → 401, 6th → 429, same-account-other-IP wrong → 429, correct after 4 wrong → 200 — all preserved.

### C8 — No change-password endpoint (FIXED)
- **Where:** account settings — only the emailed reset existed.
- **Fix:** `POST /api/auth/change-password` (requireAuth; current password required; sets the new hash; deletes all *other* sessions). Social-only accounts (NULL hash) get a clear error pointing at the reset link.
- **Regression test:** `AUDIT C3/C8`.

### C9 — Deterministic placeholder emails can be squatted (FIXED)
- **Where:** `no-email-mal-<id>@aniflick.invalid` / `no-email-anilist-<id>@aniflick.invalid` — MAL/AniList ids are public, so anyone could locally register a victim's future placeholder address; the victim's first social login then threw `SQLITE_CONSTRAINT_UNIQUE` → 502.
- **Fix:** (a) local registration of `@aniflick.invalid` addresses is rejected (400); (b) `linkOrCreateAccount` catches the UNIQUE conflict on insert and links the existing row instead of crashing (and clears its password per C2).
- **Regression test:** `AUDIT C9`.

### C6 — Rate-limiter map has no hard cap (FIXED)
- **Where:** `server/src/ratelimit.js` — entries only expired by time (prune at >5000, expired only); an attacker spraying distinct keys could grow the map without bound.
- **Fix:** hard cap of 10,000 entries; the oldest entry is evicted past the cap.

### D3 — Expired sessions never swept (FIXED)
- **Where:** no cleanup anywhere in the codebase.
- **Fix:** hourly sweep (`setInterval`, `.unref()` so tests don't hang) deletes expired sessions and expired reset tokens; runs once at startup too.

### D5 — Up to 5 live reset tokens can coexist per user (FIXED)
- **Where:** `POST /api/auth/forgot-password` minted a new token without revoking previous ones.
- **Fix:** `invalidateUserTokens(user.id)` runs before `createResetToken` in forgot-password — one live link at a time. (Note: `createResetToken` for the "setup" purpose in OAuth is untouched — it only fires for brand-new social accounts.)
- **Test impact:** e2e test 92 previously asserted two live tokens; updated to assert the first token is already invalidated by the second request and the second token is the live one.

### D4 — Secrets and DB files world-readable on EC2 (FIXED on EC2)
- **Where (EC2):** systemd drop-ins `oauth.conf` + `turnstile.conf` (hold all 8 OAuth secrets + Turnstile keys) and `aniverse.db` + `-wal`/`-shm` + two `.bak` files were mode 644.
- **Fix (applied via SSH):** all four drop-ins → 600, data dir → 700, db + wal/shm + both `.bak` files → 600. Verified after: `ls -l` shows `-rw-------` / `drwx------`. The service runs as `ubuntu` and still reads them (owner perms).

### C3-validation — Unvalidated slugs/episodes in progress + comments (FIXED)
- **Where:** `POST /api/progress` + guest `POST /api/comments` accepted unvalidated slugs/episodes — bogus slug → 500 FOREIGN KEY error; episode 99999 for a 220-ep title → 200 + a persisted phantom history row.
- **Fix:** both routes resolve the slug and check the episode range against the catalog (400/404). Comment rate limiter still runs first.
- **Regression test:** covered in `AUDIT D2` (bogus slug → 404, episode 99999 → 400).

### C5-SSRF — dub-check fetches provider URLs verbatim (FIXED)
- **Where:** `server/src/dub-check.js` — `sub.src`/`dub.src` from the provider payload, plus playlist variant/segment lines, were fetched with no allowlist, no private-IP block, and redirects followed.
- **Risk:** provider-trust only — end users can't steer it (numeric ids only); requires a compromised/malicious provider. A poisoned playlist could have steered the server at `127.0.0.1:4100` (Anivexa) or `169.254.169.254`.
- **Fix:** every fetched URL is validated before fetch and the final URL re-validated after redirects — https-only, public hosts only (rejects `localhost`, `.local`, and private/loopback/link-local/reserved IPv4 literals). Relative playlist lines resolve against the playlist base. A rejected URL throws → probe returns `available: null` (unknown), never a false positive.
- **Residual:** a hostname that DNS-rebinds to a private IP is not caught (no DNS resolution check). Accepted — only the provider can steer it.

### B2/B3 — Unescaped cover URLs and kind/status/genre passthroughs (FIXED)
- **Where:** `ani-verse/js/zoro-aizen.js` — `coverOf(t)` unescaped in `src="..."` at 5 renderers; `t.kind` unescaped at 4 sites; `genreLabel()` unescaped at the detail tooltip.
- **Risk:** latent only — covers today are hardcoded catalog paths or AniList CDN URLs rewritten to `/api/cover`; `kind` is a server-normalized enum ("Film"/"Series"). No attacker-controlled source exists today.
- **Fix:** `escapeHtml(coverOf(t))` at all 7 `src` sites, `escapeHtml(t.kind)` at all 4 sites, `escapeHtml(genreLabel(g))` at the tooltip.
- **Regression test:** `AUDIT B2/B3`.

### Minor — /api/stream validation (FIXED)
- **Where:** `GET /api/stream` — unknown `source` threw inside `buildEmbedUrl` → 500 instead of 400; `color` was passed through unvalidated; `mal_id`/`anilist_id` query params could shadow catalog ids with garbage.
- **Fix:** source validated against `ZOKO_SOURCES` (400); color must be 3–8 hex digits else the default; id overrides only apply when they are valid positive numbers.

### Expensive unauthenticated routes had no rate limits (FIXED)
- **Where:** `/api/cover`, `/api/animegg*`, `/api/dub-availability*`, `/api/hindi/vidstream3` — each call costs upstream fetches; 10/10 rapid requests got no 429.
- **Fix:** per-IP limiters — cover 120/min, animegg 60/min, dub-check 30/min, Hindi 60/min. Search/browse/A-Z deliberately left unlimited (the 148 e2e tests hit them rapidly from 127.0.0.1; AniList caching + upstream limits handle those).

## REJECTED (false positive, with evidence)

### D1 — Node CVE-2026-111497 "Broccoli2Shell" (CRITICAL, rejected)
- **Claim:** Node 22.22.1 < 22.23.4 is vulnerable to a Brotli OOB write (CVSS 9.2, CISA KEV since 27 Oct 2026).
- **Why rejected for this deployment:** EC2 Node is Ubuntu's build with `node_shared_brotli=true` — it does not ship its own Brotli; it links the system `libbrotli1`, which is **1.2.0-3ubuntu0.1**, and its changelog explicitly lists the CVE-2026-111497 security patch (USN, 25 Oct 2026). The version-number check (22.22.1 < 22.23.4) does not apply to Ubuntu's shared-library build. Verified directly on EC2 2026-11-29 ~01:15 IST. No Node upgrade needed. (The CVE itself is real; the VM's Node 24.22.1 is already the fixed version.)

## NOT CHANGED (accepted / informational)

- **C7 — Turnstile fail-open when the secret is unconfigured.** Live EC2 has the secret set and enforcement verified (`GET /api/auth/turnstile-key` → `enabled: true`). No code change.
- **D6 — No account-deletion / data-export / comment-deletion path.** Informational; a product decision, not a vulnerability. Recorded, not built overnight.
- **B4 — Zoko is unsandboxed by design.** Accepted trust in the primary player; sandboxing it needs a playback test and risks breaking fullscreen. Recorded.
- **D7 — npm audit was blocked by the VM egress proxy (403).** Resolved on EC2: `npm audit --omit=dev` → **found 0 vulnerabilities**. The Vulert listing of "4 HIGH" for nodemailer looks unreliable (placeholder GHSA ID); OSV spot-checks were clean (nodemailer 10.6.1 not affected by CVE-2026-125755/CVE-2026-121426; body-parser 2.4.0 is the fixed version for CVE-2026-111181).

## CLEAN (verified, no finding)

- Parameterized SQL everywhere; scrypt passwords + timing-safe compare + decoy-hash login; generic login/forgot/reset responses; reset tokens 256-bit, hashed at rest, single-use, 1h/24h expiry, reset kills all sessions+tokens.
- OAuth state single-use server-side (10 min) + PKCE S256 (Google/MAL); verified-email-only OAuth linking; no session fixation; cookie flags (`Secure`, `HttpOnly`, `SameSite=Lax`); `safeNextPath`; no secret logging; CSRF mitigated by SameSite=Lax + Turnstile gating.
- Comments escaped server-side AND rendered with `textContent`; all user-controlled data escaped or via `textContent`; `postMessage` origins checked exactly per branch; both sends use specific origins (no `"*"`) ; no `eval`/`new Function`/`document.write`; SEO JSON-LD neutralises `</script>` via `\u003c`.
- IDOR: all user-data routes scope by `req.user.id` (two-account test: Bob can't see/delete Alice's watchlist). GraphQL injection: all user input via variables; only interpolation is `sort` from the `BROWSE_SORTS` allowlist.
- `/api/cover` host allowlist (evil host/http → 400); `/api/stream` episode-range (ep 9999 → 404); FKs ON; migrations transactional; no secrets in repo/history (101 commits searched); DB not under web root.
- Headers: app sets CSP; live Caddyfile sets `nosniff`, HSTS, `Referrer-Policy`, `Permissions-Policy`, `X-Frame-Options`, strips `X-Powered-By`. `nosniff` is now also set in-app.

## DEPLOY + LIVE VERIFICATION

- **Commit:** `473208b` (audit fixes) on top of `54c4a95` (logo-only OAuth buttons), pushed to `faijaleaqbal/Aniverse` master.
- **EC2:** `git pull` → `sudo systemctl restart aniverse` → service **active**. D4 perms applied; `npm audit --omit=dev` → 0 vulnerabilities.
- **Live checks (2026-11-29, public URL):** homepage **200**, `/login` **200**, watch page `?live=180523&ep=1` **200**; served `zoro-aizen.js?v=41` carries `PLAYER_IFRAME_SANDBOX = "allow-scripts allow-forms allow-presentation"`; login page serves `login.css?v=3` + `login.js?v=4` with `PROVIDER_LOGOS`; path traversal `GET /..%2f..%2fetc%2fpasswd` → **404**.
- **Still needs a real-browser check (parent):** TVplus + Vidstream-3 playback after the B1 sandbox change (opaque origin), and a visual glance at the logo-only OAuth buttons on `/login`.

## TASK 2 — OAuth logo-only buttons (done in the same deploy)

- `login.js` `loadProviders()` + `zoro-aizen.js` `renderSocialLogins()` render an identical `PROVIDER_LOGOS` map (inline SVGs: Google 4-color "G", Discord Clyde white on #5865f2, AniList "A" white on #02a9ff, MAL "M" monogram white on #2e51a2 — no "MyAnimeList" text).
- Buttons are 48px squares in a centred row, same `/auth/<provider>?next=` URLs, `aria-label="Continue with <Provider>"`. Dark obsidian theme (#0c0d12/#14161f, #cae962 lime focus outline); old `.social-dot` rules removed. Cache-busters: login.css v3, login.js v4, zoro-aizen.css v33, zoro-aizen.js v41.
- Commit `54c4a95`. DOM-verified via Node stub (4 buttons, SVG-only, correct hrefs); live-browser visual glance still needed.
