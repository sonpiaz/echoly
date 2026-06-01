/**
 * Optional: login-code (OTP) sign-in flow (needs web :4321 + server :8787).
 * Not part of the default product suite — runs only when ECHOLY_E2E_CODE is set.
 *
 * ─── Why this test is skipped by default ─────────────────────────────────────
 *
 * The 6-digit login code is hashed before storage (SHA-256 + salt); the
 * plaintext is never persisted to the DB. It is therefore impossible to read
 * the code back from login_codes for automated testing.
 *
 * To run this test you need a dev code source — two options:
 *
 *   Option A (recommended): implement a NON_PROD-only server endpoint
 *     POST /dev/latest-login-code-plaintext (guarded by NODE_ENV !== 'production'
 *     and a DEV_BACKDOOR_TOKEN). That endpoint echoes the last emitted code
 *     via an in-process hook (no DB read). Set ECHOLY_E2E_DEV_ENDPOINT=true
 *     and the test will call it to obtain the code.
 *
 *   Option B: manually supply ECHOLY_E2E_CODE=<6-digit code> in the env and
 *     use a fixed test-account email. Useful for one-off smoke runs.
 *
 * When neither is available (CI without the dev endpoint), the test is skipped
 * with a clear message rather than failing.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { test, expect } from "@playwright/test";
import {
  closeExtensionContext,
  ensureExtensionPopupOpen,
  launchExtensionContext,
  openExtensionPopup,
} from "./helpers/extension-context.ts";
import { assertWebHealthy, requestLoginCode } from "./helpers/login-code.ts";
import { waitForPopupSignedIn } from "./helpers/session-cookie.ts";
import { webSigninUrl } from "./helpers/signin-tab.ts";

const WEB_ORIGIN = process.env.PLAYWRIGHT_WEB_ORIGIN ?? "http://localhost:4321";
const WEB_SIGNIN = /\/signin/;

// ─── Code source resolution ──────────────────────────────────────────────────
//
// Returns the 6-digit code string, or null if no dev source is configured.
// In that case the test will be skipped.

async function resolveLoginCode(email: string): Promise<string | null> {
  // Option B: manually supplied via env (one-off smoke).
  const envCode = process.env.ECHOLY_E2E_CODE?.trim();
  if (envCode) return envCode;

  // Option A: dev server endpoint (NODE_ENV !== 'production', guarded by token).
  // TODO: implement this once Agent C / server-src ships the dev endpoint:
  //   POST /dev/latest-login-code-plaintext { email, token: DEV_BACKDOOR_TOKEN }
  // When that endpoint exists, set ECHOLY_E2E_DEV_ENDPOINT=true in your .env.
  if (process.env.ECHOLY_E2E_DEV_ENDPOINT === "true") {
    const apiBase = (process.env.PLAYWRIGHT_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
    const devToken = process.env.DEV_BACKDOOR_TOKEN ?? "";
    const res = await fetch(`${apiBase}/dev/latest-login-code-plaintext`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, token: devToken }),
    });
    if (res.ok) {
      const body = await res.json() as { code?: string };
      if (body.code) return body.code;
    }
    // Endpoint exists but returned no code — fall through to skip.
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────

test.describe("sign-in — login code (optional)", () => {
  test.beforeAll(async () => {
    await assertWebHealthy();
  });

  test("web sign-in → enter 6-digit code → popup signed in", async () => {
    // Skip immediately if no dev code source is available — prefer an honest
    // skip over a broken test that times out or makes bogus assertions.
    const email = `ext-login-code-${Date.now()}@echoly.test`;

    const fix = await launchExtensionContext();
    try {
      const { popup, host } = await openExtensionPopup(fix.context, fix.extensionId);
      await popup.locator("#welcomeSigninBtn, #lockedCtaSigninBtn").first().click();

      // Wait for the web signin tab opened by the extension (OPEN_SIGNIN message).
      const signinTab =
        fix.context.pages().find((p) => WEB_SIGNIN.test(p.url())) ??
        (await fix.context.waitForEvent("page", {
          predicate: (p) => WEB_SIGNIN.test(p.url()),
          timeout: 20_000,
        }));

      if (!WEB_SIGNIN.test(signinTab.url())) await signinTab.goto(webSigninUrl());

      // ── Step A: fill email + request code ──────────────────────────────────
      await signinTab.locator("#email").fill(email);
      const requestPost = signinTab.waitForResponse(
        (r) => r.url().includes("/auth/sign-in") && r.request().method() === "POST",
        { timeout: 20_000 },
      );
      await signinTab.locator("#submit").click();
      expect((await requestPost).ok()).toBeTruthy();

      // Also call requestLoginCode directly so the dev code source sees a real
      // code in the system (the web form call above is the authoritative one;
      // this ensures the server has issued a code even in bypass scenarios).
      await requestLoginCode(email);

      // ── Resolve code — skip if unavailable ─────────────────────────────────
      const code = await resolveLoginCode(email);
      if (!code) {
        test.skip(
          true,
          [
            "Login code not available for e2e: plaintext is never stored in the DB.",
            "To enable this test set one of:",
            "  ECHOLY_E2E_CODE=<6-digit-code>          (manual/one-off smoke)",
            "  ECHOLY_E2E_DEV_ENDPOINT=true + DEV_BACKDOOR_TOKEN=<tok>  (dev server hook)",
            "See extension/e2e/helpers/login-code.ts and server/scripts/dev-latest-login-code.ts.",
          ].join("\n"),
        );
        return; // unreachable after skip, but keeps TS flow happy
      }

      // ── Step B: fill the 6-digit code input + submit ───────────────────────
      const codeInput = signinTab.locator(
        "input[autocomplete='one-time-code'], input[inputmode='numeric'][maxlength='6']",
      );
      await codeInput.waitFor({ state: "visible", timeout: 15_000 });
      await codeInput.fill(code);

      const verifyPost = signinTab.waitForResponse(
        (r) =>
          (r.url().includes("/api/auth/verify-code") || r.url().includes("/auth/sign-in/verify-code")) &&
          r.request().method() === "POST",
        { timeout: 20_000 },
      );

      // The web page auto-submits on 6 digits; if it doesn't, click Verify.
      const verifyBtn = signinTab.locator("button[type='submit']:has-text('Verify')");
      const autoSubmitOrManual = Promise.race([
        verifyPost,
        verifyBtn.waitFor({ state: "visible", timeout: 3_000 }).then(async () => {
          await verifyBtn.click();
          return verifyPost;
        }),
      ]);
      const verifyResponse = await autoSubmitOrManual;
      // verifyResponse is either the Response or a Promise<Response> (race branch)
      const resolved = verifyResponse instanceof Response
        ? verifyResponse
        : await (verifyResponse as unknown as Promise<Response>);
      expect(resolved.ok()).toBeTruthy();

      // After verify-code the web page navigates to /account and the Set-Cookie
      // lands on .echolyhq.com / localhost — the tab should close automatically.
      await signinTab.waitForURL(/\/(account|$)/, { timeout: 25_000 }).catch(() => {
        // Tab may close before URL change resolves — that's also success.
      });

      // ── Assert popup now shows signed-in ───────────────────────────────────
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
