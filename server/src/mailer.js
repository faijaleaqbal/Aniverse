/* Outgoing mail (password-reset + set-password magic links), via Nodemailer
   SMTP. Configuration is ONLY environment variables — no credentials in
   code or git:

     SMTP_HOST     SMTP server hostname (required for mail to send)
     SMTP_PORT     port, default 587
     SMTP_SECURE   "true" for implicit TLS (port 465); default false
     SMTP_USER     SMTP username (optional — some relays need none)
     SMTP_PASS     SMTP password
     MAIL_FROM     sender address shown in the inbox (required)

   Privacy rules (hard requirements, not style):
   - Nothing in this module ever logs a recipient address, a token, or a
     link. The only log lines are fixed strings plus nodemailer's error
     CODE (e.g. EAUTH, ECONNECTION), which carries no personal data.
   - When SMTP is unconfigured the app still runs: sendMail returns
     { sent: false, reason: "unconfigured" } and logs one generic warning
     per process (not per attempt — a forgot-password flood must not fill
     the log).
   - Credentials are read from process.env at USE time (same pattern as
     oauth-providers.js), so the enabled/disabled state follows the live
     environment.
*/
import nodemailer from "nodemailer";

const RESET_TTL_LABEL = "1 hour";
const SETUP_TTL_LABEL = "24 hours";

let cachedTransport = null;
let cachedTransportKey = null;
let warnedUnconfigured = false;
/* Test seam (same pattern as animegg._setAnivexaBaseUrlForTests): the e2e
   suite injects a capture transport so no real SMTP is ever used in tests.
   Production never calls it. */
let testTransport = null;

export function _setMailTransportForTests(transport) {
  testTransport = transport || null;
}

function mailConfig() {
  const host = (process.env.SMTP_HOST || "").trim();
  const from = (process.env.MAIL_FROM || "").trim();
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = process.env.SMTP_SECURE === "true";
  const user = (process.env.SMTP_USER || "").trim();
  const pass = process.env.SMTP_PASS || "";
  return { host, from, port: Number.isFinite(port) && port > 0 ? port : 587, secure, user, pass };
}

export function isMailConfigured() {
  if (testTransport) return true;
  const { host, from } = mailConfig();
  return Boolean(host && from);
}

function getTransport() {
  if (testTransport) return testTransport;
  const cfg = mailConfig();
  const key = [cfg.host, cfg.port, cfg.secure, cfg.user].join("|");
  if (!cachedTransport || cachedTransportKey !== key) {
    const options = { host: cfg.host, port: cfg.port, secure: cfg.secure };
    if (cfg.user) options.auth = { user: cfg.user, pass: cfg.pass };
    cachedTransport = nodemailer.createTransport(options);
    cachedTransportKey = key;
  }
  return cachedTransport;
}

/* Send one message. Never throws for a missing/broken mail setup — it
   returns { sent: false } and the caller carries on (the forgot-password
   endpoint always answers the same generic message either way). */
export async function sendMail({ to, subject, text }) {
  if (!isMailConfigured()) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn("Mail is not configured (SMTP_HOST / MAIL_FROM missing) — email not sent.");
    }
    return { sent: false, reason: "unconfigured" };
  }
  try {
    const { from } = mailConfig();
    await getTransport().sendMail({ from, to, subject, text });
    return { sent: true };
  } catch (err) {
    /* Log the error CODE only — the message can carry server text that
       echoes the recipient or the SMTP dialogue. */
    console.error("Mail send failed:", err && err.code ? String(err.code) : "unknown");
    return { sent: false, reason: "send_failed" };
  }
}

/* The two password emails. Plain text, minimal: the link is the only
   variable content — no name, no username, no account details. */
export function passwordEmailText({ link, purpose }) {
  if (purpose === "setup") {
    return {
      subject: "Set a password for your AniFlick account",
      text: [
        "You signed in to AniFlick with a social account.",
        "You can also set a password, so you can sign in with your email address.",
        "",
        `Use this link to set a password (it works for ${SETUP_TTL_LABEL}):`,
        "",
        link,
        "",
        "If you didn't sign up for AniFlick, you can ignore this email.",
        "Nothing will change unless you use the link.",
      ].join("\n"),
    };
  }
  return {
    subject: "Reset your AniFlick password",
    text: [
      "You asked to reset your AniFlick password.",
      "",
      `Use this link to set a new password (it works for ${RESET_TTL_LABEL}):`,
      "",
      link,
      "",
      "If you didn't ask for this, you can ignore this email — your password won't change.",
    ].join("\n"),
  };
}

export async function sendPasswordEmail({ to, link, purpose }) {
  const { subject, text } = passwordEmailText({ link, purpose });
  return sendMail({ to, subject, text });
}
