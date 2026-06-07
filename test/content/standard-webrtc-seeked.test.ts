// @vitest-environment jsdom
//
// FIX 3 (Bug B2 — seek desync, Standard-WebRTC): startWebRtcSession now binds an
// onSeeked handler that, for a Standard-VOD source (capture.isLive=false), calls
// standardDubSync.snapPlaybackStart() so the drift-corrector re-anchors instead
// of ramping playbackRate to chase a gap the dub stream can't close (runaway
// desync). For a LIVE source (isLive=true) it must NOT snap (live has no sync
// engine to re-anchor).
//
// We drive the REAL ContentApp.bindCommonVideoListeners with the EXACT onSeeked
// closure startWebRtcSession installs (index.ts ~707-717), then fire a real
// `seeked` DOM event on a real <video> element — exercising the full wiring
// (bindCommonVideoListeners → bindSourceVideoPlayback → addEventListener("seeked")
// → onSeeked → isLive gate → snapPlaybackStart). The pre-fix code bound NO
// onSeeked handler, so this test fails without the fix (snap never called).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { resetChrome } from "../setup";
import { ContentApp } from "@/content/index";
import type { StandardDubPlaybackSyncHandle } from "@/lib/dub-playback-sync";
import type { Session } from "@/content/session-manager";

function makeDubSync(): StandardDubPlaybackSyncHandle & {
  snapPlaybackStart: ReturnType<typeof vi.fn>;
} {
  return {
    snapPlaybackStart: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    waitForFirstDub: vi.fn().mockResolvedValue(true),
  } as unknown as StandardDubPlaybackSyncHandle & {
    snapPlaybackStart: ReturnType<typeof vi.fn>;
  };
}

/**
 * Reproduce the EXACT onSeeked closure startWebRtcSession installs at index.ts
 * ~707-717 and bind it through the real ContentApp.bindCommonVideoListeners.
 * Keeping the closure identical here (gated on capture.isLive(video)) means the
 * test breaks if the production gate is ever loosened/removed.
 */
function bindStandardSeeked(app: ContentApp, video: HTMLVideoElement): void {
  const session = { token: 1 } as unknown as Session;
  app.bindCommonVideoListeners(video, session, {
    onSeeked: () => {
      if (!app.capture.isLive(video)) {
        app.standardDubSync?.snapPlaybackStart();
      }
    },
  });
}

describe("startWebRtcSession onSeeked — Standard-VOD re-anchor gate (FIX 3, Bug B2)", () => {
  beforeEach(() => {
    resetChrome();
  });

  it("Standard-VOD (isLive=false): a `seeked` event calls standardDubSync.snapPlaybackStart()", () => {
    const app = new ContentApp();
    const video = document.createElement("video");
    const dubSync = makeDubSync();
    app.standardDubSync = dubSync;
    vi.spyOn(app.capture, "isLive").mockReturnValue(false);

    bindStandardSeeked(app, video);

    // A user seek fires the `seeked` DOM event.
    video.dispatchEvent(new Event("seeked"));

    expect(dubSync.snapPlaybackStart).toHaveBeenCalledTimes(1);
  });

  it("LIVE (isLive=true): a `seeked` event does NOT call snapPlaybackStart()", () => {
    const app = new ContentApp();
    const video = document.createElement("video");
    const dubSync = makeDubSync();
    app.standardDubSync = dubSync;
    vi.spyOn(app.capture, "isLive").mockReturnValue(true);

    bindStandardSeeked(app, video);

    video.dispatchEvent(new Event("seeked"));

    expect(dubSync.snapPlaybackStart).not.toHaveBeenCalled();
  });

  it("does not throw when standardDubSync is null (defensive ?. chain)", () => {
    const app = new ContentApp();
    const video = document.createElement("video");
    app.standardDubSync = null;
    vi.spyOn(app.capture, "isLive").mockReturnValue(false);

    bindStandardSeeked(app, video);

    expect(() => video.dispatchEvent(new Event("seeked"))).not.toThrow();
  });

  it("repeated seeks each re-anchor (VOD)", () => {
    const app = new ContentApp();
    const video = document.createElement("video");
    const dubSync = makeDubSync();
    app.standardDubSync = dubSync;
    vi.spyOn(app.capture, "isLive").mockReturnValue(false);

    bindStandardSeeked(app, video);

    video.dispatchEvent(new Event("seeked"));
    video.dispatchEvent(new Event("seeked"));
    video.dispatchEvent(new Event("seeked"));

    expect(dubSync.snapPlaybackStart).toHaveBeenCalledTimes(3);
  });

  // ── Source-of-truth guard ────────────────────────────────────────────────────
  // The tests above drive the EXACT onSeeked closure rather than the heavyweight
  // startWebRtcSession (which builds a real RTCPeerConnection). To ensure the
  // production binding itself is not silently removed/loosened, statically assert
  // that startWebRtcSession's bindCommonVideoListeners call passes an onSeeked that
  // snaps under the !isLive gate. Fails if FIX 3 is reverted in the source.
  it("FIX3 source guard: startWebRtcSession binds onSeeked → !isLive → snapPlaybackStart", () => {
    // process.cwd() is the package root under vitest; robust across the node +
    // jsdom test environments (import.meta.url is not a file: URL under jsdom).
    const src = readFileSync(
      resolve(process.cwd(), "src/content/index.ts"),
      "utf8",
    );
    // The bound onSeeked closure must call snapPlaybackStart gated on !isLive(video).
    expect(src).toMatch(/onSeeked:\s*\(\)\s*=>\s*\{[\s\S]*?if\s*\(\s*!this\.capture\.isLive\(video\)\s*\)\s*\{[\s\S]*?this\.standardDubSync\?\.snapPlaybackStart\(\)/);
  });
});
