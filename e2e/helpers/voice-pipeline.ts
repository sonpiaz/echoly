import { expect, type Page } from "@playwright/test";

/** Translated line shown in the overlay (all voice tiers write here). */
export const OVERLAY_TARGET = "aside.ec-root [data-ec-target]";

/** Hidden <audio> used for dubbed playback (WebRTC ontrack). */
export async function waitForDubAudioProgress(
  page: Page,
  timeoutMs = 120_000,
): Promise<void> {
  await page.waitForFunction(
    () => {
      for (const el of document.querySelectorAll("audio")) {
        const a = el as HTMLAudioElement;
        if (a.currentTime > 0.05 && !a.paused) return true;
        if (a.currentTime > 0.2) return true;
      }
      return false;
    },
    { timeout: timeoutMs },
  );
}

/** Status placeholders mirrored in overlay — not real translation output. */
const OVERLAY_STATUS_PLACEHOLDER =
  /^(loading captions|translating\b|preparing voices|preparing translation|ready|connecting|almost ready|paused\.?|press youtube play)/i;

export async function waitForOverlayTargetText(
  page: Page,
  timeoutMs = 120_000,
): Promise<string> {
  const loc = page.locator(OVERLAY_TARGET);
  await expect
    .poll(
      async () => {
        const text = (await loc.innerText()).trim();
        if (!text || OVERLAY_STATUS_PLACEHOLDER.test(text)) return "";
        return text;
      },
      { timeout: timeoutMs },
    )
    .not.toBe("");
  const text = (await loc.innerText()).trim();
  expect(text.length).toBeGreaterThan(2);
  return text;
}

/** Standard tier: tab audio → POST /v1/rtc/translate?pipeline=standard (SDP). */
export function waitForStandardPipelineApi(
  page: Page,
  timeoutMs = 120_000,
): Promise<import("@playwright/test").Response> {
  return page.waitForResponse(
    (r) => {
      const u = r.url();
      return (
        u.includes("/rtc/translate") &&
        u.includes("pipeline=standard") &&
        r.request().method() === "POST" &&
        r.status() >= 200 &&
        r.status() < 500
      );
    },
    { timeout: timeoutMs },
  );
}

export function waitForRtcTranslateOffer(
  page: Page,
  timeoutMs = 90_000,
): Promise<import("@playwright/test").Response> {
  return page.waitForResponse(
    (r) =>
      r.url().includes("/rtc/translate") &&
      r.request().method() === "POST" &&
      r.status() >= 200 &&
      r.status() < 500,
    { timeout: timeoutMs },
  );
}
