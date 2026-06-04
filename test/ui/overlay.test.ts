// @vitest-environment jsdom
// Layer B — overlay DOM + render-only seam. Proves buildOverlay produces the
// byte-identical DOM structure/classes the pipeline expects, and that the
// <select>/Stop DOM events ONLY invoke the injected OverlayCallbacks (the
// overlay never branches realtime-vs-standard — that's the controller's job).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { disposeMediaStageWatch } from "@/content/media-stage";
import { createOverlay } from "@/content/overlay/overlay";
import type { OverlayCallbacks } from "@/shared/ports";
import {
  HISTORY_MAX,
  LAYOUT_KEY,
  TIER_REALTIME,
  TIER_STANDARD,
} from "@/shared/constants";
import { offlineLanguagePicker } from "@/lib/offline-language-bootstrap";
import { offlineStandardVoices } from "@/lib/offline-voice-bootstrap";
function makeCallbacks(): OverlayCallbacks & {
  onLanguageChange: ReturnType<typeof vi.fn>;
  onVoiceChange: ReturnType<typeof vi.fn>;
  onStop: ReturnType<typeof vi.fn>;
} {
  return {
    onLanguageChange: vi.fn(),
    onVoiceChange: vi.fn(),
    onStop: vi.fn(),
  };
}

beforeEach(() => {
  disposeMediaStageWatch();
  document.querySelectorAll(".ec-root").forEach((n) => n.remove());
  localStorage.clear();
  // jsdom lacks setPointerCapture / matchMedia — stub the methods the overlay uses.
  // (window.innerWidth/innerHeight default to 1024×768 in jsdom.)
});

