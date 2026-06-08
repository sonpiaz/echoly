// @vitest-environment jsdom
//
// LifecycleController unit tests — locks the public contract Stage B/C/D build on
// (SOLUTION §4): the 7-state transition table, the reason-stack pause primitive,
// effectivePaused, the synchronous #selfIssued guard, the epoch, and the events.

import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { LifecycleController } from "@/content/lifecycle";

function makeFakeVideo() {
  const v = {
    paused: false,
    pause: vi.fn(() => { v.paused = true; }),
    play: vi.fn(async () => { v.paused = false; }),
  };
  return v as unknown as HTMLVideoElement & {
    pause: ReturnType<typeof vi.fn>;
    play: ReturnType<typeof vi.fn>;
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

// ─── State machine ────────────────────────────────────────────────────────────

describe("LifecycleController — transition table", () => {
  it("starts in idle", () => {
    expect(new LifecycleController().state).toBe("idle");
  });

  it("walks the happy path idle → starting → dubbing ⇄ paused → stopping → stopped", () => {
    const lc = new LifecycleController();
    const seen: string[] = [];
    lc.on("enter", (s) => seen.push(s));
    lc.transition("starting");
    lc.transition("dubbing");
    lc.transition("paused");
    lc.transition("dubbing");
    lc.transition("stopping");
    lc.transition("stopped");
    expect(seen).toEqual(["starting", "dubbing", "paused", "dubbing", "stopping", "stopped"]);
    expect(lc.state).toBe("stopped");
  });

  it("supports the auto-next loop dubbing → switching → starting", () => {
    const lc = new LifecycleController();
    lc.transition("starting");
    lc.transition("dubbing");
    lc.transition("switching");
    lc.transition("starting");
    expect(lc.state).toBe("starting");
  });

  it("supports auto-next from a PAUSED start: paused → switching → starting → dubbing", () => {
    // User paused, then YouTube autoplay advances → the controller must move
    // paused → switching (the missing LEGAL_EDGE that previously threw/no-oped).
    const lc = new LifecycleController();
    lc.transition("starting");
    lc.transition("dubbing");
    lc.transition("paused");
    expect(() => {
      lc.transition("switching");
      lc.transition("starting");
      lc.transition("dubbing");
    }).not.toThrow();
    expect(lc.state).toBe("dubbing");
  });

  it("resetForNewSession recovers from the terminal `stopped` state back to idle", () => {
    // The previous session's terminal teardown parks the controller in `stopped`;
    // the next session must be able to reset out of it and start again.
    const lc = new LifecycleController();
    lc.transition("starting");
    lc.transition("dubbing");
    lc.transition("stopping");
    lc.transition("stopped");
    expect(lc.state).toBe("stopped");

    const epochBefore = lc.epoch;
    lc.resetForNewSession();
    expect(lc.state).toBe("idle");
    expect(lc.epoch).toBe(epochBefore + 1); // epoch bumped → supersedes stale work

    // …and the happy path is legal again.
    expect(() => {
      lc.transition("starting");
      lc.transition("dubbing");
    }).not.toThrow();
    expect(lc.state).toBe("dubbing");
  });

  it("resetForNewSession clears lingering pause reasons and emits pauseChanged when it flips", () => {
    const lc = new LifecycleController();
    const changed = vi.fn();
    lc.pause("user"); // effectivePaused → true
    lc.on("pauseChanged", changed);
    lc.resetForNewSession();
    expect(lc.effectivePaused).toBe(false);
    expect(changed).toHaveBeenCalledWith(false);
  });

  it("a same-state transition is a no-op (does NOT re-emit enter)", () => {
    const lc = new LifecycleController();
    const enter = vi.fn();
    lc.on("enter", enter);
    lc.transition("idle"); // already idle
    expect(enter).not.toHaveBeenCalled();
  });

  it("emits a `stop` event when entering stopped", () => {
    const lc = new LifecycleController();
    const stop = vi.fn();
    lc.on("stop", stop);
    lc.transition("stopping");
    lc.transition("stopped");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("throws in dev on an illegal edge (idle → dubbing)", () => {
    const lc = new LifecycleController();
    // import.meta.env.DEV is true under vitest → illegal edges throw.
    expect(() => lc.transition("dubbing")).toThrow(/illegal transition/);
    expect(lc.state).toBe("idle");
  });

  it("stopped is terminal — no outgoing edges", () => {
    const lc = new LifecycleController();
    lc.transition("stopping");
    lc.transition("stopped");
    expect(() => lc.transition("starting")).toThrow(/illegal transition/);
    expect(lc.state).toBe("stopped");
  });
});

// ─── Reason-stack pause ────────────────────────────────────────────────────────

describe("LifecycleController — reason stack", () => {
  it("first pause() issues video.pause(); nested reasons do NOT re-pause", () => {
    const lc = new LifecycleController();
    const v = makeFakeVideo();
    lc.setVideo(v);
    lc.pause("user");
    expect(v.pause).toHaveBeenCalledTimes(1);
    lc.pause("system-buffer");
    expect(v.pause).toHaveBeenCalledTimes(1); // still 1 — stack was non-empty
  });

  it("holdReason adds a reason + flips effectivePaused WITHOUT issuing video.pause()", () => {
    const lc = new LifecycleController();
    const v = makeFakeVideo();
    lc.setVideo(v);
    const changed: boolean[] = [];
    lc.on("pauseChanged", (p) => changed.push(p));
    lc.holdReason("ad");
    // Reason held + effectivePaused true (dub gated) ...
    expect(lc.isPausedFor("ad")).toBe(true);
    expect(lc.effectivePaused).toBe(true);
    expect(changed).toEqual([true]);
    // ... but the <video> was NOT paused (ad shares the element, must play through).
    expect(v.pause).not.toHaveBeenCalled();
    expect(v.paused).toBe(false);
    // Idempotent.
    lc.holdReason("ad");
    expect(changed).toEqual([true]);
  });

  it("holdReason('ad') then resume('ad') recovers: stack empties, play() resumes the element", async () => {
    const lc = new LifecycleController();
    const v = makeFakeVideo();
    lc.setVideo(v);
    lc.holdReason("ad");
    expect(v.pause).not.toHaveBeenCalled();
    await lc.resume("ad");
    expect(lc.effectivePaused).toBe(false);
    expect(v.play).toHaveBeenCalledTimes(1); // harmless play() — ensures content is playing
  });

  it("resume() only plays when the LAST reason is popped (AND semantics)", async () => {
    const lc = new LifecycleController();
    const v = makeFakeVideo();
    lc.setVideo(v);
    lc.pause("user");
    lc.pause("ad");
    await lc.resume("user");
    expect(v.play).not.toHaveBeenCalled(); // ad still held
    await lc.resume("ad");
    expect(v.play).toHaveBeenCalledTimes(1); // stack empty → play
  });

  it("pause/resume are idempotent per reason", async () => {
    const lc = new LifecycleController();
    const v = makeFakeVideo();
    lc.setVideo(v);
    lc.pause("user");
    lc.pause("user"); // dup → no-op
    expect(v.pause).toHaveBeenCalledTimes(1);
    await lc.resume("user");
    await lc.resume("user"); // dup → no-op, no extra play
    expect(v.play).toHaveBeenCalledTimes(1);
  });

  it("resume() returns the play() promise (rejects on autoplay-block)", async () => {
    const lc = new LifecycleController();
    const v = makeFakeVideo();
    v.play.mockRejectedValueOnce(new Error("NotAllowedError"));
    lc.setVideo(v);
    lc.pause("user");
    await expect(lc.resume("user")).rejects.toThrow("NotAllowedError");
  });

  it("dropReason removes a reason WITHOUT issuing video.play()", () => {
    const lc = new LifecycleController();
    const v = makeFakeVideo();
    lc.setVideo(v);
    lc.pause("user");
    lc.dropReason("user");
    expect(v.play).not.toHaveBeenCalled();
    expect(lc.isPausedFor("user")).toBe(false);
  });

  it("clearReasons drops everything WITHOUT issuing video.play()", () => {
    const lc = new LifecycleController();
    const v = makeFakeVideo();
    lc.setVideo(v);
    lc.pause("user");
    lc.pause("ad");
    lc.clearReasons();
    expect(v.play).not.toHaveBeenCalled();
    expect(lc.effectivePaused).toBe(false);
  });

  it("pause/resume are state-only and safe with no video bound", async () => {
    const lc = new LifecycleController();
    lc.pause("user");
    expect(lc.effectivePaused).toBe(true);
    await expect(lc.resume("user")).resolves.toBeUndefined();
    expect(lc.effectivePaused).toBe(false);
  });
});

// ─── effectivePaused ───────────────────────────────────────────────────────────

describe("LifecycleController — effectivePaused", () => {
  it("is true for user OR ad, false for transient reasons", () => {
    const lc = new LifecycleController();
    expect(lc.effectivePaused).toBe(false);
    lc.pause("system-buffer");
    expect(lc.effectivePaused).toBe(false); // transient — NOT user-visible
    lc.pause("switching");
    expect(lc.effectivePaused).toBe(false);
    lc.pause("connection-lost");
    expect(lc.effectivePaused).toBe(false);
    lc.pause("user");
    expect(lc.effectivePaused).toBe(true); // user → true
  });

  it("emits pauseChanged only when effectivePaused flips", () => {
    const lc = new LifecycleController();
    const changed = vi.fn();
    lc.on("pauseChanged", changed);
    lc.pause("system-buffer"); // no flip (stays false)
    expect(changed).not.toHaveBeenCalled();
    lc.pause("user"); // flip → true
    expect(changed).toHaveBeenLastCalledWith(true);
    lc.dropReason("user"); // flip → false
    expect(changed).toHaveBeenLastCalledWith(false);
    expect(changed).toHaveBeenCalledTimes(2);
  });
});

// ─── #selfIssued guard ─────────────────────────────────────────────────────────

describe("LifecycleController — self-issued guard", () => {
  it("isSelfIssued() is true at the synchronous video.pause() boundary and clears on the next macrotask", async () => {
    const lc = new LifecycleController();
    let duringPause = false;
    const v = {
      paused: false,
      pause: vi.fn(() => { duringPause = lc.isSelfIssued(); }),
      play: vi.fn(async () => {}),
    } as unknown as HTMLVideoElement;
    lc.setVideo(v);
    lc.pause("system-buffer");
    expect(duringPause).toBe(true);
    expect(lc.isSelfIssued()).toBe(true); // still set across the event window
    await vi.advanceTimersByTimeAsync(1);
    expect(lc.isSelfIssued()).toBe(false);
  });
});

// ─── epoch ─────────────────────────────────────────────────────────────────────

describe("LifecycleController — epoch", () => {
  it("bumpEpoch monotonically increases and supersedes a captured epoch", () => {
    const lc = new LifecycleController();
    const captured = lc.epoch;
    const next = lc.bumpEpoch();
    expect(next).toBe(captured + 1);
    expect(lc.epoch).toBe(next);
    expect(lc.epoch !== captured).toBe(true);
  });
});
