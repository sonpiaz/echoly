/**
 * Voice-only E2E (fast iteration) — fresh browser per tier.
 * Run: npm run test:e2e:voice -- --headed
 */
import { test, expect } from "@playwright/test";
import { devUserToken } from "./helpers/dev-token.ts";
import {
  closeExtensionContext,
  launchExtensionContext,
  openExtensionPopup,
} from "./helpers/extension-context.ts";
import { expectPlanBadge } from "./helpers/popup-account.ts";
import { seedEcholySession, waitForPopupSignedIn } from "./helpers/session-cookie.ts";
import {
  prepareYouTubeHost,
  runRealtimeVoiceOnYouTube,
  runStandardVoiceOnYouTube,
  stopTranslationOnYouTube,
} from "./helpers/voice-session.ts";

test.describe("voice pipelines", () => {
  test.setTimeout(360_000);

  test("PRO · Standard dubbing (voice → WebRTC standard)", async () => {
    const fix = await launchExtensionContext();
    try {
      await seedEcholySession(fix.context, devUserToken(`ext-v-pro-${Date.now()}@echoly.test`, "pro"));
      const yt = await fix.context.newPage();
      await prepareYouTubeHost(yt);
      let { popup, openMode } = await openExtensionPopup(fix.context, fix.extensionId, {
        host: yt,
      });
      await waitForPopupSignedIn(popup);
      await expectPlanBadge(popup, "pro");
      await expect(popup.locator("#tier")).toHaveValue("standard");

      if (openMode === "page") {
        ({ popup, openMode } = await reopenActionPopupForStart(
          fix.context,
          fix.extensionId,
          yt,
          popup,
        ));
        await waitForPopupSignedIn(popup);
      }

      const target = await runStandardVoiceOnYouTube(yt, popup, { openMode });
      expect(target.length).toBeGreaterThan(2);
      await stopTranslationOnYouTube(yt, popup);
    } finally {
      await closeExtensionContext(fix);
    }
  });

  test("MAX · Realtime WebRTC voice-to-voice", async () => {
    test.skip(process.env.PW_SKIP_REALTIME === "1", "PW_SKIP_REALTIME=1");

    const fix = await launchExtensionContext();
    try {
      await seedEcholySession(fix.context, devUserToken(`ext-v-max-${Date.now()}@echoly.test`, "max"));
      const yt = await fix.context.newPage();
      await prepareYouTubeHost(yt);
      let { popup, openMode } = await openExtensionPopup(fix.context, fix.extensionId, {
        host: yt,
      });
      await waitForPopupSignedIn(popup);
      await expectPlanBadge(popup, "max");

      const target = await runRealtimeVoiceOnYouTube(yt, popup, { openMode });
      expect(target.length).toBeGreaterThan(2);
      await stopTranslationOnYouTube(yt, popup);
    } finally {
      await closeExtensionContext(fix);
    }
  });
});
