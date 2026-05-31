import { expect, test, type Page } from "@playwright/test";
import type { PopupSession } from "./extension-context.ts";
import { selectTranslationTier } from "./popup-account.ts";
import { expectStartButtonIdle, startTranslationOnYouTube } from "./youtube-tab.ts";
import {
  openYouTubeWatch,
  waitForContentScript,
  waitForOverlay,
  YOUTUBE_WATCH_URL,
} from "./youtube.ts";
import {
  waitForDubAudioProgress,
  waitForOverlayTargetText,
  waitForRtcTranslateOffer,
  waitForStandardPipelineApi,
} from "./voice-pipeline.ts";

const VOICE_TIMEOUT = Number(process.env.PW_VOICE_TIMEOUT_MS ?? 180_000);

function e2eLog(msg: string): void {
  if (process.env.PW_POPUP_DEBUG === "0") return;
  console.log(`[e2e] ${msg}`);
}

export async function logVoicePipelinePass(
  tier: "standard" | "realtime",
  targetPreview: string,
): Promise<void> {
  const line =
    `[e2e] ✓✓✓ VOICE TEST PASSED (${tier}) — overlay có bản dịch, dub audio chạy. ` +
    `Dòng: "${targetPreview.slice(0, 72)}${targetPreview.length > 72 ? "…" : ""}"`;
  console.log(line);
  e2eLog(line);
}

export async function prepareYouTubeHost(page: Page): Promise<void> {
  await openYouTubeWatch(page);
  await page.locator("video").click({ timeout: 8_000 }).catch(() => {});
}

export async function configureStandardVi(popup: Page): Promise<void> {
  await selectTranslationTier(popup, "standard");
  await popup.locator("#lang").selectOption("vi");
  await popup.locator("#lang").dispatchEvent("change");
  await popup.waitForTimeout(300);
}

export async function configureRealtimeVi(popup: Page): Promise<void> {
  await expect(popup.locator("#plan-badge")).toHaveAttribute("data-plan", "max", {
    timeout: 20_000,
  });
  // Autostart / stale session pins tier from background — stop first.
  const bodyState = await popup.locator("body").getAttribute("data-state");
  if (bodyState && bodyState !== "idle") {
    await popup.locator("#toggle").click({ timeout: 10_000 }).catch(() => {});
    await expectStartButtonIdle(popup);
  }
  await expect
    .poll(async () => {
      await selectTranslationTier(popup, "realtime");
      return popup.locator("#tier").inputValue();
    })
    .toBe("realtime");
  await popup.locator("#lang").selectOption("vi");
  await popup.locator("#lang").dispatchEvent("change");
  await popup.waitForTimeout(300);
}

export type VoiceSessionOpts = { openMode?: PopupSession["openMode"] };

/** Pro/Free Standard path: CC → translate → TTS on a YouTube watch tab. */
export async function runStandardVoiceOnYouTube(
  yt: Page,
  popup: Page,
  opts?: VoiceSessionOpts,
): Promise<string> {
  await configureStandardVi(popup);
  await expect(popup.locator("#autoStartDomain")).toHaveText("youtube.com", {
    timeout: 12_000,
  });

  await startTranslationOnYouTube(popup, yt, opts);

  await test.step("Standard: overlay + POST /rtc/translate?pipeline=standard", async () => {
    await waitForContentScript(yt, 40_000);
    await waitForOverlay(yt, 90_000);
    const apiRes = await waitForStandardPipelineApi(yt, 120_000);
    console.log(`[e2e] ✓ Standard API: ${apiRes.request().method()} ${apiRes.url()}`);
  });

  let target = "";
  await test.step("Standard: text dịch + audio dub", async () => {
    target = await waitForOverlayTargetText(yt, VOICE_TIMEOUT);
    expect(target.length).toBeGreaterThan(2);
    await waitForDubAudioProgress(yt, 120_000);
    await logVoicePipelinePass("standard", target);
  });
  return target;
}

/** Max Realtime path: WebRTC dubbing. Server must use RTC_PEER_IMPL=mediasoup. */
export async function runRealtimeVoiceOnYouTube(
  yt: Page,
  popup: Page,
  opts?: VoiceSessionOpts,
): Promise<string> {
  await configureRealtimeVi(popup);

  await startTranslationOnYouTube(popup, yt, opts);

  await test.step("Realtime: overlay + /rtc/translate", async () => {
    await waitForContentScript(yt, 40_000);
    await waitForOverlay(yt, 120_000);

    const rtcRes = await waitForRtcTranslateOffer(yt, 120_000).catch(async () => {
      const status = await popup.locator("#status").innerText().catch(() => "");
      throw new Error(`Realtime did not reach /rtc/translate: ${status}`);
    });
    expect(rtcRes.status()).toBeLessThan(500);
  });

  let target = "";
  await test.step("Realtime: text dịch + audio dub", async () => {
    target = await waitForOverlayTargetText(yt, VOICE_TIMEOUT);
    await waitForDubAudioProgress(yt, 120_000);
    await logVoicePipelinePass("realtime", target);
  });

  return target;
}

export async function stopTranslationOnYouTube(yt: Page, popup: Page): Promise<void> {
  await test.step("Stop: overlay Stop → nút về Start dubbing", async () => {
    await yt.bringToFront();
    await yt.locator("aside.ec-root [data-ec-stop]").click({ timeout: 8_000 });
    await expect(yt.locator("aside.ec-root")).toHaveCount(0, { timeout: 25_000 });
    if (!popup.isClosed()) {
      await popup.bringToFront();
      await expect(popup.locator("#actionLabel")).toContainText(/start dubbing/i, {
        timeout: 25_000,
      });
      await expect(popup.locator("#toggle")).not.toHaveClass(/is-live/, { timeout: 25_000 });
      await expect(popup.locator("body")).toHaveAttribute("data-state", "idle", {
        timeout: 25_000,
      });
      e2eLog('✓ PASS — Stop OK: nút về "Start dubbing", overlay đã tắt');
    } else {
      e2eLog("✓ PASS — Stop OK: overlay tắt (popup bubble đã đóng)");
    }
    await yt.bringToFront();
  });
}

export { YOUTUBE_WATCH_URL };
