// ────────────────────────────────────────────────────────────────────────────
// Session coordinator — glues popup intents to the content script. Ported from
// legacy/background.js handleStart/handleStop/handleUpdateSettings/
// handleUpdateVolume + the helpers ensureContentScript/relayToContent/
// activeYouTubeTab/isYouTubeUrl (209-404).
//
// ensureContentScript(tabId) is what makes Start work without a refresh: PING
// first, inject on no-reply. Injection uses CONTENT_SCRIPT_PATH / CONTENT_CSS_PATH
// (the WXT-stable bundle path) — NOT the legacy literal "content.js"/"content.css".
//
// CONTENT_START relays a full snapshot with apiBase added and kymaKey OVERRIDDEN
// to the resolved bearer (StartSettings) — content stays mode-agnostic.
// ────────────────────────────────────────────────────────────────────────────

import { CONTENT_SCRIPT_PATH, CONTENT_CSS_PATH } from "@/shared/constants";
import { relayToContent } from "@/shared/protocol";
import type { Ack, StateResult } from "@/shared/protocol";
import type { Settings, StartSettings } from "@/shared/types";
import { resolveApiMode } from "@/lib/api-mode";
import type { Store } from "./store";
import type { EcholyAuth } from "./auth";

function isYouTubeUrl(url: string | undefined): url is string {
  return typeof url === "string" && /^https?:\/\/[^/]*youtube\.com\//.test(url);
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export class SessionCoordinator {
  constructor(
    private readonly store: Store,
    private readonly auth: EcholyAuth,
  ) {}

  /** Resolve the active+currentWindow tab and assert it's a YouTube page
   *  (legacy activeYouTubeTab 218-223). Throws on no tab / non-YT. */
  private async activeYouTubeTab(): Promise<chrome.tabs.Tab> {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab) throw new Error("No active tab.");
    if (!isYouTubeUrl(tab.url)) throw new Error("Open a YouTube video first.");
    return tab;
  }

  /** PING-then-inject. Idempotent — a live content script replies {ok:true} and
   *  we skip injection. Otherwise inject the bundle + CSS at the WXT-stable path
   *  (legacy ensureContentScript 228-249). */
  async ensureContentScript(tabId: number): Promise<void> {
    try {
      const reply = await relayToContent(tabId, { type: "CONTENT_PING" });
      if (reply?.ok) return;
    } catch {
      // Not yet injected.
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [CONTENT_SCRIPT_PATH],
    });
    // Inject CSS too: the manifest static-match content_scripts entry does not
    // run on a tab that pre-existed the extension.
    try {
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: [CONTENT_CSS_PATH],
      });
    } catch {
      // CSS may already be present from manifest static match — harmless.
    }
  }

  /** Start a session (legacy handleStart 268-329). */
  async start(settings?: Partial<Settings>): Promise<StateResult> {
    const { state } = this.store;
    if (state.running || state.connecting) {
      return { ok: false, error: "Session already running." };
    }
    await this.store.persistSettings(settings ?? {});

    // Resolve subscription mode before starting: BYOK key OR Echoly cookie.
    const mode = await resolveApiMode(state, this.auth);
    if (!mode) {
      const msg = "Sign in at echolyhq.com or paste a Kyma key.";
      this.store.setError(msg);
      this.store.setStatus(msg);
      this.store.setConnecting(false);
      this.store.broadcast();
      return { ok: false, error: msg };
    }
    this.store.setApiMode(mode.mode);
    this.store.setSignedInUser(mode.user);

    let tab: chrome.tabs.Tab;
    try {
      tab = await this.activeYouTubeTab();
    } catch (err) {
      return { ok: false, error: errMessage(err) };
    }
    this.store.setTabId(tab.id ?? null);
    this.store.setConnecting(true);
    this.store.setError("");
    this.store.setStatus("Connecting");
    this.store.broadcast();

    try {
      const tabId = tab.id;
      if (tabId == null) throw new Error("No active tab to relay to.");
      await this.ensureContentScript(tabId);
      // Full snapshot + apiBase + kymaKey overridden with the resolved bearer.
      // content stays mode-agnostic — same fetch shape, different URL + bearer.
      const startSettings: StartSettings = {
        ...this.store.snapshot(),
        apiBase: mode.apiBase,
        kymaKey: mode.apiKey,
      };
      const reply = await relayToContent(tabId, {
        type: "CONTENT_START",
        settings: startSettings,
      });
      if (!reply?.ok) {
        const error = reply && !reply.ok ? reply.error : undefined;
        throw new Error(error || "Could not start translation.");
      }
      this.store.setConnecting(false);
      this.store.setRunning(true);
      this.store.setStatus("Translating");
      this.store.broadcast();
      return { ok: true, state: this.store.snapshot() };
    } catch (err) {
      this.store.setConnecting(false);
      this.store.setRunning(false);
      const msg = errMessage(err);
      this.store.setError(msg);
      this.store.setStatus(msg);
      this.store.broadcast();
      return { ok: false, error: msg };
    }
  }

  /** Stop a session cleanly so the provider sees the /end (legacy handleStop
   *  331-347). Tolerates a gone tab. */
  async stop(): Promise<StateResult> {
    const tabId = this.store.state.tabId;
    this.store.setRunning(false);
    this.store.setConnecting(false);
    this.store.setPaused(false);
    this.store.setStatus("Stopped");
    this.store.broadcast();
    if (tabId != null) {
      try {
        await relayToContent(tabId, { type: "CONTENT_STOP" });
      } catch {
        // Tab may be gone; that's fine.
      }
    }
    this.store.setTabId(null);
    return { ok: true, state: this.store.snapshot() };
  }

  /** Persist + relay settings live to the running content tab (legacy
   *  handleUpdateSettings 349-365). Reads optional reply.state back (content
   *  may not send it). */
  async updateSettings(settings?: Partial<Settings>): Promise<StateResult> {
    await this.store.persistSettings(settings ?? {});
    this.store.broadcast();
    const { state } = this.store;
    if (state.tabId != null && (state.running || state.connecting)) {
      try {
        const reply = await relayToContent(state.tabId, {
          type: "CONTENT_UPDATE_SETTINGS",
          settings: this.store.snapshot(),
        });
        if (reply?.state) this.store.mergeFromContent(reply.state);
      } catch (err) {
        this.store.setError(errMessage(err));
        this.store.broadcast();
      }
    }
    return { ok: true, state: this.store.snapshot() };
  }

  /** Apply + persist volume, relay to the content tab. Falls back to the active
   *  YouTube tab + ensureContentScript when tabId is null (popup open before
   *  Start, or SW cold-started) (legacy handleUpdateVolume 367-404). */
  async updateVolume(
    originalVolume?: number,
    voiceVolume?: number,
  ): Promise<Ack> {
    const { state } = this.store;
    const nextOriginal =
      typeof originalVolume === "number" ? originalVolume : state.originalVolume;
    const nextVoice =
      typeof voiceVolume === "number" ? voiceVolume : state.voiceVolume;
    this.store.setVolumes(nextOriginal, nextVoice);
    // Persist debounced — slider drag fires many times.
    chrome.storage.local
      .set({ originalVolume: nextOriginal, voiceVolume: nextVoice })
      .catch(() => {});

    let targetTabId = state.tabId;
    if (targetTabId == null) {
      try {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (tab && isYouTubeUrl(tab.url) && tab.id != null) {
          targetTabId = tab.id;
        }
      } catch {
        // No active YT tab — nothing to apply against. Silent.
      }
    }

    if (targetTabId != null) {
      try {
        // Inject if the tab pre-existed our extension reload, else the message
        // reaches a dead receiver and the slider feels broken.
        await this.ensureContentScript(targetTabId);
        await relayToContent(targetTabId, {
          type: "CONTENT_UPDATE_VOLUME",
          originalVolume: state.originalVolume,
          voiceVolume: state.voiceVolume,
        });
      } catch {
        // Tab gone or injection refused; volume re-applies next start.
      }
    }
    return { ok: true };
  }
}
