// ────────────────────────────────────────────────────────────────────────────
// LOCKED CONTRACT — cross-surface message protocol (hand-rolled, chrome.* only,
// NO browser.* polyfill). Every message type + payload + response is modeled
// here as a discriminated union, verbatim from legacy 0.6.3
// (legacy/background.js onMessage + legacy/content.js onMessage + popup sends).
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
//  • Content's outbound UPDATE_SETTINGS is a no-op by routing (handleContentEvent
//    ignores it) — it is still a valid ContentToBg message and acked {ok:true}.
// ────────────────────────────────────────────────────────────────────────────

import type { State, StartSettings, YtCaptionEntry, Settings } from "./types";

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
  | { type: "GET_AUTH" } // defined in legacy but never sent by popup — keep
  | { type: "SIGN_OUT_ECHOLY" }
  | { type: "START"; settings?: Partial<Settings> }
  | { type: "STOP" }
  | { type: "UPDATE_SETTINGS"; settings?: Partial<Settings> }
  | { type: "UPDATE_VOLUME"; originalVolume?: number; voiceVolume?: number };

export interface PopupToBgResponse {
  GET_STATE: StateResult;
  GET_AUTH: StateResult;
  SIGN_OUT_ECHOLY: StateResult;
  START: StateResult;
  STOP: StateResult;
  UPDATE_SETTINGS: StateResult;
  UPDATE_VOLUME: Ack; // fire-and-forget from popup; bg still acks {ok:true}
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
  | { type: "CONTENT_UPDATE_VOLUME"; originalVolume: number; voiceVolume: number };

export interface BgToContentResponse {
  CONTENT_PING: { ok: true; version: string };
  CONTENT_START: Ack; // content's startSession() result
  CONTENT_STOP: Ok;
  CONTENT_UPDATE_SETTINGS: { ok: true; state?: Partial<State> }; // state OPTIONAL
  CONTENT_UPDATE_VOLUME: Ok;
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
  | { type: "GET_YT_CC_URL"; videoId: string }
  // content also emits this; bg's content-branch ignores it (no-op) but acks.
  | { type: "UPDATE_SETTINGS"; settings: Partial<Settings> };

export type YtCcUrlResponse = ({ ok: true } & YtCaptionEntry) | { ok: false };
export interface ContentToBgResponse {
  CONTENT_STATE: Ok;
  CONTENT_ENDED: Ok;
  GET_YT_CC_URL: YtCcUrlResponse;
  UPDATE_SETTINGS: Ok; // no-op ack
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

/** Request/response send from content → bg (e.g. GET_YT_CC_URL). */
export function sendFromContent<T extends ContentToBgMessage["type"]>(
  message: Extract<ContentToBgMessage, { type: T }>,
): Promise<ContentToBgResponse[T]> {
  return chrome.runtime.sendMessage(message) as Promise<ContentToBgResponse[T]>;
}

/** Fire-and-forget send over chrome.runtime (broadcast to popup, or content's
 *  notifyBackground). Errors are swallowed — matches legacy `.catch(()=>{})`.
 *  Returns false if the runtime handle is already gone (SW/page torn down). */
export function post(message: BgToPopupMessage | ContentToBgMessage): boolean {
  try {
    if (!chrome.runtime?.id) return false;
    void (chrome.runtime.sendMessage(message) as Promise<unknown>)?.catch?.(
      () => {},
    );
    return true;
  } catch {
    return false;
  }
}
