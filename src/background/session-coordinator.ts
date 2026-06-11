// ────────────────────────────────────────────────────────────────────────────
// Session coordinator — popup START/STOP/settings → content script relay.
// ────────────────────────────────────────────────────────────────────────────

import { CONTENT_SCRIPT_PATH, CONTENT_CSS_PATH } from "@/shared/constants";
import { signInToStartMessage, ECHOLY_WEB_URLS } from "@/shared/echoly-config";
import { ERR_NO_VIDEO_TAB } from "@/shared/product-copy";
import { relayToContent } from "@/shared/protocol";
import type { Ack, StateResult } from "@/shared/protocol";
import type { Settings, StartSettings } from "@/shared/types";
import {
  effectiveAdvanced,
  normalizeDomain,
  sanitizePatch,
  sanitizeSiteOverridePatch,
  SYNCED_SETTINGS_KEYS,
  type AdvancedPatch,
  type ServerSettingsPatch,
} from "@/shared/advanced";
import type { SettingsBundle } from "./settings-client";
import { resolveApiMode } from "@/lib/api-mode";
import type { Store } from "./store";
import type { EcholyAuth } from "./auth";
import type { SettingsClient } from "./settings-client";
import { SettingsHttpError } from "./settings-client";
import { recordLanguagePairRecent } from "./language-catalog";
import { hydrateSignedIn, scheduleHydrateSignedIn } from "./hydrate-signed-in";
import {
  domainFromTabUrl,
  findSessionStartTab,
  resolveSiteDomainFromTabs,
} from "@/shared/active-site";

