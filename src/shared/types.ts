// ────────────────────────────────────────────────────────────────────────────
// LOCKED CONTRACT — shared domain types. Shapes are derived verbatim from the
// legacy 0.6.3 `state` object (legacy/background.js:170-183), DEFAULT_SETTINGS
// (legacy/background.js:9-20), and the popup render contract (legacy/popup.js
// applyState). Build agents import these — do NOT redefine.
// ────────────────────────────────────────────────────────────────────────────

import type { AdvancedSettings, SiteOverrideMap } from "./advanced";
import { DEFAULT_ADVANCED } from "./advanced";

/** Translation mode chosen by the user (settings.tier). NOT the account tier. */
export type TranslationTier = "realtime" | "standard";

/** Account / subscription tier (signedInUser.tier). NOT the translation mode. */
export type AccountTier = "free" | "pro" | "max";

/** How the content script's provider calls are routed.
 *  "byok" = user's own Kyma key (wins when present); "proxy" = Echoly session. */
export type ApiMode = "byok" | "proxy" | null;

/** The 8 persisted settings keys (chrome.storage.local). `kymaKey` is the
 *  LEGACY name for the resolved bearer (a Kyma key OR an Echoly session token);
 *  keep the name unless renamed on BOTH sides. */
export interface Settings {
  tier: TranslationTier;
  targetLanguage: string;
  realtimeVoice: string;
  standardVoice: string;
  originalVolume: number;
  voiceVolume: number;
  showSource: boolean;
  kymaKey: string;
}

/** Verbatim DEFAULT_SETTINGS (legacy/background.js:9-20). */
export const DEFAULT_SETTINGS: Settings = {
  tier: "realtime",
  targetLanguage: "vi",
  realtimeVoice: "marin",
  standardVoice: "English_magnetic_voiced_man",
  originalVolume: 18,
  voiceVolume: 100,
  showSource: false,
  kymaKey: "",
};

export interface SignedInUser {
  email: string;
  tier: AccountTier;
}

export interface Usage {
  standard: number; // used minutes
  realtime: number; // used minutes
}

// ── Guest language policy ────────────────────────────────────────────────────
// In the GUEST world (apiMode === "byok": user brings their own Kyma key, no
// Echoly account) the extension limits the languages it offers. The policy is
// served by the Echoly server at GET /v1/config/guest (public, admin-editable
// on the server). The extension fetches it, caches it, and falls back to a
// default (en→vi) on failure. Enforcement is client-side — it's a UX nudge,
// not a security boundary (the guest spends their own Kyma credit, so no
// Echoly resource is at risk). See the approved plan §4.

export interface GuestLanguagePolicy {
  /** ISO codes (e.g. "en", "vi") allowed as the SOURCE language for guests. */
  allowedSource: string[];
  /** ISO codes allowed as the TARGET language for guests. */
  allowedTarget: string[];
  /** Defaults the extension pre-selects when entering guest mode or when the
   *  currently-selected language is outside the allowed set. */
  defaults: { source: string; target: string };
}

/** Default served when the policy fetch fails or shape-validates as invalid. */
export const DEFAULT_GUEST_LANGUAGE_POLICY: GuestLanguagePolicy = {
  allowedSource: ["en"],
  allowedTarget: ["vi"],
  defaults: { source: "en", target: "vi" },
};

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
  /** Guest language policy (null until the first fetch lands; popup gates on
   *  this when apiMode === "byok"). */
  guestPolicy: GuestLanguagePolicy | null;
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
  guestPolicy: null,
  sessionStartedAt: null,
  advanced: { ...DEFAULT_ADVANCED },
  siteOverrides: {},
  advancedVersion: 0,
  advancedDirty: false,
  currentDomain: null,
  ...DEFAULT_SETTINGS,
};

/** Result of resolveApiMode (legacy/background.js:153-166). null when neither
 *  a BYOK key nor a signed-in Echoly session is available. */
export interface ResolvedApiMode {
  apiBase: string;
  apiKey: string;
  mode: Exclude<ApiMode, null>;
  user: SignedInUser | null;
}

/** Settings payload the SW relays to content on CONTENT_START
 *  (legacy/background.js:304-308): a full state snapshot with apiBase added and
 *  `kymaKey` OVERRIDDEN to the resolved bearer. */
export interface StartSettings extends State {
  apiBase: string;
}

/** A YouTube caption-track cache entry (legacy/background.js:45-52). */
export interface YtCaptionEntry {
  url: string;
  lang: string | null;
  kind: string | null;
  tlang: string | null;
  isAsr: boolean;
  capturedAt: number;
}

/** One translated turn in the overlay history (newest-first, capped HISTORY_MAX). */
export interface HistoryTurn {
  source: string;
  target: string;
}
