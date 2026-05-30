import { expect, type BrowserContext, type Page } from "@playwright/test";
import { devUserToken } from "./dev-token.ts";
import { openExtensionPopup } from "./extension-context.ts";
import {
  seedEcholySession,
  waitForPopupSignedIn,
} from "./session-cookie.ts";

export type AccountTier = "free" | "pro" | "max";

export async function openSignedInPopup(
  context: BrowserContext,
  extensionId: string,
  tier: AccountTier,
  opts?: { host?: Page; hostUrl?: string; email?: string },
): Promise<{ popup: Page; host: Page; email: string }> {
  const email = opts?.email ?? `ext-${tier}-${Date.now()}@echoly.test`;
  const token = devUserToken(email, tier);
  await seedEcholySession(context, token);
  const { popup, host } = await openExtensionPopup(context, extensionId, opts);
  await waitForPopupSignedIn(popup);
  return { popup, host, email };
}

export async function expectAccountShell(
  popup: Page,
  account: "welcome" | "locked" | "in",
): Promise<void> {
  await expect(popup.locator("body")).toHaveAttribute("data-account", account, {
    timeout: 20_000,
  });
}

export async function expectPlanBadge(popup: Page, tier: AccountTier): Promise<void> {
  await expect(popup.locator("#plan-badge")).toHaveAttribute("data-plan", tier, {
    timeout: 15_000,
  });
  // Max shows "LIVE" while connecting/running (popup applyState).
  const label = tier === "max" ? /^(MAX|LIVE)$/ : new RegExp(`^${tier.toUpperCase()}$`);
  await expect(popup.locator("#plan-badge-text")).toHaveText(label);
}

export async function expectUsageHintVisible(popup: Page): Promise<void> {
  await expect(popup.locator("#usage-hint-row")).toBeVisible({ timeout: 10_000 });
  await expect(popup.locator("#usage-hint-amount")).not.toHaveText(/^\s*$/);
}

export async function selectTranslationTier(
  popup: Page,
  tier: "standard" | "realtime",
): Promise<void> {
  await popup.evaluate((value) => {
    const sel = document.getElementById("tier") as HTMLSelectElement | null;
    if (!sel) return;
    sel.value = value;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }, tier);
  await expect(popup.locator("#tier")).toHaveValue(tier, { timeout: 10_000 });
  await expect(popup.locator("#tier-primary")).toContainText(
    tier === "standard" ? /standard/i : /realtime/i,
    { timeout: 5_000 },
  );
}

export async function expectRealtimeTierGated(popup: Page): Promise<void> {
  await selectTranslationTier(popup, "realtime");
  await expect(popup.locator("#tier-secondary")).toContainText(/max/i, {
    timeout: 10_000,
  });
}

export async function clickStartTranslating(popup: Page): Promise<void> {
  await popup.locator("#toggle").click();
}

export async function expectStartBlockedForRealtime(popup: Page): Promise<void> {
  await clickStartTranslating(popup);
  await expect(popup.locator("body")).toHaveAttribute("data-state", "error", {
    timeout: 15_000,
  });
  await expect(popup.locator("#status")).toContainText(/max|upgrade/i);
}

export async function signOutFromPopup(popup: Page): Promise<void> {
  await popup.locator("#account-trigger").click();
  await popup.locator("#am-signout").click();
  await expectAccountShell(popup, "locked");
  await expect(popup.locator("#plan-badge")).toBeHidden();
  await expect(popup.locator("#lockedCtaSigninBtn")).toBeVisible();
}
