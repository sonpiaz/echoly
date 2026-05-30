import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { assertExtensionBuild } from "./paths.ts";

export interface ExtensionFixtures {
  context: BrowserContext;
  extensionId: string;
  userDataDir: string;
}

/** Host + popup pair used by most E2E specs. */
export interface PopupSession {
  popup: Page;
  host: Page;
  /** How the popup document was opened (for debugging). */
  openMode: "action" | "toolbar" | "page";
}

const DEFAULT_HOST =
  "https://www.youtube.com/watch?v=jNQXAC9IVRw";

const POPUP_PATH_SUFFIX = "/popup.html";

function popupUrl(extensionId: string): string {
  return `chrome-extension://${extensionId}${POPUP_PATH_SUFFIX}`;
}

function isExtensionPopupUrl(url: string, extensionId: string): boolean {
  return (
    url.startsWith(`chrome-extension://${extensionId}/`) &&
    url.includes("popup")
  );
}

function findPopupPage(
  context: BrowserContext,
  extensionId: string,
): Page | undefined {
  for (const page of context.pages()) {
    if (!page.isClosed() && isExtensionPopupUrl(page.url(), extensionId)) {
      return page;
    }
  }
  return undefined;
}

/** Close Playwright-tracked popup tabs so `openPopup()` is not blocked. */
async function closeTrackedPopupPages(
  context: BrowserContext,
  extensionId: string,
): Promise<void> {
  for (const page of [...context.pages()]) {
    if (!page.isClosed() && isExtensionPopupUrl(page.url(), extensionId)) {
      await page.close().catch(() => {});
    }
  }
}

/**
 * Wait until Playwright exposes the popup document (action bubble or tab).
 * Mirrors Puppeteer's `browser.waitForTarget(... popup.html)`.
 */
async function waitForExtensionPopupPage(
  context: BrowserContext,
  extensionId: string,
  timeoutMs: number,
): Promise<Page | null> {
  const existing = findPopupPage(context, extensionId);
  if (existing) return existing;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (page: Page | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      context.off("page", onPage);
      resolve(page);
    };

    const onPage = (page: Page) => {
      if (isExtensionPopupUrl(page.url(), extensionId)) {
        void page.waitForLoadState("domcontentloaded").catch(() => {});
        finish(page);
      }
    };

    context.on("page", onPage);

    const poll = setInterval(() => {
      const page = findPopupPage(context, extensionId);
      if (page) finish(page);
    }, 50);

    const timer = setTimeout(() => finish(null), timeoutMs);
  });
}

async function getServiceWorker(context: BrowserContext) {
  let sw = context.serviceWorkers()[0];
  if (!sw) {
    sw = await context.waitForEvent("serviceworker", { timeout: 30_000 });
  }
  return sw;
}

/** Launch Chromium with the unpacked dev extension loaded. */
export async function launchExtensionContext(): Promise<ExtensionFixtures> {
  const extensionPath = assertExtensionBuild();
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "echoly-ext-pw-"));
  const headless = process.env.PW_HEADLESS === "1";

  const args = [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    "--no-first-run",
    "--disable-sync",
    "--autoplay-policy=no-user-gesture-required",
  ];
  if (headless) args.push("--headless=new");

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless,
    slowMo: headless
      ? 0
      : Number(process.env.PW_SLOW_MO ?? 25),
    args,
  });

  const extensionId = await waitForExtensionId(context);
  return { context, extensionId, userDataDir };
}

export async function waitForExtensionId(context: BrowserContext): Promise<string> {
  const boot = context.pages()[0] ?? (await context.newPage());
  await boot.goto("about:blank");

  const sw = await getServiceWorker(context);
  const id = parseExtensionId(sw.url());
  if (!id) {
    throw new Error(`Could not parse extension id from ${sw.url()}`);
  }
  return id;
}