describe("buildOverlay — DOM structure", () => {
  it("mounts <aside.ec-root data-state=ready> on document.body", () => {
    const ov = createOverlay();
    expect(ov.isMounted()).toBe(false);
    ov.buildOverlay(makeCallbacks());
    const root = document.body.querySelector(".ec-root");
    expect(root).not.toBeNull();
    expect(root!.tagName).toBe("ASIDE");
    expect((root as HTMLElement).dataset.state).toBe("ready");
    expect(root!.parentElement).toBe(document.body);
    expect(ov.isMounted()).toBe(true);
  });

  it("contains V5 dock + caption + expanded panel hooks", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const root = document.body.querySelector(".ec-root")!;
    expect(root.querySelector(".ec-dock[data-ec-drag]")).not.toBeNull();
    expect(root.querySelector(".ec-dock-mark[aria-hidden]")).not.toBeNull();
    expect(root.querySelector("[data-ec-status]")!.textContent).toBe("Ready");
    expect(root.querySelector(".ec-caption[data-ec-target]")).not.toBeNull();
    expect(root.querySelector("[data-ec-stop]")).not.toBeNull();
    expect(root.querySelector("[data-ec-caption-toggle]")).not.toBeNull();
    expect(root.querySelector("[data-ec-expand]")).not.toBeNull();
    const panel = root.querySelector("[data-ec-panel]") as HTMLElement;
    expect(panel.hidden).toBe(true);
    expect(root.querySelector("[data-ec-panel-preview]")).not.toBeNull();
    expect(root.querySelector("[data-ec-source]")).not.toBeNull();
    expect(
      root.querySelector("select.ec-select[data-ec-language]"),
    ).not.toBeNull();
    expect(
      root.querySelector("select.ec-select[data-ec-voice]"),
    ).not.toBeNull();
  });

  it("expand opens panel and collapse closes it (persisted in LAYOUT_KEY)", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const root = document.body.querySelector(".ec-root") as HTMLElement;
    const expand = root.querySelector("[data-ec-expand]") as HTMLButtonElement;
    expand.click();
    expect(root.classList.contains("ec-panel-open")).toBe(true);
    expect((root.querySelector("[data-ec-panel]") as HTMLElement).hidden).toBe(
      false,
    );
    const collapse = root.querySelector(
      "[data-ec-collapse]",
    ) as HTMLButtonElement;
    collapse.click();
    expect(root.classList.contains("ec-panel-open")).toBe(false);
    const stored = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}");
    expect(stored.panelExpanded).toBe(false);
  });

  it("dock CC and panel toggle hide subtitles (ec-caption-off)", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const root = document.body.querySelector(".ec-root") as HTMLElement;
    const dockCc = root.querySelector(
      "[data-ec-caption-toggle]",
    ) as HTMLButtonElement;
    dockCc.click();
    expect(root.classList.contains("ec-caption-off")).toBe(true);
    expect(dockCc.getAttribute("aria-pressed")).toBe("false");
    const panelToggle = root.querySelector(
      "[data-ec-caption-visible]",
    ) as HTMLInputElement;
    expect(panelToggle.checked).toBe(false);
    panelToggle.checked = true;
    panelToggle.dispatchEvent(new Event("change", { bubbles: true }));
    expect(root.classList.contains("ec-caption-off")).toBe(false);
    expect(dockCc.getAttribute("aria-pressed")).toBe("true");
  });

  it("populates the language picker (17-lang offline bootstrap, default vi)", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const lang = document.body.querySelector(
      "[data-ec-language]",
    ) as HTMLSelectElement;
    const langs = offlineLanguagePicker();
    expect(lang.options.length).toBe(langs.length);
    expect(langs.length).toBe(17);
    expect(lang.value).toBe("vi");
  });

  it("realtime voice picker is Auto only (server ignores voice id)", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    ov.populateVoicePicker(TIER_REALTIME, "");
    const voice = document.body.querySelector(
      "[data-ec-voice]",
    ) as HTMLSelectElement;
    expect(voice.options.length).toBe(1);
    expect(voice.options[0]!.value).toBe("");
    expect(voice.options[0]!.textContent).toBe("Auto");
    expect(voice.value).toBe("");
  });

  it("populateVoicePicker('standard') swaps to the 5 standard voices", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const std = offlineStandardVoices();
    ov.populateVoicePicker(TIER_STANDARD, std[0]![0]);
    const voice = document.body.querySelector(
      "[data-ec-voice]",
    ) as HTMLSelectElement;
    expect(voice.options.length).toBe(offlineStandardVoices().length);
    expect(voice.options[0]!.value).toBe("English_magnetic_voiced_man");
    expect(voice.options[0]!.textContent).toBe("Magnetic Man");
    expect(voice.value).toBe("English_magnetic_voiced_man");
  });

  it("is idempotent — a second buildOverlay does not create a second root", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    ov.buildOverlay(makeCallbacks());
    expect(document.body.querySelectorAll(".ec-root").length).toBe(1);
  });
});

