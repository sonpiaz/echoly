// @vitest-environment jsdom
//
// Credit-metering display tests — CONTRACTS §D/§G.
//
// 1. Bug #1 REGRESSION — Realtime meter row (#um-rt) and usage-hint-row are
//    HIDDEN for free/pro plans EVEN IF the server snapshot sends realtimeCap>0.
//    Gate is on canUseRealtime(tier), not on the server cap value.
//
// 2. capsForUsage — server snapshot overrides offline fallback caps.
//
// 3. Meter label format — "X / Y credits" (CONTRACTS §G, no minutes).

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
// Keeps the same structure used by popup-advanced.test.ts.
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
      <div id="um-std">
        <span id="um-std-used">0</span>
        <span id="um-std-cap">0</span>
        <span id="um-std-fill"></span>
      </div>
      <div id="um-rt" hidden>
        <span id="um-rt-used">0</span>
        <span id="um-rt-cap">0</span>
        <span id="um-rt-fill"></span>
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
// §1 — Bug #1 REGRESSION: Realtime meter row gate
//
// The BUG: a free/pro user receives a server snapshot with realtimeCap > 0
// (e.g. a stale or misconfigured server response). The Realtime meter row
// (#um-rt) must remain HIDDEN — the gate is on canUseRealtime(user.tier), not
// on whatever cap the server sent.
// ────────────────────────────────────────────────────────────────────────────

