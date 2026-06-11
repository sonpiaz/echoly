// @vitest-environment jsdom
// Acceptance-criteria tests for the overlay drag fast path (A1–A4).
// Uses a manual-flush rAF stub so coalescing can be verified precisely:
// install the stub before importing the overlay, dispatch moves, flush explicitly.

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { disposeMediaStageWatch } from "@/content/media-stage";
import { LAYOUT_KEY } from "@/shared/constants";

// ── PolyPointerEvent (jsdom has no PointerEvent) ─────────────────────────────
class PolyPointerEvent extends MouseEvent {
  pointerId: number;
  constructor(type: string, params: PointerEventInit = {}) {
    super(type, params);
    this.pointerId = params.pointerId ?? 1;
  }
}
vi.stubGlobal("PointerEvent", PolyPointerEvent);

// ── Manual-flush rAF stub ─────────────────────────────────────────────────────
// Replaces the global requestAnimationFrame/cancelAnimationFrame with a queue
// that only fires when flushRaf() is called. Installed globally so the overlay
// module picks it up at call time (per §A·2 rAF call-time contract).
const rafQueue: Map<number, FrameRequestCallback> = new Map();
let rafIdCounter = 1;

function stubRaf(): void {
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback): number => {
    const id = rafIdCounter++;
    rafQueue.set(id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number): void => {
    rafQueue.delete(id);
  });
}

