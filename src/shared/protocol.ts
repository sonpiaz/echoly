// ────────────────────────────────────────────────────────────────────────────
// Cross-surface message protocol (popup ↔ background ↔ content).
//
// PRESERVED QUIRKS (do NOT "fix" — they are behavior):
//  • Background routes on `sender.tab` truthiness: content-origin (has tab) vs
//    popup-origin (no tab). Use isFromContent(sender).
//  • The async popup branch returns `true` (keeps the channel open);
//    the content branches return `false`. Surface code owns those returns.
//  • Genuine fire-and-forget sends (UPDATE_VOLUME from popup, CONTENT_STATE /
//    CONTENT_ENDED from content, BACKGROUND_STATE_UPDATE broadcast) use post()
//    — no awaiting, errors swallowed.
//  • CONTENT_UPDATE_SETTINGS: background reads `reply.state` but content does
//    NOT send it → response.state is OPTIONAL.
//  • UPDATE_SETTINGS from content persists via SessionCoordinator.
// ────────────────────────────────────────────────────────────────────────────

import type { TranslationTier } from "./constants";
import type { State, StartSettings, Settings } from "./types";
import type { AdvancedPatch } from "./advanced";

// ───── Generic response shapes ─────
export type Ok = { ok: true };
export type Err = { ok: false; error: string };
export type Ack = Ok | Err;
export type StateResult = { ok: true; state: State } | Err;

// ════════════════════════════════════════════════════════════════════════════
// Popup → Background  (sent via chrome.runtime.sendMessage; NO sender.tab)
// ════════════════════════════════════════════════════════════════════════════
export type PopupToBgMessage =
  | { type: "GET_STATE" }
  | { type: "SIGN_OUT_ECHOLY" }
  | { type: "OPEN_SIGNIN" } // Wave: popup asks bg to open signin tab + track its id
  | { type: "START"; settings?: Partial<Settings> }
  | { type: "STOP" }
  | { type: "UPDATE_SETTINGS"; settings?: Partial<Settings> }
  | { type: "UPDATE_VOLUME"; originalVolume?: number; voiceVolume?: number }
  // ── Advanced settings sync (Wave: per-user Advanced controls) ──────────
  | { type: "UPDATE_ADVANCED_SETTINGS"; patch: AdvancedPatch }
  | { type: "UPDATE_SITE_OVERRIDE"; domain: string; patch: AdvancedPatch }
  | { type: "REMOVE_SITE_OVERRIDE"; domain: string }
  | { type: "SAVE_SITE_DEFAULT"; domain: string }       // popup snapshots current advanced into the override
  | { type: "REFRESH_SETTINGS" }                        // force GET /v1/me/settings
  // ── Output device enumeration (popup picker populating) ────────────────
  | { type: "LIST_AUDIO_OUTPUT_DEVICES" }
  // ── Pre-warm intent (Workstream D): sent on Start button hover/focus ───
  // Only fires when the realtime tier is selected and no session is running.
  // Background relays to the active content script; any error is a no-op.
  | { type: "PREPARE_INTENT" };

export type AudioDeviceList = {
  ok: true;
  devices: { deviceId: string; label: string }[];
} | Err;

export interface PopupToBgResponse {
  GET_STATE: StateResult;
  SIGN_OUT_ECHOLY: StateResult;
  OPEN_SIGNIN: Ack;
  START: StateResult;
  STOP: StateResult;
  UPDATE_SETTINGS: StateResult;
  UPDATE_VOLUME: Ack;
  UPDATE_ADVANCED_SETTINGS: StateResult;
  UPDATE_SITE_OVERRIDE:     StateResult;
  REMOVE_SITE_OVERRIDE:     StateResult;
  SAVE_SITE_DEFAULT:        StateResult;
  REFRESH_SETTINGS:         StateResult;
  LIST_AUDIO_OUTPUT_DEVICES: AudioDeviceList;
  PREPARE_INTENT: Ack;
}

// ════════════════════════════════════════════════════════════════════════════
// Background → Popup  (broadcast via chrome.runtime.sendMessage; fire-and-forget)
// ════════════════════════════════════════════════════════════════════════════
export type BgToPopupMessage = { type: "BACKGROUND_STATE_UPDATE"; state: State };

// ════════════════════════════════════════════════════════════════════════════
// Background → Content  (relayed via chrome.tabs.sendMessage)
// ════════════════════════════════════════════════════════════════════════════
export type BgToContentMessage =
  | { type: "CONTENT_PING" }
  | { type: "CONTENT_START"; settings: StartSettings }
  | { type: "CONTENT_STOP" }
  | { type: "CONTENT_UPDATE_SETTINGS"; settings: State }
  | { type: "CONTENT_UPDATE_VOLUME"; originalVolume: number; voiceVolume: number }
  /** Pre-warm intent relay: background forwards to content after PREPARE_INTENT
   *  from popup. Carries the settings the Start would use (resolved by the
   *  background, the source of truth) so content does NOT depend on its own
   *  `sm.settings`, which is null before the first CONTENT_START and stale after
   *  an old session. `intent` is omitted when signed out / cold SW → content
   *  no-ops. `pipeline` is the translation tier ("standard" | "realtime"). */
  | {
      type: "CONTENT_PREPARE_INTENT";
      intent?: { apiBearer: string; targetLanguage: string; pipeline: string };
    }
  /** Background relays a toast to display on the page. Used for pre-content
   *  failures (e.g. session expired before content script is involved) so the
   *  user sees a friendly on-page notification instead of silence. */
  | {
      type: "CONTENT_SHOW_TOAST";
      text: string;
      durationMs?: number;
      cta?: string;
      ctaLabel?: string;
    };

