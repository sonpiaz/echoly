/**
 * Single serial product suite — one browser, no duplicate tier/auth/voice specs.
 *
 * Covers: signed-out shells → FREE gate → PRO Standard voice → MAX Realtime voice → sign-out.
 *
 * Prereqs: Postgres, API :8787 (RTC_PEER_IMPL=mediasoup for Max step), provider keys.
 * Headed: npm run test:e2e
 * CI headless: npm run test:e2e:ci
 */
import { test, expect } from "@playwright/test";
import {
  closeExtensionContext,
  launchExtensionContext,
  openExtensionPopup,
  reopenActionPopupForStart,
  reloadExtensionPopup,
  type ExtensionFixtures,
} from "./helpers/extension-context.ts";
import { devUserToken } from "./helpers/dev-token.ts";
import {
  expectPlanBadge,
  expectRealtimeTierGated,
  expectStartBlockedForRealtime,
  expectUsageHintVisible,
  signOutFromPopup,
} from "./helpers/popup-account.ts";
import { seedEcholySession, waitForPopupSignedIn } from "./helpers/session-cookie.ts";
import { seedHasEverSignedIn } from "./helpers/storage.ts";
import {
  prepareYouTubeHost,
  runRealtimeVoiceOnYouTube,
  runStandardVoiceOnYouTube,
  stopTranslationOnYouTube,
} from "./helpers/voice-session.ts";

const skipVoice = process.env.PW_SKIP_VOICE === "1";
const skipRealtime = process.env.PW_SKIP_REALTIME === "1" || skipVoice;

test.describe.serial("Echoly product E2E", () => {
  test.setTimeout(skipVoice ? 90_000 : 600_000);

  let fix: ExtensionFixtures;
  let ytPage: import("@playwright/test").Page | undefined;

  test.afterAll(async () => {
    if (fix) await closeExtensionContext(fix);
  });

  test("signed-out shells (welcome → locked)", async () => {
    fix = await launchExtensionContext();
    const { popup } = await openExtensionPopup(fix.context, fix.extensionId);
    await expect(popup.locator("body")).toHaveAttribute(
      "data-account",
      /welcome|locked/,
      { timeout: 15_000 },
    );

    await seedHasEverSignedIn(fix.context);
    await reloadExtensionPopup(popup);
    await expect(popup.locator("body")).toHaveAttribute("data-account", "locked", {
      timeout: 15_000,
    });
    await expect(popup.locator("#lockedCtaSigninBtn")).toBeVisible();
  });

  test("FREE — badge, usage, Realtime gated at Start", async () => {
    const token = devUserToken(`ext-free-${Date.now()}@echoly.test`, "free");
    await seedEcholySession(fix.context, token);
    const { popup } = await openExtensionPopup(fix.context, fix.extensionId);
    await waitForPopupSignedIn(popup);
      await expectPlanBadge(popup, "free");
      await expect(popup.locator("#tier")).toHaveValue("standard");
      await expectUsageHintVisible(popup);
    await expectRealtimeTierGated(popup);
    await expectStartBlockedForRealtime(popup);
  });

  test("PRO — Standard Start → dubbed speech on YouTube", async () => {
    test.skip(skipVoice, "PW_SKIP_VOICE=1");

    const token = devUserToken(`ext-pro-${Date.now()}@echoly.test`, "pro");
    await seedEcholySession(fix.context, token);

    ytPage = ytPage ?? (await fix.context.newPage());
    await prepareYouTubeHost(ytPage);

    let { popup, openMode } = await openExtensionPopup(fix.context, fix.extensionId, {
      host: ytPage,
    });
    await waitForPopupSignedIn(popup);
    await expectPlanBadge(popup, "pro");
    await expect(popup.locator("#tier")).toHaveValue("standard");

    if (openMode === "page") {
      ({ popup, openMode } = await reopenActionPopupForStart(
        fix.context,
        fix.extensionId,
        ytPage,
        popup,
      ));
      await waitForPopupSignedIn(popup);
    }

    await runStandardVoiceOnYouTube(ytPage, popup, { openMode });
    await stopTranslationOnYouTube(ytPage, popup);
  });

  test("MAX — Realtime Start → WebRTC dub on YouTube", async () => {
    test.skip(skipRealtime, "PW_SKIP_REALTIME=1 or PW_SKIP_VOICE=1");

    const token = devUserToken(`ext-max-${Date.now()}@echoly.test`, "max");
    await seedEcholySession(fix.context, token);

    ytPage = ytPage ?? (await fix.context.newPage());
    await prepareYouTubeHost(ytPage);

    let { popup, openMode } = await openExtensionPopup(fix.context, fix.extensionId, {
      host: ytPage,
    });
    await waitForPopupSignedIn(popup);
    await expectPlanBadge(popup, "max");

    if (openMode === "page") {
      ({ popup, openMode } = await reopenActionPopupForStart(
        fix.context,
        fix.extensionId,
        ytPage,
        popup,
      ));
      await waitForPopupSignedIn(popup);
    }

    await runRealtimeVoiceOnYouTube(ytPage, popup, { openMode });
    await stopTranslationOnYouTube(ytPage, popup);
  });

  test("sign-out → locked shell", async () => {
    const token = devUserToken(`ext-out-${Date.now()}@echoly.test`, "pro");
    await seedEcholySession(fix.context, token);
    const { popup } = await openExtensionPopup(fix.context, fix.extensionId);
    await waitForPopupSignedIn(popup);
    await signOutFromPopup(popup);
    await expect(popup.locator("#toggle")).toBeHidden();
  });
});
