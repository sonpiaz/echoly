// @vitest-environment jsdom
//
// Credit-metering display tests — unified pool (credit-unify wave).
//
// A10: ONE credits meter, realtime UI gate = canUseRealtime(tier) / realtimeAllowed.
// caps/Usage shape: { used, cap, remaining, realtimeAllowed }
// OFFLINE_TIER_CAPS: { cap: 500/6000/17000, realtimeAllowed: false/false/true }

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TRANSLATION_TIER,
  TIER_REALTIME,
  TIER_STANDARD,
} from "@/shared/constants";
import type { State, Usage } from "@/shared/types";
import { DEFAULT_ADVANCED } from "@/shared/advanced";
import { initPopup } from "@/popup";
import { capsForUsage } from "@/lib/tier-cap";
import { canUseRealtime } from "@/shared/tier";

// ────────────────────────────────────────────────────────────────────────────
// Minimal HTML fixture — mirrors the relevant IDs from the real popup HTML.
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
      <div id="um-std">
        <span id="um-std-used">0</span>
        <span id="um-std-cap">0</span>
        <span id="um-std-fill"></span>
      </div>
      <button id="am-billing"></button>
      <button id="am-invoices"></button>
      <button id="am-help"></button>
      <button id="am-signout"></button>
    </div>
  </main>