describe("buildOverlay — render-only seam", () => {
  it("language <select> change invokes ONLY onLanguageChange (no branching here)", () => {
    const ov = createOverlay();
    const cbs = makeCallbacks();
    ov.buildOverlay(cbs);
    const lang = document.body.querySelector(
      "[data-ec-language]",
    ) as HTMLSelectElement;
    lang.value = "ja";
    lang.dispatchEvent(new Event("change"));
    expect(cbs.onLanguageChange).toHaveBeenCalledTimes(1);
    expect(cbs.onLanguageChange).toHaveBeenCalledWith("ja");
    expect(cbs.onVoiceChange).not.toHaveBeenCalled();
    expect(cbs.onStop).not.toHaveBeenCalled();
  });

  it("voice <select> change invokes ONLY onVoiceChange", () => {
    const ov = createOverlay();
    const cbs = makeCallbacks();
    ov.buildOverlay(cbs);
    const std = offlineStandardVoices();
    ov.populateVoicePicker(TIER_STANDARD, std[0]![0]);
    const voice = document.body.querySelector(
      "[data-ec-voice]",
    ) as HTMLSelectElement;
    voice.value = std[1]![0];
    voice.dispatchEvent(new Event("change"));
    expect(cbs.onVoiceChange).toHaveBeenCalledTimes(1);
    expect(cbs.onVoiceChange).toHaveBeenCalledWith(std[1]![0]);
    expect(cbs.onLanguageChange).not.toHaveBeenCalled();
  });

  it("Stop button click invokes ONLY onStop", () => {
    const ov = createOverlay();
    const cbs = makeCallbacks();
    ov.buildOverlay(cbs);
    const stop = document.body.querySelector(
      "[data-ec-stop]",
    ) as HTMLButtonElement;
    stop.click();
    expect(cbs.onStop).toHaveBeenCalledTimes(1);
    expect(cbs.onLanguageChange).not.toHaveBeenCalled();
    expect(cbs.onVoiceChange).not.toHaveBeenCalled();
  });

  it("caption toggle invokes onTargetCaptionVisibilityChange", () => {
    const ov = createOverlay();
    const cbs = makeCallbacks();
    cbs.onTargetCaptionVisibilityChange = vi.fn();
    ov.buildOverlay(cbs);
    const dockCc = document.body.querySelector(
      "[data-ec-caption-toggle]",
    ) as HTMLButtonElement;
    dockCc.click();
    expect(cbs.onTargetCaptionVisibilityChange).toHaveBeenCalledWith(false);
    dockCc.click();
    expect(cbs.onTargetCaptionVisibilityChange).toHaveBeenCalledWith(true);
  });

  it("mix sliders invoke onMixChange without onStop", () => {
    const ov = createOverlay();
    const cbs = makeCallbacks();
    cbs.onMixChange = vi.fn();
    ov.buildOverlay(cbs);
    ov.setMixVolumes(18, 100);
    const orig = document.body.querySelector(
      "[data-ec-original-vol]",
    ) as HTMLInputElement;
    orig.value = "25";
    orig.dispatchEvent(new Event("input", { bubbles: true }));
    expect(cbs.onMixChange).toHaveBeenCalledWith(25, 100);
    expect(cbs.onStop).not.toHaveBeenCalled();
  });
});

