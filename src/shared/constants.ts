// ────────────────────────────────────────────────────────────────────────────
// LOCKED CONTRACT — shared constants. Values are verbatim from legacy 0.6.3
// (legacy/content.js, legacy/background.js, legacy/popup.js). Do NOT change a
// value during the rebuild; behavior must stay identical. Build agents import
// from here — they must not redefine these.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Stable, unhashed output path of the bundled content script under WXT
 * (verified: `content-scripts/content.js`). This is the SINGLE source of the
 * path — `chrome.scripting.executeScript({files:[CONTENT_SCRIPT_PATH]})` and
 * `insertCSS` use it (replacing the legacy literal "content.js").
 */
export const CONTENT_SCRIPT_PATH = "content-scripts/content.js";
export const CONTENT_CSS_PATH = "content-scripts/content.css";

/** F9 idempotent version guard. Single-sourced from the manifest/package.json
 * version (fixes the legacy 0.6.1↔0.6.3 drift). The guard is version-keyed. */
export const ECHOLY_VERSION = "0.6.3";
export const CONTENT_GLOBAL_KEY = "__echolyContentVersion";

// ───── API bases (legacy/content.js, legacy/background.js) ─────
// Echoly origins are BUILD-TIME configurable so a local dev build points at
// localhost without editing source. Set WXT_ECHOLY_API_ORIGIN +
// WXT_ECHOLY_WEB_ORIGIN in extension/.env to override (see .env.example).
// Defaults = prod URLs so a `wxt zip` for the store ships with the right
// values. Kyma + OpenAI URLs are not overridable (they ARE the provider URLs).
export const KYMA_BASE = "https://api.kymaapi.com/v1";
export const KYMA_DIRECT_BASE = "https://api.kymaapi.com/v1";
export const OPENAI_CALLS_URL =
  "https://api.openai.com/v1/realtime/translations/calls";

// Dot notation (NOT bracket) so Vite does the static-replace at build time.
// Falls back to prod URLs when the env var is undefined (store-ready by default).
export const ECHOLY_API_ORIGIN =
  import.meta.env.WXT_ECHOLY_API_ORIGIN ?? "https://api.echolyhq.com";
export const ECHOLY_WEB_ORIGIN =
  import.meta.env.WXT_ECHOLY_WEB_ORIGIN ?? "https://echolyhq.com";

// Echoly server unified API base. Used when apiMode === "proxy" (signed-in)
// for /v1/rtc/translate, /v1/translate/chunk, /v1/chat. The legacy /v1/proxy
// path remains on the SERVER as a compat shim for 0.6.x extension versions; the
// rebuilt extension targets /v1 directly. (Plan §2, Wave 3.)
export const ECHOLY_PROXY_BASE = `${ECHOLY_API_ORIGIN}/v1`;

/** Public guest-mode policy endpoint (no auth, admin-editable on the server). */
export const ECHOLY_GUEST_CONFIG_URL = `${ECHOLY_API_ORIGIN}/v1/config/guest`;
export const EC_SESSION_COOKIE = "ec_session";

// ───── Session / timing tunables (legacy/content.js) ─────
export const SESSION_LIMIT_MS = 60 * 60 * 1000;
export const SESSION_WARNING_MS = 55 * 60 * 1000;
export const HEARTBEAT_MS = 30_000;
export const CAPTION_POLL_MS = 350;
export const HISTORY_MAX = 16;
export const VOICE_GAIN_MAX = 2.0; // unity at slider 50, 2× boost at 100
export const LAYOUT_KEY = "echolyOverlayLayout";
export const RTL_LANGS: ReadonlySet<string> = new Set(["ar", "fa", "he", "ur"]);

// ───── Standard (chunked) pipeline tunables (legacy/content.js) ─────
export const STANDARD_CHUNK_MS = 5000;
export const STANDARD_MIN_CHUNK_BYTES = 2000; // sub-2KB blobs are silence
export const STANDARD_RECORDER_MIMES: readonly string[] = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

// ───── YouTube caption cache (legacy/background.js) ─────
export const YT_CACHE_TTL_MS = 30 * 60 * 1000;
export const YT_CACHE_GC_MS = 5 * 60 * 1000;

// ───── Broadcast debounce (legacy/background.js) ─────
export const BROADCAST_DEBOUNCE_MS = 50;

// ───── Language + voice option lists ─────
// NOTE: the overlay and popup render DIFFERENT labels for the "Auto" option
// (overlay "Auto", popup "Auto · clones speaker"). Keep the data here; render
// the surface-specific label in each surface (do NOT collapse to one form).
export type LangPair = readonly [code: string, name: string];

export const LANGUAGES: readonly LangPair[] = [
  ["en", "English"],
  ["vi", "Vietnamese"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["zh", "Chinese"],
  ["fr", "French"],
  ["es", "Spanish"],
  ["de", "German"],
  ["pt", "Portuguese"],
  ["hi", "Hindi"],
  ["id", "Indonesian"],
  ["it", "Italian"],
  ["ru", "Russian"],
];

export const LANG_NAME: Readonly<Record<string, string>> =
  Object.fromEntries(LANGUAGES);

export const REALTIME_VOICES: readonly string[] = [
  "marin",
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
];

// Standard tier voices — Minimax `speech-02-turbo` IDs. Curated 2026-05-08.
export const STANDARD_VOICES: readonly LangPair[] = [
  ["English_magnetic_voiced_man", "Magnetic Man"],
  ["English_captivating_female1", "Captivating Female"],
  ["English_ManWithDeepVoice", "Deep Voice Man"],
  ["English_ConfidentWoman", "Confident Woman"],
  ["Chinese (Mandarin)_News_Anchor", "News Anchor"],
];

export const STANDARD_DEFAULT_VOICE = STANDARD_VOICES[0]![0];

// ───── Tier usage caps (minutes) — legacy/popup.js renderUsageMeters ─────
export interface TierCap {
  readonly std: number;
  readonly rt: number;
}
export const TIER_CAPS: Readonly<Record<string, TierCap>> = {
  free: { std: 30, rt: 0 },
  pro: { std: 600, rt: 0 },
  max: { std: 3000, rt: 120 },
};
