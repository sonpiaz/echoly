// @vitest-environment jsdom
// Tests for the Source-language dropdown in the popup (Agent 4 — Fix D-UI).
// Acceptance: D8a, D8b, D8c.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ADVANCED } from "@/shared/advanced";
import { DEFAULT_TRANSLATION_TIER, TIER_STANDARD, TIER_REALTIME } from "@/shared/constants";
import type { State } from "@/shared/types";
import { initPopup } from "@/popup";

// ────────────────────────────────────────────────────────────────────────────
// Minimal HTML fixture — includes src-trigger / src-lang nodes added by Fix D.
// ────────────────────────────────────────────────────────────────────────────
const FIXTURE_HTML = `
<body data-state="idle" data-account="loading">
  <main class="shell shell--main main-only">
    <header class="topline">
      <span id="plan-badge"><span id="plan-badge-text">FREE</span></span>
      <button id="account-trigger"><span id="account-avatar-initial">·</span></button>
    </header>

    <section class="session-card idle-only">
      <!-- Translating row with Source dropdown (Fix D) -->
      <div class="session-row session-row--trans">
        <div class="trans-grid">
          <div class="lang-side lang-side--left" id="src-trigger">
            <span class="flag-chip" id="src-flag">??</span>
            <span class="lang-name" id="src-name">Auto-detect</span>
            <select id="src-lang" class="dropdown-mirror-select" aria-label="Source language"></select>
          </div>
          <div class="trans-divider"></div>
          <div class="lang-side lang-side--right" id="lang-trigger">
            <span class="lang-name" id="tgt-name"></span>
            <span class="flag-chip" id="tgt-flag"></span>
            <select id="lang"></select>
          </div>
        </div>
      </div>

      <div id="tier-trigger">
        <span id="tier-primary"></span>
        <span id="tier-secondary"></span>
        <select id="tier">
          <option value="${TIER_REALTIME}">Realtime</option>
          <option value="${TIER_STANDARD}">Standard</option>
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
      <div><span id="latency">—</span></div>
      <div><span id="words">—</span></div>
    </section>

    <button id="toggle"><span id="actionLabel">Start dubbing</span></button>

    <div class="usage-hint-row signedin-only idle-only" id="usage-hint-row">
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
      <summary><span class="adv-label">Advanced</span></summary>
      <div class="advanced-body">
        <div class="adv-row">
          <div class="segmented" data-count="3" data-setting="captionPosition">
            <button type="button" data-value="top">Top</button>
            <button type="button" data-value="bottom">Bottom</button>
            <button type="button" data-value="float">Float</button>
          </div>
        </div>
        <div class="adv-row adv-row--inline">
          <span id="autoStartDomain">—</span>
          <label><input type="checkbox" id="autoStart" /></label>
        </div>
        <div class="adv-row">
          <select id="outputDevice"><option value="">System default</option></select>
        </div>
        <div class="adv-footer">
          <button type="button" id="advResetBtn">Reset to defaults</button>
          <button type="button" id="advSaveBtn" disabled>Save for this site</button>
        </div>
      </div>
    </details>

    <footer class="status-footer">
      <span class="status-text">
        <span class="status-dot"></span>
        <span id="status">Ready</span>
      </span>
      <span class="dirty-pill" id="advDirtyPill" hidden></span>
      <span class="version">v0.0.0</span>
    </footer>

    <div id="account-menu-dim" hidden></div>
    <div id="account-menu" hidden>
      <div id="am-avatar">·</div>
      <div id="am-email"></div>
      <div id="am-plan-badge"><span id="am-plan-badge-text"></span></div>
      <span id="am-days-left" hidden></span>
      <span id="am-reset"></span>
      <div id="um-std"><span id="um-std-used">0</span><span id="um-std-cap">0</span><span id="um-std-fill"></span></div>
      <div id="um-rt" hidden><span id="um-rt-used">0</span><span id="um-rt-cap">0</span><span id="um-rt-fill"></span></div>
      <button id="am-billing"></button>
      <button id="am-invoices"></button>
      <button id="am-help"></button>
      <button id="am-signout"></button>
    </div>
  </main>
</body>
`;

interface SentMessage {
  type: string;
  [k: string]: unknown;
}

function makeState(overrides: Partial<State> = {}): State {
  return {
    running: false,
    connecting: false,
    paused: false,
    tabId: null,
    status: "Ready",
    errorMessage: "",
    apiMode: "proxy",
    signedInUser: { email: "u@e.com", tier: "max" },
    usage: { used: 0 },
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
    ...overrides,
  };
}