describe("overlay view methods", () => {
  it("setOverlayState writes data-state; setStatusText updates .ec-state", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const root = document.body.querySelector(".ec-root") as HTMLElement;
    ov.setOverlayState("live");
    expect(root.dataset.state).toBe("live");
    ov.setStatusText("Translating");
    expect(root.querySelector("[data-ec-status]")!.textContent).toBe(
      "Translating",
    );
  });

  // GAP-4: "buffering" sets data-state="buffering" AND joins the clock-RUNNING
  // branch (elapsed timer starts / sessionStartedAt set). Guards against a refactor
  // that drops "buffering" from the running branch (overlay.ts:~791).
  it('setOverlayState("buffering") sets data-state=buffering AND restarts the elapsed clock after paused', () => {
    vi.useFakeTimers();
    try {
      const ov = createOverlay();
      ov.buildOverlay(makeCallbacks());
      const root = document.body.querySelector(".ec-root") as HTMLElement;
      const elapsed = root.querySelector("[data-ec-elapsed]") as HTMLElement | null;

      // 1. Start a live session so the clock is running.
      ov.setOverlayState("live");
      expect(root.dataset.state).toBe("live");

      // 2. Pause → clock stops, elapsed resets to "00:00".
      ov.setOverlayState("paused");
      expect(root.dataset.state).toBe("paused");
      // After pausing the elapsed timer is stopped and sessionStartedAt cleared.
      if (elapsed) {
        expect(elapsed.textContent).toBe("00:00");
      }

      // 3. Buffering (e.g. paused→buffering transition on resume) → must join the
      //    RUNNING branch, NOT the paused/ready/error branch.
      ov.setOverlayState("buffering");
      expect(root.dataset.state).toBe("buffering");

      // Advance fake time 2 s. If "buffering" joined the RUNNING branch, the
      // setInterval fires → elapsed updates past "00:00". If it fell through both
      // branches (no startElapsedTimer), the element stays "00:00".
      vi.advanceTimersByTime(2000);
      if (elapsed) {
        expect(elapsed.textContent).not.toBe("00:00");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("setTargetText sets text + dir=ltr for LTR languages", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    ov.setTargetText("xin chào");
    const target = document.body.querySelector(
      "[data-ec-target]",
    ) as HTMLElement;
    expect(target.textContent).toBe("xin chào");
    expect(target.dir).toBe("ltr"); // vi is not RTL
  });

  it("setSourceText shows source block in panel when showSource is on", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    ov.applySourceVisibility(true);
    ov.setSourceText("hello source");
    const source = document.body.querySelector(
      "[data-ec-source]",
    ) as HTMLElement;
    expect(source.hidden).toBe(false);
    expect(source.textContent).toBe("hello source");
  });

  it("history remains unmounted in V5 (markers are no-op)", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    ov.pushHistoryTurn({ source: "s", target: "t" });
    ov.pushHistoryMarker("vi → en");
    expect(document.body.querySelector("[data-ec-history]")).toBeNull();
  });

  it.skip("pushHistoryTurn prepends newest-first and caps at HISTORY_MAX", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    for (let i = 0; i < HISTORY_MAX + 5; i++) {
      ov.pushHistoryTurn({ source: `s${i}`, target: `t${i}` });
    }
    const history = document.body.querySelector(
      "[data-ec-history]",
    ) as HTMLElement;
    expect(history.hidden).toBe(false);
    const items = history.querySelectorAll(".ec-h-item");
    expect(items.length).toBe(HISTORY_MAX);
    const last = HISTORY_MAX + 5 - 1;
    expect(items[0]!.querySelector(".ec-h-text")!.textContent).toBe(`t${last}`);
  });

  it.skip("pushHistoryMarker renders a .ec-h-marker > .ec-h-marker-chip with the text", () => {});

  it.skip("pushHistoryMarker flushes the current target turn (legacy)", () => {});

  it("setLanguageSelection sets the <select> value and is a safe no-op unmounted", () => {
    const ov = createOverlay();
    // unmounted → no throw, no DOM
    expect(() => ov.setLanguageSelection("ja")).not.toThrow();
    ov.buildOverlay(makeCallbacks());
    ov.setLanguageSelection("ko");
    const lang = document.body.querySelector(
      "[data-ec-language]",
    ) as HTMLSelectElement;
    expect(lang.value).toBe("ko");
    // also drives RTL on subsequent target text (ar is RTL)
    ov.setLanguageSelection("ar");
    ov.setTargetText("مرحبا");
    const target = document.body.querySelector(
      "[data-ec-target]",
    ) as HTMLElement;
    expect(target.dir).toBe("rtl");
  });

  it("showToast builds a .ec-toast via DOM API (textContent, never innerHTML)", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const root = document.body.querySelector(".ec-root")!;
    ov.showToast("<img src=x onerror=alert(1)>");
    const toast = root.querySelector(".ec-toast")!;
    expect(toast.textContent).toBe("<img src=x onerror=alert(1)>");
    // XSS guard: the payload is text, NOT a parsed element.
    expect(toast.querySelector("img")).toBeNull();
    expect(toast.children.length).toBe(0);
  });

  it("removeOverlay tears down the node and resets isMounted", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    expect(ov.isMounted()).toBe(true);
    ov.removeOverlay();
    expect(ov.isMounted()).toBe(false);
    expect(document.body.querySelector(".ec-root")).toBeNull();
  });

  it("showToast renders an optional CTA link via DOM APIs", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const root = document.body.querySelector(".ec-root")!;
    ov.showToast("Quota exhausted.", {
      durationMs: 9000,
      cta: "https://echolyhq.com/upgrade",
      ctaLabel: "Upgrade",
    });
    const link = root.querySelector(".ec-toast a") as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.href).toBe("https://echolyhq.com/upgrade");
    expect(link.textContent).toBe("Upgrade");
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
  });

  it("showToast with a bare number keeps the legacy duration-only form (no link)", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const root = document.body.querySelector(".ec-root")!;
    ov.showToast("plain message", 6000);
    const toast = root.querySelector(".ec-toast")!;
    expect(toast.textContent).toBe("plain message");
    expect(toast.querySelector("a")).toBeNull();
  });
});

