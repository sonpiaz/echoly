// ────────────────────────────────────────────────────────────────────────────
// Message router — content (sender.tab) vs popup. MV3 return semantics:
// content → false (sync ack); popup → true (async sendResponse).
// ────────────────────────────────────────────────────────────────────────────

import { isFromContent } from "@/shared/protocol";
import type {
  ToBackgroundMessage,
  ContentToBgMessage,
  PopupToBgMessage,
  AudioDeviceList,
} from "@/shared/protocol";
import { ECHOLY_WEB_URLS } from "@/shared/echoly-config";
import type { Store } from "./store";
import type { EcholyAuth } from "./auth";
import type { SessionCoordinator } from "./session-coordinator";
import { setSigninTabId, getSigninTabId } from "./auth-listener";
import { usagePatchFromServerError } from "@/lib/server-errors";
import { getYtCaptionCache } from "@/platforms/youtube/caption-cache";
import { hydrateSignedIn, scheduleHydrateSignedIn } from "./hydrate-signed-in";
import type { SettingsClient } from "./settings-client";

export interface RouterDeps {
  store: Store;
  auth: EcholyAuth;
  session: SessionCoordinator;
  settings?: SettingsClient;
}

/** Serializes concurrent OPEN_SIGNIN handlers (the popup has no disabled guard,
 *  so a rapid double-click would otherwise open two tabs during the async
 *  pre-check window). A second call while one is in flight is a no-op ack. */
let openSigninInFlight = false;

/** Apply content push events: CONTENT_STATE, CONTENT_ENDED, CONTENT_QUOTA, UPDATE_SETTINGS. */
export function handleContentEvent(
  deps: RouterDeps,
  message: ContentToBgMessage,
): void {
  const { store } = deps;
  if (message.type === "CONTENT_STATE") {
    if (typeof message.running === "boolean") store.setRunning(message.running);
    if (typeof message.paused === "boolean") store.setPaused(message.paused);
    if (typeof message.status === "string") store.setStatus(message.status);
    if (typeof message.errorMessage === "string") {
      store.setError(message.errorMessage);
    }
    store.broadcast();
  }
  if (message.type === "CONTENT_QUOTA") {
    const parsed = {
      status: 402,
      code: "quota_exhausted" as const,
      user: "",
      isQuotaOrTier: true,
      mode: message.mode,
      usedCredits: message.used_credits,
      capCredits: message.cap_credits,
      resetsAt: message.resets_at,
    };
    const patch = usagePatchFromServerError(parsed);
    if (patch) store.applyUsagePatch(patch);
    store.setRunning(false);
    store.setConnecting(false);
    store.setPaused(false);
    store.setTabId(null);
    store.setSessionStartedAt(null);
    store.setStatus("Quota exhausted");
    store.broadcast();
    return;
  }
  if (message.type === "CONTENT_STOP_REQUEST") {
    void deps.session.stop();
    return;
  }
  if (message.type === "CONTENT_ENDED") {
    store.setRunning(false);
    store.setConnecting(false);
    store.setPaused(false);
    store.setTabId(null);
    store.setSessionStartedAt(null);
    store.setStatus(message.reason || "Stopped");
    store.broadcast();
    if (deps.settings && store.state.signedInUser) {
      scheduleHydrateSignedIn(store, deps.settings);
    }
  }
  if (message.type === "UPDATE_SETTINGS" && message.settings) {
    void deps.session.updateSettings(message.settings);
  }
}

/** Handle a popup-originated message asynchronously and resolve its typed
 *  response (legacy popup switch 442-499). Throws are caught by the caller and
 *  turned into {ok:false, error}. */
async function handlePopupMessage(
  deps: RouterDeps,
  message: PopupToBgMessage,
): Promise<object> {
  const { store, auth, session } = deps;
  switch (message.type) {
    case "GET_STATE":
      await store.loadSettings();
      await hydrateSignedIn(store, deps.settings);
      await session.refreshActiveSite();
      return { ok: true, state: store.snapshot() };
    case "SIGN_OUT_ECHOLY":
      await auth.signOut();
      await store.refreshAuth();
      store.broadcast();
      return { ok: true, state: store.snapshot() };
    case "OPEN_SIGNIN": {
      // Background owns the signin tab's lifecycle. Before opening a tab we check
      // whether a session already exists (the web may already be signed in — the
      // extension shares the same ec_session cookie), so the user is never asked
      // to sign in twice. Only when truly signed out do we open (or focus an
      // existing) signin tab; the cookie-listener / onUpdated→/account watcher
      // then closes it once a session lands.
      if (openSigninInFlight) return { ok: true }; // a concurrent open is running
      openSigninInFlight = true;
      try {
        // 1. Store already warm with a user → nothing to do but re-broadcast.
        if (store.state.signedInUser) {
          store.broadcast();
          return { ok: true };
        }
        // 2. Cold store but a shared session cookie may exist (signed in on web,
        //    or SW just woke). Read it; if present, hydrate and skip the tab.
        const token = await auth.getSessionToken();
        if (token) {
          await hydrateSignedIn(store, deps.settings);
          if (store.state.signedInUser) return { ok: true };
        }
        // 3. Genuinely signed out. Reuse/focus an existing signin tab if one is
        //    still open (dedup), else open a new one.
        const existing = getSigninTabId();
        if (existing != null) {
          try {
            const tab = await chrome.tabs.get(existing);
            await chrome.tabs.update(existing, { active: true });
            if (tab.windowId != null) {
              await chrome.windows.update(tab.windowId, { focused: true });
            }
            return { ok: true };
          } catch {
            setSigninTabId(null); // tracked tab is gone — open a fresh one below
          }
        }
        const tab = await chrome.tabs.create({
          url: ECHOLY_WEB_URLS.signin(),
          active: true,
        });
        setSigninTabId(tab.id ?? null);
        return { ok: true };
      } catch (err) {
        // Surface tabs.create errors so the popup can fall back to instructing
        // the user to open the URL manually.
        const error = err instanceof Error ? err.message : String(err);
        return { ok: false, error };
      } finally {
        openSigninInFlight = false;
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
      const unsupported = message as { type?: string };
      return { ok: false, error: "Unknown message: " + unsupported.type };
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
  sendResponse: (response?: object) => void,
): boolean {
  if (isFromContent(sender) && message.type === "GET_YT_CC_URL") {
    const videoId =
      "videoId" in message && typeof message.videoId === "string"
        ? message.videoId
        : "";
    const entry = videoId ? getYtCaptionCache(videoId) : undefined;
    sendResponse(entry ? { ok: true, ...entry } : { ok: false });
    return false;
  }

  // Content-originated messages (have sender.tab).
  if (isFromContent(sender)) {
    handleContentEvent(deps, message as ContentToBgMessage);
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
