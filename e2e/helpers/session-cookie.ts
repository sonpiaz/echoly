import type { BrowserContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";

const WEB_ORIGIN = process.env.PLAYWRIGHT_WEB_ORIGIN ?? "http://localhost:4321";
const API_ORIGIN = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:8787";

type CookieSetDetails = {
  url: string;
  name: string;
  value: string;
  path: string;
  secure: boolean;
  sameSite: "lax";
};

type CookieGetDetails = { url: string; name: string };
type CookieValue = { value?: string } | null;

type SwChromeApi = {
  cookies: {
    set: (details: CookieSetDetails) => Promise<CookieValue>;
    get: (details: CookieGetDetails) => Promise<CookieValue>;
  };
};

/**
 * Seed ec_session from the extension service worker itself so
 * background `chrome.cookies.get` sees it immediately.
 */
export async function seedEcholySession(
  context: BrowserContext,
  token: string,
): Promise<void> {
  let sw = context.serviceWorkers()[0];
  if (!sw) {
    sw = await context.waitForEvent("serviceworker", { timeout: 30_000 });
  }

  const origins = [WEB_ORIGIN, API_ORIGIN].map((origin) =>
    origin.endsWith("/") ? origin : `${origin}/`,
  );

  await sw.evaluate(
    async ({ origins, token }: { origins: string[]; token: string }) => {
      const api = (globalThis as { chrome?: SwChromeApi }).chrome;
      if (!api) return;
      for (const url of origins) {
        await api.cookies.set({
          url,
          name: "ec_session",
          value: token,
          path: "/",
          secure: url.startsWith("https"),
          sameSite: "lax",
        });
      }
    },
    { origins, token },
  );

  await expect
    .poll(
      async () =>
        sw!.evaluate(
          async (url: string) => {
            const api = (globalThis as { chrome?: SwChromeApi }).chrome;
            if (!api) return false;
            return Boolean((await api.cookies.get({ url, name: "ec_session" }))?.value);
          },
          origins[0]!,
        ),
      { timeout: 15_000 },
    )
    .toBe(true);
}

/** Wait until popup reflects a signed-in background snapshot. */
export async function waitForPopupSignedIn(
  popup: Page,
  timeoutMs = 30_000,
): Promise<void> {
  const body = popup.locator("body");
  await expect(body).toHaveAttribute("data-account", "in", { timeout: timeoutMs });
}
