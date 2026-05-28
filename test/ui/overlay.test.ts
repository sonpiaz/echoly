// @vitest-environment jsdom
// Layer B — overlay DOM + render-only seam. Proves buildOverlay produces the
// byte-identical DOM structure/classes the pipeline expects, and that the
// <select>/Stop DOM events ONLY invoke the injected OverlayCallbacks (the
// overlay never branches realtime-vs-standard — that's the controller's job).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOverlay } from "@/content/overlay/overlay";
import type { OverlayCallbacks } from "@/shared/ports";
import {
  HISTORY_MAX,
  LANGUAGES,
  LAYOUT_KEY,
  REALTIME_VOICES,
  STANDARD_VOICES,
} from "@/shared/constants";
import { CAPTION_PRESETS } from "@/shared/advanced";

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
  document.documentElement.querySelectorAll(".ec-root").forEach((n) =>
    n.remove(),
  );
  localStorage.clear();
  // jsdom lacks setPointerCapture / matchMedia — stub the methods the overlay uses.
  // (window.innerWidth/innerHeight default to 1024×768 in jsdom.)
});

describe("buildOverlay — DOM structure", () => {
  it("mounts <aside.ec-root data-state=ready> on document.documentElement", () => {
    const ov = createOverlay();
    expect(ov.isMounted()).toBe(false);
    ov.buildOverlay(makeCallbacks());
    const root = document.documentElement.querySelector(".ec-root");
    expect(root).not.toBeNull();
    expect(root!.tagName).toBe("ASIDE");
    expect((root as HTMLElement).dataset.state).toBe("ready");
    expect(root!.parentElement).toBe(document.documentElement);
    expect(ov.isMounted()).toBe(true);
  });

  it("contains all the load-bearing .ec-* nodes + data-ec-* hooks", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const root = document.documentElement.querySelector(".ec-root")!;
    // toolbar + brand cluster
    expect(root.querySelector(".ec-toolbar[data-ec-drag]")).not.toBeNull();
    expect(root.querySelector(".ec-brand")).not.toBeNull();
    expect(root.querySelector(".ec-mark[aria-hidden]")).not.toBeNull();
    expect(root.querySelector(".ec-mark svg path")).not.toBeNull();
    expect(root.querySelector(".ec-wordmark")!.textContent).toBe("Echoly");
    expect(root.querySelector("[data-ec-status]")!.textContent).toBe("Ready");
    expect(root.querySelector(".ec-spacer")).not.toBeNull();
    // controls
    expect(
      root.querySelector("select.ec-select[data-ec-language]"),
    ).not.toBeNull();
    expect(
      root.querySelector("select.ec-select[data-ec-voice]"),
    ).not.toBeNull();
    expect(root.querySelector("[data-ec-hide]")!.textContent).toBe("Hide");
    expect(
      root.querySelector("button.ec-btn-primary[data-ec-stop]")!.textContent,
    ).toBe("Stop");
    // body
    expect(root.querySelector(".ec-body .ec-main [data-ec-target]")).not.toBeNull();
    expect(root.querySelector(".ec-side[data-ec-side]")).not.toBeNull();
    const source = root.querySelector("[data-ec-source]") as HTMLElement;
    const history = root.querySelector("[data-ec-history]") as HTMLElement;
    expect(source.hidden).toBe(true);
    expect(history.hidden).toBe(true);
  });

  it("renders the 8 resize handles with exact data-ec-resize values", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const root = document.documentElement.querySelector(".ec-root")!;
    const values = Array.from(
      root.querySelectorAll<HTMLElement>("[data-ec-resize]"),
    ).map((h) => h.dataset.ecResize);
    expect(values).toEqual(["n", "e", "s", "w", "nw", "ne", "sw", "se"]);
    // edges vs corners class hooks
    expect(root.querySelector(".ec-resize-edge-n[data-ec-resize=n]")).not.toBeNull();
    expect(
      root.querySelector(".ec-resize-corner-se[data-ec-resize=se]"),
    ).not.toBeNull();
  });

  it("populates the language picker (13 LANGUAGES, default vi)", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const lang = document.documentElement.querySelector(
      "[data-ec-language]",
    ) as HTMLSelectElement;
    expect(lang.options.length).toBe(LANGUAGES.length);
    expect(lang.options[0]!.value).toBe("en");
    expect(lang.options[0]!.textContent).toBe("English");
    expect(lang.value).toBe("vi");
  });

  it("realtime voice picker shows 'Auto' (NOT 'Auto · clones speaker') + 9 voices", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const voice = document.documentElement.querySelector(
      "[data-ec-voice]",
    ) as HTMLSelectElement;
    expect(voice.options.length).toBe(REALTIME_VOICES.length + 1);
    expect(voice.options[0]!.value).toBe("");
    expect(voice.options[0]!.textContent).toBe("Auto"); // overlay form, not popup form
    expect(voice.options[1]!.value).toBe("marin");
    expect(voice.options[1]!.textContent).toBe("Marin");
    expect(voice.value).toBe("marin");
  });

  it("populateVoicePicker('standard') swaps to the 5 standard voices", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    ov.populateVoicePicker("standard", STANDARD_VOICES[0]![0]);
    const voice = document.documentElement.querySelector(
      "[data-ec-voice]",
    ) as HTMLSelectElement;
    expect(voice.options.length).toBe(STANDARD_VOICES.length);
    expect(voice.options[0]!.value).toBe("English_magnetic_voiced_man");
    expect(voice.options[0]!.textContent).toBe("Magnetic Man");
    expect(voice.value).toBe("English_magnetic_voiced_man");
  });

  it("is idempotent — a second buildOverlay does not create a second root", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    ov.buildOverlay(makeCallbacks());
    expect(document.documentElement.querySelectorAll(".ec-root").length).toBe(1);
  });
});