describe("Bug #1 regression — Realtime meter row gate (CONTRACTS §G)", () => {
  beforeEach(() => {
    document.documentElement.innerHTML = FIXTURE_HTML;
    document.body.dataset.state = "idle";
    document.body.dataset.account = "loading";
  });
  afterEach(() => {
    document.documentElement.innerHTML = "";
  });

  // ── canUseRealtime SoT ──────────────────────────────────────────────────

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

  // ── Render gate: free user + non-zero server-sent realtimeCap ───────────

  it("free user: #um-rt stays HIDDEN even when server sends realtimeCap=6000 (the bug)", async () => {
    // This simulates a server that incorrectly echoes a non-zero realtime cap
    // for a free user — the popup MUST ignore it and keep the row hidden.
    const realtimeCapFromServer = 6000; // non-zero — the buggy server value
    const usage: Usage = {
      standard: 200,
      realtime: 0,
      standardCap: 1000,
      realtimeCap: realtimeCapFromServer,  // server sends non-zero — BUG trigger
      standardRemaining: 800,
      realtimeRemaining: 0,
      resetsAt: "2026-07-01T00:00:00.000Z",
    };
    const s = makeState({ signedInUser: { email: "u@e.com", tier: "free" }, usage });
    installChromeMock(s);
    initPopup();
    await flush();

    const umRtBlock = document.getElementById("um-rt");
    expect(umRtBlock).not.toBeNull();
    // MUST be hidden — free user must not see Realtime meter regardless of cap
    expect(umRtBlock!.hidden).toBe(true);
  });

  it("pro user: #um-rt stays HIDDEN even when server sends realtimeCap=6000", async () => {
    const usage: Usage = {
      standard: 5000,
      realtime: 0,
      standardCap: 10000,
      realtimeCap: 6000,  // non-zero — the buggy server value
      standardRemaining: 5000,
      realtimeRemaining: 0,
      resetsAt: "2026-07-01T00:00:00.000Z",
    };
    const s = makeState({ signedInUser: { email: "u@e.com", tier: "pro" }, usage });
    installChromeMock(s);
    initPopup();
    await flush();

    const umRtBlock = document.getElementById("um-rt");
    expect(umRtBlock).not.toBeNull();
    expect(umRtBlock!.hidden).toBe(true);
  });

  it("max user: #um-rt is SHOWN when server sends realtimeCap=6000", async () => {
    const usage: Usage = {
      standard: 10000,
      realtime: 150,
      standardCap: 28000,
      realtimeCap: 6000,
      standardRemaining: 18000,
      realtimeRemaining: 5850,
      resetsAt: "2026-07-01T00:00:00.000Z",
    };
    const s = makeState({ signedInUser: { email: "u@e.com", tier: "max" }, usage });
    installChromeMock(s);
    initPopup();
    await flush();

    const umRtBlock = document.getElementById("um-rt");
    expect(umRtBlock).not.toBeNull();
    expect(umRtBlock!.hidden).toBe(false);
  });

  it("max user: #um-rt is HIDDEN when realtimeCap=0 (server correctly zeroed it)", async () => {
    // Even Max plan: if server sends cap=0, the row should not show (no credits).
    const usage: Usage = {
      standard: 100,
      realtime: 0,
      standardCap: 28000,
      realtimeCap: 0,
      standardRemaining: 27900,
      realtimeRemaining: 0,
    };
    const s = makeState({ signedInUser: { email: "u@e.com", tier: "max" }, usage });
    installChromeMock(s);
    initPopup();
    await flush();

    const umRtBlock = document.getElementById("um-rt");
    expect(umRtBlock).not.toBeNull();
    // canUseRealtime("max") = true BUT caps.rt = 0 → showRt = false
    expect(umRtBlock!.hidden).toBe(true);
  });

  // ── Usage hint text — credits label, no minutes ──────────────────────────

  it("usage-hint-amount shows credit count with 'credits' suffix (CONTRACTS §G)", async () => {
    const usage: Usage = {
      standard: 2000,
      realtime: 0,
      standardCap: 10000,
      realtimeCap: 0,
      standardRemaining: 8000,
      realtimeRemaining: 0,
    };
    const s = makeState({ signedInUser: { email: "u@e.com", tier: "pro" }, usage });
    installChromeMock(s);
    initPopup();
    await flush();

    const amountEl = document.getElementById("usage-hint-amount");
    expect(amountEl).not.toBeNull();
    // Must say "credits" — never "min"
    expect(amountEl!.textContent).toMatch(/credits/i);
    expect(amountEl!.textContent).not.toMatch(/min\b/i);
  });

  it("usage-hint-amount for max user in realtime shows realtime remaining", async () => {
    const usage: Usage = {
      standard: 10000,
      realtime: 100,
      standardCap: 28000,
      realtimeCap: 6000,
      standardRemaining: 18000,
      realtimeRemaining: 5900,
    };
    const s = makeState({ signedInUser: { email: "u@e.com", tier: "max" }, usage });
    installChromeMock(s);
    initPopup();
    await flush();

    const amountEl = document.getElementById("usage-hint-amount");
    expect(amountEl).not.toBeNull();
    expect(amountEl!.textContent).toContain("5,900");
    expect(amountEl!.textContent).toMatch(/credits/i);
  });

  // ── Standard meter label format — "X / Y credits" ────────────────────────

  it("standard meter cap label renders '28,000 credits' for max plan", async () => {
    const usage: Usage = {
      standard: 4200,
      realtime: 0,
      standardCap: 28000,
      realtimeCap: 6000,
      standardRemaining: 23800,
      realtimeRemaining: 6000,
    };
    const s = makeState({ signedInUser: { email: "u@e.com", tier: "max" }, usage });
    installChromeMock(s);
    initPopup();
    await flush();

    const umStdUsed = document.getElementById("um-std-used");
    const umStdCap = document.getElementById("um-std-cap");
    expect(umStdUsed).not.toBeNull();
    expect(umStdCap).not.toBeNull();
    expect(umStdUsed!.textContent).toBe("4,200");
    // Cap label: "28,000 credits"
    expect(umStdCap!.textContent).toBe("28,000 credits");
  });

  it("realtime meter cap label renders '6,000 credits' for max plan", async () => {
    const usage: Usage = {
      standard: 0,
      realtime: 150,
      standardCap: 28000,
      realtimeCap: 6000,
      standardRemaining: 28000,
      realtimeRemaining: 5850,
    };
    const s = makeState({ signedInUser: { email: "u@e.com", tier: "max" }, usage });
    installChromeMock(s);
    initPopup();
    await flush();

    const umRtUsed = document.getElementById("um-rt-used");
    const umRtCap = document.getElementById("um-rt-cap");
    expect(umRtUsed).not.toBeNull();
    expect(umRtCap).not.toBeNull();
    expect(umRtUsed!.textContent).toBe("150");
    expect(umRtCap!.textContent).toBe("6,000 credits");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// §2 — capsForUsage: server snapshot overrides offline caps (CONTRACTS §G)
// Pure unit tests — no DOM required.
// ────────────────────────────────────────────────────────────────────────────

describe("capsForUsage — server snapshot overrides offline caps", () => {
  it("returns offline free caps when usage is null", () => {
    expect(capsForUsage("free", null)).toEqual({ std: 1000, rt: 0 });
  });

  it("returns offline pro caps when usage is null", () => {
    expect(capsForUsage("pro", null)).toEqual({ std: 10000, rt: 0 });
  });

  it("returns offline max caps when usage is null", () => {
    expect(capsForUsage("max", null)).toEqual({ std: 28000, rt: 6000 });
  });

  it("overrides std with server standardCap when present", () => {
    const usage: Usage = {
      standard: 0,
      realtime: 0,
      standardCap: 15000, // custom server value (e.g. bonus credits)
    };
    const caps = capsForUsage("pro", usage);
    expect(caps.std).toBe(15000);
    // rt falls back to offline (0 for pro)
    expect(caps.rt).toBe(0);
  });

  it("overrides rt with server realtimeCap when present", () => {
    const usage: Usage = {
      standard: 0,
      realtime: 0,
      realtimeCap: 6000,
    };
    const caps = capsForUsage("max", usage);
    expect(caps.rt).toBe(6000);
  });

  it("falls back to offline when standardCap is undefined in usage", () => {
    const usage: Usage = { standard: 0, realtime: 0 /* no standardCap */ };
    const caps = capsForUsage("pro", usage);
    expect(caps.std).toBe(10000); // offline fallback
  });

  it("server realtime cap=0 overrides offline max rt cap", () => {
    // Server sends 0 for non-max plan that somehow has max tier offline
    const usage: Usage = { standard: 0, realtime: 0, realtimeCap: 0 };
    const caps = capsForUsage("max", usage);
    // Server snapshot explicitly says 0 → capsForUsage trusts server (??=0 is falsy)
    // Usage: usage.realtimeCap ?? fallback.rt → 0 ?? 6000 = 0 (0 is not undefined)
    expect(caps.rt).toBe(0);
  });

  it("full max snapshot: both caps from server", () => {
    const usage: Usage = {
      standard: 5000,
      realtime: 100,
      standardCap: 28000,
      realtimeCap: 6000,
    };
    const caps = capsForUsage("max", usage);
    expect(caps).toEqual({ std: 28000, rt: 6000 });
  });

  it("nullish tier falls back to free offline caps", () => {
    expect(capsForUsage(null, null)).toEqual({ std: 1000, rt: 0 });
    expect(capsForUsage(undefined, null)).toEqual({ std: 1000, rt: 0 });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// §3 — fmtCredits + "X / Y credits" label format (CONTRACTS §G)
// These are already tested in popup-format.test.ts; extend with edge cases.
// ────────────────────────────────────────────────────────────────────────────

import { fmtCredits } from "@/lib/popup-format";

describe("fmtCredits — thousands separators, integer rounding (CONTRACTS §G)", () => {
  it("4200 → '4,200'", () => {
    expect(fmtCredits(4200)).toBe("4,200");
  });
  it("28000 → '28,000'", () => {
    expect(fmtCredits(28000)).toBe("28,000");
  });
  it("6000 → '6,000'", () => {
    expect(fmtCredits(6000)).toBe("6,000");
  });
  it("1000 → '1,000'", () => {
    expect(fmtCredits(1000)).toBe("1,000");
  });
  it("10000 → '10,000'", () => {
    expect(fmtCredits(10000)).toBe("10,000");
  });
  it("rounds fractional values: 4200.7 → '4,201'", () => {
    expect(fmtCredits(4200.7)).toBe("4,201");
  });
  it("rounds fractional values: 999.4 → '999'", () => {
    expect(fmtCredits(999.4)).toBe("999");
  });
  it("0 → '0'", () => {
    expect(fmtCredits(0)).toBe("0");
  });

  it("meter label format: 'X / Y credits' shape (no minutes)", () => {
    // Validates the format the popup builds: `${fmtCredits(used)}` + `${fmtCredits(cap)} credits`
    const used = fmtCredits(4200);
    const cap = fmtCredits(10000);
    const label = `${used} / ${cap} credits`;
    expect(label).toBe("4,200 / 10,000 credits");
    expect(label).not.toMatch(/min\b/i);
  });

  it("meter label format for max plan standard: '0 / 28,000 credits'", () => {
    const label = `${fmtCredits(0)} / ${fmtCredits(28000)} credits`;
    expect(label).toBe("0 / 28,000 credits");
  });

  it("meter label format for max plan realtime: '150 / 6,000 credits'", () => {
    const label = `${fmtCredits(150)} / ${fmtCredits(6000)} credits`;
    expect(label).toBe("150 / 6,000 credits");
  });
});
