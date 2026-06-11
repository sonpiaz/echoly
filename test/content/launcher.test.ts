// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QuickStartLauncher, clampLauncherCenterY } from "@/content/launcher";

function makeApp(hasVideo = true) {
  return {
    sm: { session: null },
    adapter: { findVideo: () => (hasVideo ? document.createElement("video") : null) },
    capture: { findVideo: () => (hasVideo ? document.createElement("video") : null) },
  } as never;
}

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
  if (typeof globalThis.PointerEvent === "undefined") {
    class PolyPointerEvent extends MouseEvent {
      pointerId: number;
      constructor(type: string, params: PointerEventInit = {}) {
        super(type, params);
        this.pointerId = params.pointerId ?? 1;
      }
    }
    vi.stubGlobal("PointerEvent", PolyPointerEvent);
  }
  vi.stubGlobal("chrome", {
    runtime: {
      sendMessage: vi.fn().mockResolvedValue({ ok: true, signedIn: true }),
    },
  });
});

describe("QuickStartLauncher", () => {
  it("renders docked flush to the right edge by default (right: 0)", async () => {
    const launcher = new QuickStartLauncher(makeApp());
    await launcher.init();
    const btn = document.querySelector(".ec-launcher") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.style.right).toBe("0px");
    expect(btn.style.top).toMatch(/^50%$/);
    expect(btn.querySelector(".ec-launcher-mark svg path")?.getAttribute("stroke")).toBe("#fff");
    launcher.destroy();
  });

  it("contains an English label span (all extension UI labels are English)", async () => {
    const launcher = new QuickStartLauncher(makeApp());
    await launcher.init();
    const btn = document.querySelector(".ec-launcher") as HTMLButtonElement;
    const label = btn.querySelector("span.ec-launcher-label");
    expect(label).not.toBeNull();
    expect(label!.textContent).toBe("Start dubbing");
    launcher.destroy();
  });

  it("drags vertically only — stays docked right, persists centerY, suppresses click", async () => {
    const launcher = new QuickStartLauncher(makeApp());
    await launcher.init();
    const btn = document.querySelector(".ec-launcher") as HTMLButtonElement;
    Object.defineProperty(btn, "getBoundingClientRect", {
      value: () => ({
        left: 900,
        top: 300,
        right: 952,
        bottom: 362,
        width: 52,
        height: 62,
      }),
    });
    btn.setPointerCapture = vi.fn();
    btn.releasePointerCapture = vi.fn();
    btn.hasPointerCapture = vi.fn().mockReturnValue(true);

    btn.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        clientX: 910,
        clientY: 313,
        button: 0,
        pointerId: 1,
      }),
    );
    btn.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: 860,
        clientY: 380,
        button: 0,
        pointerId: 1,
      }),
    );
    btn.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        clientX: 860,
        clientY: 380,
        button: 0,
        pointerId: 1,
      }),
    );

    const stored = JSON.parse(localStorage.getItem("echolyLauncherPos") || "{}");
    expect(stored.userPlaced).toBe(true);
    // Vertical-only: origin centerY 300+62/2=331, dy=+67 → 398 (inside clamps).
    expect(stored.centerY).toBe(398);
    // The legacy `left` field is gone from saved records (edge-docked design).
    expect(stored.left).toBeUndefined();
    expect(btn.style.top).toBe("398px");
    // Never leaves the right edge — horizontal delta is ignored.
    expect(btn.style.right).toBe("0px");
    expect(btn.style.left).toBe("auto");

    launcher.destroy();
  });

  it("clampLauncherCenterY clamps to the viewport with the 62px fallback height", () => {
    // When BCR returns 0×0, #measuredHeight() falls back to LAUNCHER_H=62
    // (46px mark + 8px halo top/bottom): far down → centerY = vh - 62/2 - 8.
    const vh = 768;
    expect(clampLauncherCenterY(9999, vh)).toBe(vh - 31 - 8);   // 729
    expect(clampLauncherCenterY(-9999, vh)).toBe(31 + 8);       // 39
    expect(clampLauncherCenterY(400, vh, 62)).toBe(400);        // untouched inside
  });

  it("debounces resize localStorage saves (~150 ms)", async () => {
    vi.useFakeTimers();

    // Pre-seed a userPlaced position so #onResize is active.
    localStorage.setItem(
      "echolyLauncherPos",
      JSON.stringify({ left: 200, centerY: 300, userPlaced: true }),
    );

    const launcher = new QuickStartLauncher(makeApp());
    await launcher.init();

    // Clear any initial save that may have happened during init.
    localStorage.clear();

    // Fire two rapid resize events.
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));

    // No save should have occurred yet (within the debounce window).
    expect(localStorage.getItem("echolyLauncherPos")).toBeNull();

    // Advance past the 150 ms debounce threshold.
    vi.advanceTimersByTime(200);

    // Exactly one save should have fired.
    expect(localStorage.getItem("echolyLauncherPos")).not.toBeNull();
    const stored = JSON.parse(localStorage.getItem("echolyLauncherPos")!);
    expect(stored.userPlaced).toBe(true);

    launcher.destroy();
    vi.useRealTimers();
  });
});
