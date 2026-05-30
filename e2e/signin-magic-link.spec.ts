/** Optional: real magic-link flow (needs web :4321). Not part of default product suite. */
import { test, expect } from "@playwright/test";
import {
  closeExtensionContext,
  ensureExtensionPopupOpen,
  launchExtensionContext,
  openExtensionPopup,
} from "./helpers/extension-context.ts";
import { assertWebHealthy, magicLinkCallbackUrl } from "./helpers/magic-link.ts";
import { waitForPopupSignedIn } from "./helpers/session-cookie.ts";
import { webSigninUrl } from "./helpers/signin-tab.ts";

const WEB_SIGNIN = /\/signin/;

test.describe("sign-in — magic link (optional)", () => {
  test.beforeAll(async () => {
    await assertWebHealthy();
  });

  test("web sign-in → callback → popup signed in", async () => {
    const email = `ext-magic-${Date.now()}@echoly.test`;
    const fix = await launchExtensionContext();
    try {
      const { popup, host } = await openExtensionPopup(fix.context, fix.extensionId);
      await popup.locator("#welcomeSigninBtn, #lockedCtaSigninBtn").first().click();

      const signinTab =
        fix.context.pages().find((p) => WEB_SIGNIN.test(p.url())) ??
        (await fix.context.waitForEvent("page", {
          predicate: (p) => WEB_SIGNIN.test(p.url()),
          timeout: 20_000,
        }));

      if (!WEB_SIGNIN.test(signinTab.url())) await signinTab.goto(webSigninUrl());
      await signinTab.locator("#email").fill(email);
      const post = signinTab.waitForResponse(
        (r) => r.url().includes("/auth/sign-in") && r.request().method() === "POST",
        { timeout: 20_000 },
      );
      await signinTab.locator("#submit").click();
      expect((await post).ok()).toBeTruthy();

      await signinTab.goto(magicLinkCallbackUrl(email));
      await signinTab.waitForURL(/\/account/, { timeout: 25_000 });

      const popupAfter = await ensureExtensionPopupOpen(
        fix.context,
        fix.extensionId,
        host,
        popup,
      );
      await waitForPopupSignedIn(popupAfter);
    } finally {
      await closeExtensionContext(fix);
    }
  });
});
