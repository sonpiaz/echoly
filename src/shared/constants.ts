// Shared constants — paths, timing, offline bootstrap exports.

import { ECHOLY_API_ORIGIN, ECHOLY_WEB_ORIGIN } from "./echoly-config";

export { ECHOLY_API_ORIGIN, ECHOLY_WEB_ORIGIN };

/** WXT content script bundle path (unhashed). */
export const CONTENT_SCRIPT_PATH = "content-scripts/content.js";
export const CONTENT_CSS_PATH = "content-scripts/content.css";

export const ECHOLY_VERSION = "0.6.3";
export const CONTENT_GLOBAL_KEY = "__echolyContentVersion";

/** Signed-in API base (all provider traffic via Echoly server). */
export const ECHOLY_PROXY_BASE = `${ECHOLY_API_ORIGIN}/v1`;

export const EC_SESSION_COOKIE = "ec_session";

export const SESSION_LIMIT_MS = 60 * 60 * 1000;
export const SESSION_WARNING_MS = 55 * 60 * 1000;
export const HEARTBEAT_MS = 30_000;
/** Realtime pipeline only: signals live mint at SDP (must exceed server CLIP_MAX_SEC). */
export const RTC_LIVE_DURATION_HINT_SEC = 3600;
export const CAPTION_POLL_MS = 350;
export const HISTORY_MAX = 16;
export const VOICE_GAIN_MAX = 2.0;
export const LAYOUT_KEY = "echolyOverlayLayout";
export const RTL_LANGS: ReadonlySet<string> = new Set(["ar", "fa", "he", "ur"]);

export const YT_CACHE_TTL_MS = 30 * 60 * 1000;
export const YT_CACHE_GC_MS = 5 * 60 * 1000;
export const BROADCAST_DEBOUNCE_MS = 50;

export type LangPair = readonly [code: string, name: string];

// ── Translation mode (settings.tier) — NOT account subscription tier ───────────

/** Low-latency WebRTC pipeline (OpenAI realtime translate). */
export const TIER_REALTIME = "realtime" as const;
/** Standard dubbing pipeline (tab audio → WebRTC standard). */
export const TIER_STANDARD = "standard" as const;

export const TRANSLATION_TIERS = [TIER_REALTIME, TIER_STANDARD] as const;
export type TranslationTier = (typeof TRANSLATION_TIERS)[number];

/** Standard VOD only — expected pipeline lag (video ahead of dub playhead). */
export const DUB_SYNC_TARGET_LAG_SEC = 5;
/** Hysteresis: enter above / exit below (avoids rate flicker). */
export const DUB_SYNC_ENTER_SOFT_SEC = 2.2;
export const DUB_SYNC_EXIT_SOFT_SEC = 1.0;
export const DUB_SYNC_ENTER_HARD_SEC = 4.8;
export const DUB_SYNC_EXIT_HARD_SEC = 3.0;
export const DUB_SYNC_ENTER_CATCHUP_SEC = -0.55;
export const DUB_SYNC_EXIT_CATCHUP_SEC = -0.15;
export const DUB_SYNC_LAG_EMA_ALPHA = 0.28;
export const DUB_SYNC_RATE_BLEND = 0.14;
export const DUB_SYNC_POLL_MS = 500;
export const DUB_SYNC_SLOW_RATE = 0.96;
export const DUB_SYNC_HARD_SLOW_RATE = 0.92;
export const DUB_SYNC_CATCHUP_RATE = 1.02;
/** Max wait for first Standard dub before video.play (VOD). */
export const DUB_TTFA_GATE_MS = 14_000;
/** Realtime VOD only — post-ICE align before play (no adaptive sync). */
export const REALTIME_VOD_PLAY_ALIGN_MS = 80;

/** Default translation mode — Standard; Realtime is opt-in on Max. */
export const DEFAULT_TRANSLATION_TIER: TranslationTier = TIER_STANDARD;

/** Popup/overlay tier row + dropdown copy (product UX — not provider-specific). */
export interface TierUiCopy {
  readonly primary: string;
  readonly secondary: string;
  readonly optionLabel: string;
}

export const TIER_UI: Readonly<Record<TranslationTier, TierUiCopy>> = {
  [TIER_STANDARD]: {
    primary: "Standard",
    secondary: "· AI voice dub · ~5s",
    optionLabel: "Standard · voice dub · ~5s · Pro/Free",
  },
  [TIER_REALTIME]: {
    primary: "Realtime",
    secondary: "· live voice-to-voice · <1s",
    optionLabel: "Realtime · live dub · <1s · Max",
  },
};

/** Realtime row when account cannot start Realtime (dropdown secondary). */
export const TIER_REALTIME_GATED_SECONDARY = "· Max plan";

/** Realtime row when gated but signed in (status row under tier picker). */
export const TIER_REALTIME_START_GATED_SECONDARY = "· Included with Max";

/** Session-manager discriminator for caption-driven pipeline. */

/** Target languages supported by OpenAI gpt-realtime-translate (server rtc.routes guard). */
export const GPT_REALTIME_TRANSLATE_OUTPUT_LANGS: readonly string[] = [
  "en",
  "es",
  "pt",
  "fr",
  "ja",
  "ru",
  "zh",
  "de",
  "ko",
  "hi",
  "id",
  "vi",
  "it",
];

export function isGptRealtimeTranslateLanguage(code: string): boolean {
  const c = (code ?? "").trim().toLowerCase();
  return GPT_REALTIME_TRANSLATE_OUTPUT_LANGS.includes(c);
}

/** Realtime OpenAI voice IDs (bundled until a public config endpoint exists). */
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

export { OFFLINE_STANDARD_DEFAULT_VOICE as STANDARD_DEFAULT_VOICE } from "@/lib/offline-voice-bootstrap";
