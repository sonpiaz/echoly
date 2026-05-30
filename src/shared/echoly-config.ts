// ────────────────────────────────────────────────────────────────────────────
// Echoly environment config — single place to audit dev vs production origins.
//
// Build-time overrides (WXT / Vite static replace):
//   • `.env.development`  → `wxt dev`, `wxt build --mode development`
//   • `.env.production`   → `wxt build`, `wxt zip` (store build)
//   • `.env.development.local` / `.env.local` → per-machine overrides (gitignored)
//
// See extension/.env.example for the full matrix.
// ────────────────────────────────────────────────────────────────────────────

/** Production defaults — must match committed `.env.production`. */
export const ECHOLY_PROD_ORIGINS = {
  api: "https://api.echolyhq.com",
  web: "https://echolyhq.com",
} as const;

export const ECHOLY_API_ORIGIN: string =
  import.meta.env.WXT_ECHOLY_API_ORIGIN ?? ECHOLY_PROD_ORIGINS.api;

export const ECHOLY_WEB_ORIGIN: string =
  import.meta.env.WXT_ECHOLY_WEB_ORIGIN ?? ECHOLY_PROD_ORIGINS.web;

/** `development` | `production` — from Vite/WXT mode at build time. */
export const ECHOLY_BUILD_MODE: string = import.meta.env.MODE ?? "production";

/** Web app routes (path + hash only; no origin). */
export const ECHOLY_WEB_PATHS = {
  signin: "/signin",
  account: "/account",
  accountBilling: "/account#billing",
  accountUsage: "/account#usage",
  help: "/help",
  privacy: "/privacy",
  terms: "/terms",
} as const;

export type EcholyWebPath = (typeof ECHOLY_WEB_PATHS)[keyof typeof ECHOLY_WEB_PATHS];

/** Absolute URL on the configured web origin. */
export function webUrl(path: EcholyWebPath | `/${string}`): string {
  const base = ECHOLY_WEB_ORIGIN.replace(/\/$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

/** Pre-built URLs for popup / overlay / background (import these, don't string-concat). */
export const ECHOLY_WEB_URLS = {
  signin: () => webUrl(ECHOLY_WEB_PATHS.signin),
  account: () => webUrl(ECHOLY_WEB_PATHS.account),
  accountBilling: () => webUrl(ECHOLY_WEB_PATHS.accountBilling),
  accountUsage: () => webUrl(ECHOLY_WEB_PATHS.accountUsage),
  help: () => webUrl(ECHOLY_WEB_PATHS.help),
  privacy: () => webUrl(ECHOLY_WEB_PATHS.privacy),
  terms: () => webUrl(ECHOLY_WEB_PATHS.terms),
} as const;

/** Hostname for user-facing copy, e.g. "Sign in at echolyhq.com …". */
export function echolyWebHostLabel(): string {
  try {
    return new URL(ECHOLY_WEB_ORIGIN).host;
  } catch {
    return "echolyhq.com";
  }
}

/** Shown when START has no Echoly session. */
export function signInToStartMessage(): string {
  return `Sign in at ${echolyWebHostLabel()} to start.`;
}

/**
 * `ec_session` cookie domains accepted by auth-listener (exact match only).
 * Production: apex + `.apex`. Local dev (`localhost:4321`): `localhost` only.
 */
/** Origins to probe for `ec_session` (web first, then API when split in dev). */
export function echolySessionTokenOrigins(): readonly string[] {
  const web = ECHOLY_WEB_ORIGIN.replace(/\/$/, "");
  const api = ECHOLY_API_ORIGIN.replace(/\/$/, "");
  return web === api ? [web] : [web, api];
}

export function echolySessionCookieDomains(): readonly string[] {
  const host = echolyWebHostLabel();
  // Browser cookies use domain "localhost" (no port), even when the page is :4321.
  if (host === "localhost" || host.startsWith("localhost:") || host.startsWith("127.0.0.1")) {
    return ["localhost", "127.0.0.1"];
  }
  const apex = host.startsWith("www.") ? host.slice(4) : host;
  return [apex, `.${apex}`];
}

/** Snapshot for debugging / support (no secrets). */
export function echolyConfigSnapshot(): {
  buildMode: string;
  apiOrigin: string;
  webOrigin: string;
  webHost: string;
  cookieDomains: readonly string[];
  sessionTokenOrigins: readonly string[];
} {
  return {
    buildMode: ECHOLY_BUILD_MODE,
    apiOrigin: ECHOLY_API_ORIGIN,
    webOrigin: ECHOLY_WEB_ORIGIN,
    webHost: echolyWebHostLabel(),
    cookieDomains: echolySessionCookieDomains(),
    sessionTokenOrigins: echolySessionTokenOrigins(),
  };
}
