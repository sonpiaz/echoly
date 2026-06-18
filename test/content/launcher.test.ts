// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QuickStartLauncher, clampLauncherCenterY } from "@/content/launcher";
import { TIER_REALTIME, TIER_STANDARD } from "@/shared/constants";

function makeApp(hasVideo = true, session: object | null = null) {
  return {
    sm: { session },
    adapter: { findVideo: () => (hasVideo ? document.createElement("video") : null) },
    capture: { findVideo: () => (hasVideo ? document.createElement("video") : null) },
  } as never;
}

/** Build a chrome.runtime.sendMessage mock that returns different values per
 *  message type so the launcher's GET_LAUNCH_STATE + PREPARE_INTENT can be
 *  tracked independently. */
function makeSendMessage(opts: {
  tier?: string;
  signedIn?: boolean;
}) {
  return vi.fn().mockImplementation((msg: { type: string }) => {
    if (msg.type === "GET_LAUNCH_STATE") {
      return Promise.resolve({
        ok: true,
        signedIn: opts.signedIn ?? true,
        tier: opts.tier ?? TIER_STANDARD,
      });
    }
    return Promise.resolve({ ok: true });
  });
}

/** Count PREPARE_INTENT calls in a mock sendMessage's call list. */
function countPrepareIntentCalls(sendMessage: ReturnType<typeof vi.fn>): number {
  return (sendMessage.mock.calls as Array<[{ type?: string }]>).filter(
    (args) => args[0]?.type === "PREPARE_INTENT",
  ).length;
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
      sendMessage: makeSendMessage({ tier: TIER_STANDARD, signedIn: true }),
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

  it("mounts as soon as the <video> appears via the DOM watch (no 20s tick wait)", async () => {
    // Start with NO video on the page (Udemy/Shaka loads it after init()).
    let videoEl: HTMLVideoElement | null = null;
    const app = {
      sm: { session: null },
      adapter: { findVideo: () => videoEl, isWatchUrl: () => true },
      capture: { findVideo: () => null },
    } as never;

    const launcher = new QuickStartLauncher(app);
    await launcher.init();
    // No video yet → not mounted; the DOM watch is now armed.
    expect(document.querySelector(".ec-launcher")).toBeNull();

    // Simulate the SPA/Shaka adding the <video> later — fires the MutationObserver.
    videoEl = document.createElement("video");
    document.body.appendChild(videoEl);

    // Within the debounce (150 ms) the launcher mounts — NOT 20 s later.
    await new Promise((r) => setTimeout(r, 300));
    expect(document.querySelector(".ec-launcher")).not.toBeNull();

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

// ── Realtime launcher pre-warm (R1) ─────────────────────────────────────────
// When tier=realtime and no session is live, hovering or focusing the Start
// button sends PREPARE_INTENT to the background, which relays
// CONTENT_PREPARE_INTENT → app.webrtc.prepareIntent() (existing plumbing).
// Standard tier: guard skips — no point warming a standard WebRTC slot.

describe("QuickStartLauncher — realtime pre-warm hover (R1)", () => {
  it("sends PREPARE_INTENT on mouseenter when tier is realtime", async () => {
    const sendMessage = makeSendMessage({ tier: TIER_REALTIME, signedIn: true });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    const launcher = new QuickStartLauncher(makeApp());
    await launcher.init(); // GET_LAUNCH_STATE fires here, caches tier=realtime

    const btn = document.querySelector(".ec-launcher") as HTMLButtonElement;
    expect(btn).not.toBeNull();

    btn.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));

    expect(countPrepareIntentCalls(sendMessage)).toBe(1);
    launcher.destroy();
  });

  it("sends PREPARE_INTENT on focus when tier is realtime", async () => {
    const sendMessage = makeSendMessage({ tier: TIER_REALTIME, signedIn: true });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    const launcher = new QuickStartLauncher(makeApp());
    await launcher.init();

    const btn = document.querySelector(".ec-launcher") as HTMLButtonElement;
    btn.dispatchEvent(new FocusEvent("focus", { bubbles: true }));

    expect(countPrepareIntentCalls(sendMessage)).toBe(1);
    launcher.destroy();
  });

  it("does NOT send PREPARE_INTENT when tier is standard", async () => {
    const sendMessage = makeSendMessage({ tier: TIER_STANDARD, signedIn: true });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    const launcher = new QuickStartLauncher(makeApp());
    await launcher.init(); // tier=standard cached

    const btn = document.querySelector(".ec-launcher") as HTMLButtonElement;
    btn.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    btn.dispatchEvent(new FocusEvent("focus", { bubbles: true }));

    expect(countPrepareIntentCalls(sendMessage)).toBe(0);
    launcher.destroy();
  });

  it("fires PREPARE_INTENT only once per hover session (fire-once-per-arming)", async () => {
    const sendMessage = makeSendMessage({ tier: TIER_REALTIME, signedIn: true });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    const launcher = new QuickStartLauncher(makeApp());
    await launcher.init();

    const btn = document.querySelector(".ec-launcher") as HTMLButtonElement;

    // Multiple events in the same hover session must not re-fire.
    btn.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    btn.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    btn.dispatchEvent(new FocusEvent("focus", { bubbles: true }));

    expect(countPrepareIntentCalls(sendMessage)).toBe(1);
    launcher.destroy();
  });

  it("resets fire-once flag on mouseleave so a second hover may fire again", async () => {
    const sendMessage = makeSendMessage({ tier: TIER_REALTIME, signedIn: true });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    const launcher = new QuickStartLauncher(makeApp());
    await launcher.init();

    const btn = document.querySelector(".ec-launcher") as HTMLButtonElement;

    // First hover session.
    btn.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    // Leave — resets the flag.
    btn.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    // Second hover session — should fire again.
    btn.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));

    expect(countPrepareIntentCalls(sendMessage)).toBe(2);
    launcher.destroy();
  });

  it("resets fire-once flag on blur so a second focus may fire again", async () => {
    const sendMessage = makeSendMessage({ tier: TIER_REALTIME, signedIn: true });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    const launcher = new QuickStartLauncher(makeApp());
    await launcher.init();

    const btn = document.querySelector(".ec-launcher") as HTMLButtonElement;

    btn.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
    btn.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    btn.dispatchEvent(new FocusEvent("focus", { bubbles: true }));

    expect(countPrepareIntentCalls(sendMessage)).toBe(2);
    launcher.destroy();
  });

  it("does NOT send PREPARE_INTENT when a session is already live (button not mounted)", async () => {
    const sendMessage = makeSendMessage({ tier: TIER_REALTIME, signedIn: true });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    // A live session makes #shouldShow()=false → button not mounted → no hover possible.
    const launcher = new QuickStartLauncher(makeApp(true, { id: "live" }));
    await launcher.init();

    const btn = document.querySelector(".ec-launcher");
    expect(btn).toBeNull(); // not mounted

    expect(countPrepareIntentCalls(sendMessage)).toBe(0);
    launcher.destroy();
  });

  it("does NOT send PREPARE_INTENT at mount time — only on explicit hover/focus", async () => {
    const sendMessage = makeSendMessage({ tier: TIER_REALTIME, signedIn: true });
    vi.stubGlobal("chrome", { runtime: { sendMessage } });

    const launcher = new QuickStartLauncher(makeApp());
    await launcher.init(); // mounts, but must NOT fire prepare eagerly

    // Button is present.
    expect(document.querySelector(".ec-launcher")).not.toBeNull();

    // No PREPARE_INTENT without a hover event (RISK-4 guard).
    expect(countPrepareIntentCalls(sendMessage)).toBe(0);
    launcher.destroy();
  });
});
