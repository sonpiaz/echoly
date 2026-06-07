import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  applyVideoPauseToSession,
  bindSourceVideoPlayback,
  notifyServerMediaGate,
  syncSourcePauseState,
} from "@/lib/rtc-media-sync";
import type { WebRtcSession } from "@/content/session-manager";

function makeSession(): WebRtcSession {
  const track = { kind: "audio", enabled: true } as MediaStreamTrack;
  const stream = {
    getAudioTracks: () => [track],
  } as MediaStream;
  const sender = { track } as RTCRtpSender;
  const pc = {
    getSenders: () => [sender],
  } as RTCPeerConnection;
  const remoteAudio = {
    pause: vi.fn(),
    play: vi.fn().mockResolvedValue(undefined),
  } as unknown as HTMLAudioElement;
  return {
    token: 1,
    stream,
    remoteAudio,
    audioCtx: null,
    outputGain: null,
    pc,
    dc: null,
    rtcSessionId: "rt_test",
    apiBearer: "tok",
    pipeline: "standard",
    targetLanguage: "vi",
    voice: "v",
  };
}

describe("rtc-media-sync", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("applyVideoPauseToSession disables capture and pauses dub", () => {
    const session = makeSession();
    applyVideoPauseToSession(session, true);
    expect(session.stream!.getAudioTracks()[0]!.enabled).toBe(false);
    expect(session.remoteAudio!.pause).toHaveBeenCalled();
    applyVideoPauseToSession(session, false);
    expect(session.stream!.getAudioTracks()[0]!.enabled).toBe(true);
    expect(session.remoteAudio!.play).toHaveBeenCalled();
  });

  it("syncSourcePauseState does the media-plane work + notifies the server gate", async () => {
    // Stage A: the pause STATE is now held as a lifecycle reason by the caller —
    // syncSourcePauseState no longer writes sm.videoPaused (a derived getter). It
    // still POSTs the server media-gate. It pushes the 'connection-lost' reason
    // (via the optional lifecycle arg) ONLY on a non-ok response — here ok:true.
    const sm = { apiBase: "https://api.test" };
    const session = makeSession();
    const lifecycle = { pause: vi.fn() };
    await syncSourcePauseState(sm, session, true, lifecycle);
    expect(session.stream!.getAudioTracks()[0]!.enabled).toBe(false);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test/rtc/translate/rt_test/media-pause",
      expect.objectContaining({ method: "POST" }),
    );
    // ok:true → no connection-lost reason pushed.
    expect(lifecycle.pause).not.toHaveBeenCalled();
  });

  it("bindSourceVideoPlayback registers and unregisters listeners", () => {
    const listeners = new Map<string, () => void>();
    const video = {
      addEventListener: (type: string, fn: () => void) => {
        listeners.set(type, fn);
      },
      removeEventListener: (type: string) => {
        listeners.delete(type);
      },
    } as unknown as HTMLVideoElement;
    const onPause = vi.fn();
    const unbind = bindSourceVideoPlayback(video, {
      onPause,
      onPlay: vi.fn(),
      onEnded: vi.fn(),
    });
    listeners.get("pause")!();
    expect(onPause).toHaveBeenCalled();
    unbind();
    expect(listeners.has("pause")).toBe(false);
  });

  it("notifyServerMediaGate POSTs media-resume", () => {
    notifyServerMediaGate("https://api.test", "rt_1", "bearer", false);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.test/rtc/translate/rt_1/media-resume",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
