// @vitest-environment jsdom
// Layer B — interaction tests for the Advanced settings section of the popup.
// Asserts each control dispatches the correct UPDATE_ADVANCED_SETTINGS /
// SAVE_SITE_DEFAULT message, the Save-for-site button is gated on
// state.currentDomain, and the output device picker round-trips correctly.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ADVANCED } from "@/shared/advanced";
import { DEFAULT_TRANSLATION_TIER, TIER_REALTIME, TIER_STANDARD } from "@/shared/constants";
import type { State } from "@/shared/types";
import { initPopup } from "@/popup";

// ────────────────────────────────────────────────────────────────────────────
// HTML fixture — a minimal version of src/entrypoints/popup/index.html with
// only the IDs / classes initPopup() queries. Re-installed before each test.
// ────────────────────────────────────────────────────────────────────────────
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
      <span><b id="usage-hint-amount">0 min</b><span id="usage-hint-label">left</span></span>
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

    <details class="advanced idle-only" open>
      <summary><span class="adv-label">Advanced</span></summary>
      <div class="advanced-body">
        <div class="adv-row">
          <div class="adv-row-label">Captions</div>
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
      <span class="dirty-pill" id="advDirtyPill" hidden>Saving locally — will sync when online</span>
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

/** Build a full State with signed-in user + the given currentDomain. */
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
    usage: { standard: 0, realtime: 0 },
    languagePicker: null,
    languageNames: null,
    standardVoices: null,
    standardVoiceDefaultId: null,
    sessionStartedAt: null,
    tier: DEFAULT_TRANSLATION_TIER,
    targetLanguage: "vi",
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

/** Wait for pending microtasks / awaited sends to settle. */
async function flush() {
  // Two awaits — one for the GET_STATE / LIST_AUDIO_OUTPUT_DEVICES promise
  // resolution, another for the .then() that calls applyState.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("popup Advanced section — dispatch contract", () => {
  let sent: SentMessage[];
  let stateForReply: State;

  beforeEach(async () => {
    document.documentElement.innerHTML = FIXTURE_HTML;
    document.body.dataset.state = "idle";
    document.body.dataset.account = "loading";

    sent = [];
    stateForReply = makeState({ currentDomain: "youtube.com" });

    // Mock chrome.runtime.sendMessage — record + return scripted replies.
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
        case "UPDATE_ADVANCED_SETTINGS":
          // Echo a state with the patch applied — popup re-renders from this.
          return { ok: true, state: stateForReply };
        case "SAVE_SITE_DEFAULT":
          return { ok: true, state: stateForReply };
        case "LIST_AUDIO_OUTPUT_DEVICES":
          return {
            ok: true,
            devices: [
              { deviceId: "id-x", label: "External Speakers" },
              { deviceId: "id-y", label: "Headphones" },
            ],
          };
        default:
          return { ok: true };
      }
    });

    initPopup();
    await flush();
  });

  afterEach(() => {
    document.documentElement.innerHTML = "";
  });

  it("captions = top → UPDATE_ADVANCED_SETTINGS { captionPosition: 'top' }", async () => {
    const btn = document.querySelector<HTMLButtonElement>(
      '.segmented[data-setting="captionPosition"] button[data-value="top"]',
    );
    btn!.click();
    await flush();
    const updates = sent.filter((m) => m.type === "UPDATE_ADVANCED_SETTINGS");
    expect(updates[updates.length - 1]!.patch).toEqual({ captionPosition: "top" });
  });

  it("reset to defaults → UPDATE_ADVANCED_SETTINGS with full DEFAULT_ADVANCED patch", async () => {
    const reset = document.querySelector<HTMLButtonElement>("#advResetBtn");
    reset!.click();
    await flush();
    const updates = sent.filter((m) => m.type === "UPDATE_ADVANCED_SETTINGS");
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect(updates[updates.length - 1]!.patch).toEqual({ ...DEFAULT_ADVANCED });
  });

  it("save-for-site dispatches SAVE_SITE_DEFAULT with the current domain", async () => {
    const save = document.querySelector<HTMLButtonElement>("#advSaveBtn");
    expect(save).not.toBeNull();
    expect(save!.disabled).toBe(false);
    save!.click();
    await flush();
    const saves = sent.filter((m) => m.type === "SAVE_SITE_DEFAULT");
    expect(saves).toHaveLength(1);
    expect(saves[0]!.domain).toBe("youtube.com");
  });

  it("output device select → UPDATE_ADVANCED_SETTINGS { outputDeviceId: 'id-x' }", async () => {
    const sel = document.querySelector<HTMLSelectElement>("#outputDevice");
    expect(sel).not.toBeNull();
    // The select should have been populated by LIST_AUDIO_OUTPUT_DEVICES.
    const values = Array.from(sel!.options).map((o) => o.value);
    expect(values).toContain("id-x");
    sel!.value = "id-x";
    sel!.dispatchEvent(new Event("change"));
    await flush();
    const updates = sent.filter((m) => m.type === "UPDATE_ADVANCED_SETTINGS");
    expect(updates[updates.length - 1]!.patch).toEqual({ outputDeviceId: "id-x" });
  });

  it("auto-start checkbox dispatches a per-domain autoStartHosts patch", async () => {
    const cb = document.querySelector<HTMLInputElement>("#autoStart");
    expect(cb).not.toBeNull();
    expect(cb!.disabled).toBe(false);
    cb!.checked = true;
    cb!.dispatchEvent(new Event("change"));
    await flush();
    const updates = sent.filter((m) => m.type === "UPDATE_ADVANCED_SETTINGS");
    expect(updates[updates.length - 1]!.patch).toEqual({
      autoStartHosts: { "youtube.com": true },
    });
  });
});

