// @vitest-environment jsdom
//
// B3 — Popup optimistic render tests.
//
// Verifies:
//  - On open, if a cached state exists in chrome.storage.local, the popup
//    renders it BEFORE the GET_STATE round-trip resolves (masks SW cold start).
//  - The GET_STATE authoritative reply reconciles/overwrites the cached render.
//  - Cache is written on applyState from a real (non-cached) reply.
//  - When no cache exists, the popup shows the loading skeleton until GET_STATE.
//  - The cached render does NOT write back to the cache (no stale-data loop).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DEFAULT_ADVANCED } from "@/shared/advanced";
import { DEFAULT_TRANSLATION_TIER } from "@/shared/constants";
import type { State } from "@/shared/types";
import { initPopup } from "@/popup";

// ─── Minimal HTML fixture ─────────────────────────────────────────────────────

const FIXTURE_HTML = `
<body data-state="idle" data-account="loading">
  <main class="shell shell--main main-only">
    <header class="topline">
      <span id="plan-badge"><span id="plan-badge-text">FREE</span></span>
      <button id="account-trigger"><span id="account-avatar-initial">·</span></button>
    </header>
    <section class="session-card idle-only">
      <div id="lang-trigger">
        <span id="tgt-name"></span>
        <span id="tgt-flag"></span>
        <select id="lang"></select>
      </div>
      <div id="tier-trigger">
        <span id="tier-primary"></span>
        <span id="tier-secondary"></span>
        <select id="tier">
          <option value="standard">Standard</option>
          <option value="realtime">Realtime</option>
        </select>
      </div>
      <div id="voice-trigger">
        <span id="voice-primary"></span>
        <span id="voice-secondary"></span>
        <span id="voice-avatar"></span>
        <select id="voice"></select>
      </div>
    </section>
    <section class="live-summary live-only">
      <span id="live-src-flag"></span>
      <span id="live-target-flag"></span>
      <span id="live-voice-avatar"></span>
      <span id="live-voice-name"></span>
    </section>
    <div class="live-note live-only"></div>
    <section class="live-stats live-only">
      <div><span id="elapsed">00:00</span></div>
    </section>
    <button id="toggle"><span id="actionLabel">Start dubbing</span></button>
    <div class="usage-hint-row signedin-only idle-only">
      <span><b id="usage-hint-amount">— credits</b><span id="usage-hint-label">left</span></span>
      <span id="usage-hint-reset"></span>
    </div>
    <section class="mix-panel">
      <input id="originalVolume" type="range" min="0" max="100" value="18" />
      <output id="originalOut">18</output>
      <input id="voiceVolume" type="range" min="0" max="100" value="100" />
      <output id="voiceOut">100</output>
      <label><input id="showTargetCaptions" type="checkbox" checked /></label>
      <label><input id="showSource" type="checkbox" /></label>
    </section>
    <details class="advanced idle-only">
      <summary>Advanced</summary>
      <div class="advanced-body">
        <div class="segmented" data-count="3" data-setting="captionPosition">
          <button type="button" data-value="top">Top</button>
          <button type="button" data-value="bottom">Bottom</button>
          <button type="button" data-value="float">Float</button>
        </div>
        <div class="adv-row adv-row--inline">
          <span id="autoStartDomain">—</span>
          <label><input type="checkbox" id="autoStart" /></label>
        </div>
        <div class="adv-row">
          <select id="outputDevice"><option value="">System default</option></select>
        </div>
        <div class="adv-footer">
          <button type="button" id="advResetBtn">Reset</button>
          <button type="button" id="advSaveBtn" disabled>Save</button>
        </div>
      </div>
    </details>
    <footer class="status-footer">
      <span class="status-text"><span id="status">Ready</span></span>
      <span class="version">v0.0.0</span>
    </footer>
    <div id="account-menu-dim" hidden></div>
    <div id="account-menu" hidden>
      <div id="am-avatar">·</div>
      <div id="am-email"></div>
      <div id="am-plan-badge"><span id="am-plan-badge-text"></span></div>
      <span id="am-days-left" hidden></span>
      <span id="am-reset"></span>
      <div id="um-std">
        <span id="um-std-used">0</span><span id="um-std-cap">0</span>
        <span id="um-std-fill"></span>
      </div>
      <div id="um-rt" hidden>
        <span id="um-rt-used">0</span><span id="um-rt-cap">0</span>
        <span id="um-rt-fill"></span>
      </div>
      <button id="am-billing"></button><button id="am-invoices"></button>
      <button id="am-help"></button><button id="am-signout"></button>
    </div>
  </main>
</body>
`;

