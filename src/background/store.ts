// ────────────────────────────────────────────────────────────────────────────
// Store — the single source of truth for session state (legacy/background.js
// state object 170-183 + snapshot/broadcast/persist/loadSettings/refreshAuth).
//
// In-memory state resets when the SW cold-starts — intentional (the user gets a
// clean idle on cold start). Only the 8 DEFAULT_SETTINGS keys are persisted to
// chrome.storage.local; session + auth fields are ephemeral. The popup is a
// passive renderer: BACKGROUND_STATE_UPDATE pushes snapshot() to it, debounced
// to 1 per BROADCAST_DEBOUNCE_MS (leading-edge, no trailing flush — the popup
// self-heals because every explicit send() reply also carries state).
// ────────────────────────────────────────────────────────────────────────────

import { BROADCAST_DEBOUNCE_MS } from "@/shared/constants";
import { post } from "@/shared/protocol";
import type {
  State,
  Settings,
  SignedInUser,
  ApiMode,
} from "@/shared/types";
import { INITIAL_STATE } from "@/shared/types";
import {
  loadSettings as loadStoredSettings,
  saveSettings,
  restrictStorageAccess,
} from "@/shared/storage";
import { deriveApiModeLabel } from "@/lib/api-mode";
import type { EcholyAuth } from "./auth";

export class Store {
  /** The canonical in-memory state. The ONLY mutation owner. */
  readonly state: State = { ...INITIAL_STATE };

  private lastBroadcastAt = 0;

  constructor(private readonly auth: EcholyAuth) {}

  /** Block youtube.com page scripts from reading the user's key. Sticky, no
   *  retry (legacy/background.js:187-189). */
  restrictStorage(): void {
    restrictStorageAccess();
  }

  /** Shallow snapshot (legacy snapshot 194-196). Sent everywhere — popup pushes,
   *  START/STOP/etc replies, CONTENT_START base settings. */
  snapshot(): State {
    return { ...this.state };
  }

  /** Push BACKGROUND_STATE_UPDATE to the popup, debounced leading-edge to 1 per
   *  BROADCAST_DEBOUNCE_MS. Fire-and-forget (no popup may be open).
   *  (legacy broadcastToPopup 198-207.) */
  broadcast(): void {
    const now = Date.now();
    if (now - this.lastBroadcastAt < BROADCAST_DEBOUNCE_MS) return;
    this.lastBroadcastAt = now;
    post({ type: "BACKGROUND_STATE_UPDATE", state: this.snapshot() });
  }

  /** Hydrate the 8 persisted keys from storage into state (legacy loadSettings
   *  251-255). Returns the stored values. */
  async loadSettings(): Promise<Settings> {
    const stored = await loadStoredSettings();
    Object.assign(this.state, stored);
    return stored;
  }

  /** Merge a partial into state and persist ONLY the DEFAULT_SETTINGS keys
   *  present in it (legacy persistSettings 257-266). */
  async persistSettings(partial: Partial<Settings>): Promise<void> {
    Object.assign(this.state, partial);
    await saveSettings(partial);
  }

  /** Apply a partial settings update to state without persisting (used when
   *  content echoes settings back). */
  mergeFromContent(partial: Partial<State>): void {
    Object.assign(this.state, partial);
  }

  /** Refresh the popup-visible auth snapshot (signedInUser + usage + apiMode)
   *  from the cookie (legacy refreshAuth 129-146). BYOK still wins for apiMode
   *  even when signed in. */
  async refreshAuth(): Promise<void> {
    const token = await this.auth.getSessionToken();
    if (!token) {
      this.state.signedInUser = null;
      this.state.usage = null;
      this.state.apiMode = deriveApiModeLabel(this.state.kymaKey, null);
      return;
    }
    const [user, usage] = await Promise.all([
      this.auth.fetchUser(token),
      this.auth.fetchUsage(token),
    ]);
    this.state.signedInUser = user;
    this.state.usage = usage;
    this.state.apiMode = deriveApiModeLabel(this.state.kymaKey, user);
  }

  /** Clear the signed-in auth snapshot after sign-out (legacy SIGN_OUT 472-473). */
  clearAuth(): void {
    this.state.signedInUser = null;
    this.state.apiMode = null;
  }

  // ── Field setters used by the session coordinator + content events. Kept on
  //    the Store so it remains the single mutation owner of `state`. ──

  setRunning(running: boolean): void {
    this.state.running = running;
  }

  setConnecting(connecting: boolean): void {
    this.state.connecting = connecting;
  }

  setPaused(paused: boolean): void {
    this.state.paused = paused;
  }

  setTabId(tabId: number | null): void {
    this.state.tabId = tabId;
  }

  setStatus(status: string): void {
    this.state.status = status;
  }

  setError(errorMessage: string): void {
    this.state.errorMessage = errorMessage;
  }

  setApiMode(apiMode: ApiMode): void {
    this.state.apiMode = apiMode;
  }

  setSignedInUser(user: SignedInUser | null): void {
    this.state.signedInUser = user;
  }

  setVolumes(originalVolume: number, voiceVolume: number): void {
    this.state.originalVolume = originalVolume;
    this.state.voiceVolume = voiceVolume;
  }
}
