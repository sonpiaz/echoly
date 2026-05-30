import { describe, it, expect, vi } from "vitest";
import { detachOutgoingPeer } from "@/lib/rtc-handover";
import type { WebRtcSession } from "@/content/session-manager";

describe("detachOutgoingPeer", () => {
  it("closes pc and remote audio but keeps stream tracks enabled", () => {
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

    expect(close).toHaveBeenCalled();
    expect(removeTrack).toHaveBeenCalled();
    expect(audio.pause).toHaveBeenCalled();
    expect(track.enabled).toBe(true);
    expect(track.stop).not.toHaveBeenCalled();
  });
});