function makeState(overrides: Partial<State> = {}): State {
  return {
    running: false,
    connecting: false,
    paused: false,
    tabId: null,
    status: "Ready",
    errorMessage: "",
    apiMode: "proxy",
    signedInUser: { email: "user@example.com", tier: "pro" },
    usage: { used: 100 },
    languagePicker: null,
    languageNames: null,
    standardVoices: null,
    standardVoiceDefaultId: null,
    sessionStartedAt: null,
    tier: DEFAULT_TRANSLATION_TIER,
    targetLanguage: "vi",
    sourceLanguage: "auto",
    realtimeVoice: "marin",
    standardVoice: "English_magnetic_voiced_man",
    originalVolume: 18,
    voiceVolume: 100,
    showSource: false,
    showTargetCaptions: true,
    apiBearer: "",
    advanced: { ...DEFAULT_ADVANCED },
    siteOverrides: {},
    advancedVersion: 1,
    advancedDirty: false,
    currentDomain: null,
    hydrating: false,
    ...overrides,
  };
}

const POPUP_STATE_CACHE_KEY = "echoly_popup_state_cache";
const HAS_EVER_SIGNED_IN_KEY = "echoly_has_ever_signed_in";

/** Drain all pending micro/macro tasks. */
async function flush(n = 6) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