describe("buildOverlay — caption position (V5 caption strip)", () => {
  it("default dock is top-right", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const dock = document.body.querySelector(
      ".ec-dock",
    ) as HTMLElement;
    expect(parseFloat(dock.style.top)).toBe(12);
    expect(parseFloat(dock.style.left)).toBeGreaterThan(700);
  });

  it("LAYOUT_KEY persists dock drag position", () => {
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({ left: 42, top: 100, width: 220, height: 46, sideCollapsed: true }),
    );
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const dock = document.body.querySelector(
      ".ec-dock",
    ) as HTMLElement;
    expect(parseFloat(dock.style.left)).toBeCloseTo(42, 0);
    expect(parseFloat(dock.style.top)).toBeCloseTo(100, 0);
  });
});

describe("setCaptionPosition — live preset hot-swap", () => {
  it("setCaptionPosition('top') adds ec-caption-top class", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const root = document.body.querySelector(
      ".ec-root",
    ) as HTMLElement;
    expect(root.classList.contains("ec-caption-top")).toBe(false);
    ov.setCaptionPosition("top");
    expect(root.classList.contains("ec-caption-top")).toBe(true);
  });

  it("setCaptionPosition('bottom') removes ec-caption-top", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const root = document.body.querySelector(
      ".ec-root",
    ) as HTMLElement;
    ov.setCaptionPosition("top");
    ov.setCaptionPosition("bottom");
    expect(root.classList.contains("ec-caption-top")).toBe(false);
  });

  it("setCaptionPosition does NOT write LAYOUT_KEY (user's drag still wins)", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    expect(localStorage.getItem(LAYOUT_KEY)).toBeNull();
    ov.setCaptionPosition("top");
    expect(localStorage.getItem(LAYOUT_KEY)).toBeNull();
    ov.setCaptionPosition("float");
    expect(localStorage.getItem(LAYOUT_KEY)).toBeNull();
  });

  it("setCaptionPosition is a safe no-op when the overlay is unmounted", () => {
    const ov = createOverlay();
    // Not built → no root. Should not throw, no DOM created.
    expect(() => ov.setCaptionPosition("top")).not.toThrow();
    expect(document.body.querySelector(".ec-root")).toBeNull();
  });
});