describe("buildOverlay — render-only seam", () => {
  it("language <select> change invokes ONLY onLanguageChange (no branching here)", () => {
    const ov = createOverlay();
    const cbs = makeCallbacks();
    ov.buildOverlay(cbs);
    const lang = document.documentElement.querySelector(
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
    const voice = document.documentElement.querySelector(
      "[data-ec-voice]",
    ) as HTMLSelectElement;
    voice.value = "coral";
    voice.dispatchEvent(new Event("change"));
    expect(cbs.onVoiceChange).toHaveBeenCalledTimes(1);
    expect(cbs.onVoiceChange).toHaveBeenCalledWith("coral");
    expect(cbs.onLanguageChange).not.toHaveBeenCalled();
  });

  it("Stop button click invokes ONLY onStop", () => {
    const ov = createOverlay();
    const cbs = makeCallbacks();
    ov.buildOverlay(cbs);
    const stop = document.documentElement.querySelector(
      "[data-ec-stop]",
    ) as HTMLButtonElement;
    stop.click();
    expect(cbs.onStop).toHaveBeenCalledTimes(1);
    expect(cbs.onLanguageChange).not.toHaveBeenCalled();
    expect(cbs.onVoiceChange).not.toHaveBeenCalled();
  });

  it("Hide toggle is pure UI — flips label + persists layout, no callbacks", () => {
    const ov = createOverlay();
    const cbs = makeCallbacks();
    ov.buildOverlay(cbs);
    const hide = document.documentElement.querySelector(
      "[data-ec-hide]",
    ) as HTMLButtonElement;
    const root = document.documentElement.querySelector(".ec-root")!;
    expect(hide.textContent).toBe("Hide");
    hide.click();
    expect(hide.textContent).toBe("Show");
    expect(root.classList.contains("is-side-collapsed")).toBe(true);
    expect(JSON.parse(localStorage.getItem(LAYOUT_KEY)!).sideCollapsed).toBe(
      true,
    );
    expect(cbs.onStop).not.toHaveBeenCalled();
  });
});

describe("overlay view methods", () => {
  it("setOverlayState writes data-state; setStatusText updates .ec-state", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const root = document.documentElement.querySelector(".ec-root") as HTMLElement;
    ov.setOverlayState("live");
    expect(root.dataset.state).toBe("live");
    ov.setStatusText("Translating");
    expect(root.querySelector("[data-ec-status]")!.textContent).toBe(
      "Translating",
    );
  });

  it("setTargetText sets text + dir=ltr for LTR languages", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    ov.setTargetText("xin chào");
    const target = document.documentElement.querySelector(
      "[data-ec-target]",
    ) as HTMLElement;
    expect(target.textContent).toBe("xin chào");
    expect(target.dir).toBe("ltr"); // vi is not RTL
  });

  it("applySourceVisibility + setSourceText (last 220 chars)", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const source = document.documentElement.querySelector(
      "[data-ec-source]",
    ) as HTMLElement;
    ov.applySourceVisibility(true);
    expect(source.hidden).toBe(false);
    const long = "a".repeat(300);
    ov.setSourceText(long);
    expect(source.textContent!.length).toBe(220);
    ov.applySourceVisibility(false);
    expect(source.hidden).toBe(true);
  });

  it("pushHistoryTurn prepends newest-first and caps at HISTORY_MAX", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    for (let i = 0; i < HISTORY_MAX + 5; i++) {
      ov.pushHistoryTurn({ source: `s${i}`, target: `t${i}` });
    }
    const history = document.documentElement.querySelector(
      "[data-ec-history]",
    ) as HTMLElement;
    expect(history.hidden).toBe(false);
    const items = history.querySelectorAll(".ec-h-item");
    expect(items.length).toBe(HISTORY_MAX);
    // newest-first: first DOM item is the last pushed
    const last = HISTORY_MAX + 5 - 1;
    expect(items[0]!.querySelector(".ec-h-text")!.textContent).toBe(`t${last}`);
  });

  it("pushHistoryMarker renders a .ec-h-marker > .ec-h-marker-chip with the text", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    ov.pushHistoryMarker("vi → en");
    const history = document.documentElement.querySelector(
      "[data-ec-history]",
    ) as HTMLElement;
    expect(history.hidden).toBe(false);
    const marker = history.querySelector(".ec-h-marker");
    expect(marker).not.toBeNull();
    const chip = marker!.querySelector(".ec-h-marker-chip");
    expect(chip).not.toBeNull();
    expect(chip!.textContent).toBe("vi → en");
  });

  it("pushHistoryMarker flushes the current target turn (legacy pushHistoryTurn({marker}))", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    // an in-progress turn is captured via setTargetText, then a swap marks it
    ov.setTargetText("dở dang");
    ov.pushHistoryMarker("Switching voice");
    const history = document.documentElement.querySelector(
      "[data-ec-history]",
    ) as HTMLElement;
    // one entry: marker chip + the flushed turn's text
    expect(history.querySelector(".ec-h-marker-chip")!.textContent).toBe(
      "Switching voice",
    );
    expect(history.querySelector(".ec-h-item .ec-h-text")!.textContent).toBe(
      "dở dang",
    );
    expect(history.querySelectorAll(".ec-h-item").length).toBe(1);
    // marker entries count toward HISTORY_MAX
    for (let i = 0; i < HISTORY_MAX; i++) ov.pushHistoryMarker(`m${i}`);
    expect(history.querySelectorAll(".ec-h-marker-chip").length).toBe(
      HISTORY_MAX,
    );
  });

  it("setLanguageSelection sets the <select> value and is a safe no-op unmounted", () => {
    const ov = createOverlay();
    // unmounted → no throw, no DOM
    expect(() => ov.setLanguageSelection("ja")).not.toThrow();
    ov.buildOverlay(makeCallbacks());
    ov.setLanguageSelection("ko");
    const lang = document.documentElement.querySelector(
      "[data-ec-language]",
    ) as HTMLSelectElement;
    expect(lang.value).toBe("ko");
    // also drives RTL on subsequent target text (ar is RTL)
    ov.setLanguageSelection("ar");
    ov.setTargetText("مرحبا");
    const target = document.documentElement.querySelector(
      "[data-ec-target]",
    ) as HTMLElement;
    expect(target.dir).toBe("rtl");
  });

  it("showToast builds a .ec-toast via DOM API (textContent, never innerHTML)", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const root = document.documentElement.querySelector(".ec-root")!;
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
    expect(document.documentElement.querySelector(".ec-root")).toBeNull();
  });

  it("showToast renders an optional CTA link via DOM APIs (the 'Top up' link)", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const root = document.documentElement.querySelector(".ec-root")!;
    ov.showToast("Out of Kyma balance.", {
      durationMs: 9000,
      cta: "https://kymaapi.com/billing",
      ctaLabel: "Top up",
    });
    const link = root.querySelector(".ec-toast a") as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.href).toBe("https://kymaapi.com/billing");
    expect(link.textContent).toBe("Top up");
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
  });

  it("showToast with a bare number keeps the legacy duration-only form (no link)", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const root = document.documentElement.querySelector(".ec-root")!;
    ov.showToast("plain message", 6000);
    const toast = root.querySelector(".ec-toast")!;
    expect(toast.textContent).toBe("plain message");
    expect(toast.querySelector("a")).toBeNull();
  });
});

