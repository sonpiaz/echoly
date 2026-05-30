import type { BrowserContext } from "@playwright/test";

const HAS_EVER_SIGNED_IN_KEY = "echoly_has_ever_signed_in";

/** Mark returning-user shell (locked after sign-out, not welcome). */
export async function seedHasEverSignedIn(context: BrowserContext): Promise<void> {
  let sw = context.serviceWorkers()[0];
  if (!sw) {
    sw = await context.waitForEvent("serviceworker", { timeout: 30_000 });
  }
  await sw.evaluate(
    (key) => chrome.storage.local.set({ [key]: true }),
    HAS_EVER_SIGNED_IN_KEY,
  );
}