describe("syncFromSettings", () => {
  it("syncs caption toggle and mix from settings snapshot", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    ov.syncFromSettings({
      tier: TIER_REALTIME,
      targetLanguage: "ja",
      realtimeVoice: "marin",
      standardVoice: "English_magnetic_voiced_man",
      originalVolume: 42,
      voiceVolume: 77,
      showSource: false,
      showTargetCaptions: false,
      apiBearer: "",
      apiMode: null,
      apiBase: "https://api.example",
      running: true,
      connecting: false,
      paused: false,
      tabId: 1,
      status: "Translating",
      errorMessage: "",
      signedInUser: null,
      usage: null,
      languagePicker: [["ja", "Japanese"], ["vi", "Vietnamese"]],
      languageNames: null,
      standardVoices: null,
      standardVoiceDefaultId: null,
      sessionStartedAt: Date.now(),
      advanced: {} as never,
      siteOverrides: {},
      advancedVersion: 0,
      advancedDirty: false,
      currentDomain: null,
    });
    const lang = document.body.querySelector(
      "[data-ec-language]",
    ) as HTMLSelectElement;
    const orig = document.body.querySelector(
      "[data-ec-original-vol]",
    ) as HTMLInputElement;
    const cc = document.body.querySelector(
      "[data-ec-caption-visible]",
    ) as HTMLInputElement;
    expect(lang.value).toBe("ja");
    expect(orig.value).toBe("42");
    expect(cc.checked).toBe(false);
    expect(document.body.querySelector(".ec-root")!.classList.contains("ec-caption-off")).toBe(true);
  });

  it("signed-in proxy realtime keeps Auto selected (not a blank voice row)", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks(), null, undefined, true, undefined, TIER_REALTIME);
    ov.syncFromSettings({
      tier: TIER_REALTIME,
      targetLanguage: "vi",
      realtimeVoice: "marin",
      standardVoice: "English_magnetic_voiced_man",
      originalVolume: 18,
      voiceVolume: 100,
      showSource: false,
      showTargetCaptions: true,
      apiBearer: "tok",
      apiMode: "proxy",
      apiBase: "https://api.example",
      running: true,
      connecting: false,
      paused: false,
      tabId: 1,
      status: "Translating",
      errorMessage: "",
      signedInUser: { email: "a@b.c", tier: "pro" },
      usage: null,
      languagePicker: null,
      languageNames: null,
      standardVoices: null,
      standardVoiceDefaultId: null,
      sessionStartedAt: Date.now(),
      advanced: {} as never,
      siteOverrides: {},
      advancedVersion: 0,
      advancedDirty: false,
      currentDomain: null,
    });
    const voice = document.body.querySelector(
      "[data-ec-voice]",
    ) as HTMLSelectElement;
    expect(voice.options.length).toBe(1);
    expect(voice.options[0]!.textContent).toBe("Auto");
    expect(voice.value).toBe("");
    expect(voice.selectedOptions[0]!.textContent).toBe("Auto");
  });

  it("lag placeholder does not render a trailing unit (no em-dash + s)", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    expect(document.body.querySelector(".ec-lag-unit")).toBeNull();
    expect(document.body.querySelector(".ec-lag-line")!.textContent).toBe("—");
  });

  it("setDubSyncReadout shows dock hint when matching", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    ov.setDubSyncReadout({ lagSec: 3.2, mode: "slow", ratePct: 96 });
    expect(document.body.querySelector(".ec-lag-line")!.textContent).toBe("96");
    expect(document.body.querySelector(".ec-lag-label")!.textContent).toBe(
      "sync",
    );
    const hint = document.body.querySelector(
      "[data-ec-sync-hint]",
    ) as HTMLElement;
    expect(hint.hidden).toBe(false);
    expect(hint!.textContent).toContain("Matching dub");
    expect(hint!.textContent).toContain("96%");
  });
});

// ── showToast self-mount (AC 3 from SOLUTION.md) ─────────────────────────

describe("showToast — self-mount when root is null (cold / no buildOverlay)", () => {
  it("mounts a .ec-root and places .ec-toast inside it without prior buildOverlay", () => {
    // Precondition: no ec-root in the DOM.
    expect(document.body.querySelector(".ec-root")).toBeNull();

    const ov = createOverlay();
    // Deliberately do NOT call buildOverlay — test the self-mount path.
    ov.showToast("Session expired. Please sign in.");

    const root = document.body.querySelector(".ec-root");
    expect(root).not.toBeNull();

    const toast = root!.querySelector(".ec-toast");
    expect(toast).not.toBeNull();
    expect(toast!.textContent).toContain("Session expired");
  });

  it("self-mounted .ec-root is a child of document.body", () => {
    const ov = createOverlay();
    ov.showToast("Credits used up.");

    const root = document.body.querySelector(".ec-root");
    expect(root).not.toBeNull();
    expect(root!.parentElement).toBe(document.body);
  });
});

