// User-facing product strings — voice-to-voice dubbing on video sites (multi-platform).

/** Chrome Web Store / manifest `name`. */
export const PRODUCT_NAME =
  "Echoly — AI voice dubbing & translation for video";

/** Manifest `description` (store listing). */
export const PRODUCT_DESCRIPTION =
  "Voice-to-voice AI dubbing and live translation for videos on YouTube, courses, and more. Hear any page in your language.";

/** Toolbar action tooltip. */
export const PRODUCT_ACTION_TITLE = "Echoly — AI voice dubbing";

/** Popup header under logo. */
export const PRODUCT_TAGLINE = "Voice dubbing & translation";

/** First-run welcome headline (HTML allows <br>). */
export const WELCOME_HEADLINE = "AI voice dubbing<br>for video on any site";

export const WELCOME_TAGLINE =
  "Hear videos dubbed in your language — voice-to-voice on any site with a player. Captions on YouTube when available. Realtime <1s (Max) or Standard (~5s).";

/** Shown when Start cannot find a target tab. */
export const ERR_NO_VIDEO_TAB =
  "Open a page with video first (YouTube, Coursera, Udemy, …).";

export const TOAST_PRESS_PLAY = "Press play on the video to start dubbing";

export const TOAST_NO_CC_FALLBACK =
  "No captions — using live voice dubbing (~5s lag)";

/** Shown in the "ad-wait" overlay state while a YouTube ad plays. */
export const STATUS_AD_WAIT = "Waiting for ad to finish…";

export const STATUS_PAUSED_VIDEO = "Paused — press play to resume";
export const STATUS_SWITCHING_VIDEO = "Switching to next video…";
export const STATUS_LOADING_NEXT = "Loading next video…";

// ── Phase-label copy for the loading/buffering UX (Workstream C3) ──────────
// These are the honest status strings shown during each loading phase.
// Callers set these via overlay.setStatusText(). Keeping them here (rather
// than inline) means copy-only changes stay in one place and referencing code
// gets a named constant the type-checker can track.

/** Shown while acquiring audio capture / initial WebRTC handshake (pre-connect). */
export const STATUS_CONNECTING = "Connecting…";

/** Shown during the caption-fetch + first TTS batch phase (subtitle-first pipeline). */
export const STATUS_PREPARING_DUB = "Preparing dub…";

/** Shown during subtitle-first micro-pause (next cue not yet buffered). */
export const STATUS_BUFFERING = "Buffering…";

/** Shown when a WebRTC session is reconnecting after connection loss. */
export const STATUS_RECONNECTING = "Reconnecting…";