function parseExtensionId(serviceWorkerUrl: string): string | null {
  const m = serviceWorkerUrl.match(/^chrome-extension:\/\/([^/]+)\//);
  return m?.[1] ?? null;
}

async function prepareHost(
  context: BrowserContext,
  opts?: { hostUrl?: string; host?: Page },
): Promise<Page> {
  const hostUrl = opts?.hostUrl ?? DEFAULT_HOST;
  let host = opts?.host;
  if (!host || host.isClosed()) {
    host = await context.newPage();
    await host.goto(hostUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
  }
  await host.bringToFront();
  return host;
}

/**
 * Official Chrome 127+ / Puppeteer pattern:
 * https://developer.chrome.com/docs/extensions/how-to/test/puppeteer
 *
 * 1. Focus host tab (YouTube).
 * 2. `chrome.action.openPopup({ windowId })` from the service worker.
 * 3. Wait until Playwright sees `chrome-extension://…/popup.html`.
 */
async function openExtensionActionPopup(
  context: BrowserContext,
  extensionId: string,
  host: Page,
): Promise<Page | null> {
  await host.bringToFront();
  await closeTrackedPopupPages(context, extensionId);

  const sw = await getServiceWorker(context);
  const waitMs = Number(process.env.PW_POPUP_WAIT_MS ?? 15_000);

  const popupWait = waitForExtensionPopupPage(context, extensionId, waitMs);

  const opened = await sw.evaluate(async () => {
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      const windowId = tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT;
      return await chrome.action.openPopup({ windowId });
    } catch {
      return false;
    }
  });

  if (!opened) {
    await popupWait;
    return null;
  }

  const popup = await popupWait;
  if (!popup) return null;

  await popup.waitForLoadState("domcontentloaded").catch(() => {});
  return popup;
}

/**
 * Playwright docs pattern: open popup HTML as a page in the extension context.
 * Immediately refocus the host tab so YouTube stays the active web tab (site
 * detection + START use `resolveSiteDomainFromTabs` in the background).
 */
async function openExtensionPopupAsPage(
  context: BrowserContext,
  extensionId: string,
  host: Page,
): Promise<Page> {
  const existing = findPopupPage(context, extensionId);
  if (existing && !existing.isClosed()) {
    await host.bringToFront();
    return existing;
  }

  const popup = await context.newPage();
  await popup.goto(popupUrl(extensionId), {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await host.bringToFront();
  return popup;
}

async function clickExtensionToolbarIcon(
  host: Page,
  fromRight: number,
  fromTop: number,
): Promise<void> {
  await host.bringToFront();
  await host.waitForTimeout(200);

  const geom = await host.evaluate(() => ({
    screenX: window.screenX,
    screenY: window.screenY,
    outerWidth: window.outerWidth,
  }));

  const x = Math.round(geom.screenX + geom.outerWidth - fromRight);
  const y = Math.round(geom.screenY + fromTop);

  const cdp = await host.context().newCDPSession(host);
  for (const type of ["mousePressed", "mouseReleased"] as const) {
    await cdp.send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }
}

async function tryToolbarClickOpen(
  context: BrowserContext,
  extensionId: string,
  host: Page,
): Promise<Page | null> {
  const attempts = [
    {
      fromRight: Number(process.env.PW_EXT_CLICK_FROM_RIGHT ?? "64"),
      fromTop: Number(process.env.PW_EXT_CLICK_FROM_TOP ?? "72"),
    },
    { fromRight: 80, fromTop: 88 },
    { fromRight: 96, fromTop: 104 },
    { fromRight: 112, fromTop: 120 },
  ];

  for (const attempt of attempts) {
    await clickExtensionToolbarIcon(host, attempt.fromRight, attempt.fromTop);
    const popup = await waitForExtensionPopupPage(context, extensionId, 2_000);
    if (popup) return popup;
  }
  return null;
}

/**
 * Keep the host tab (YouTube / web) focused while driving the popup UI.
 * Call before START / overlay assertions when the popup was opened as a tab.
 */
export async function focusHostForExtension(host: Page): Promise<void> {
  await host.bringToFront();
}

/**
 * Open extension popup for E2E.
 *
 * | Mode | Headed | Headless CI |
 * |------|--------|-------------|
 * | `action` (default headed) | `chrome.action.openPopup` — real toolbar bubble; YouTube tab stays active | — |
 * | `page` (default CI) | `goto(chrome-extension://…/popup.html)` + `host.bringToFront()` | same |
 * | `toolbar` | CDP click on extension icon (`PW_TRY_TOOLBAR_CLICK=1`) | — |
 *
 * Site label / START: background `refreshActiveSite()` uses `resolveSiteDomainFromTabs`
 * so YouTube is detected even when popup.html is opened as a tab (see `active-site.ts`).
 */
export async function openExtensionPopup(
  context: BrowserContext,
  extensionId: string,
  opts?: { hostUrl?: string; host?: Page },
): Promise<PopupSession> {
  const host = await prepareHost(context, opts);
  const headless = process.env.PW_HEADLESS === "1";
  const mode = process.env.PW_POPUP_MODE ?? (headless ? "page" : "action");

  let popup: Page | null = null;
  let openMode: PopupSession["openMode"] = "page";
  const notes: string[] = [];

  const wantAction = mode === "action" || mode === "auto";
  const wantToolbar = mode === "toolbar" || process.env.PW_TRY_TOOLBAR_CLICK === "1";

  if (wantAction && !headless) {
    popup = await openExtensionActionPopup(context, extensionId, host);
    if (popup) {
      openMode = "action";
      notes.push("chrome.action.openPopup (Chrome 127+ official)");
    }
  }

  if (!popup && wantToolbar && !headless) {
    popup = await tryToolbarClickOpen(context, extensionId, host);
    if (popup) {
      openMode = "toolbar";
      notes.push("synthesized toolbar click");
    }
  }

  if (!popup) {
    popup = await openExtensionPopupAsPage(context, extensionId, host);
    openMode = "page";
    notes.push(
      headless
        ? "popup.html tab (CI — Playwright cannot click chrome toolbar)"
        : "popup.html tab + host refocus (action popup unavailable in this environment)",
    );
  }

  if (process.env.PW_POPUP_DEBUG !== "0") {
    console.log(`[e2e] openExtensionPopup [${openMode}]: ${notes.join(" → ")}`);
  }

  return { popup, host, openMode };
}

/**
 * Headed voice E2E: retry `chrome.action.openPopup` so Start can be a visible
 * `#toggle` click (popup tab mode steals YouTube focus on click).
 */
export async function reopenActionPopupForStart(
  context: BrowserContext,
  extensionId: string,
  host: Page,
  current: Page,
): Promise<PopupSession> {
  if (process.env.PW_HEADLESS === "1") {
    return { popup: current, host, openMode: "page" };
  }

  const actionPopup = await openExtensionActionPopup(context, extensionId, host);
  if (!actionPopup) {
    return { popup: current, host, openMode: "page" };
  }

  if (current !== actionPopup && !current.isClosed() && current.url().includes("popup.html")) {
    await current.close().catch(() => {});
  }

  await host.bringToFront();
  return { popup: actionPopup, host, openMode: "action" };
}

/** @deprecated Use {@link openExtensionPopup} — same implementation. */
export const openExtensionPopupWithHost = openExtensionPopup;

/** Reload popup after external auth (cookie set on web origin). */
export async function reloadExtensionPopup(popup: Page): Promise<void> {
  await popup.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
}

export async function ensureExtensionPopupOpen(
  context: BrowserContext,
  extensionId: string,
  host: Page,
  prior?: Page,
): Promise<Page> {
  if (prior && !prior.isClosed()) {
    try {
      await reloadExtensionPopup(prior);
      await focusHostForExtension(host);
      return prior;
    } catch {
      /* closed or detached */
    }
  }
  const found = findPopupPage(context, extensionId);
  if (found && !found.isClosed()) {
    await reloadExtensionPopup(found);
    await focusHostForExtension(host);
    return found;
  }
  const { popup } = await openExtensionPopup(context, extensionId, { host });
  return popup;
}

export async function closeExtensionContext(fix: ExtensionFixtures): Promise<void> {
  await fix.context.close();
  await fs.rm(fix.userDataDir, { recursive: true, force: true }).catch(() => {});
}