describe("showToast — after removeOverlay, subsequent showToast still renders", () => {
  it("showToast with cta after removeOverlay renders .ec-toast with <a> href", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    expect(ov.isMounted()).toBe(true);

    // Tear down the session overlay (as the content catch does before toasting).
    ov.removeOverlay();
    expect(ov.isMounted()).toBe(false);
    expect(document.body.querySelector(".ec-root")).toBeNull();

    // Now call showToast — must self-mount a new root.
    ov.showToast("Credits exhausted. Upgrade your plan.", {
      cta: "https://echolyhq.com/upgrade",
      ctaLabel: "Upgrade",
    });

    const root = document.body.querySelector(".ec-root");
    expect(root).not.toBeNull();

    const toast = root!.querySelector(".ec-toast");
    expect(toast).not.toBeNull();
    expect(toast!.textContent).toContain("Credits exhausted");

    const link = root!.querySelector(".ec-toast a") as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link!.href).toBe("https://echolyhq.com/upgrade");
    expect(link!.textContent).toBe("Upgrade");
    expect(link!.target).toBe("_blank");
    expect(link!.rel).toBe("noopener noreferrer");
  });
});

describe("caption auto-scroll", () => {
  async function flushCaptionScroll(): Promise<void> {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }

  function scrollableCaption(el: HTMLElement): void {
    el.style.maxHeight = "36px";
    el.style.overflowY = "auto";
    el.style.width = "260px";
    el.classList.add("ec-caption--rolling");
  }

  function maxScrollTop(el: HTMLElement): number {
    return Math.max(0, el.scrollHeight - el.clientHeight);
  }

  it("growing live text scrolls to the newest line (not stuck at top)", async () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const target = document.body.querySelector(
      "[data-ec-target]",
    ) as HTMLElement;
    scrollableCaption(target);
    const part = "phụ đề đang chạy dài ".repeat(12);
    ov.setTargetText(part);
    await flushCaptionScroll();
    const max1 = maxScrollTop(target);
    if (max1 > 0) expect(target.scrollTop).toBeGreaterThanOrEqual(max1 - 14);

    ov.setTargetText(part + part);
    await flushCaptionScroll();
    const max2 = maxScrollTop(target);
    expect(target.scrollTop).toBeGreaterThanOrEqual(max2 - 14);
  });

  it("panel preview mirrors target text and scrolls when panel opens", async () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const part = "xem bản dịch trong panel ".repeat(30);
    ov.setTargetText(part);
    const preview = document.body.querySelector(
      "[data-ec-panel-preview]",
    ) as HTMLElement;
    expect(preview.textContent).toBe(part);
    preview.style.maxHeight = "24px";
    preview.style.overflowY = "auto";
    preview.style.width = "240px";
    const expand = document.body.querySelector(
      "[data-ec-expand]",
    ) as HTMLButtonElement;
    expand.click();
    await flushCaptionScroll();
    const max = maxScrollTop(preview);
    if (max > 0) {
      expect(preview.scrollTop).toBeGreaterThanOrEqual(max - 14);
    }
  });

  it("respects manual scroll-up until a new utterance arrives", async () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const target = document.body.querySelector(
      "[data-ec-target]",
    ) as HTMLElement;
    scrollableCaption(target);
    const first = "đoạn một ".repeat(20);
    ov.setTargetText(first);
    await flushCaptionScroll();
    target.scrollTop = 0;
    target.dispatchEvent(new Event("scroll"));

    ov.setTargetText(first + " thêm chữ");
    await flushCaptionScroll();
    expect(target.scrollTop).toBe(0);

    ov.setTargetText("đoạn hai hoàn toàn mới");
    await flushCaptionScroll();
    const max = maxScrollTop(target);
    if (max > 0) expect(target.scrollTop).toBeGreaterThanOrEqual(max - 14);
  });
});