function flushRaf(): void {
  // Snapshot then clear so callbacks that schedule new frames don't re-run.
  const cbs = Array.from(rafQueue.values());
  rafQueue.clear();
  for (const cb of cbs) cb(performance.now());
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeCallbacks() {
  return {
    onLanguageChange: vi.fn(),
    onVoiceChange: vi.fn(),
    onStop: vi.fn(),
  };
}

/** Set up a realistic 1366×768 viewport and stub getBoundingClientRect on both
 *  dock and panel to return a known rect so clampDockToStage has a stable
 *  input. Returns the mocked rects. */
function stubElementRects(root: HTMLElement): {
  dockBcr: () => DOMRect;
  panelBcr: () => DOMRect;
} {
  Object.defineProperty(window, "innerWidth", { value: 1366, writable: true });
  Object.defineProperty(window, "innerHeight", { value: 768, writable: true });
  const dockBcr = (): DOMRect =>
    DOMRect.fromRect({ x: 100, y: 50, width: 212, height: 32 });
  const panelBcr = (): DOMRect =>
    DOMRect.fromRect({ x: 100, y: 50, width: 256, height: 296 });
  const dock = root.querySelector<HTMLElement>(".ec-dock");
  const panel = root.querySelector<HTMLElement>(".ec-panel");
  if (dock) {
    Object.defineProperty(dock, "getBoundingClientRect", {
      value: dockBcr,
      configurable: true,
    });
  }
  if (panel) {
    Object.defineProperty(panel, "getBoundingClientRect", {
      value: panelBcr,
      configurable: true,
    });
  }
  return { dockBcr, panelBcr };
}

function getDragHandle(root: HTMLElement): HTMLElement {
  const handle = root.querySelector<HTMLElement>("[data-ec-drag]");
  if (!handle) throw new Error("drag handle not found");
  return handle;
}

/** Stage rect used by the A4 stage-clamp tests — keep in sync with the
 *  expected clamp math in those tests. */
const STAGE = { x: 100, y: 50, width: 900, height: 500 } as const;

/** Mount a <video> with a stubbed BCR so the REAL watchMediaStage pipeline
 *  (pickLargestVisibleVideo → resolveStageRect → onUpdate) emits a genuine
 *  MediaStageSnapshot. jsdom hostname is localhost → generic platform →
 *  insets { bottom: 56, top: 44, side: 16 }. */
function installStageVideo(): HTMLVideoElement {
  const video = document.createElement("video");
  Object.defineProperty(video, "getBoundingClientRect", {
    value: () => DOMRect.fromRect(STAGE),
    configurable: true,
  });
  document.body.appendChild(video);
  return video;
}

// ── Setup / teardown ──────────────────────────────────────────────────────────
beforeEach(() => {
  stubRaf();
  disposeMediaStageWatch();
  document.querySelectorAll(".ec-root").forEach((n) => n.remove());
  // Remove stage videos from previous tests so watchMediaStage emits null in
  // the tests that assume the no-stage fallback path.
  document.querySelectorAll("video").forEach((n) => n.remove());
  localStorage.clear();
  // Provide setPointerCapture/releasePointerCapture stubs on the handle element
  // via HTMLElement.prototype so the overlay can call them.
  if (!HTMLElement.prototype.setPointerCapture) {
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      value: vi.fn(),
      writable: true,
      configurable: true,
    });
  } else {
    HTMLElement.prototype.setPointerCapture = vi.fn();
  }
  if (!HTMLElement.prototype.releasePointerCapture) {
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
      value: vi.fn(),
      writable: true,
      configurable: true,
    });
  } else {
    HTMLElement.prototype.releasePointerCapture = vi.fn();
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  rafQueue.clear();
  rafIdCounter = 1;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("overlay drag fast path — A1: .ec-dragging class lifecycle", () => {
  it("adds .ec-dragging to dock AND panel on pointerdown, removes after pointerup + reflow", async () => {
    // Import the module after stubs are in place.
    const { createOverlay } = await import("@/content/overlay/overlay");
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const root = document.body.querySelector<HTMLElement>(".ec-root")!;
    const handle = getDragHandle(root);
    const dock = root.querySelector<HTMLElement>(".ec-dock")!;
    const panel = root.querySelector<HTMLElement>(".ec-panel")!;

    handle.dispatchEvent(
      new PolyPointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 200,
        clientY: 100,
        pointerId: 1,
      }),
    );

    // After pointerdown both elements must carry .ec-dragging.
    expect(dock.classList.contains("ec-dragging")).toBe(true);
    expect(panel.classList.contains("ec-dragging")).toBe(true);

    handle.dispatchEvent(
      new PolyPointerEvent("pointermove", {
        bubbles: true,
        button: 0,
        clientX: 220,
        clientY: 120,
        pointerId: 1,
      }),
    );

    // Still dragging during move.
    expect(dock.classList.contains("ec-dragging")).toBe(true);
    expect(panel.classList.contains("ec-dragging")).toBe(true);

    handle.dispatchEvent(
      new PolyPointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        clientX: 220,
        clientY: 120,
        pointerId: 1,
      }),
    );

    // After drop commit both classes must be removed.
    expect(dock.classList.contains("ec-dragging")).toBe(false);
    expect(panel.classList.contains("ec-dragging")).toBe(false);
  });

  it("removes .ec-dragging on pointercancel too", async () => {
    const { createOverlay } = await import("@/content/overlay/overlay");
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const root = document.body.querySelector<HTMLElement>(".ec-root")!;
    const handle = getDragHandle(root);
    const dock = root.querySelector<HTMLElement>(".ec-dock")!;

    handle.dispatchEvent(
      new PolyPointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 200,
        clientY: 100,
        pointerId: 1,
      }),
    );
    expect(dock.classList.contains("ec-dragging")).toBe(true);

    handle.dispatchEvent(
      new PolyPointerEvent("pointercancel", {
        bubbles: true,
        button: 0,
        clientX: 200,
        clientY: 100,
        pointerId: 1,
      }),
    );
    expect(dock.classList.contains("ec-dragging")).toBe(false);
  });
});

