/* OAuth provider definitions + pure helpers (no database import — safe to
   use from the smoke tests, which must never touch a database).
   The route handlers and account linking live in oauth.js. */
import { createHash } from "node:crypto";
import { BASE_URL } from "./config.js";
import { cleanText } from "./utils.js";

/* Provider table. MAL requires PKCE (no client-secret-only flow); Google
   uses it too. Discord and AniList use the plain confidential-client flow.
   MAL and AniList have no scope parameter for basic profile access. */
export const OAUTH_PROVIDERS = {
  google: {
    id: "google",
    name: "Google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    scope: "openid email profile",
    pkce: true,
    clientIdEnv: "GOOGLE_CLIENT_ID",
    clientSecretEnv: "GOOGLE_CLIENT_SECRET",
  },
  discord: {
    id: "discord",
    name: "Discord",
    authorizeUrl: "https://discord.com/oauth2/authorize",
    tokenUrl: "https://discord.com/api/oauth2/token",
    userinfoUrl: "https://discord.com/api/users/@me",
    scope: "identify email",
    pkce: false,
    clientIdEnv: "DISCORD_CLIENT_ID",
    clientSecretEnv: "DISCORD_CLIENT_SECRET",
  },
  mal: {
    id: "mal",
    name: "MyAnimeList",
    authorizeUrl: "https://myanimelist.net/v1/oauth2/authorize",
    tokenUrl: "https://myanimelist.net/v1/oauth2/token",
    userinfoUrl: "https://myanimelist.net/v1/users/@me",
    scope: "",
    pkce: true,
    clientIdEnv: "MAL_CLIENT_ID",
    clientSecretEnv: "MAL_CLIENT_SECRET",
  },
  anilist: {
    id: "anilist",
    name: "AniList",
    authorizeUrl: "https://anilist.co/api/v2/oauth/authorize",
    tokenUrl: "https://anilist.co/api/v2/oauth/token",
    userinfoUrl: "https://graphql.anilist.co",
    scope: "",
    pkce: false,
    clientIdEnv: "ANILIST_CLIENT_ID",
    clientSecretEnv: "ANILIST_CLIENT_SECRET",
  },
};

export const OAUTH_PROVIDER_IDS = Object.keys(OAUTH_PROVIDERS);

/* Credentials are read from process.env at USE time (not import time) so
   the enabled/disabled state follows the live environment. */
export function providerConfig(providerId) {
  const def = OAUTH_PROVIDERS[providerId];
  if (!def) return null;
  const clientId = (process.env[def.clientIdEnv] || "").trim();
  const clientSecret = (process.env[def.clientSecretEnv] || "").trim();
  return { ...def, clientId, clientSecret, enabled: Boolean(clientId && clientSecret) };
}

export function enabledProviders() {
  return OAUTH_PROVIDER_IDS.map(providerConfig)
    .filter((p) => p.enabled)
    .map((p) => ({ id: p.id, name: p.name }));
}

export function buildRedirectUri(providerId) {
  return `${BASE_URL}/auth/${providerId}/callback`;
}

/* PKCE S256 code challenge. RFC 7636 test vector: verifier
   dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk →
   E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM. */
export function pkceChallenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

/* Placeholder for accounts whose provider returns no email. The .invalid
   TLD (RFC 2606) can never be a real address, so it is unmistakably fake;
   the provider user id keeps it unique. The user can add a real email
   later (profile feature, not this change). */
export function placeholderEmail(provider, providerUserId) {
  const safeId = String(providerUserId).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64) || "unknown";
  return `no-email-${provider}-${safeId}@aniflick.invalid`;
}

export function isPlaceholderEmail(email) {
  return typeof email === "string" && email.endsWith("@aniflick.invalid");
}

/* Provider display names can be long or odd — clean and cap at the same
   40-character limit local registration uses. */
export function cleanSocialName(name) {
  const cleaned = cleanText(name).slice(0, 40);
  return cleaned || "AniFlick User";
}
