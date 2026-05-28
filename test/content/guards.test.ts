// Layer B (iii) — the dual-guard (realtime) vs identity-guard (chunked/subtitle)
// predicates as a table test. They are NOT interchangeable (research 02 §4):
//   • realtime dual-guard:   token !== pageToken && session?.token !== token
//   • chunked identity-guard: s !== session || s.stopFlag
// The discriminator: a just-swapped handover session (token < pageToken but
// equal to session.token) must be considered FRESH by the dual-guard but the
// identity-guard keys on object identity + stopFlag instead.
import { describe, it, expect } from "vitest";
import { SessionManager } from "@/content/session-manager";
import type { RealtimeSession, StandardSession } from "@/content/session-manager";

function rt(token: number): RealtimeSession {
  return {
    token,
    pc: null,
    dc: null,
    stream: null,
    remoteAudio: null,
    audioCtx: null,
    outputGain: null,
    kymaSessionId: null,
    kymaKey: "",
    targetLanguage: "vi",
    realtimeVoice: "marin",
  };
}

function std(token: number, stopFlag = false): StandardSession {
  return {
    token,
    type: "standard",
    pc: null,
    dc: null,
    stream: null,
    remoteAudio: null,
    audioCtx: null,
    outputGain: null,
    kymaSessionId: null,
    kymaKey: "",
    recorderMime: "audio/webm",
    activeRecorder: null,
    nextPlayAt: 0,
    stopFlag,
    abortController: new AbortController(),
  };
}

describe("realtime dual-guard — isRealtimeStale(token)", () => {
  it("fresh when token === pageToken", () => {
    const sm = new SessionManager();
    sm.pageToken = 5;
    sm.session = rt(5);
    expect(sm.isRealtimeStale(5)).toBe(false);
  });

  it("STALE when token mismatches AND it isn't the current session's token", () => {
    const sm = new SessionManager();
    sm.pageToken = 6;
    sm.session = rt(6);
    expect(sm.isRealtimeStale(4)).toBe(true);
  });

  it("FRESH for a just-swapped handover session: token<pageToken BUT == session.token (the && quirk)", () => {
    const sm = new SessionManager();
    // After a handover swap the new session owns token 5, but a further token
    // bump pushed pageToken to 6. The dual-guard keeps the new session alive.
    sm.pageToken = 6;
    sm.session = rt(5);
    expect(sm.isRealtimeStale(5)).toBe(false);
  });
});

describe("chunked identity-guard — isIdentityStale(s) / isChunkStale(s,t)", () => {
  it("fresh when s is the active session and not stopped", () => {
    const sm = new SessionManager();
    const s = std(5);
    sm.session = s;
    expect(sm.isIdentityStale(s)).toBe(false);
  });

  it("STALE when stopFlag is set even though it is still the active session", () => {
    const sm = new SessionManager();
    const s = std(5, true);
    sm.session = s;
    expect(sm.isIdentityStale(s)).toBe(true);
  });

  it("STALE when a different session object is now active", () => {
    const sm = new SessionManager();
    const s = std(5);
    sm.session = std(5); // same token, DIFFERENT object
    expect(sm.isIdentityStale(s)).toBe(true);
  });

  it("isChunkStale keys on object identity AND the captured token", () => {
    const sm = new SessionManager();
    const s = std(5);
    sm.session = s;
    expect(sm.isChunkStale(s, 5)).toBe(false);
    s.token = 7; // token drifted from the captured t=5
    expect(sm.isChunkStale(s, 5)).toBe(true);
  });
});

describe("the two idioms are NOT interchangeable (the discriminating case)", () => {
  it("handover session: dual-guard says FRESH, but identity-guard on a DIFFERENT object says STALE", () => {
    const sm = new SessionManager();
    sm.pageToken = 6;
    const live = rt(5);
    sm.session = live;
    // Dual-guard: token 5 belongs to the current session → fresh.
    expect(sm.isRealtimeStale(5)).toBe(false);
    // Identity-guard on a stale object with the SAME token → stale (different
    // object), proving the identity check can't be derived from the token alone.
    const orphan = std(5);
    expect(sm.isIdentityStale(orphan)).toBe(true);
  });
});