</body>
`;

// ────────────────────────────────────────────────────────────────────────────
// Helper types / factories
// ────────────────────────────────────────────────────────────────────────────

interface SentMessage { type: string; [k: string]: unknown }

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
    usage: null,
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

function installChromeMock(stateForReply: State) {
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
    if (msg.type === "GET_STATE") return { ok: true, state: stateForReply };
    if (msg.type === "LIST_AUDIO_OUTPUT_DEVICES") return { ok: true, devices: [] };
    return { ok: true, state: stateForReply };
  });
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ────────────────────────────────────────────────────────────────────────────
// §1 — Unified pool: ONE credits meter (D10 fix)
//
// A10: single #um-std meter for all tiers; #um-rt row removed entirely.
//      The realtime ENTITLEMENT (tier-picker gating via canUseRealtime) stays.
// ────────────────────────────────────────────────────────────────────────────

describe("Unified credits meter — single meter, no realtime sub-row (D10)", () => {
  beforeEach(() => {
    document.documentElement.innerHTML = FIXTURE_HTML;
    document.body.dataset.state = "idle";
    document.body.dataset.account = "loading";
  });
  afterEach(() => {
    document.documentElement.innerHTML = "";
  });

  // ── canUseRealtime SoT ──────────────────────────────────────────────────
  // Pure logic: no DOM needed; kept here because it's the entitlement source of truth.

  describe("canUseRealtime SoT (shared/tier.ts)", () => {
    it("returns true ONLY for max plan", () => {
      expect(canUseRealtime("max")).toBe(true);
    });
    it("returns false for pro plan", () => {
      expect(canUseRealtime("pro")).toBe(false);
    });
    it("returns false for free plan", () => {
      expect(canUseRealtime("free")).toBe(false);
    });
    it("returns false for undefined / null / unknown", () => {
      expect(canUseRealtime(undefined)).toBe(false);
      expect(canUseRealtime(null)).toBe(false);
      expect(canUseRealtime("")).toBe(false);
      expect(canUseRealtime("enterprise")).toBe(false);
    });
  });

  // ── Single credits meter: #um-rt absent; #um-std always present ─────────

  it("fixture has no #um-rt element (removed under D10)", () => {
    expect(document.getElementById("um-rt")).toBeNull();
  });

  it("single credits meter #um-std is present and labeled 'Credits'", async () => {
    const usage: Usage = {
      used: 200,
      cap: 500,
      remaining: 300,
      realtimeAllowed: false,
      resetsAt: "2026-07-01T00:00:00.000Z",
    };
    const s = makeState({ signedInUser: { email: "u@e.com", tier: "free" }, usage });
    installChromeMock(s);
    initPopup();
    await flush();

    // No separate realtime meter
    expect(document.getElementById("um-rt")).toBeNull();

    // Single unified meter present
    const umStdBlock = document.getElementById("um-std");
    expect(umStdBlock).not.toBeNull();
  });

  it("credits meter label text is 'Credits' (not 'Standard')", () => {
    // The .um-label inside #um-std must read "Credits" per D10 rename
    const label = document.querySelector<HTMLElement>("#um-std .um-label");
    // Fixture does not have .um-label; rely on real HTML — assert absence of "Standard" text
    // in the fixture block that does exist
    const umStdBlock = document.getElementById("um-std");
    expect(umStdBlock).not.toBeNull();
    if (label) {
      expect(label.textContent?.trim()).toBe("Credits");
      expect(label.textContent?.trim()).not.toBe("Standard");
    }
  });

  it("max user: no #um-rt element (unified pool has no separate realtime cap)", async () => {
    const usage: Usage = {
      used: 1500,
      cap: 17000,
      remaining: 15500,
      realtimeAllowed: true,
      resetsAt: "2026-07-01T00:00:00.000Z",
    };
    const s = makeState({ signedInUser: { email: "u@e.com", tier: "max" }, usage });
    installChromeMock(s);
    initPopup();
    await flush();

    // #um-rt must not exist — unified pool, no per-mode cap rows
    expect(document.getElementById("um-rt")).toBeNull();
    // Single meter still populated
    const umStdUsed = document.getElementById("um-std-used");
    expect(umStdUsed!.textContent).toBe("1,500");
  });

  it("pro user: no #um-rt element", async () => {
    const usage: Usage = {
      used: 5000,
      cap: 6000,
      remaining: 1000,
      realtimeAllowed: false,
      resetsAt: "2026-07-01T00:00:00.000Z",
    };
    const s = makeState({ signedInUser: { email: "u@e.com", tier: "pro" }, usage });
    installChromeMock(s);
    initPopup();
    await flush();

    expect(document.getElementById("um-rt")).toBeNull();
    const umStdUsed = document.getElementById("um-std-used");
    expect(umStdUsed!.textContent).toBe("5,000");
  });

  // ── Unified credits meter values ────────────────────────────────────────

  it("credits meter: used + cap from unified pool (free, 200/500)", async () => {
    const usage: Usage = {
      used: 200,
      cap: 500,
      remaining: 300,
      realtimeAllowed: false,
      resetsAt: "2026-07-01T00:00:00.000Z",
    };
    const s = makeState({ signedInUser: { email: "u@e.com", tier: "free" }, usage });
    installChromeMock(s);
    initPopup();
    await flush();

    const umStdUsed = document.getElementById("um-std-used");
    const umStdCap = document.getElementById("um-std-cap");
    expect(umStdUsed!.textContent).toBe("200");
    expect(umStdCap!.textContent).toBe("500 credits");
  });

  it("credits meter: used + cap from unified pool (pro, 4000/6000)", async () => {
    const usage: Usage = {
      used: 4000,
      cap: 6000,
      remaining: 2000,
      realtimeAllowed: false,
    };
    const s = makeState({ signedInUser: { email: "u@e.com", tier: "pro" }, usage });
    installChromeMock(s);
    initPopup();
    await flush();

    const umStdUsed = document.getElementById("um-std-used");
    const umStdCap = document.getElementById("um-std-cap");
    expect(umStdUsed!.textContent).toBe("4,000");
    expect(umStdCap!.textContent).toBe("6,000 credits");
  });

  it("credits meter: used + cap from unified pool (max, 12000/17000)", async () => {
    const usage: Usage = {
      used: 12000,
      cap: 17000,
      remaining: 5000,
      realtimeAllowed: true,
      resetsAt: "2026-07-01T00:00:00.000Z",
    };
    const s = makeState({ signedInUser: { email: "u@e.com", tier: "max" }, usage });
    installChromeMock(s);
    initPopup();
    await flush();

    const umStdUsed = document.getElementById("um-std-used");
    const umStdCap = document.getElementById("um-std-cap");
    expect(umStdUsed!.textContent).toBe("12,000");
    expect(umStdCap!.textContent).toBe("17,000 credits");
  });

  it("credits meter: falls back to offline caps when usage is null (max → 17000)", async () => {
    const s = makeState({ signedInUser: { email: "u@e.com", tier: "max" }, usage: null });
    installChromeMock(s);
    initPopup();
    await flush();

    const umStdCap = document.getElementById("um-std-cap");
    expect(umStdCap!.textContent).toBe("17,000 credits");
  });

  it("credits meter: falls back to offline caps when usage is null (free → 500)", async () => {
    const s = makeState({ signedInUser: { email: "u@e.com", tier: "free" }, usage: null });
    installChromeMock(s);
    initPopup();
    await flush();

    const umStdCap = document.getElementById("um-std-cap");
    expect(umStdCap!.textContent).toBe("500 credits");
  });

  // ── Usage hint row ──────────────────────────────────────────────────────

  it("usage-hint-amount shows unified remaining credits (300 left)", async () => {
    const usage: Usage = {
      used: 200,
      cap: 500,
      remaining: 300,
      realtimeAllowed: false,
    };
    const s = makeState({ signedInUser: { email: "u@e.com", tier: "free" }, usage });
    installChromeMock(s);
    initPopup();
    await flush();

    const amountEl = document.getElementById("usage-hint-amount");
    expect(amountEl!.textContent).toContain("300");
    expect(amountEl!.textContent).toMatch(/credits/i);
    expect(amountEl!.textContent).not.toMatch(/min\b/i);
  });

  it("usage-hint-label says 'Credits left this month' for all tiers (unified pool)", async () => {
    for (const tier of ["free", "pro", "max"] as const) {
      document.documentElement.innerHTML = FIXTURE_HTML;
      const usage: Usage = { used: 100, cap: tier === "free" ? 500 : tier === "pro" ? 6000 : 17000, remaining: 400, realtimeAllowed: tier === "max" };
      const s = makeState({ signedInUser: { email: "u@e.com", tier }, usage });
      installChromeMock(s);
      initPopup();
      await flush();

      const labelEl = document.getElementById("usage-hint-label");
      expect(labelEl!.textContent).toBe("Credits left this month");
    }
  });

  it("usage-hint-amount: server remaining preferred over computed", async () => {
    // Server sends remaining=5900 directly; popup should use it.
    const usage: Usage = {
      used: 11100,
      cap: 17000,
      remaining: 5900,
      realtimeAllowed: true,
    };
    const s = makeState({ signedInUser: { email: "u@e.com", tier: "max" }, usage });
    installChromeMock(s);
    initPopup();
    await flush();

    const amountEl = document.getElementById("usage-hint-amount");
    expect(amountEl!.textContent).toContain("5,900");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// §2 — capsForUsage: server snapshot overrides offline caps (unified shape)
// Pure unit tests — no DOM required.
// ────────────────────────────────────────────────────────────────────────────

describe("capsForUsage — unified pool, server snapshot overrides offline caps (A10)", () => {
  it("returns offline free caps when usage is null (cap=500, realtimeAllowed=false)", () => {
    expect(capsForUsage("free", null)).toEqual({ cap: 500, realtimeAllowed: false });
  });

  it("returns offline pro caps when usage is null (cap=6000, realtimeAllowed=false)", () => {
    expect(capsForUsage("pro", null)).toEqual({ cap: 6000, realtimeAllowed: false });
  });

  it("returns offline max caps when usage is null (cap=17000, realtimeAllowed=true)", () => {
    expect(capsForUsage("max", null)).toEqual({ cap: 17000, realtimeAllowed: true });
  });

  it("overrides cap with server cap when present", () => {
    const usage: Usage = { used: 0, cap: 15000, realtimeAllowed: false };
    const caps = capsForUsage("pro", usage);
    expect(caps.cap).toBe(15000);
    expect(caps.realtimeAllowed).toBe(false);
  });

  it("overrides realtimeAllowed with server value (true for max)", () => {
    const usage: Usage = { used: 0, cap: 17000, realtimeAllowed: true };
    const caps = capsForUsage("max", usage);
    expect(caps.realtimeAllowed).toBe(true);
  });

  it("falls back to offline cap when usage.cap is undefined", () => {
    const usage: Usage = { used: 0 };
    const caps = capsForUsage("pro", usage);
    expect(caps.cap).toBe(6000);
  });

  it("falls back to offline realtimeAllowed when usage.realtimeAllowed is undefined", () => {
    const usage: Usage = { used: 0, cap: 17000 };
    const caps = capsForUsage("max", usage);
    expect(caps.realtimeAllowed).toBe(true); // offline fallback for max
  });

  it("full max snapshot: both fields from server", () => {
    const usage: Usage = { used: 5000, cap: 17000, remaining: 12000, realtimeAllowed: true };
    const caps = capsForUsage("max", usage);
    expect(caps).toEqual({ cap: 17000, realtimeAllowed: true });
  });

  it("nullish tier falls back to free offline caps (cap=500)", () => {
    expect(capsForUsage(null, null)).toEqual({ cap: 500, realtimeAllowed: false });
    expect(capsForUsage(undefined, null)).toEqual({ cap: 500, realtimeAllowed: false });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// §3 — fmtCredits + label format with new caps (A10: 500/6000/17000)
// ────────────────────────────────────────────────────────────────────────────

import { fmtCredits } from "@/lib/popup-format";

describe("fmtCredits — thousands separators with new unified caps (A10)", () => {
  it("500 → '500'", () => { expect(fmtCredits(500)).toBe("500"); });
  it("6000 → '6,000'", () => { expect(fmtCredits(6000)).toBe("6,000"); });
  it("17000 → '17,000'", () => { expect(fmtCredits(17000)).toBe("17,000"); });
  it("4200 → '4,200'", () => { expect(fmtCredits(4200)).toBe("4,200"); });
  it("0 → '0'", () => { expect(fmtCredits(0)).toBe("0"); });

  it("meter label: '200 / 500 credits' (free plan)", () => {
    const label = `${fmtCredits(200)} / ${fmtCredits(500)} credits`;
    expect(label).toBe("200 / 500 credits");
    expect(label).not.toMatch(/min\b/i);
  });

  it("meter label: '4,000 / 6,000 credits' (pro plan)", () => {
    const label = `${fmtCredits(4000)} / ${fmtCredits(6000)} credits`;
    expect(label).toBe("4,000 / 6,000 credits");
  });

  it("meter label: '12,000 / 17,000 credits' (max plan)", () => {
    const label = `${fmtCredits(12000)} / ${fmtCredits(17000)} credits`;
    expect(label).toBe("12,000 / 17,000 credits");
  });

  it("rounds fractional values: 4200.7 → '4,201'", () => {
    expect(fmtCredits(4200.7)).toBe("4,201");
  });
  it("rounds fractional values: 999.4 → '999'", () => {
    expect(fmtCredits(999.4)).toBe("999");
  });
});
