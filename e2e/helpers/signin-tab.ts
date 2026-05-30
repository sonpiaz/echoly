import type { BrowserContext, Page } from "@playwright/test";

const WEB_ORIGIN = process.env.PLAYWRIGHT_WEB_ORIGIN ?? "http://localhost:4321";

/** Tab opened by background OPEN_SIGNIN → chrome.tabs.create(signin). */
export async function waitForSigninTab(
  context: BrowserContext,
  timeoutMs = 30_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tab = context.pages().find((p) => /\/signin/.test(p.url()));
    if (tab) return tab;
    await new Promise((r) => setTimeout(r, 200));
  }
  const urls = context.pages().map((p) => p.url()).join(", ");
  throw new Error(`No /signin tab within ${timeoutMs}ms (pages: ${urls})`);
}

export function webSigninUrl(): string {
  const base = WEB_ORIGIN.replace(/\/$/, "");
  return `${base}/signin`;
}