describe("popup — B3 optimistic render from cache", () => {
  let fakeStore: Record<string, unknown>;
  let getStateCalls: number;
  let getStateDeferred: { resolve: (v: unknown) => void } | null = null;
  let getStateResult: { ok: boolean; state: State };

  beforeEach(() => {
    document.documentElement.innerHTML = FIXTURE_HTML;
    fakeStore = {};
    getStateCalls = 0;
    getStateDeferred = null;
    getStateResult = { ok: true, state: makeState() };

    const chrome = {
      runtime: {
        id: "test-ext-id",
        getManifest: () => ({ version: "0.0.0-test" }),
        onMessage: {
          addListener: vi.fn(),
        },
        sendMessage: vi.fn(async (msg: { type: string }) => {
          if (msg.type === "GET_STATE") {
            getStateCalls++;
            // If a deferred is set, hang until resolved (simulates SW cold start).
            if (getStateDeferred) {
              return new Promise((resolve) => {
                getStateDeferred = { resolve: (v) => resolve(v) };
              });
            }
            return getStateResult;
          }
          if (msg.type === "LIST_AUDIO_OUTPUT_DEVICES") {
            return { ok: true, devices: [] };
          }
          return { ok: true };
        }),
      },
      storage: {
        local: {
          _data: fakeStore,
          get: vi.fn(async (keys: unknown) => {
            if (typeof keys === "string") {
              return keys in fakeStore ? { [keys]: fakeStore[keys] } : {};
            }
            if (Array.isArray(keys)) {
              const out: Record<string, unknown> = {};
              for (const k of keys as string[]) {
                if (k in fakeStore) out[k] = fakeStore[k];
              }
              return out;
            }
            return { ...fakeStore };
          }),
          set: vi.fn(async (obj: Record<string, unknown>) => {
            Object.assign(fakeStore, obj);
          }),
          setAccessLevel: vi.fn().mockResolvedValue(undefined),
        },
      },
      cookies: { onChanged: { addListener: vi.fn() } },
      tabs: {},
    };
    (globalThis as { chrome?: unknown }).chrome = chrome;
  });

  afterEach(() => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
  });

  it("renders the signed-in UI immediately from cache before GET_STATE resolves", async () => {
    // Pre-populate the cache with a signed-in state.
    const cachedState = makeState({
      signedInUser: { email: "cached@test.com", tier: "pro" },
    });
    fakeStore[POPUP_STATE_CACHE_KEY] = {
      running: cachedState.running,
      connecting: cachedState.connecting,
      paused: cachedState.paused,
      signedInUser: cachedState.signedInUser,
      tier: cachedState.tier,
      targetLanguage: cachedState.targetLanguage,
    };
    fakeStore[HAS_EVER_SIGNED_IN_KEY] = true;

    // Make GET_STATE hang (cold SW).
    let resolveGetState!: (v: unknown) => void;
    const chrome = (globalThis as unknown as { chrome?: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome!;
    chrome.runtime.sendMessage = vi.fn(async (msg: { type: string }) => {
      if (msg.type === "GET_STATE") {
        getStateCalls++;
        return new Promise((r) => { resolveGetState = r; });
      }
      return { ok: true, devices: [] };
    });

    initPopup();

    // Let the storage reads complete (hasEverSignedIn + cache load).
    await flush(10);

    // At this point GET_STATE is still pending but we should already show
    // the signed-in account state from the cache.
    expect(document.body.dataset.account).toBe("in");

    // Now resolve the real GET_STATE.
    resolveGetState({ ok: true, state: makeState({ signedInUser: { email: "live@test.com", tier: "pro" } }) });
    await flush(10);

    // After reconciliation the live state takes over.
    expect(document.body.dataset.account).toBe("in");
    // GET_STATE was called exactly once.
    expect(getStateCalls).toBe(1);
  });

  it("falls back to loading state when no cache entry exists", async () => {
    // No cache, GET_STATE hangs.
    let resolveGetState!: (v: unknown) => void;
    const chrome = (globalThis as unknown as { chrome?: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } }).chrome!;
    chrome.runtime.sendMessage = vi.fn(async (msg: { type: string }) => {
      if (msg.type === "GET_STATE") {
        getStateCalls++;
        return new Promise((r) => { resolveGetState = r; });
      }
      return { ok: true, devices: [] };
    });

    initPopup();
    await flush(10);

    // No cache → account state should still be "loading" or "welcome"
    // (whatever the default is without a cache entry).
    // The popup shows "loading" shell, NOT "in".
    expect(document.body.dataset.account).not.toBe("in");

    // Resolve.
    resolveGetState({ ok: true, state: makeState() });
    await flush(10);

    // After reconciliation it shows "in".
    expect(document.body.dataset.account).toBe("in");
  });

  it("writes the cache when applyState is called from a real GET_STATE reply", async () => {
    const setCalls: Array<Record<string, unknown>> = [];
    const chrome = (globalThis as unknown as { chrome?: { runtime: { sendMessage: ReturnType<typeof vi.fn> }; storage: { local: { set: ReturnType<typeof vi.fn> } } } }).chrome!;
    const origSet = chrome.storage.local.set;
    chrome.storage.local.set = vi.fn(async (obj: Record<string, unknown>) => {
      setCalls.push({ ...obj });
      return (origSet as (obj: Record<string, unknown>) => Promise<void>)(obj);
    });

    initPopup();
    await flush(10);

    // A cache write should have happened for the GET_STATE reply.
    const cacheWrite = setCalls.find((c) => POPUP_STATE_CACHE_KEY in c);
    expect(cacheWrite).toBeDefined();
    expect((cacheWrite![POPUP_STATE_CACHE_KEY] as Partial<State>)?.signedInUser?.email).toBe("user@example.com");
  });

  it("does NOT write cache when applying optimistic (cached) state", async () => {
    // Pre-populate.
    fakeStore[POPUP_STATE_CACHE_KEY] = {
      running: false,
      signedInUser: { email: "cached@test.com", tier: "pro" },
      tier: "standard",
      targetLanguage: "vi",
    };
    fakeStore[HAS_EVER_SIGNED_IN_KEY] = true;

    const setCalls: Array<Record<string, unknown>> = [];
    const chrome = (globalThis as unknown as { chrome?: { runtime: { sendMessage: ReturnType<typeof vi.fn> }; storage: { local: { set: ReturnType<typeof vi.fn> } } } }).chrome!;
    const origSet = chrome.storage.local.set;
    chrome.storage.local.set = vi.fn(async (obj: Record<string, unknown>) => {
      setCalls.push({ ...obj });
      return (origSet as (obj: Record<string, unknown>) => Promise<void>)(obj);
    });

    // Make GET_STATE hang so we can observe the point in time after the
    // optimistic render but before GET_STATE replies.
    let resolveGetState!: (v: unknown) => void;
    chrome.runtime.sendMessage = vi.fn(async (msg: { type: string }) => {
      if (msg.type === "GET_STATE") {
        return new Promise((r) => { resolveGetState = r; });
      }
      return { ok: true, devices: [] };
    });

    initPopup();
    // Let the cache load + optimistic render run.
    await flush(10);

    // Check that no cache write happened for the optimistic render.
    // (Any SET calls at this point should be for hasEverSignedIn or other
    // non-cache keys — NOT for POPUP_STATE_CACHE_KEY yet.)
    const cacheWritesBeforeGetState = setCalls.filter((c) => POPUP_STATE_CACHE_KEY in c);
    expect(cacheWritesBeforeGetState).toHaveLength(0);

    // Resolve the real state — this SHOULD trigger a cache write.
    resolveGetState({ ok: true, state: makeState() });
    await flush(10);

    const cacheWritesAfterGetState = setCalls.filter((c) => POPUP_STATE_CACHE_KEY in c);
    expect(cacheWritesAfterGetState.length).toBeGreaterThan(0);
  });

  // ── W5/AC14 — cold-SW no-regress + cache suppression while hydrating ───────

  it("does NOT regress a rendered signed-in user when signedInUser:null arrives while hydrating", async () => {
    // Cached signed-in render first (cold SW path).
    fakeStore[POPUP_STATE_CACHE_KEY] = {
      running: false,
      signedInUser: { email: "cached@test.com", tier: "pro" },
      tier: "standard",
      targetLanguage: "vi",
    };
    fakeStore[HAS_EVER_SIGNED_IN_KEY] = true;

    // GET_STATE replies instantly with the cold-SW snapshot: signed-out + hydrating.
    getStateResult = { ok: true, state: makeState({ signedInUser: null, hydrating: true }) };

    initPopup();
    await flush(10);

    // The popup must keep the signed-in render — no flash to signed-out.
    expect(document.body.dataset.account).toBe("in");

    // The eventual broadcast carries the real user and hydrating=false → reconciles.
    const chrome = (globalThis as unknown as {
      chrome: { runtime: { onMessage: { addListener: ReturnType<typeof vi.fn> } } };
    }).chrome;
    const listener = chrome.runtime.onMessage.addListener.mock.calls[0]?.[0] as
      | ((msg: unknown) => void)
      | undefined;
    expect(listener).toBeDefined();
    listener!({
      type: "BACKGROUND_STATE_UPDATE",
      state: makeState({ signedInUser: { email: "live@test.com", tier: "pro" }, hydrating: false }),
    });
    await flush(10);
    expect(document.body.dataset.account).toBe("in");
  });

  it("suppresses popup cache writes while hydrating, resumes after hydrating=false", async () => {
    const setCalls: Array<Record<string, unknown>> = [];
    const chrome = (globalThis as unknown as {
      chrome: {
        runtime: { onMessage: { addListener: ReturnType<typeof vi.fn> } };
        storage: { local: { set: ReturnType<typeof vi.fn> } };
      };
    }).chrome;
    const origSet = chrome.storage.local.set;
    chrome.storage.local.set = vi.fn(async (obj: Record<string, unknown>) => {
      setCalls.push({ ...obj });
      return (origSet as (obj: Record<string, unknown>) => Promise<void>)(obj);
    });

    // GET_STATE replies with a signed-in but still-hydrating snapshot.
    getStateResult = { ok: true, state: makeState({ hydrating: true }) };

    initPopup();
    await flush(10);

    // No cache write while hydrating (poisoning guard).
    expect(setCalls.filter((c) => POPUP_STATE_CACHE_KEY in c)).toHaveLength(0);

    // Hydration completes via broadcast → cache write resumes.
    const listener = chrome.runtime.onMessage.addListener.mock.calls[0]?.[0] as
      | ((msg: unknown) => void)
      | undefined;
    expect(listener).toBeDefined();
    listener!({ type: "BACKGROUND_STATE_UPDATE", state: makeState({ hydrating: false }) });
    await flush(10);
    expect(setCalls.filter((c) => POPUP_STATE_CACHE_KEY in c).length).toBeGreaterThan(0);
  });
});