// ─── Advanced — caption-position preset (Layout seed + live setter) ─────────

/** Resolve a preset's % string against jsdom's default viewport. */
function pct(value: string, axis: number): number {
  if (value.endsWith("%")) return (parseFloat(value) / 100) * axis;
  return parseFloat(value);
}

describe("buildOverlay — caption-position preset seeds Layout when LAYOUT_KEY empty", () => {
  it("seeds Layout.left/top from CAPTION_PRESETS.top when localStorage is empty", () => {
    // jsdom default viewport: 1024×768. Preset "top": left=50%, top=8%.
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks(), "top");
    const root = document.documentElement.querySelector(
      ".ec-root",
    ) as HTMLElement;
    // The seed is then run through clampLayout (defaults width 560, height 200),
    // which clamps to within the viewport but starts from the preset's pixels.
    // The "top" preset places the overlay near the top — top px = 8% × 768 ≈ 61.
    const topPx = parseFloat(root.style.top);
    expect(topPx).toBeLessThan(120); // well above the bottom default (~478)
    expect(topPx).toBeGreaterThan(0);
    // "top" preset has left=50% × 1024 ≈ 512, but clampLayout will keep it
    // visible. Just verify it isn't the bottom default (innerHeight - 200 - 96).
    const bottomDefault = 768 - 200 - 96; // 472
    expect(Math.abs(topPx - bottomDefault)).toBeGreaterThan(50);
  });

  it("seeds Layout.top from CAPTION_PRESETS.bottom (~78% of viewport)", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks(), "bottom");
    const root = document.documentElement.querySelector(
      ".ec-root",
    ) as HTMLElement;
    const expectedTop = pct(CAPTION_PRESETS.bottom.top, 768);
    const topPx = parseFloat(root.style.top);
    // clampLayout snaps so it isn't off-screen; allow generous tolerance.
    expect(topPx).toBeLessThanOrEqual(expectedTop + 50);
    expect(topPx).toBeGreaterThan(expectedTop - 200);
  });

  it("LAYOUT_KEY (user's drag) WINS over the captionPosition preset", () => {
    // Persist a custom layout — buildOverlay should not seed from the preset.
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({
        left: 42,
        top: 100,
        width: 600,
        height: 220,
        sideCollapsed: false,
      }),
    );
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks(), "top");
    const root = document.documentElement.querySelector(
      ".ec-root",
    ) as HTMLElement;
    // Persisted values flow through clampLayout (which won't shrink under 300×130).
    expect(parseFloat(root.style.left)).toBeCloseTo(42, 0);
    expect(parseFloat(root.style.top)).toBeCloseTo(100, 0);
    expect(parseFloat(root.style.width)).toBeCloseTo(600, 0);
    expect(parseFloat(root.style.height)).toBeCloseTo(220, 0);
  });

  it("no captionPosition arg → falls back to DEFAULT_LAYOUT (legacy behaviour)", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const root = document.documentElement.querySelector(
      ".ec-root",
    ) as HTMLElement;
    // clampLayout defaults: width=560, height=200, bottom-right with 24px margin.
    expect(parseFloat(root.style.width)).toBeCloseTo(560, 0);
    expect(parseFloat(root.style.height)).toBeCloseTo(200, 0);
  });
});