describe("overlay drag fast path — A2: zero BCR on moves + rAF coalescing", () => {
  it("calls getBoundingClientRect on dock/panel exactly zero times between first and last pointermove", async () => {
    const { createOverlay } = await import("@/content/overlay/overlay");
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const root = document.body.querySelector<HTMLElement>(".ec-root")!;
    const handle = getDragHandle(root);

    // pointerdown (allowed — one BCR each for dragDims cache)
    handle.dispatchEvent(
      new PolyPointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 200,
        clientY: 100,
        pointerId: 1,
      }),
    );

    // Start spying AFTER pointerdown so the one-time cache BCRs don't count.
    const dock = root.querySelector<HTMLElement>(".ec-dock")!;
    const panel = root.querySelector<HTMLElement>(".ec-panel")!;
    const dockBcrSpy = vi.fn().mockReturnValue(
      DOMRect.fromRect({ x: 100, y: 50, width: 212, height: 32 }),
    );
    const panelBcrSpy = vi.fn().mockReturnValue(
      DOMRect.fromRect({ x: 100, y: 50, width: 256, height: 296 }),
    );
    Object.defineProperty(dock, "getBoundingClientRect", {
      value: dockBcrSpy,
      configurable: true,
    });
    Object.defineProperty(panel, "getBoundingClientRect", {
      value: panelBcrSpy,
      configurable: true,
    });

    // Two pointermoves — both should coalesce into ONE rAF callback.
    handle.dispatchEvent(
      new PolyPointerEvent("pointermove", {
        bubbles: true,
        button: 0,
        clientX: 220,
        clientY: 110,
        pointerId: 1,
      }),
    );
    handle.dispatchEvent(
      new PolyPointerEvent("pointermove", {
        bubbles: true,
        button: 0,
        clientX: 240,
        clientY: 130,
        pointerId: 1,
      }),
    );

    // Flush rAF — both moves map to a single frame.
    flushRaf();

    // Zero BCR calls on dock/panel in the move phase.
    expect(dockBcrSpy).not.toHaveBeenCalled();
    expect(panelBcrSpy).not.toHaveBeenCalled();

    // Clean up
    handle.dispatchEvent(
      new PolyPointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        clientX: 240,
        clientY: 130,
        pointerId: 1,
      }),
    );
  });

  it("moves write nothing synchronously; one flush applies exactly the SECOND move's target", async () => {
    const { createOverlay } = await import("@/content/overlay/overlay");
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const root = document.body.querySelector<HTMLElement>(".ec-root")!;
    const handle = getDragHandle(root);
    const dock = root.querySelector<HTMLElement>(".ec-dock")!;

    // Mock BCR so capturePointer gets origin.left = 100 (layout.left is null
    // before the first drag — anchorChrome's no-stage branch never writes it).
    Object.defineProperty(dock, "getBoundingClientRect", {
      value: () => DOMRect.fromRect({ x: 100, y: 50, width: 212, height: 32 }),
      configurable: true,
    });

    // pointerdown at origin (100, 50)
    handle.dispatchEvent(
      new PolyPointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 100,
        clientY: 50,
        pointerId: 1,
      }),
    );

    // Capture the pre-move style — set by buildOverlay's applyLayout, NOT by
    // the drag. The old synchronous code updated style.left on every move, so
    // the "unchanged before flush" assertions below fail under it.
    const beforeLeft = dock.style.left;

    // First move: delta (+30, +20) → would target left = 130px.
    handle.dispatchEvent(
      new PolyPointerEvent("pointermove", {
        bubbles: true,
        button: 0,
        clientX: 130,
        clientY: 70,
        pointerId: 1,
      }),
    );

    // No flush yet — NOTHING may have been written synchronously.
    expect(dock.style.left).toBe(beforeLeft);

    // Second move: delta (+60, +40) → targets left = 160px, superseding move 1.
    handle.dispatchEvent(
      new PolyPointerEvent("pointermove", {
        bubbles: true,
        button: 0,
        clientX: 160,
        clientY: 90,
        pointerId: 1,
      }),
    );

    // Still nothing written — both moves only updated layout + the rAF queue.
    expect(dock.style.left).toBe(beforeLeft);

    // ONE flush applies the final coalesced position: origin.left (100) + 60.
    // 160 is within both viewport clamps (jsdom 1024×768), so the value is exact.
    flushRaf();
    expect(dock.style.left).toBe("160px");
    // Explicitly NOT the first move's target — the first write was superseded.
    expect(dock.style.left).not.toBe("130px");
    // Coalescing left no stale frames behind.
    expect(rafQueue.size).toBe(0);

    handle.dispatchEvent(
      new PolyPointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        clientX: 160,
        clientY: 90,
        pointerId: 1,
      }),
    );
  });
});

