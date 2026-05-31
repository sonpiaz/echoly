// Tests for drainRemoteAudio (SOLUTION §3.2a, AC#7, AC#12).
//
// Covers:
//   AC#7  — drainRemoteAudio defers teardown for the drain window, then cleans up.
//   AC#12 — stopSession VIDEO_ENDED uses drain; user STOP cuts immediately.
//           (Tested here at the drainRemoteAudio API level; the stopSession
//           integration is verified by tsc compile + the guard logic in index.ts.)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { drainRemoteAudio, RTC_DRAIN_TIMEOUT_MS } from "@/lib/rtc-handover";

// ─── Fake HTMLAudioElement ─────────────────────────────────────────────────────

function makeFakeAudio() {
  return {
    pause: vi.fn(),
    remove: vi.fn(),
    srcObject: {} as MediaStream | null,
  } as unknown as HTMLAudioElement;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("drainRemoteAudio (AC#7 / AC#12)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("AC#7: does NOT pause/remove remoteAudio immediately — defers by drainTimeoutMs", async () => {
    const audio = makeFakeAudio();
    const drainPromise = drainRemoteAudio(audio, 600);

    // Before timeout: no teardown.
    expect(audio.pause).not.toHaveBeenCalled();
    expect(audio.remove).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(599);
    expect(audio.pause).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1); // now at 600ms
    await drainPromise;

    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(audio.srcObject).toBeNull();
    expect(audio.remove).toHaveBeenCalledTimes(1);
  });

  it("AC#7: resolves after the timeout (promise resolves)", async () => {
    const audio = makeFakeAudio();
    let resolved = false;
    const drainPromise = drainRemoteAudio(audio, 600).then(() => { resolved = true; });

    await vi.advanceTimersByTimeAsync(599);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await drainPromise;
    expect(resolved).toBe(true);
  });

  it("AC#12: drain timeout is RTC_DRAIN_TIMEOUT_MS = 600", () => {
    expect(RTC_DRAIN_TIMEOUT_MS).toBe(600);
  });

  it("AC#12: drain with custom short timeout tears down after that timeout (immediate-cut simulation)", async () => {
    // A 0ms timeout simulates an immediate cut (all non-VIDEO_ENDED reasons).
    const audio = makeFakeAudio();
    const drainPromise = drainRemoteAudio(audio, 0);

    await vi.advanceTimersByTimeAsync(0);
    await drainPromise;

    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(audio.remove).toHaveBeenCalledTimes(1);
  });

  it("AC#7: does not add an 'ended' listener — relies on timeout only (live stream never fires ended)", () => {
    const audio = makeFakeAudio();
    const addEventListenerSpy = vi.fn();
    (audio as unknown as { addEventListener: typeof addEventListenerSpy }).addEventListener = addEventListenerSpy;

    void drainRemoteAudio(audio, 600);

    expect(addEventListenerSpy).not.toHaveBeenCalled();
  });
});
