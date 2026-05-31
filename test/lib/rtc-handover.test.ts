import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { detachOutgoingPeer, RTC_DRAIN_TIMEOUT_MS } from "@/lib/rtc-handover";
import type { WebRtcSession } from "@/content/session-manager";

describe("detachOutgoingPeer", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("closes pc and remote audio (deferred via drain) but keeps stream tracks enabled", async () => {
    const track = { enabled: false, kind: "audio", stop: vi.fn() } as unknown as MediaStreamTrack;
    const stream = { getAudioTracks: () => [track] } as unknown as MediaStream;
    const close = vi.fn();
    const removeTrack = vi.fn();
    const pc = {
      getSenders: () => [{ track }],
      removeTrack,
      close,
    } as unknown as RTCPeerConnection;
    const audio = {
      pause: vi.fn(),
      remove: vi.fn(),
      srcObject: stream,
    } as unknown as HTMLAudioElement;

    const session = {
      stream,
      pc,
      remoteAudio: audio,
      dc: { close: vi.fn() },
      audioCtx: { state: "running", close: vi.fn() },
      outputGain: { disconnect: vi.fn() },
    } as unknown as WebRtcSession;

    detachOutgoingPeer(session);

    // PC and signaling are closed immediately (no drain on the signaling side).
    expect(close).toHaveBeenCalled();
    expect(removeTrack).toHaveBeenCalled();
    // Stream tracks are re-enabled immediately.
    expect(track.enabled).toBe(true);
    expect(track.stop).not.toHaveBeenCalled();

    // Remote audio teardown is deferred via drainRemoteAudio (not immediate).
    // Before the drain timeout: audio.pause not yet called.
    expect(audio.pause).not.toHaveBeenCalled();

    // After RTC_DRAIN_TIMEOUT_MS: drain resolves and audio is torn down.
    await vi.advanceTimersByTimeAsync(RTC_DRAIN_TIMEOUT_MS);
    expect(audio.pause).toHaveBeenCalled();
    expect(audio.remove).toHaveBeenCalled();
  });
});