describe("setCaptionPosition — live preset hot-swap", () => {
  it("setCaptionPosition('top') updates root.style.top to the top preset (live)", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks()); // default-seeded (bottom)
    const root = document.documentElement.querySelector(
      ".ec-root",
    ) as HTMLElement;
    const beforeTop = parseFloat(root.style.top);
    ov.setCaptionPosition("top");
    const afterTop = parseFloat(root.style.top);
    expect(afterTop).not.toBeCloseTo(beforeTop, 0);
    // "top" preset: top=8% × 768 ≈ 61 (clamped to ≥12 from edges).
    expect(afterTop).toBeLessThan(120);
  });

  it("setCaptionPosition('float') updates root.style.left/top to the float preset", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const root = document.documentElement.querySelector(
      ".ec-root",
    ) as HTMLElement;
    ov.setCaptionPosition("float");
    // "float" preset: left=20% × 1024 ≈ 205, top=40% × 768 ≈ 307.
    const expectedLeft = pct(CAPTION_PRESETS.float.left, 1024);
    const expectedTop = pct(CAPTION_PRESETS.float.top, 768);
    expect(parseFloat(root.style.left)).toBeCloseTo(expectedLeft, 0);
    expect(parseFloat(root.style.top)).toBeCloseTo(expectedTop, 0);
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
    expect(document.documentElement.querySelector(".ec-root")).toBeNull();
  });
});
