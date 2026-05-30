/**
 * Standard tier → WebRTC (tab capture → POST /v1/rtc/translate?pipeline=standard).
 *
 * Set PW_YOUTUBE_CHUNKED_URL to a watch URL (VOD or live).
 */
import { test, expect } from "@playwright/test";
import { devUserToken } from "./helpers/dev-token.ts";
import {
  closeExtensionContext,
  launchExtensionContext,
  openExtensionPopup,
} from "./helpers/extension-context.ts";
import {
  seedEcholySession,
  waitForPopupSignedIn,
} from "./helpers/session-cookie.ts";
import { openYouTubeWatch, waitForContentScript, waitForOverlay } from "./helpers/youtube.ts";
import { clickPopupStartOnYouTube } from "./helpers/youtube-tab.ts";
import {
  waitForDubAudioProgress,
  waitForOverlayTargetText,
  waitForStandardPipelineApi,
} from "./helpers/voice-pipeline.ts";

const WATCH_URL =
  process.env.PW_YOUTUBE_CHUNKED_URL ??
  process.env.PW_YOUTUBE_NO_CC_URL ??
  "";

test.describe("YouTube — Standard WebRTC dubbing", () => {
  test.setTimeout(300_000);

  test.skip(() => !WATCH_URL, "Set PW_YOUTUBE_CHUNKED_URL to a YouTube watch URL");

  test("Standard Start negotiates rtc/translate (standard) and plays dub audio", async () => {
    const token = devUserToken(`ext-voice-std-${Date.now()}@echoly.test`, "pro");
    const fix = await launchExtensionContext();
    try {
      await seedEcholySession(fix.context, token);

      const yt = await fix.context.newPage();
      await openYouTubeWatch(yt, WATCH_URL);
      await yt.locator("video").click({ timeout: 10_000 }).catch(() => {});

      const { popup } = await openExtensionPopup(fix.context, fix.extensionId, {
        host: yt,
        hostUrl: WATCH_URL,
      });
      await waitForPopupSignedIn(popup);

      await popup.locator("#tier").selectOption("standard");
      await popup.locator("#tier").dispatchEvent("change");

      const rtcWait = waitForStandardPipelineApi(yt, 240_000);

      await clickPopupStartOnYouTube(popup);
      await waitForContentScript(yt);
      await waitForOverlay(yt);

      const rtcRes = await rtcWait;
      expect(rtcRes.ok()).toBeTruthy();

      await waitForDubAudioProgress(yt, 240_000);
      await waitForOverlayTargetText(yt, 240_000);
    } finally {
      await closeExtensionContext(fix);
    }
  });
});
