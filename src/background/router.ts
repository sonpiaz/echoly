// ────────────────────────────────────────────────────────────────────────────
// Message router (legacy/background.js onMessage 406-501). Pivots on
// isFromContent(sender):
//
//  • GET_YT_CC_URL from content → respond with the cache entry, return FALSE
//    (handled FIRST so it doesn't fall through to the generic content branch).
//  • any other content message → handleContentEvent, ack {ok:true}, return FALSE.
//  • popup message → async switch, sendResponse from the IIFE, return TRUE
//    (keeps the channel open for the async sendResponse).
//
// These exact return values are the MV3 channel semantics — returning true on a
// sync content path would leak channels; returning false on the async popup path
// would drop the response. Do NOT change them.
// ────────────────────────────────────────────────────────────────────────────

import { isFromContent } from "@/shared/protocol";
import type {
  ToBackgroundMessage,
  ContentToBgMessage,
  PopupToBgMessage,
  YtCcUrlResponse,
  AudioDeviceList,
} from "@/shared/protocol";
import { ECHOLY_WEB_ORIGIN } from "@/shared/constants";
import type { Store } from "./store";
import type { EcholyAuth } from "./auth";
import type { SessionCoordinator } from "./session-coordinator";
import type { CaptionCache } from "./caption-cache";
import { setSigninTabId } from "./auth-listener";

export interface RouterDeps {
  store: Store;
  auth: EcholyAuth;
  session: SessionCoordinator;
  captions: CaptionCache;
}

/** Apply a content-side push event to state (legacy handleContentEvent 407-423).
 *  CONTENT_STATE merges partial type-guarded fields; CONTENT_ENDED resets the
 *  session to idle. Other content message types (e.g. UPDATE_SETTINGS) are a
 *  no-op by routing — still acked by the caller. */
export function handleContentEvent(
  store: Store,
  message: ContentToBgMessage,
): void {
  if (message.type === "CONTENT_STATE") {
    if (typeof message.running === "boolean") store.setRunning(message.running);
    if (typeof message.paused === "boolean") store.setPaused(message.paused);
    if (typeof message.status === "string") store.setStatus(message.status);
    if (typeof message.errorMessage === "string") {
      store.setError(message.errorMessage);
    }
    store.broadcast();
  }
  if (message.type === "CONTENT_ENDED") {
    store.setRunning(false);
    store.setConnecting(false);
    store.setPaused(false);
    store.setTabId(null);
    store.setStatus(message.reason || "Stopped");
    store.broadcast();
  }
}

/** Handle a popup-originated message asynchronously and resolve its typed
 *  response (legacy popup switch 442-499). Throws are caught by the caller and
 *  turned into {ok:false, error}. */
async function handlePopupMessage(
  deps: RouterDeps,
  message: PopupToBgMessage,
): Promise<unknown> {
  const { store, auth, session } = deps;
  switch (message.type) {
    case "GET_STATE":
      await store.loadSettings();
      // Refresh auth + the guest language policy opportunistically so the popup
      // renders the signed-in banner AND can immediately gate the language
      // picker (in guest/BYOK mode) without an extra round trip.
      await Promise.all([store.refreshAuth(), store.refreshGuestPolicy()]);
      return { ok: true, state: store.snapshot() };
    case "GET_AUTH":
      await store.refreshAuth();
      return { ok: true, state: store.snapshot() };
    case "SIGN_OUT_ECHOLY":
      await auth.signOut();
      store.clearAuth();
      store.broadcast();
      return { ok: true, state: store.snapshot() };
    case "OPEN_SIGNIN": {
      // Background owns the signin tab's lifecycle: open it, store the id, and
      // the cookie-listener closes it after the magic-link callback succeeds.
      // Surface chrome.tabs.create errors (do NOT swallow) so the popup can
      // fall back to instructing the user to open the URL manually.
      try {
        const tab = await chrome.tabs.create({
          url: `${ECHOLY_WEB_ORIGIN}/signin`,
          active: true,
        });
        setSigninTabId(tab.id ?? null);
        return { ok: true };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        return { ok: false, error };
      }
    }
    case "START":
      return session.start(message.settings);
    case "STOP":
      return session.stop();
    case "UPDATE_SETTINGS":
      return session.updateSettings(message.settings);
    case "UPDATE_VOLUME":
      return session.updateVolume(message.originalVolume, message.voiceVolume);
    case "UPDATE_ADVANCED_SETTINGS":
      return session.updateAdvancedSettings(message.patch);
    case "UPDATE_SITE_OVERRIDE":
      return session.updateSiteOverride(message.domain, message.patch);
    case "REMOVE_SITE_OVERRIDE":
      return session.removeSiteOverride(message.domain);
    case "SAVE_SITE_DEFAULT":
      return session.saveSiteDefault(message.domain);
    case "REFRESH_SETTINGS":
      return session.refreshSettings();
    case "LIST_AUDIO_OUTPUT_DEVICES":
      return listAudioOutputDevices();
    default: {
      const unknown = message as { type?: string };
      return { ok: false, error: "Unknown message: " + unknown.type };
    }
  }
}

/** Output-device enumeration. The MV3 service-worker context does NOT expose
 *  navigator.mediaDevices (it's a window-only API). The popup or content
 *  script must enumerate locally and apply via HTMLMediaElement.setSinkId.
 *  This handler returns a typed sentinel so the popup knows to fall back —
 *  it does NOT mock a device list (the SW has no way to know what's plugged
 *  in). The contract documents this as the architected behaviour, not a
 *  TODO: enumeration is a presentation concern. */
async function listAudioOutputDevices(): Promise<AudioDeviceList> {
  const md: MediaDevices | undefined = (
    globalThis as { navigator?: { mediaDevices?: MediaDevices } }
  ).navigator?.mediaDevices;
  if (!md || typeof md.enumerateDevices !== "function") {
    return { ok: false, error: "enumerate in popup context" };
  }
  try {
    const devices = await md.enumerateDevices();
    return {
      ok: true,
      devices: devices
        .filter((d) => d.kind === "audiooutput")
        .map((d) => ({ deviceId: d.deviceId, label: d.label })),
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, error };
  }
}

/**
 * The chrome.runtime.onMessage listener body (legacy 426-501). Returns the value
 * the listener must return (true to keep the channel open for an async response,
 * false for sync paths). sendResponse is the chrome callback.
 */
export function routeMessage(
  deps: RouterDeps,
  message: ToBackgroundMessage,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean {
  // Cache lookup from content — needs a real response (not fire-and-forget).
  // Handled before the generic content-event branch so we don't fall through.
  if (isFromContent(sender) && message?.type === "GET_YT_CC_URL") {
    const videoId = (message as { videoId?: string }).videoId;
    const entry = videoId ? deps.captions.get(videoId) : undefined;
    const response: YtCcUrlResponse = entry
      ? { ok: true, ...entry }
      : { ok: false };
    sendResponse(response);
    return false;
  }
  // Content-originated messages (have sender.tab).
  if (isFromContent(sender)) {
    handleContentEvent(deps.store, message as ContentToBgMessage);
    sendResponse?.({ ok: true });
    return false;
  }

  // Popup-originated messages (no sender.tab).
  void (async () => {
    try {
      const result = await handlePopupMessage(deps, message as PopupToBgMessage);
      sendResponse(result);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      sendResponse({ ok: false, error });
    }
  })();
  return true; // async sendResponse
}