describe("overlay drag fast path — A3: first drag persists dragged position (not stage default)", () => {
  it("first drag with dockUserPlaced=false ends with the dragged position in localStorage", async () => {
    const { createOverlay } = await import("@/content/overlay/overlay");
    const ov = createOverlay();
    // dockUserPlaced starts false (DEFAULT_LAYOUT has no dockUserPlaced field)
    ov.buildOverlay(makeCallbacks());
    const root = document.body.querySelector<HTMLElement>(".ec-root")!;
    const handle = getDragHandle(root);
    const dock = root.querySelector<HTMLElement>(".ec-dock")!;

    // Give the dock a realistic BCR so capturePointer gets a non-zero origin.
    Object.defineProperty(dock, "getBoundingClientRect", {
      value: () => DOMRect.fromRect({ x: 800, y: 300, width: 212, height: 32 }),
      configurable: true,
    });

    // Drag from (810, 316) to (700, 250) — a clear user-chosen position.
    handle.dispatchEvent(
      new PolyPointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 810,
        clientY: 316,
        pointerId: 1,
      }),
    );
    handle.dispatchEvent(
      new PolyPointerEvent("pointermove", {
        bubbles: true,
        button: 0,
        clientX: 700,
        clientY: 250,
        pointerId: 1,
      }),
    );
    handle.dispatchEvent(
      new PolyPointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        clientX: 700,
        clientY: 250,
        pointerId: 1,
      }),
    );

    const stored = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}");
    // Must be marked user-placed.
    expect(stored.dockUserPlaced).toBe(true);
    // left must be a number (the dragged position, not null/undefined).
    expect(typeof stored.left).toBe("number");
    expect(typeof stored.top).toBe("number");
    // The saved left must correspond to the drag delta (origin ≈ 800, delta ≈ −110).
    // We allow clamping but it should not be the stage default (0 or null).
    expect(stored.left).toBeGreaterThan(0);
  });
});

describe("overlay drag fast path — A4: saveLayout once per drag, clamp write-back", () => {
  it("saveLayout (localStorage.setItem for LAYOUT_KEY) is called exactly once per drag at drag end", async () => {
    const { createOverlay } = await import("@/content/overlay/overlay");
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const root = document.body.querySelector<HTMLElement>(".ec-root")!;
    const handle = getDragHandle(root);

    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");

    // pointerdown
    handle.dispatchEvent(
      new PolyPointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 200,
        clientY: 100,
        pointerId: 1,
      }),
    );
    // Multiple moves — should NOT trigger saveLayout.
    handle.dispatchEvent(
      new PolyPointerEvent("pointermove", {
        bubbles: true,
        button: 0,
        clientX: 220,
        clientY: 120,
        pointerId: 1,
      }),
    );
    handle.dispatchEvent(
      new PolyPointerEvent("pointermove", {
        bubbles: true,
        button: 0,
        clientX: 240,
        clientY: 140,
        pointerId: 1,
      }),
    );

    // No setItem for LAYOUT_KEY yet.
    const midDragCalls = setItemSpy.mock.calls.filter(
      ([key]) => key === LAYOUT_KEY,
    );
    expect(midDragCalls.length).toBe(0);

    // Drop — exactly one save.
    handle.dispatchEvent(
      new PolyPointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        clientX: 240,
        clientY: 140,
        pointerId: 1,
      }),
    );

    const afterDropCalls = setItemSpy.mock.calls.filter(
      ([key]) => key === LAYOUT_KEY,
    );
    expect(afterDropCalls.length).toBe(1);

    setItemSpy.mockRestore();
  });

  it("dockUserPlaced is true after drop and persists (>48 px reset does not fire)", async () => {
    const { createOverlay } = await import("@/content/overlay/overlay");
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const root = document.body.querySelector<HTMLElement>(".ec-root")!;
    const handle = getDragHandle(root);

    handle.dispatchEvent(
      new PolyPointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 200,
        clientY: 100,
        pointerId: 1,
      }),
    );
    handle.dispatchEvent(
      new PolyPointerEvent("pointermove", {
        bubbles: true,
        button: 0,
        clientX: 250,
        clientY: 130,
        pointerId: 1,
      }),
    );
    handle.dispatchEvent(
      new PolyPointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        clientX: 250,
        clientY: 130,
        pointerId: 1,
      }),
    );

    const stored = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}");
    expect(stored.dockUserPlaced).toBe(true);
    // left/top should be numeric (not null) after a move.
    expect(typeof stored.left).toBe("number");
    expect(typeof stored.top).toBe("number");
  });
});

