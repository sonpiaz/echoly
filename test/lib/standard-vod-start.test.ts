// @vitest-environment jsdom
// Tests for alignRealtimeVodBeforePlay (B1 / AC4).
//
// AC4 contract:
//   - Resolves as soon as the remote audio track fires `canplay` or
//     `loadedmetadata` — NOT on a fixed timer.
//   - If the element already has readyState >= 1 (HAVE_METADATA) when we
//     attach, resolves immediately without waiting for any event.
//   - Falls back to the ceiling timeout when no element arrives / no event
//     fires — never hangs forever.
//   - No unconditional sleep (the old 80 ms alignMs sleep is gone; the
//     function returns as soon as the track is demonstrably ready).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { alignRealtimeVodBeforePlay } from "@/lib/standard-vod-start";

// jsdom does not fire media events; we drive them manually.

describe("alignRealtimeVodBeforePlay — AC4", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves immediately when the audio element already has readyState >= 1", async () => {
    const audio = document.createElement("audio");
    // Simulate HAVE_METADATA state.
    Object.defineProperty(audio, "readyState", { get: () => 1, configurable: true });

    const start = Date.now();
    const p = alignRealtimeVodBeforePlay(() => audio, 80);
    // No timer advance needed — should resolve in the same microtask.
    await vi.advanceTimersByTimeAsync(0);
    await p;
    // Should resolve without any significant delay.
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("resolves on canplay event before the ceiling timeout", async () => {
    const audio = document.createElement("audio");
    // readyState = 0 (HAVE_NOTHING) — needs event.
    Object.defineProperty(audio, "readyState", { get: () => 0, configurable: true });

    let resolved = false;
    const p = alignRealtimeVodBeforePlay(() => audio, 80).then(() => {
      resolved = false; // just to check it ran
      resolved = true;
    });

    // Advance just enough for the first poll to attach listeners (~16 ms).
    await vi.advanceTimersByTimeAsync(20);
    expect(resolved).toBe(false); // not yet — no event fired

    // Fire canplay.
    audio.dispatchEvent(new Event("canplay"));

    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(resolved).toBe(true);
  });

  it("resolves on loadedmetadata event", async () => {
    const audio = document.createElement("audio");
    Object.defineProperty(audio, "readyState", { get: () => 0, configurable: true });

    let resolved = false;
    const p = alignRealtimeVodBeforePlay(() => audio, 80).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(20);
    expect(resolved).toBe(false);

    audio.dispatchEvent(new Event("loadedmetadata"));

    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(resolved).toBe(true);
  });

  it("does NOT resolve before the event fires (no fixed sleep path)", async () => {
    // This test verifies that the function is not using an unconditional sleep:
    // it should be waiting for the event, NOT ticking off 80 ms automatically.
    const audio = document.createElement("audio");
    Object.defineProperty(audio, "readyState", { get: () => 0, configurable: true });

    let resolved = false;
    const p = alignRealtimeVodBeforePlay(() => audio, 80).then(() => {
      resolved = true;
    });

    // Advance 200 ms (well past the old 80 ms sleep) — should still be waiting.
    await vi.advanceTimersByTimeAsync(200);
    expect(resolved).toBe(false);

    // Now fire the event — should resolve promptly.
    audio.dispatchEvent(new Event("canplay"));
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(resolved).toBe(true);
  });

  it("falls back to ceiling when no element is ever returned", async () => {
    // getDubAudio always returns null — should resolve at the ceiling.
    let resolved = false;
    const p = alignRealtimeVodBeforePlay(() => null, 80).then(() => {
      resolved = true;
    });

    // Should NOT resolve immediately.
    await vi.advanceTimersByTimeAsync(50);
    expect(resolved).toBe(false);

    // Advance past the 2 000 ms ceiling.
    await vi.advanceTimersByTimeAsync(2100);
    await p;
    expect(resolved).toBe(true);
  });

  it("resolves at ceiling when element appears but fires no events", async () => {
    // Element appears but its readyState stays at 0 and events never fire.
    const audio = document.createElement("audio");
    Object.defineProperty(audio, "readyState", { get: () => 0, configurable: true });

    let resolved = false;
    const p = alignRealtimeVodBeforePlay(() => audio, 80).then(() => {
      resolved = true;
    });

    // Should wait — not resolved at 200 ms.
    await vi.advanceTimersByTimeAsync(200);
    expect(resolved).toBe(false);

    // Advance to ceiling.
    await vi.advanceTimersByTimeAsync(2100);
    await p;
    expect(resolved).toBe(true);
  });

  it("getDubAudio can initially return null then return an element", async () => {
    const audio = document.createElement("audio");
    Object.defineProperty(audio, "readyState", { get: () => 0, configurable: true });
    let available = false;

    let resolved = false;
    const p = alignRealtimeVodBeforePlay(() => available ? audio : null, 80).then(() => {
      resolved = true;
    });

    // Before element is available.
    await vi.advanceTimersByTimeAsync(50);
    expect(resolved).toBe(false);

    // Make element available.
    available = true;
    await vi.advanceTimersByTimeAsync(30); // let the poll fire

    // Fire the event.
    audio.dispatchEvent(new Event("canplay"));
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(resolved).toBe(true);
  });
});
