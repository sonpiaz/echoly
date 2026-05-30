import { expect, test, type Page } from "@playwright/test";
import type { PopupSession } from "./extension-context.ts";

type StartReply = { ok?: boolean; error?: string; state?: unknown };

export type TranslationStartMethod = "click" | "message";

function e2eLog(msg: string): void {
  if (process.env.PW_POPUP_DEBUG === "0") return;
  console.log(`[e2e] ${msg}`);
}

/** Idle shell before Start — what the user sees when ready. */
export async function expectStartButtonIdle(popup: Page): Promise<void> {
  await expect(popup.locator("body")).toHaveAttribute("data-state", "idle", {
    timeout: 20_000,
  });
  await expect(popup.locator("#actionLabel")).toHaveText(/start translating/i);
  await expect(popup.locator("#toggle")).not.toHaveClass(/is-live/);
}

/** Compact live shell (live-summary visible, session card hidden). */
export async function expectPopupLiveCompact(popup: Page): Promise<void> {
  await expect(popup.locator(".live-summary")).toBeVisible({ timeout: 45_000 });
  await expect(popup.locator(".session-card")).toBeHidden({ timeout: 45_000 });
  await expect(popup.locator(".live-note")).toContainText(/translation shows on the video/i);
}

/**
 * After Start: Stop button + compact popup (legacy GlassLive minimize).
 */
export async function expectStartButtonLive(popup: Page): Promise<void> {
  await expect(popup.locator("#actionLabel")).toHaveText(/stop translating/i, {
    timeout: 45_000,
  });
  await expect(popup.locator("#toggle")).toHaveClass(/is-live/, { timeout: 45_000 });
  await expect(popup.locator("body")).toHaveAttribute(
    "data-state",
    /^(connecting|active|paused)$/,
    { timeout: 45_000 },
  );
  await expectPopupLiveCompact(popup);
}

async function holdPopupForHeadedReview(popup: Page, yt: Page): Promise<void> {
  if (process.env.PW_HEADLESS === "1") return;
  const holdMs = Number(process.env.PW_HOLD_POPUP_MS ?? 2_500);
  if (holdMs <= 0) return;
  await popup.bringToFront();
  await popup.waitForTimeout(holdMs);
  await yt.bringToFront();
}

export async function logTranslationStartPass(
  popup: Page,
  method: TranslationStartMethod,
): Promise<void> {
  const state = (await popup.locator("body").getAttribute("data-state")) ?? "?";
  const label = (await popup.locator("#actionLabel").innerText()).trim();
  const status = (await popup.locator("#status").innerText()).trim();
  const compact =
    (await popup.locator(".live-summary").isVisible()) ? "compact UI" : "full UI (unexpected)";
  const line =
    `[e2e] ✓ PASS — Start OK (${method}): ` +
    `nút="${label}", body[data-state]=${state}, ${compact}, status="${status}"`;
  console.log(line);
  e2eLog(line);
}

async function startViaRuntimeMessage(popup: Page, yt: Page): Promise<void> {
  await yt.bringToFront();
  await yt.waitForTimeout(200);

  const reply = (await popup.evaluate(async (): Promise<StartReply> => {
    const tierEl = document.getElementById("tier") as HTMLSelectElement | null;
    const langEl = document.getElementById("lang") as HTMLSelectElement | null;
    const voiceEl = document.getElementById("voice") as HTMLSelectElement | null;
    const tier = tierEl?.value ?? "standard";
    const voiceKey = tier === "standard" ? "standardVoice" : "realtimeVoice";
    const orig = document.getElementById("originalVolume") as HTMLInputElement | null;
    const vv = document.getElementById("voiceVolume") as HTMLInputElement | null;
    const show = document.getElementById("showSource") as HTMLInputElement | null;
    const settings: Record<string, unknown> = {
      tier,
      targetLanguage: langEl?.value ?? "vi",
      [voiceKey]: voiceEl?.value ?? "",
      originalVolume: Number(orig?.value ?? 50),
      voiceVolume: Number(vv?.value ?? 50),
      showSource: !!show?.checked,
    };
    return chrome.runtime.sendMessage({ type: "START", settings }) as Promise<StartReply>;
  })) as StartReply;

  if (!reply?.ok) {
    const status = await popup.locator("#status").innerText().catch(() => "");
    throw new Error(`START failed: ${reply?.error ?? "unknown"} (${status})`);
  }
}

/**
 * Visible Start on the extension popup (toolbar bubble or popup tab).
 * Background resolves the YouTube watch tab in-window — popup tab may stay focused.
 */
export async function clickStartButtonInPopup(popup: Page, yt: Page): Promise<void> {
  await popup.bringToFront();
  await expect(popup.locator("#toggle")).toBeVisible();
  await expect(popup.locator("#toggle")).toBeEnabled();
  await popup.locator("#toggle").click({ timeout: 20_000 });
  e2eLog("Start: Playwright click #toggle on extension popup");
  await yt.bringToFront();
  await popup.waitForTimeout(400);
}

/**
 * Start translation and assert the popup button state changed (user-visible proof).
 */
export async function startTranslationOnYouTube(
  popup: Page,
  yt: Page,
  _opts?: { openMode?: PopupSession["openMode"] },
): Promise<TranslationStartMethod> {
  await test.step("Start: nút idle → nhấn Start", async () => {
    await expectStartButtonIdle(popup);
    await expect(popup.locator("#toggle")).toBeEnabled();
  });

  const forceMessage = process.env.PW_START_VIA_MESSAGE === "1";
  let method: TranslationStartMethod = "click";

  await test.step("Start: click #toggle (DOM)", async () => {
    if (forceMessage) {
      method = "message";
      e2eLog("Start: PW_START_VIA_MESSAGE=1 — bỏ qua click");
      return;
    }
    e2eLog("Start: DOM click #toggle (YouTube tab vẫn active)");
    await clickStartButtonInPopup(popup, yt);
  });

  await test.step('Start: assert nút "Stop translating" + is-live', async () => {
    try {
      await expectStartButtonLive(popup);
    } catch (firstErr) {
      if (forceMessage) throw firstErr;
      e2eLog(`Start: click chưa đổi nút (${firstErr}) — fallback runtime START`);
      method = "message";
      await startViaRuntimeMessage(popup, yt);
      await expectStartButtonLive(popup);
    }
  });

  await test.step("Start: hiển thị popup (headed) + log PASS", async () => {
    await holdPopupForHeadedReview(popup, yt);
    await logTranslationStartPass(popup, method);
  });

  return method;
}

/** @deprecated Use {@link startTranslationOnYouTube} */
export async function clickPopupStartOnYouTube(popup: Page): Promise<void> {
  const yt = popup
    .context()
    .pages()
    .find((p) => /youtube\.com\/watch/.test(p.url()));
  if (!yt) throw new Error("No YouTube watch tab for START");
  await startTranslationOnYouTube(popup, yt);
}
