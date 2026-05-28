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
import {
  DEFAULT_ADVANCED,
  mergeAdvanced as mergeAdvancedSettings,
  type AdvancedPatch,
  type AdvancedSettings,
  type SiteOverrideMap,
} from "@/shared/advanced";
import { deriveApiModeLabel } from "@/lib/api-mode";
import type { EcholyAuth } from "./auth";
import { loadByokKey, saveByokKey } from "./byok-storage";
import { fetchGuestPolicy } from "./guest-policy";

/** chrome.storage.local key holding the persisted Advanced bundle (offline
 *  mirror of the server's authoritative copy). Versioned so a future
 *  schema change can migrate without colliding with the legacy 8-key set. */
export const ADVANCED_STORAGE_KEY = "echoly_advanced";

/** Shape persisted under ADVANCED_STORAGE_KEY. The dirty flag rides along
 *  so an SW cold-start after a failed PUT still knows to retry. */
interface PersistedAdvanced {
  settings: AdvancedSettings;
  siteOverrides: SiteOverrideMap;
  version: number;
  dirty: boolean;
}

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
   *  251-255). The BYOK key (`kymaKey`) is decrypted at rest via byok-storage;
   *  state.kymaKey holds the plaintext bearer in memory. Also hydrates the
   *  Advanced bundle (server-authoritative mirror) so the popup can render
   *  user-customized values immediately even on a cold SW start. */
  async loadSettings(): Promise<Settings> {
    const [stored, kymaPlain] = await Promise.all([
      loadStoredSettings(),
      loadByokKey(),
      this.loadAdvanced(),
    ]);
    stored.kymaKey = kymaPlain;
    Object.assign(this.state, stored);
    return stored;
  }

  /** Hydrate the Advanced bundle from chrome.storage.local. Defaults to the
   *  factory bundle (DEFAULT_ADVANCED, no site overrides, version 0, clean)
   *  when no entry exists. Tolerant: a malformed entry resets to defaults
   *  rather than throwing — the next sign-in fetch will replace it anyway. */
  async loadAdvanced(): Promise<void> {
    const raw = await chrome.storage.local.get(ADVANCED_STORAGE_KEY);
    const entry = (raw as Record<string, unknown> | undefined)?.[
      ADVANCED_STORAGE_KEY
    ];
    if (entry && typeof entry === "object") {
      const e = entry as Partial<PersistedAdvanced>;
      this.state.advanced = {
        ...DEFAULT_ADVANCED,
        ...(e.settings ?? {}),
        autoStartHosts: {
          ...DEFAULT_ADVANCED.autoStartHosts,
          ...(e.settings?.autoStartHosts ?? {}),
        },
      };
      this.state.siteOverrides = e.siteOverrides ?? {};
      this.state.advancedVersion = typeof e.version === "number" ? e.version : 0;
      this.state.advancedDirty = e.dirty === true;
      return;
    }
    this.state.advanced = { ...DEFAULT_ADVANCED };
    this.state.siteOverrides = {};
    this.state.advancedVersion = 0;
    this.state.advancedDirty = false;
  }

  /** Persist the current Advanced bundle to chrome.storage.local. Called on
   *  every mutation so a popup-side edit survives an SW recycle even before
   *  the server PUT lands. */
  async persistAdvanced(): Promise<void> {
    const entry: PersistedAdvanced = {
      settings: this.state.advanced,
      siteOverrides: this.state.siteOverrides,
      version: this.state.advancedVersion,
      dirty: this.state.advancedDirty,
    };
    await chrome.storage.local.set({ [ADVANCED_STORAGE_KEY]: entry });
  }

  /** Shallow-merge a patch into state.advanced (autoStartHosts merges deep
   *  via mergeAdvanced). Does NOT persist — caller schedules persistAdvanced. */
  mergeAdvanced(patch: AdvancedPatch): void {
    this.state.advanced = mergeAdvancedSettings(this.state.advanced, patch);
  }

  /** Replace the local Advanced bundle with the server-authoritative one and
   *  clear the dirty flag. Used on sign-in fetch, on successful PUT, and on
   *  409-conflict resolution (the server's body IS the current bundle). */
  applyServerBundle(bundle: {
    settings: AdvancedSettings;
    siteOverrides: SiteOverrideMap;
    version: number;
  }): void {
    this.state.advanced = { ...bundle.settings };
    this.state.siteOverrides = { ...bundle.siteOverrides };
    this.state.advancedVersion = bundle.version;
    this.state.advancedDirty = false;
  }

  /** Set or update a per-site override. Shallow-merge into the existing entry
   *  (so toggling a single field doesn't clobber the rest). */
  setSiteOverride(domain: string, patch: AdvancedPatch): void {
    const existing = this.state.siteOverrides[domain] ?? {};
    this.state.siteOverrides = {
      ...this.state.siteOverrides,
      [domain]: { ...existing, ...patch },
    };
  }

  /** Remove a per-site override entirely (the site reverts to global). */
  removeSiteOverride(domain: string): void {
    if (!(domain in this.state.siteOverrides)) return;
    const next: SiteOverrideMap = { ...this.state.siteOverrides };
    delete next[domain];
    this.state.siteOverrides = next;
  }

  /** Track the active translation tab's hostname so per-site overrides apply
   *  on START and the auto-start matcher knows which host to compare against. */
  setCurrentDomain(domain: string | null): void {
    this.state.currentDomain = domain;
  }

  /** Mark/unmark the Advanced bundle as needing a server retry. Set when a
   *  local mutation succeeds but the server PUT failed (offline / 5xx). */
  setAdvancedDirty(dirty: boolean): void {
    this.state.advancedDirty = dirty;
  }

  /** Merge a partial into state and persist ONLY the DEFAULT_SETTINGS keys
   *  present in it (legacy persistSettings 257-266). The BYOK key is routed
   *  through byok-storage (light-encrypted at rest) — the generic settings
   *  writer never sees it. */
  async persistSettings(partial: Partial<Settings>): Promise<void> {
    Object.assign(this.state, partial);
    if (partial.kymaKey !== undefined) {
      await saveByokKey(partial.kymaKey);
      // Strip kymaKey from the rest before handing to the plaintext writer so
      // no plaintext copy is ever written to chrome.storage.local.
      const { kymaKey: _omit, ...rest } = partial;
      void _omit;
      if (Object.keys(rest).length) await saveSettings(rest);
    } else {
      await saveSettings(partial);
    }
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

  /** Refresh state.guestPolicy from the public server endpoint. Always resolves
   *  (fetcher itself falls back to default on any failure). Wave 2 — the popup
   *  uses this to gate the language picker when apiMode === "byok". */
  async refreshGuestPolicy(): Promise<void> {
    this.state.guestPolicy = await fetchGuestPolicy();
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

  setSessionStartedAt(ts: number | null): void {
    this.state.sessionStartedAt = ts;
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
