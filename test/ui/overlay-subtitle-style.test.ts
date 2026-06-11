// @vitest-environment jsdom
// W6 — Overlay setSubtitleStyle CSS custom property mapping + ec-cap-flat toggle.
//   • Each CaptionFontSize maps to the correct --ec-caption-font-size px value.
//   • Each CaptionBgOpacity maps to the correct --ec-caption-bg-opacity value.
//   • Each CaptionFontWeight maps to the correct --ec-caption-font-weight value.
//   • transparent bgOpacity adds ec-cap-flat class; non-transparent removes it.
//   • No-op when root is not mounted (no throw).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOverlay } from "@/content/overlay/overlay";
import type { OverlayCallbacks } from "@/shared/ports";

function makeCallbacks(): OverlayCallbacks {
  return {
    onLanguageChange: vi.fn(),
    onVoiceChange: vi.fn(),
    onStop: vi.fn(),
  };
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.innerHTML = "";
});

describe("overlay.setSubtitleStyle — CSS custom property mapping", () => {
  it("sets --ec-caption-font-size to the correct px value for each size", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());

    const cases = [
      ["small", "12px"],
      ["medium", "15px"],
      ["large", "18px"],
      ["xlarge", "22px"],
    ] as const;

    for (const [size, expected] of cases) {
      ov.setSubtitleStyle({ fontSize: size, bgOpacity: "high", fontWeight: "semibold" });
      const root = document.body.querySelector(".ec-root") as HTMLElement;
      expect(root.style.getPropertyValue("--ec-caption-font-size")).toBe(expected);
    }
  });

  it("sets --ec-caption-bg-opacity to the correct value for each opacity", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());

    const cases = [
      ["transparent", "0"],
      ["low", ".35"],
      ["medium", ".60"],
      ["high", ".82"],
    ] as const;

    for (const [opacity, expected] of cases) {
      ov.setSubtitleStyle({ fontSize: "medium", bgOpacity: opacity, fontWeight: "semibold" });
      const root = document.body.querySelector(".ec-root") as HTMLElement;
      expect(root.style.getPropertyValue("--ec-caption-bg-opacity")).toBe(expected);
    }
  });

  it("sets --ec-caption-font-weight to the correct value for each weight", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());

    const cases = [
      ["normal", "400"],
      ["semibold", "600"],
      ["bold", "700"],
    ] as const;

    for (const [weight, expected] of cases) {
      ov.setSubtitleStyle({ fontSize: "medium", bgOpacity: "high", fontWeight: weight });
      const root = document.body.querySelector(".ec-root") as HTMLElement;
      expect(root.style.getPropertyValue("--ec-caption-font-weight")).toBe(expected);
    }
  });

  it("adds ec-cap-flat class when bgOpacity is transparent", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    ov.setSubtitleStyle({ fontSize: "medium", bgOpacity: "transparent", fontWeight: "semibold" });
    const root = document.body.querySelector(".ec-root")!;
    expect(root.classList.contains("ec-cap-flat")).toBe(true);
  });

  it("removes ec-cap-flat class when bgOpacity changes away from transparent", () => {
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    ov.setSubtitleStyle({ fontSize: "medium", bgOpacity: "transparent", fontWeight: "semibold" });
    ov.setSubtitleStyle({ fontSize: "medium", bgOpacity: "high", fontWeight: "semibold" });
    const root = document.body.querySelector(".ec-root")!;
    expect(root.classList.contains("ec-cap-flat")).toBe(false);
  });

  it("no-ops gracefully when overlay is not mounted", () => {
    const ov = createOverlay();
    // Do NOT call buildOverlay — root is null.
    expect(() =>
      ov.setSubtitleStyle({ fontSize: "medium", bgOpacity: "high", fontWeight: "semibold" }),
    ).not.toThrow();
  });
});
