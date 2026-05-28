// ────────────────────────────────────────────────────────────────────────────
// LOCKED CONTRACT — shared domain types. Shapes are derived verbatim from the
// legacy 0.6.3 `state` object (legacy/background.js:170-183), DEFAULT_SETTINGS
// (legacy/background.js:9-20), and the popup render contract (legacy/popup.js
// applyState). Build agents import these — do NOT redefine.
// ────────────────────────────────────────────────────────────────────────────

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
