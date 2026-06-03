// @vitest-environment jsdom
//
// Unit tests for the MAIN-world capture cache, focused on the cross-video
// isolation invariant (Codex P1): captured captions must stay scoped to the
// video they belong to. The `latest` fallback bucket may ONLY hold captures we
// could not key to a videoId — it must never serve a *known different* video's
// data, or a fresh video (whose own request hasn't been captured yet) would be
// dubbed with the previous video's captions.

import { beforeEach, describe, it, expect } from "vitest";
import {
  installYtMainWorldBridge,
  getYtMainWorldData,
  __resetYtMainWorldCache,
} from "@/platforms/youtube/yt-mainworld-cache";

const EVENT = "echoly:yt-capture";

/** Dispatch a capture exactly as the MAIN-world script does (JSON-string detail). */
function capture(detail: Record<string, unknown>): void {
  document.dispatchEvent(
    new CustomEvent(EVENT, { detail: JSON.stringify(detail) }),
  );
}

const timedtextUrl = (videoId: string) =>
  `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&fmt=json3`;

describe("yt-mainworld-cache — cross-video isolation (P1)", () => {
  beforeEach(() => {
    __resetYtMainWorldCache();
    installYtMainWorldBridge(); // idempotent
  });

  it("does NOT serve video A's cc-body to a request for video B", () => {
    capture({ kind: "cc-body", url: timedtextUrl("vidA"), body: "BODY_A" });

    const b = getYtMainWorldData("vidB");
    expect(b.ccBodies).toEqual([]);
    expect(b.ccUrls).toEqual([]);
  });

  it("does NOT serve video A's cc-url to a request for video B", () => {
    capture({ kind: "cc-url", url: timedtextUrl("vidA") });

    const b = getYtMainWorldData("vidB");
    expect(b.ccUrls).toEqual([]);
    expect(b.ccBodies).toEqual([]);
  });

  it("does NOT serve video A's captionTracks/poToken to a request for video B", () => {
    capture({
      kind: "player",
      videoId: "vidA",
      poToken: "POT_A",
      captionTracks: [{ baseUrl: timedtextUrl("vidA"), languageCode: "en", kind: "asr" }],
    });

    const b = getYtMainWorldData("vidB");
    expect(b.captionTracks).toBeUndefined();
    expect(b.poToken).toBeUndefined();
  });

  it("still serves the SAME video's captures (no false negative)", () => {
    capture({ kind: "cc-body", url: timedtextUrl("vidA"), body: "BODY_A" });
    capture({ kind: "cc-url", url: timedtextUrl("vidA") });
    capture({
      kind: "player",
      videoId: "vidA",
      poToken: "POT_A",
      captionTracks: [{ baseUrl: timedtextUrl("vidA"), languageCode: "en", kind: "asr" }],
    });

    const a = getYtMainWorldData("vidA");
    expect(a.ccBodies).toEqual([{ url: timedtextUrl("vidA"), body: "BODY_A" }]);
    expect(a.ccUrls).toEqual([timedtextUrl("vidA")]);
    expect(a.captionTracks).toHaveLength(1);
    expect(a.poToken).toBe("POT_A");
  });

  it("a later video's capture does not overwrite an earlier video's per-video entry", () => {
    capture({ kind: "cc-body", url: timedtextUrl("vidA"), body: "BODY_A" });
    capture({ kind: "cc-body", url: timedtextUrl("vidB"), body: "BODY_B" });

    expect(getYtMainWorldData("vidA").ccBodies).toEqual([
      { url: timedtextUrl("vidA"), body: "BODY_A" },
    ]);
    expect(getYtMainWorldData("vidB").ccBodies).toEqual([
      { url: timedtextUrl("vidB"), body: "BODY_B" },
    ]);
  });
});

describe("yt-mainworld-cache — unkeyed fallback preserved", () => {
  beforeEach(() => {
    __resetYtMainWorldCache();
    installYtMainWorldBridge();
  });

  it("serves an un-keyed cc-body (URL with no v=) as a last-resort fallback for any video", () => {
    // No `v=` param → not keyable → lands in `latest`.
    capture({
      kind: "cc-body",
      url: "https://www.youtube.com/api/timedtext?lang=en&fmt=json3",
      body: "UNKEYED_BODY",
    });

    const got = getYtMainWorldData("any-video-id");
    expect(got.ccBodies).toEqual([
      { url: "https://www.youtube.com/api/timedtext?lang=en&fmt=json3", body: "UNKEYED_BODY" },
    ]);
  });

  it("serves an un-keyed player response (no videoId) as a fallback for any video", () => {
    capture({
      kind: "player",
      poToken: "POT_UNKEYED",
      captionTracks: [{ baseUrl: "https://www.youtube.com/api/timedtext?lang=en", languageCode: "en" }],
    });

    const got = getYtMainWorldData("any-video-id");
    expect(got.poToken).toBe("POT_UNKEYED");
    expect(got.captionTracks).toHaveLength(1);
  });

  it("prefers the per-video entry over the un-keyed fallback when both exist", () => {
    capture({ kind: "cc-body", url: "https://www.youtube.com/api/timedtext?lang=en", body: "UNKEYED" });
    capture({ kind: "cc-body", url: timedtextUrl("vidA"), body: "KEYED_A" });

    expect(getYtMainWorldData("vidA").ccBodies).toEqual([
      { url: timedtextUrl("vidA"), body: "KEYED_A" },
    ]);
  });
});
