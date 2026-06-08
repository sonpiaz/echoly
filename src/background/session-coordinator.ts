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
  type AdvancedPatch,
} from "@/shared/advanced";
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
      this.store.applyServerBundle(bundle);
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
          this.store.applyServerBundle({
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
      scheduleHydrateSignedIn(this.store, this.settingsClient);
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
        this.store.setError(errMessage(err instanceof Error ? err : String(err)));
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

  // ── Advanced settings (server-authoritative, per-user) ─────────────────────
  // Each mutator follows the same pattern:
  //   1. apply the change locally (in-memory + persist to chrome.storage),
  //   2. broadcast so the popup sees the optimistic update,
  //   3. attempt the server PUT/DELETE; on success adopt the server bundle,
  //      on failure (network/5xx) set the dirty flag for retry.
  // The local edit is never lost — even offline the popup looks responsive.

  /** Merge an AdvancedPatch into global state. Server-PUTs the patch under
   *  optimistic concurrency. */
  async updateAdvancedSettings(patch: AdvancedPatch): Promise<StateResult> {
    const safe = sanitizePatch(patch);
    this.store.mergeAdvanced(safe);
    await this.store.persistAdvanced();
    this.store.broadcast();
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
    const safe = sanitizePatch(patch);
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

  /** "Save as default for this site" — snapshot the FULL current Advanced
   *  values into siteOverrides[domain]. The override is a partial in shape,
   *  but stores every field so the site is fully pinned to the current setup
   *  (not just the most-recent diff). */
  async saveSiteDefault(domain: string): Promise<StateResult> {
    const norm = normalizeDomain(domain);
    if (!norm) return { ok: false, error: "Invalid domain." };
    const fullSnapshot: AdvancedPatch = { ...this.store.state.advanced };
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
   *  the freshest values (e.g. after the user edited from another device). */
  async refreshSettings(): Promise<StateResult> {
    if (!this.settingsClient) {
      return { ok: true, state: this.store.snapshot() };
    }
    try {
      const bundle = await this.settingsClient.fetchBundle();
      if (bundle) {
        this.store.applyServerBundle(bundle);
        await this.store.persistAdvanced();
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