function errMessage(err: Error | string | object | null): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export class SessionCoordinator {
  constructor(
    private readonly store: Store,
    private readonly auth: EcholyAuth,
    private readonly settingsClient?: SettingsClient,
  ) {}

  private domainFromTab(tab: chrome.tabs.Tab): string | null {
    return domainFromTabUrl(tab.url);
  }

  /**
   * Refresh `state.currentDomain` from the focused window (popup open, tab switch).
   * Does not require an active translation session.
   */
  async refreshActiveSite(): Promise<string | null> {
    const domain = await this.resolveFocusedWindowDomain();
    this.store.setCurrentDomain(domain);
    return domain;
  }

  private async resolveFocusedWindowDomain(): Promise<string | null> {
    try {
      const windowTabs = await chrome.tabs.query({ currentWindow: true });
      const fromWindow = resolveSiteDomainFromTabs(windowTabs);
      if (fromWindow) return fromWindow;
      const allTabs = await chrome.tabs.query({});
      return resolveSiteDomainFromTabs(allTabs);
    } catch {
      return null;
    }
  }

  /** Apply a server bundle (success) OR mark dirty (failure) after a PUT/DELETE.
   *  Centralized so every advanced mutator shares the same fault-tolerance
   *  policy. Always re-persists local state. */
  private async syncOrDirty(
    op: () => Promise<{
      settings: import("@/shared/advanced").AdvancedSettings;
      siteOverrides: import("@/shared/advanced").SiteOverrideMap;
      version: number;
    }>,
  ): Promise<void> {
    try {
      const bundle = await op();
      await this.store.applyServerBundle(bundle);
    } catch (err) {
      // 409 conflict: server returns the CURRENT bundle in the error body —
      // adopt it (the user's local edit is dropped in favour of the server's
      // authoritative state). Other errors set the dirty flag for retry.
      if (err instanceof SettingsHttpError && err.status === 409) {
        const body = err.body as
          | {
              settings?: import("@/shared/advanced").AdvancedSettings;
              siteOverrides?: import("@/shared/advanced").SiteOverrideMap;
              version?: number;
            }
          | null;
        if (
          body?.settings &&
          typeof body.version === "number" &&
          body.siteOverrides
        ) {
          await this.store.applyServerBundle({
            settings: body.settings,
            siteOverrides: body.siteOverrides,
            version: body.version,
          });
        } else {
          this.store.setAdvancedDirty(true);
        }
      } else {
        this.store.setAdvancedDirty(true);
      }
    }
    await this.store.persistAdvanced();
  }

  /** Web tab with video for START (active page, else YouTube, else last web tab). */
  private async sessionTabForStart(): Promise<chrome.tabs.Tab> {
    let tabs = await chrome.tabs.query({ currentWindow: true });
    let pick = findSessionStartTab(tabs);
    if (!pick) {
      tabs = await chrome.tabs.query({});
      pick = findSessionStartTab(tabs);
    }
    if (!pick?.id) throw new Error(ERR_NO_VIDEO_TAB);
    const tab = tabs.find((t) => t.id === pick.id);
    if (!tab || !domainFromTabUrl(tab.url)) {
      throw new Error(ERR_NO_VIDEO_TAB);
    }
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

    const token = await this.auth.getSessionToken();
    if (token && !state.signedInUser && this.settingsClient) {
      await hydrateSignedIn(this.store, this.settingsClient);
    }

    const mode = await resolveApiMode(this.auth, this.store.state.signedInUser);
    if (!mode) {
      const msg = signInToStartMessage();
      // Best-effort relay a page toast so the on-page launcher path is not silent.
      // Runs BEFORE the store updates so the async tab lookup doesn't race with
      // cleanup. A missing tab, uninjected content script, or any other error is
      // silently swallowed — the { ok:false } return always proceeds.
      try {
        let toastTabId: number | undefined;
        try {
          const tab = await this.sessionTabForStart();
          toastTabId = tab.id;
        } catch {
          // No dubbable tab found — fall back to the focused window's active tab.
          try {
            const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
            toastTabId = activeTab?.id;
          } catch {
            // tabs API unavailable — skip toast.
          }
        }
        if (toastTabId != null) {
          try {
            await chrome.tabs.sendMessage(toastTabId, {
              type: "CONTENT_SHOW_TOAST" as const,
              text: msg,
              cta: ECHOLY_WEB_URLS.signin(),
              ctaLabel: "Sign in",
            } satisfies import("@/shared/protocol").BgToContentMessage);
          } catch {
            // Content script not injected in this tab — acceptable, skip toast.
          }
        }
      } catch {
        // Unexpected error in relay logic — never propagate out of start().
      }
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
      tab = await this.sessionTabForStart();
    } catch (err) {
      return { ok: false, error: errMessage(err instanceof Error ? err : String(err)) };
    }
    this.store.setTabId(tab.id ?? null);
    // Resolve and stash the active domain so per-site overrides apply on this
    // session and downstream code (auto-start matcher, popup site-default UI)
    // sees the authoritative host. Falls back to null on chrome:// / parse fail.
    const domain = this.domainFromTab(tab);
    this.store.setCurrentDomain(domain);
    this.store.setConnecting(true);
    this.store.setError("");
    this.store.setStatus("Connecting");
    this.store.broadcast();

    try {
      const tabId = tab.id;
      if (tabId == null) throw new Error("No active tab to relay to.");
      await this.ensureContentScript(tabId);
      // Compute the effective Advanced settings for this domain (global merged
      // with the per-site override, if any). Mutate the snapshot's `advanced`
      // so content sees the resolved values directly — no override re-merge
      // logic needs to live in content.
      const snapshot = this.store.snapshot();
      snapshot.advanced = effectiveAdvanced(
        snapshot.advanced,
        snapshot.siteOverrides,
        snapshot.currentDomain,
      );
      // Full snapshot + apiBase + apiBearer overridden with the resolved bearer.
      // content stays mode-agnostic — same fetch shape, different URL + bearer.
      const startSettings: StartSettings = {
        ...snapshot,
        apiBase: mode.apiBase,
        apiBearer: mode.apiKey,
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
      this.store.setSessionStartedAt(Date.now());
      this.store.setStatus("Translating");
      const token = await this.auth.getSessionToken();
      if (token) {
        void recordLanguagePairRecent(token, this.store.state.targetLanguage,
          (this.store.state.sourceLanguage && this.store.state.sourceLanguage !== "auto")
            ? this.store.state.sourceLanguage
            : "en");
      }
      this.store.broadcast();
      return { ok: true, state: this.store.snapshot() };
    } catch (err) {
      this.store.setConnecting(false);
      this.store.setRunning(false);
      const msg = errMessage(err instanceof Error ? err : String(err));
      this.store.setError(msg);
      this.store.setStatus(msg);
      this.store.broadcast();
      return { ok: false, error: msg };
    }
  }

  /** Stop a session cleanly so the provider sees the /end (legacy handleStop
   *  331-347). Tolerates a gone tab. */
  async stop(): Promise<StateResult> {
    const wasActive =
      this.store.state.running || this.store.state.connecting;
    let targetTabId = this.store.state.tabId;

    if (targetTabId == null) {
      try {
        const [tab] = await chrome.tabs.query({
          active: true,
          currentWindow: true,
        });
        if (tab && tab.id != null) {
          targetTabId = tab.id;
        }
      } catch {
        /* no active tab */
      }
    }

    // Tear down the page overlay BEFORE updating popup state so Stop feels synced.
    let relayOk = !wasActive;
    if (targetTabId != null) {
      try {
        await this.ensureContentScript(targetTabId);
        await relayToContent(targetTabId, { type: "CONTENT_STOP" });
        relayOk = true;
      } catch {
        relayOk = false;
      }
    } else if (wasActive) {
      relayOk = false;
    }

    this.store.setRunning(false);
    this.store.setConnecting(false);
    this.store.setPaused(false);
    this.store.setSessionStartedAt(null);
    await this.refreshActiveSite();
    this.store.setStatus("Stopped");
    this.store.setTabId(null);
    this.store.broadcast();
    if (this.settingsClient && this.store.state.signedInUser) {
      scheduleHydrateSignedIn(this.store, this.settingsClient, () =>
        this.relaySettingsToContent(),
      );
    }
    if (wasActive && !relayOk) {
      return {
        ok: false,
        error: "Could not reach the tab to stop translation.",
      };
    }
    return { ok: true, state: this.store.snapshot() };
  }

  /** Persist + relay settings live to the running content tab (legacy
   *  handleUpdateSettings 349-365). Reads optional reply.state back (content
   *  may not send it). Also diffs the 7 synced Settings keys and pushes any
   *  change to the server (debounced ~800ms, retry-once on 409). */
  async updateSettings(settings?: Partial<Settings>): Promise<StateResult> {
    // Snapshot the PREVIOUS synced-key values before we apply the patch.
    const prev: Settings = {
      tier: this.store.state.tier,
      targetLanguage: this.store.state.targetLanguage,
      sourceLanguage: this.store.state.sourceLanguage,
      standardVoice: this.store.state.standardVoice,
      realtimeVoice: this.store.state.realtimeVoice,
      showSource: this.store.state.showSource,
      showTargetCaptions: this.store.state.showTargetCaptions,
      originalVolume: this.store.state.originalVolume,
      voiceVolume: this.store.state.voiceVolume,
      apiBearer: this.store.state.apiBearer,
    };

    await this.store.persistSettings(settings ?? {});
    this.store.broadcast();

    // Diff the 7 synced keys and push when signed in and there's a change.
    if (this.settingsClient && this.store.state.signedInUser && settings) {
      const next: Settings = {
        tier: this.store.state.tier,
        targetLanguage: this.store.state.targetLanguage,
        sourceLanguage: this.store.state.sourceLanguage,
        standardVoice: this.store.state.standardVoice,
        realtimeVoice: this.store.state.realtimeVoice,
        showSource: this.store.state.showSource,
        showTargetCaptions: this.store.state.showTargetCaptions,
        originalVolume: this.store.state.originalVolume,
        voiceVolume: this.store.state.voiceVolume,
        apiBearer: this.store.state.apiBearer,
      };
      // Only push if any of the SYNCED_SETTINGS_KEYS changed.
      // Use explicit comparisons to avoid the index-signature TS error.
      const hasSyncedChange =
        prev.tier !== next.tier ||
        prev.targetLanguage !== next.targetLanguage ||
        prev.sourceLanguage !== next.sourceLanguage ||
        prev.standardVoice !== next.standardVoice ||
        prev.realtimeVoice !== next.realtimeVoice ||
        prev.showSource !== next.showSource ||
        prev.showTargetCaptions !== next.showTargetCaptions;
      if (hasSyncedChange) {
        const diff = this.diffSyncedSettings(prev, next);
        if (Object.keys(diff).length > 0) {
          this.pushSyncedSettings(diff);
        }
      }
    }

    const { state } = this.store;
    if (state.tabId != null && (state.running || state.connecting)) {
      try {
        const reply = await relayToContent(state.tabId, {
          type: "CONTENT_UPDATE_SETTINGS",
          settings: this.snapshotForContent(),
        });
        if (reply?.state) this.store.mergeFromContent(reply.state);
      } catch (err) {
        this.store.setError(errMessage(err instanceof Error ? err : String(err)));
        this.store.broadcast();
      }
    }
    return { ok: true, state: this.store.snapshot() };
  }

  /**
   * Snapshot for CONTENT relays — `advanced` resolved to the EFFECTIVE values
   * (global merged with the current domain's override), EXACTLY like the
   * session-START path. Relaying the raw snapshot leaked the GLOBAL
   * captionPosition to content: with a site override pinning the placement,
   * any unrelated advanced edit (e.g. a subtitle-style change) relayed
   * global "top" and visibly yanked the caption away from its override
   * position ("đổi style → sub nhảy lên top").
   */
  private snapshotForContent(): ReturnType<Store["snapshot"]> {
    const snapshot = this.store.snapshot();
    snapshot.advanced = effectiveAdvanced(
      snapshot.advanced,
      snapshot.siteOverrides,
      snapshot.currentDomain,
    );
    return snapshot;
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
        if (tab && tab.id != null) {
          targetTabId = tab.id;
        }
      } catch {
        // No active tab — nothing to apply against. Silent.
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

  // ── Synced settings push (W3) ─────────────────────────────────────────────
  // When the user edits one of the 7 synced Settings keys (tier/language/voice/
  // show*), we diff vs. the previous state and debounce-push the delta to the
  // server. On 409 we adopt the fresh bundle, then retry the user's patch once
  // (user-edit-wins semantic). On second failure we fall back to advancedDirty.

  private pushSyncedTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSyncedPatch: ServerSettingsPatch | null = null;

  /**
   * Compute a patch of the 7 synced keys by diffing `next` against `prev`.
   * Returns an empty object when nothing changed.
   */
  private diffSyncedSettings(
    prev: import("@/shared/types").Settings,
    next: import("@/shared/types").Settings,
  ): ServerSettingsPatch {
    const patch: ServerSettingsPatch = {};
    // Map state.tier → bundle "mode"
    if (prev.tier !== next.tier) patch.mode = next.tier as "standard" | "realtime";
    if (prev.targetLanguage !== next.targetLanguage) patch.targetLanguage = next.targetLanguage;
    if (prev.sourceLanguage !== next.sourceLanguage) patch.sourceLanguage = next.sourceLanguage;
    if (prev.standardVoice !== next.standardVoice) patch.standardVoice = next.standardVoice;
    if (prev.realtimeVoice !== next.realtimeVoice) patch.realtimeVoice = next.realtimeVoice;
    if (prev.showSource !== next.showSource) patch.showSource = next.showSource;
    if (prev.showTargetCaptions !== next.showTargetCaptions) patch.showTargetCaptions = next.showTargetCaptions;
    return patch;
  }

  /**
   * Debounced (~800 ms) push of a synced-settings patch to the server.
   * Retries once on 409 (user-edit-wins). Falls back to advancedDirty flag
   * on a second failure or other error.
   */
  private pushSyncedSettings(patch: ServerSettingsPatch): void {
    // Coalesce rapid edits into one push: accumulate the diff.
    this.pendingSyncedPatch = { ...this.pendingSyncedPatch, ...patch };
    if (this.pushSyncedTimer) clearTimeout(this.pushSyncedTimer);
    this.pushSyncedTimer = setTimeout(() => {
      this.pushSyncedTimer = null;
      const merged = this.pendingSyncedPatch;
      this.pendingSyncedPatch = null;
      if (!merged || Object.keys(merged).length === 0) return;
      // Note: no `!this.settingsClient` guard needed — the field is readonly and
      // the only call site (pushSyncedSettings) is always guarded by a settingsClient
      // check in updateSettings. Belt-and-suspenders check here anyway.
      void this.executePushSynced(merged, false);
    }, 800);
  }

  /** Execute the actual server PUT; retryOnce=false → first attempt; true → retry. */
  private async executePushSynced(patch: ServerSettingsPatch, isRetry: boolean): Promise<void> {
    const version = this.store.state.advancedVersion;
    try {
      const bundle = await this.settingsClient!.putGlobal(patch, version);
      await this.store.applyServerBundle(bundle as SettingsBundle);
      await this.store.persistAdvanced();
      this.store.broadcast();
    } catch (err) {
      if (err instanceof SettingsHttpError && err.status === 409 && !isRetry) {
        // Adopt fresh bundle then retry the user's patch once.
        const body = err.body as {
          settings?: import("@/shared/advanced").AdvancedSettings;
          siteOverrides?: import("@/shared/advanced").SiteOverrideMap;
          version?: number;
          updatedAt?: string;
        } | null;
        if (body?.settings && typeof body.version === "number") {
          await this.store.applyServerBundle({
            settings: body.settings,
            siteOverrides: body.siteOverrides ?? {},
            version: body.version,
          });
          await this.store.persistAdvanced();
          this.store.broadcast();
          // Retry once with the same patch but fresh version.
          await this.executePushSynced(patch, true);
        } else {
          this.store.setAdvancedDirty(true);
          await this.store.persistAdvanced();
        }
      } else {
        // Second failure or network/5xx: mark dirty.
        this.store.setAdvancedDirty(true);
        await this.store.persistAdvanced();
      }
    }
  }

  // ── Advanced settings (server-authoritative, per-user) ─────────────────────
  // Each mutator follows the same pattern:
  //   1. apply the change locally (in-memory + persist to chrome.storage),
  //   2. broadcast so the popup sees the optimistic update,
  //   3. attempt the server PUT/DELETE; on success adopt the server bundle,
  //      on failure (network/5xx) set the dirty flag for retry.
  // The local edit is never lost — even offline the popup looks responsive.

  /**
   * Relay CONTENT_UPDATE_SETTINGS to the active translation tab when a session
   * is running or connecting. Used after both popup advanced edits and server-bundle
   * applies so the content script's subtitle styling updates live. Fire-and-forget.
   */
  relaySettingsToContent(): void {
    const { tabId, running, connecting } = this.store.state;
    if (tabId == null || (!running && !connecting)) return;
    void relayToContent(tabId, {
      type: "CONTENT_UPDATE_SETTINGS",
      settings: this.snapshotForContent(),
    }).catch(() => {
      // Content script unavailable — acceptable, re-applied on next start.
    });
  }

  /** Merge an AdvancedPatch into global state. Server-PUTs the patch under
   *  optimistic concurrency. Relays to content when a session is active.
   *
   *  WHAT-YOU-SEE-IS-WHAT-YOU-EDIT: the popup renders EFFECTIVE values
   *  (site override over global). If the current site's override already pins
   *  one of the patched keys, a global write would be masked by that pin and
   *  the control would appear dead (the "stuck on Float" bug). So keys pinned
   *  by the current domain's override are routed INTO that override; the rest
   *  follow the normal global flow. Style keys can never be pinned (overrides
   *  are healed to the legacy 3 keys), so they always go global. */
  async updateAdvancedSettings(patch: AdvancedPatch): Promise<StateResult> {
    let safe = sanitizePatch(patch);
    const domain = this.store.state.currentDomain;
    const override = domain ? this.store.state.siteOverrides[domain] : undefined;
    if (domain && override) {
      const pinned: AdvancedPatch = {};
      const globalRest: AdvancedPatch = {};
      for (const key of Object.keys(safe) as (keyof AdvancedPatch)[]) {
        if (key in override) {
          (pinned as Record<string, unknown>)[key] = safe[key];
        } else {
          (globalRest as Record<string, unknown>)[key] = safe[key];
        }
      }
      if (Object.keys(pinned).length > 0) {
        await this.updateSiteOverride(domain, pinned);
        if (Object.keys(globalRest).length === 0) {
          this.relaySettingsToContent();
          return { ok: true, state: this.store.snapshot() };
        }
        safe = globalRest;
      }
    }
    this.store.mergeAdvanced(safe);
    await this.store.persistAdvanced();
    this.store.broadcast();
    // Relay to content so subtitle styling takes effect live (W6).
    this.relaySettingsToContent();
    if (this.settingsClient) {
      const version = this.store.state.advancedVersion;
      await this.syncOrDirty(() =>
        this.settingsClient!.putGlobal(safe, version),
      );
      this.store.broadcast();
    } else {
      this.store.setAdvancedDirty(true);
      await this.store.persistAdvanced();
    }
    return { ok: true, state: this.store.snapshot() };
  }

  /** Update a per-site override. Server-PUTs to /me/settings/sites/:domain. */
  async updateSiteOverride(
    domain: string,
    patch: AdvancedPatch,
  ): Promise<StateResult> {
    const norm = normalizeDomain(domain);
    if (!norm) return { ok: false, error: "Invalid domain." };
    // Site overrides carry ONLY the 3 legacy keys — the server strict-rejects
    // style keys in site overrides with a 400 (audit P2-1).
    const safe = sanitizeSiteOverridePatch(patch);
    if (Object.keys(safe).length === 0) {
      return { ok: true, state: this.store.snapshot() };
    }
    this.store.setSiteOverride(norm, safe);
    await this.store.persistAdvanced();
    this.store.broadcast();
    if (this.settingsClient) {
      const version = this.store.state.advancedVersion;
      await this.syncOrDirty(() =>
        this.settingsClient!.putSiteOverride(norm, safe, version),
      );
      this.store.broadcast();
    } else {
      this.store.setAdvancedDirty(true);
      await this.store.persistAdvanced();
    }
    return { ok: true, state: this.store.snapshot() };
  }

  /** Remove a per-site override entirely (the domain reverts to global). */
  async removeSiteOverride(domain: string): Promise<StateResult> {
    const norm = normalizeDomain(domain);
    if (!norm) return { ok: false, error: "Invalid domain." };
    this.store.removeSiteOverride(norm);
    await this.store.persistAdvanced();
    this.store.broadcast();
    if (this.settingsClient) {
      await this.syncOrDirty(() =>
        this.settingsClient!.removeSiteOverride(norm),
      );
      this.store.broadcast();
    } else {
      this.store.setAdvancedDirty(true);
      await this.store.persistAdvanced();
    }
    return { ok: true, state: this.store.snapshot() };
  }

  /** "Save as default for this site" — snapshot the SITE-SCOPED Advanced
   *  values (captionPosition / autoStartHosts / outputDeviceId) into
   *  siteOverrides[domain]. The 3 subtitle-style keys are GLOBAL-only and
   *  must NOT be pinned per-site (the server strict-rejects them in site
   *  overrides, and a local pin would block global style edits on the site). */
  async saveSiteDefault(domain: string): Promise<StateResult> {
    const norm = normalizeDomain(domain);
    if (!norm) return { ok: false, error: "Invalid domain." };
    // Snapshot the EFFECTIVE values for this domain (global merged with any
    // existing override) — NOT raw global. The popup renders effective, so
    // pinning raw global would visibly revert the user's on-screen choices
    // (the "press Save → Captions jumps back to Top" bug).
    const eff = effectiveAdvanced(
      this.store.state.advanced,
      this.store.state.siteOverrides,
      norm,
    );
    const fullSnapshot: AdvancedPatch = {
      captionPosition: eff.captionPosition,
      autoStartHosts: { ...eff.autoStartHosts },
      outputDeviceId: eff.outputDeviceId,
    };
    this.store.setSiteOverride(norm, fullSnapshot);
    await this.store.persistAdvanced();
    this.store.broadcast();
    if (this.settingsClient) {
      const version = this.store.state.advancedVersion;
      await this.syncOrDirty(() =>
        this.settingsClient!.putSiteOverride(norm, fullSnapshot, version),
      );
      this.store.broadcast();
    } else {
      this.store.setAdvancedDirty(true);
      await this.store.persistAdvanced();
    }
    return { ok: true, state: this.store.snapshot() };
  }

  /** Force a GET /me/settings and replace local state with the server's bundle.
   *  Idempotent — useful when the popup re-opens and wants to be sure it has
   *  the freshest values (e.g. after the user edited from another device).
   *  Relays to content when a session is active so subtitle styling applies live. */
  async refreshSettings(): Promise<StateResult> {
    if (!this.settingsClient) {
      return { ok: true, state: this.store.snapshot() };
    }
    try {
      const bundle = await this.settingsClient.fetchBundle();
      if (bundle) {
        const changed = await this.store.applyServerBundle(bundle);
        if (changed) {
          await this.store.persistAdvanced();
          // Relay to content so subtitle styling takes effect live (W6).
          this.relaySettingsToContent();
        }
      }
    } catch (err) {
      // Network/5xx: keep current state; surface error message on state.
      const msg = errMessage(err instanceof Error ? err : String(err));
      this.store.setError(msg);
    }
    this.store.broadcast();
    return { ok: true, state: this.store.snapshot() };
  }
}