describe("popup Advanced section — save-for-site gating", () => {
  beforeEach(async () => {
    document.documentElement.innerHTML = FIXTURE_HTML;
    document.body.dataset.state = "idle";
    document.body.dataset.account = "loading";

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
      if (msg.type === "GET_STATE") {
        // No currentDomain ⇒ Save-for-site must stay disabled.
        return { ok: true, state: makeState({ currentDomain: null }) };
      }
      if (msg.type === "LIST_AUDIO_OUTPUT_DEVICES") {
        return { ok: true, devices: [] };
      }
      return { ok: true };
    });

    initPopup();
    await flush();
  });

  afterEach(() => {
    document.documentElement.innerHTML = "";
  });

  it("Save-for-site is DISABLED when state.currentDomain is null", () => {
    const save = document.querySelector<HTMLButtonElement>("#advSaveBtn");
    expect(save).not.toBeNull();
    expect(save!.disabled).toBe(true);
  });

  it("Auto-start checkbox is also disabled when there is no current domain", () => {
    const cb = document.querySelector<HTMLInputElement>("#autoStart");
    expect(cb).not.toBeNull();
    expect(cb!.disabled).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Realtime tier lock — Realtime is Max-only; Free/Pro/signed-out must NOT be
// able to select it in the tier dropdown. (SOLUTION ext-overlay-tier-fixes AC2.)
// ────────────────────────────────────────────────────────────────────────────
describe("popup tier dropdown — Realtime locked for non-Max", () => {
  let stateForReply: State;

  function installChromeMock() {
    const fakeChrome = (globalThis as { chrome?: unknown }).chrome as {
      runtime: {
        sendMessage: ReturnType<typeof vi.fn>;
        getManifest?: () => { version: string };
      };
    };
    fakeChrome.runtime.getManifest = () => ({ version: "0.0.0-test" });
    fakeChrome.runtime.sendMessage = vi.fn(async (msg: SentMessage) => {
      if (msg.type === "GET_STATE") return { ok: true, state: stateForReply };
      if (msg.type === "LIST_AUDIO_OUTPUT_DEVICES") return { ok: true, devices: [] };
      return { ok: true, state: stateForReply };
    });
  }

  beforeEach(() => {
    document.documentElement.innerHTML = FIXTURE_HTML;
    document.body.dataset.state = "idle";
  });
  afterEach(() => {
    document.documentElement.innerHTML = "";
  });

  /** Boot the popup for a given account plan + selected tier, then open the
   *  tier dropdown and return the rendered Realtime option element. */
  async function bootAndOpenTier(
    plan: "free" | "pro" | "max",
    tier = TIER_STANDARD,
  ): Promise<{ realtimeOpt: HTMLElement | null; tierSelect: HTMLSelectElement }> {
    stateForReply = makeState({ signedInUser: { email: "u@e.com", tier: plan }, tier });
    installChromeMock();
    initPopup();
    await flush();
    const trigger = document.querySelector<HTMLElement>("#tier-trigger");
    // The custom dropdown opens on the trigger's mousedown (not click).
    trigger!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await flush();
    const realtimeOpt = document.querySelector<HTMLElement>(
      `.dropdown-option[data-value="${TIER_REALTIME}"]`,
    );
    const tierSelect = document.querySelector<HTMLSelectElement>("#tier")!;
    return { realtimeOpt, tierSelect };
  }

  for (const plan of ["free", "pro"] as const) {
    it(`${plan}: Realtime option is disabled (aria-disabled + .is-disabled) and not selectable`, async () => {
      const { realtimeOpt, tierSelect } = await bootAndOpenTier(plan);
      expect(realtimeOpt).not.toBeNull();
      expect(realtimeOpt!.getAttribute("aria-disabled")).toBe("true");
      expect(realtimeOpt!.classList.contains("is-disabled")).toBe(true);

      // Picking the disabled option (mousedown) must NOT switch tier to realtime.
      realtimeOpt!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      await flush();
      expect(tierSelect.value).toBe(TIER_STANDARD);
    });
  }

  it("max: Realtime option is enabled (not locked)", async () => {
    // The gating contract is plan→disabled; the disabled flag drives dropdown.ts's
    // already-tested pick() guard. Here we assert the flag differs by plan: a Max
    // account's Realtime option is NOT disabled (so it remains selectable).
    const { realtimeOpt } = await bootAndOpenTier("max");
    expect(realtimeOpt).not.toBeNull();
    expect(realtimeOpt!.getAttribute("aria-disabled")).not.toBe("true");
    expect(realtimeOpt!.classList.contains("is-disabled")).toBe(false);
  });
});
