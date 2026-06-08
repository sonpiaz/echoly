// Shared domain types — background state, settings, and cross-surface contracts.

import type { LangPair, TranslationTier } from "./constants";
import { DEFAULT_TRANSLATION_TIER } from "./constants";
import type { AdvancedSettings, SiteOverrideMap } from "./advanced";
import { DEFAULT_ADVANCED } from "./advanced";

export type { TranslationTier } from "./constants";
export { TIER_REALTIME, TIER_STANDARD, DEFAULT_TRANSLATION_TIER } from "./constants";

/** Account / subscription tier (signedInUser.tier). NOT the translation mode. */
export type AccountTier = "free" | "pro" | "max";

/** Signed-in Echoly session routes API calls through the server proxy. */
export type ApiMode = "proxy" | null;

/** The persisted settings keys (chrome.storage.local). `apiBearer` is not
 *  user-editable; CONTENT_START overwrites it with the session bearer. */
export interface Settings {
  tier: TranslationTier;
  targetLanguage: string;
  /** Source (spoken) language of the video. `"auto"` = auto-detect the original
   *  caption track; an explicit BCP-47 code (e.g. `"en"`) forces that source. */
  sourceLanguage: string;
  realtimeVoice: string;
  standardVoice: string;
  originalVolume: number;
  voiceVolume: number;
  showSource: boolean;
  /** Show translated subtitles on the video overlay strip (all platforms). */
  showTargetCaptions: boolean;
  apiBearer: string;
}

export const DEFAULT_SETTINGS: Settings = {
  tier: DEFAULT_TRANSLATION_TIER,
  targetLanguage: "vi",
  sourceLanguage: "auto",
  realtimeVoice: "marin",
  standardVoice: "English_magnetic_voiced_man",
  originalVolume: 18,
  voiceVolume: 100,
  showSource: false,
  showTargetCaptions: true,
  apiBearer: "",
};

export interface SignedInUser {
  id?: string;
  email: string;
  tier: AccountTier;
  cancel_at_period_end?: boolean;
}

export interface Usage {
  /** Total credits used this period (unified pool — standard + realtime). */
  used: number;
  /** Unified pool cap from server snapshot (capCredits). */
  cap?: number;
  /** Server-computed remaining credits from unified pool. */
  remaining?: number;
  /** Max-only feature entitlement flag from server snapshot. */
  realtimeAllowed?: boolean;
  /** Period end from bootstrap `usage.resetsAt` (anchor-based; not calendar month). */
  resetsAt?: string;
}

/** The canonical session snapshot owned by the background SW (single source of
 *  truth). Popup is a passive renderer of this; content holds no copy. */
export interface State extends Settings {
  running: boolean;
  connecting: boolean;
  paused: boolean;
  tabId: number | null;
  status: string;
  errorMessage: string;
  apiMode: ApiMode;
  signedInUser: SignedInUser | null;
  usage: Usage | null;
  /** Target-language options from server catalog (full catalog; not tier-gated). */
  languagePicker: LangPair[] | null;
  /** Display names from server `languages` map (catalog SoT). */
  languageNames: Record<string, string> | null;
  /** Standard-tier voice catalog from bootstrap or GET /v1/config/voices (signed-out). */
  standardVoices: ReadonlyArray<{ id: string; label: string }> | null;
  /** Default standard voice_id from server catalog. */
  standardVoiceDefaultId: string | null;
  /** Wall-clock millis when the current session went `running=true`. Set by
   *  the session coordinator on START, cleared on STOP. The popup uses this
   *  to render an authoritative elapsed counter; without it the counter
   *  would only know "time since popup opened". */
  sessionStartedAt: number | null;

  // ── Advanced settings (server-authoritative, per-user) ─────────────────
  /** Global Advanced settings for the signed-in user. Defaults applied when
   *  signed-out / first sync hasn't landed. */
  advanced: AdvancedSettings;
  /** Per-site overrides: `{ [hostname]: Partial<AdvancedSettings> }`. */
  siteOverrides: SiteOverrideMap;
  /** Monotonically-increasing version assigned by the server. 0 ⇒ never
   *  synced (defaults in use); used as the optimistic-concurrency token on
   *  PUT. Server returns the new version on success. */
  advancedVersion: number;
  /** When a popup edit succeeds locally but the server PUT failed (offline /
   *  500), this flag persists. SW retries on next boot / sign-in / popup open. */
  advancedDirty: boolean;
  /** Hostname of the active translation tab. Set when the SW resolves a
   *  YouTube tab for START; used for per-site override lookup + auto-start
   *  matching. null when no active tab. */
  currentDomain: string | null;
}

/** Verbatim initial in-memory state (legacy/background.js:170-183). */
export const INITIAL_STATE: State = {
  running: false,
  connecting: false,
  paused: false,
  tabId: null,
  status: "Ready",
  errorMessage: "",
  apiMode: null,
  signedInUser: null,
  usage: null,
  languagePicker: null,
  languageNames: null,
  standardVoices: null,
  standardVoiceDefaultId: null,
  sessionStartedAt: null,
  advanced: { ...DEFAULT_ADVANCED },
  siteOverrides: {},
  advancedVersion: 0,
  advancedDirty: false,
  currentDomain: null,
  ...DEFAULT_SETTINGS,
};

/** Background-internal hard-navigation continuation marker. Recorded by nav-stop
 *  the moment a RUNNING session hard-navigates to another supported watch page
 *  (playlist auto-advance / full reload), consumed by auto-start on the fresh
 *  page's `complete` event to bypass Gate-4 and auto-continue the dub.
 *  NOT part of the broadcast State / INITIAL_STATE — it never leaves the SW. */
export interface ContinuationIntent {
  tabId: number;
  /** Date.now() when the intent was recorded. */
  at: number;
}

/** Result of resolveApiMode — null when not signed in. */
export interface ResolvedApiMode {
  apiBase: string;
  apiKey: string;
  mode: "proxy";
  user: SignedInUser;
}

/** Full state snapshot relayed to content on CONTENT_START (apiBase + apiBearer). */
export interface StartSettings extends State {
  apiBase: string;
}

/** One translated turn in the overlay history (newest-first, capped HISTORY_MAX). */
export interface HistoryTurn {
  source: string;
  target: string;
}
