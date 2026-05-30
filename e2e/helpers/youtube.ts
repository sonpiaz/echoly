import type { Page } from "@playwright/test";

/** Short public YouTube watch URL (stable for content-script injection tests). */
export const YOUTUBE_WATCH_URL =
  process.env.PW_YOUTUBE_URL ?? "https://www.youtube.com/watch?v=jNQXAC9IVRw";

export async function openYouTubeWatch(
  page: Page,
  url: string = YOUTUBE_WATCH_URL,
): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const consent = page.locator(
    'button:has-text("Accept"), button:has-text("Agree"), button:has-text("Reject all")',
  );
  await consent.first().click({ timeout: 5_000 }).catch(() => {});
  await page.locator("video").first().waitFor({ state: "attached", timeout: 45_000 }).catch(() => {});
}

export async function waitForContentScript(page: Page, timeoutMs = 30_000): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as Window & { __echolyContentVersion?: string }).__echolyContentVersion === "string",
    { timeout: timeoutMs },
  );
}

export async function waitForOverlay(page: Page, timeoutMs = 45_000): Promise<void> {
  await page.locator("aside.ec-root").waitFor({ state: "visible", timeout: timeoutMs });
}