export interface BgToContentResponse {
  CONTENT_PING: { ok: true; version: string };
  CONTENT_START: Ack; // content's startSession() result
  CONTENT_STOP: Ok;
  CONTENT_UPDATE_SETTINGS: { ok: true; state?: Partial<State> }; // state OPTIONAL
  CONTENT_UPDATE_VOLUME: Ok;
  CONTENT_PREPARE_INTENT: Ok;
  CONTENT_SHOW_TOAST: Ok;
}

// ════════════════════════════════════════════════════════════════════════════
// Content → Background  (sent via chrome.runtime.sendMessage; HAS sender.tab)
// ════════════════════════════════════════════════════════════════════════════
export type ContentToBgMessage =
  | {
      type: "CONTENT_STATE";
      running?: boolean;
      paused?: boolean;
      status?: string;
      errorMessage?: string;
    }
  | { type: "CONTENT_ENDED"; reason?: string }
  /** Overlay Stop — ask background to run the same STOP path as the popup. */
  | { type: "CONTENT_STOP_REQUEST" }
  /** On-page launcher — ask background to run the same START path as the popup. */
  | { type: "START_REQUEST" }
  /** On-page launcher — query sign-in (gates the launcher) + keep the SW warm. */
  | { type: "GET_LAUNCH_STATE" }
  | {
      type: "CONTENT_QUOTA";
      mode?: TranslationTier;
      used_credits?: number;
      cap_credits?: number;
      resets_at?: string;
    }
  | { type: "UPDATE_SETTINGS"; settings: Partial<Settings> }
  | { type: "GET_YT_CC_URL"; videoId: string }
  | { type: "GET_YT_PLAYER_RESPONSE" }
  /** Marker content script relays this after the web page dispatches
   *  `echoly:settings-updated` — triggers a settings refetch/hydrate (C4). */
  | { type: "REFRESH_SETTINGS" };

/** A single caption track as exposed by YouTube's player response (MAIN-world
 *  `movie_player.getPlayerResponse().captions.playerCaptionsTracklistRenderer
 *  .captionTracks`). Only the fields the caption fetch needs. */
export interface YtCaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
}

export type YtPlayerResponseResult =
  | { ok: true; captionTracks: YtCaptionTrack[] }
  | { ok: false };

export type YtCcUrlResult =
  | {
      ok: true;
      url: string;
      lang: string | null;
      kind: string | null;
      tlang: string | null;
      isAsr: boolean;
      capturedAt: number;
    }
  | { ok: false };

export type LaunchStateResult = { ok: true; signedIn: boolean } | { ok: false };

export interface ContentToBgResponse {
  CONTENT_STATE: Ok;
  CONTENT_ENDED: Ok;
  CONTENT_STOP_REQUEST: Ok;
  CONTENT_QUOTA: Ok;
  UPDATE_SETTINGS: Ok;
  GET_YT_CC_URL: YtCcUrlResult;
  GET_YT_PLAYER_RESPONSE: YtPlayerResponseResult;
  START_REQUEST: Ok;
  GET_LAUNCH_STATE: LaunchStateResult;
  REFRESH_SETTINGS: Ok;
}

// ───── Convenience: everything the background onMessage listener can receive ─
export type ToBackgroundMessage = PopupToBgMessage | ContentToBgMessage;

// ════════════════════════════════════════════════════════════════════════════
// Transport helpers (chrome.* only). Surface code (router / sendResponse) stays
// in each surface; these are the typed wrappers around send.
// ════════════════════════════════════════════════════════════════════════════

/** Background routing discriminant. Content-origin messages carry a tab. */
export function isFromContent(
  sender: chrome.runtime.MessageSender,
): boolean {
  return !!sender.tab;
}

/** Request/response send over chrome.runtime (popup → bg). Resolves with the
 *  typed response; rejects if the channel errors. */
export function sendToBackground<T extends PopupToBgMessage["type"]>(
  message: Extract<PopupToBgMessage, { type: T }>,
): Promise<PopupToBgResponse[T]> {
  return chrome.runtime.sendMessage(message) as Promise<PopupToBgResponse[T]>;
}

/** Request/response relay to a content script (bg → content). */
export function relayToContent<T extends BgToContentMessage["type"]>(
  tabId: number,
  message: Extract<BgToContentMessage, { type: T }>,
): Promise<BgToContentResponse[T]> {
  return chrome.tabs.sendMessage(tabId, message) as Promise<
    BgToContentResponse[T]
  >;
}

/** Fire-and-forget send over chrome.runtime (broadcast to popup, or content's
 *  notifyBackground). Errors are swallowed.
 *  Returns false if the runtime handle is already gone (SW/page torn down). */
/** Callback-style request from content that expects a typed reply
 *  (GET_YT_CC_URL, GET_YT_PLAYER_RESPONSE, GET_LAUNCH_STATE). */
export function sendFromContent<
  T extends "GET_YT_CC_URL" | "GET_YT_PLAYER_RESPONSE" | "GET_LAUNCH_STATE",
>(
  message: Extract<ContentToBgMessage, { type: T }>,
): Promise<ContentToBgResponse[T]> {
  return chrome.runtime.sendMessage(message) as Promise<ContentToBgResponse[T]>;
}

export function post(message: BgToPopupMessage | ContentToBgMessage): boolean {
  try {
    if (!chrome.runtime?.id) return false;
    void (chrome.runtime.sendMessage(message) as Promise<void>)?.catch?.(
      () => {},
    );
    return true;
  } catch {
    return false;
  }
}
