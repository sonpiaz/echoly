import { describe, it, expect } from "vitest";
import { SessionManager } from "@/content/session-manager";
import type { WebRtcSession } from "@/content/session-manager";

function session(token: number): WebRtcSession {
  return {
    token,
    pc: null,
    dc: null,
    stream: null,
    remoteAudio: null,
    audioCtx: null,
    outputGain: null,
    rtcSessionId: null,
    apiBearer: "",
    pipeline: "realtime",
    targetLanguage: "vi",
    voice: "marin",
  };
}

describe("WebRTC session guard — isSessionStale(token)", () => {
  it("fresh when token === pageToken", () => {
    const sm = new SessionManager();
    sm.pageToken = 5;
    sm.session = session(5);
    expect(sm.isSessionStale(5)).toBe(false);
  });

  it("STALE when token mismatches AND it is not the current session token", () => {
    const sm = new SessionManager();
    sm.pageToken = 6;
    sm.session = session(6);
    expect(sm.isSessionStale(4)).toBe(true);
  });

  it("FRESH for handover: token < pageToken but equals session.token", () => {
    const sm = new SessionManager();
    sm.pageToken = 6;
    sm.session = session(5);
    expect(sm.isSessionStale(5)).toBe(false);
  });
});