/** Settle microtasks / promise chains inside initPopup. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("popup source-language dropdown — D8a, D8b, D8c", () => {
  let sent: SentMessage[];
  let stateForReply: State;

  function installChromeMock() {
    const fakeChrome = (globalThis as { chrome?: unknown }).chrome as {
      runtime: {
        id?: string;
        sendMessage: ReturnType<typeof vi.fn>;
        onMessage: { addListener: (fn: (...a: unknown[]) => unknown) => void };
        getManifest?: () => { version: string };
      };
    };
    fakeChrome.runtime.getManifest = () => ({ version: "0.0.0-test" });
    fakeChrome.runtime.sendMessage = vi.fn(async (msg: SentMessage) => {
      sent.push(msg);
      switch (msg.type) {
        case "GET_STATE":
          return { ok: true, state: stateForReply };
        case "UPDATE_SETTINGS":
          return { ok: true, state: stateForReply };
        case "LIST_AUDIO_OUTPUT_DEVICES":
          return { ok: true, devices: [] };
        default:
          return { ok: true };
      }
    });
  }

  beforeEach(async () => {
    document.documentElement.innerHTML = FIXTURE_HTML;
    document.body.dataset.state = "idle";
    document.body.dataset.account = "loading";
    sent = [];
    stateForReply = makeState();
    installChromeMock();
    initPopup();
    await flush();
  });

  afterEach(() => {
    document.documentElement.innerHTML = "";
  });

  // ── D8a: source dropdown renders "Auto-detect" + language options ──────────
  it("D8a: src-lang has an 'Auto-detect' option and at least one language option", () => {
    const srcSelect = document.querySelector<HTMLSelectElement>("#src-lang");
    expect(srcSelect).not.toBeNull();

    const values = Array.from(srcSelect!.options).map((o) => o.value);
    expect(values).toContain("auto");

    const autoOpt = Array.from(srcSelect!.options).find((o) => o.value === "auto");
    expect(autoOpt?.textContent).toBe("Auto-detect");

    // Should have more than just "auto" (at least one real language).
    expect(srcSelect!.options.length).toBeGreaterThan(1);
  });

  it("D8a: 'Auto-detect' is the first option (prepended)", () => {
    const srcSelect = document.querySelector<HTMLSelectElement>("#src-lang");
    expect(srcSelect!.options[0]!.value).toBe("auto");
    expect(srcSelect!.options[0]!.textContent).toBe("Auto-detect");
  });

  // ── D8b: selecting a source language sends UPDATE_SETTINGS { sourceLanguage } ─
  it("D8b: changing src-lang select sends UPDATE_SETTINGS containing { sourceLanguage: 'en' }", async () => {
    const srcSelect = document.querySelector<HTMLSelectElement>("#src-lang");
    expect(srcSelect).not.toBeNull();

    srcSelect!.value = "en";
    srcSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();

    const updates = sent.filter((m) => m.type === "UPDATE_SETTINGS");
    expect(updates.length).toBeGreaterThanOrEqual(1);
    const last = updates[updates.length - 1]!;
    expect((last.settings as Record<string, unknown>)?.sourceLanguage).toBe("en");
  });

  it("D8b: selecting 'auto' source sends UPDATE_SETTINGS { sourceLanguage: 'auto' }", async () => {
    const srcSelect = document.querySelector<HTMLSelectElement>("#src-lang");
    // First switch to "en" then back to "auto" to ensure a change event fires.
    srcSelect!.value = "en";
    srcSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();

    srcSelect!.value = "auto";
    srcSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    await flush();

    const updates = sent.filter((m) => m.type === "UPDATE_SETTINGS");
    const last = updates[updates.length - 1]!;
    expect((last.settings as Record<string, unknown>)?.sourceLanguage).toBe("auto");
  });

  // ── D8c: popup reflects state.sourceLanguage ──────────────────────────────
  it("D8c: when sourceLanguage='auto', src-name shows 'Auto-detect' and src-flag shows '??'", () => {
    // Default state has sourceLanguage: "auto"
    const srcName = document.querySelector<HTMLElement>("#src-name");
    const srcFlag = document.querySelector<HTMLElement>("#src-flag");
    expect(srcName?.textContent).toBe("Auto-detect");
    expect(srcFlag?.textContent).toBe("??");
  });

  it("D8c: when state has sourceLanguage='en', popup shows the language name and flag", async () => {
    stateForReply = makeState({ sourceLanguage: "en" });
    const fakeChrome = (globalThis as { chrome?: unknown }).chrome as {
      runtime: { sendMessage: ReturnType<typeof vi.fn> };
    };
    fakeChrome.runtime.sendMessage = vi.fn(async (msg: SentMessage) => {
      if (msg.type === "GET_STATE") return { ok: true, state: stateForReply };
      if (msg.type === "LIST_AUDIO_OUTPUT_DEVICES") return { ok: true, devices: [] };
      return { ok: true };
    });

    // Reinitialize to pick up new stateForReply.
    document.documentElement.innerHTML = FIXTURE_HTML;
    initPopup();
    await flush();

    const srcName = document.querySelector<HTMLElement>("#src-name");
    const srcFlag = document.querySelector<HTMLElement>("#src-flag");
    // "en" → resolves to "English" from the offline catalog; flag = "EN"
    expect(srcName?.textContent).toBe("English");
    expect(srcFlag?.textContent).toBe("EN");
  });

  it("D8c: src-lang select value matches state.sourceLanguage", async () => {
    stateForReply = makeState({ sourceLanguage: "en" });
    const fakeChrome = (globalThis as { chrome?: unknown }).chrome as {
      runtime: { sendMessage: ReturnType<typeof vi.fn> };
    };
    fakeChrome.runtime.sendMessage = vi.fn(async (msg: SentMessage) => {
      if (msg.type === "GET_STATE") return { ok: true, state: stateForReply };
      if (msg.type === "LIST_AUDIO_OUTPUT_DEVICES") return { ok: true, devices: [] };
      return { ok: true };
    });

    document.documentElement.innerHTML = FIXTURE_HTML;
    initPopup();
    await flush();

    const srcSelect = document.querySelector<HTMLSelectElement>("#src-lang");
    expect(srcSelect?.value).toBe("en");
  });

  // ── live-src-flag reflects sourceLanguage ──────────────────────────────────
  it("live-src-flag shows '??' when sourceLanguage is 'auto'", () => {
    const liveSrcFlag = document.querySelector<HTMLElement>("#live-src-flag");
    // Default state: sourceLanguage = "auto"
    expect(liveSrcFlag?.textContent).toBe("??");
  });
});
