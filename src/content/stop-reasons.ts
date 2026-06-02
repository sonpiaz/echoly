// Stop-reason constants for ContentApp.stopSession(reason).
// Using a `const` object so callers get autocomplete + exhaustiveness checking
// from the StopReason union without a full enum.

export const STOP_REASON = {
  DEFAULT: "stop",
  VIDEO_ENDED: "video-ended",
  USER_STOP: "user-stop",
  BACKEND_STOP: "backend-stop",
  AUTO_STOP_60MIN: "auto-stop-60min",
  SPA_NAVIGATION: "spa-navigation",
  UNLOAD: "unload",
  CONNECTION_LOST: "connection-lost",
  SERVER_ERROR: "server-error",
  HANDOVER_FAILED: "handover-failed",
  /** Platform cannot capture audio (DRM) and has no captions for this video. */
  NO_CC_UNSUPPORTED: "no-cc-unsupported",
  /** Auto-next continuation attempted but the new video could not be loaded/dubbed. */
  NEXT_VIDEO_LOAD_FAILED: "next-video-load-failed",
} as const;

export type StopReason = (typeof STOP_REASON)[keyof typeof STOP_REASON];

/**
 * User-facing status shown when a session ends. `stopSession` emits this (via
 * CONTENT_ENDED → background setStatus) — ONE source of truth, so no raw reason
 * code ever leaks to the UI and call sites no longer emit their own duplicate.
 * `Record<StopReason, string>` forces an entry for every reason (exhaustive).
 */
export const STOP_REASON_MESSAGE: Record<StopReason, string> = {
  [STOP_REASON.DEFAULT]: "Stopped",
  [STOP_REASON.VIDEO_ENDED]: "Video ended.",
  [STOP_REASON.USER_STOP]: "Stopped",
  // Not emitted (backend already drove the stop) — kept for exhaustiveness.
  [STOP_REASON.BACKEND_STOP]: "Stopped",
  [STOP_REASON.AUTO_STOP_60MIN]: "Auto-stopped at 60 min — start again to continue.",
  [STOP_REASON.SPA_NAVIGATION]: "Page navigated.",
  [STOP_REASON.UNLOAD]: "Stopped",
  [STOP_REASON.CONNECTION_LOST]: "Connection lost.",
  [STOP_REASON.SERVER_ERROR]: "Translation error.",
  [STOP_REASON.HANDOVER_FAILED]: "Switch failed.",
  [STOP_REASON.NO_CC_UNSUPPORTED]: "No captions available on this video.",
  [STOP_REASON.NEXT_VIDEO_LOAD_FAILED]: "Couldn't load the next video.",
};