describe("overlay drag fast path — A4: stage-clamp write-back (real watchMediaStage snapshot)", () => {
  // Drives a GENUINE MediaStageSnapshot through the real watchMediaStage
  // pipeline: a <video> with a stubbed BCR is found by pickLargestVisibleVideo,
  // resolveStageRect returns its rect, and the watcher's rAF-scheduled emit
  // lands in our manual-flush queue. Stage rect: (100,50)+900×500 → right=1000,
  // bottom=550. Generic insets {bottom:56, top:44, side:16}; dock dims 212×32.
  it("drop far outside the stage → persisted position is stage-clamped; a subsequent stage pass keeps it (>48px reset does NOT fire)", async () => {
    installStageVideo();
    const { createOverlay } = await import("@/content/overlay/overlay");
    const ov = createOverlay();
    ov.buildOverlay(makeCallbacks());
    const root = document.body.querySelector<HTMLElement>(".ec-root")!;
    // 1366×768 viewport + dock 212×32 / panel 256×296 measured BCRs.
    stubElementRects(root);
    const handle = getDragHandle(root);
    const dock = root.querySelector<HTMLElement>(".ec-dock")!;

    // Deliver the initial stage snapshot through the REAL watcher (its emit
    // was scheduled into our manual rAF queue at buildOverlay time).
    flushRaf();

    // Sanity: dock sits at the stage default (top-right inside the stage):
    // def.left = rect.right - dockW - side = 1000 - 212 - 16 = 772
    // def.top  = rect.top + min(insets.top, 10) = 50 + 10 = 60
    expect(dock.style.left).toBe("772px");
    expect(dock.style.top).toBe("60px");

    // Drag +600/+600 — raw drop lands at viewport-clamped (1146, 660), which is
    // MORE than 48px beyond the stage rect (right=1000, bottom=550). Without
    // the §A·5(2) write-back, anchorChrome's >48px reset WOULD fire on the next
    // stage pass and snap the dock back to the default.
    handle.dispatchEvent(
      new PolyPointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        clientX: 500,
        clientY: 300,
        pointerId: 1,
      }),
    );
    handle.dispatchEvent(
      new PolyPointerEvent("pointermove", {
        bubbles: true,
        button: 0,
        clientX: 1100,
        clientY: 900,
        pointerId: 1,
      }),
    );
    handle.dispatchEvent(
      new PolyPointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        clientX: 1100,
        clientY: 900,
        pointerId: 1,
      }),
    );

    // (a) Persisted layout is stage-clamped per clampDockToStage:
    // left = min(max(100+16, 1146), 1000-212-16) = 772
    // top  = min(max(50+10,  660), 550-32-min(56,24)) = 494
    const stored = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}");
    expect(stored.dockUserPlaced).toBe(true);
    expect(stored.left).toBe(772);
    expect(stored.top).toBe(494);
    // Inside the stage rect by construction (dock 212×32 fits within bounds).
    expect(stored.left).toBeGreaterThanOrEqual(STAGE.x);
    expect(stored.left + 212).toBeLessThanOrEqual(STAGE.x + STAGE.width);
    expect(stored.top).toBeGreaterThanOrEqual(STAGE.y);
    expect(stored.top + 32).toBeLessThanOrEqual(STAGE.y + STAGE.height);
    // The dock renders at the clamped position, not the raw pointer position.
    expect(dock.style.left).toBe("772px");
    expect(dock.style.top).toBe("494px");

    // (b) Subsequent stage-update applyLayout() passes must keep the position:
    // resize triggers BOTH the overlay's sync applyLayout and the media-stage
    // watcher's re-emit (flushed below) — two full anchorChrome passes.
    window.dispatchEvent(new Event("resize"));
    flushRaf();

    // dockUserPlaced stayed true, the >48px reset did NOT fire, and the dock
    // did NOT snap back to the stage default (top would read "60px").
    expect(dock.style.left).toBe("772px");
    expect(dock.style.top).toBe("494px");
    const after = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}");
    expect(after.dockUserPlaced).toBe(true);
    expect(after.left).toBe(772);
    expect(after.top).toBe(494);
  });
});
