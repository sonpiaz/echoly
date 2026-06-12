// Standalone store-screenshot capture: loads the built extension into headless
// Chromium (same flags as e2e/helpers/extension-context.ts) and captures
// 1280x800 shots for the Chrome Web Store listing.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const EXT = path.join(ROOT, ".output", "chrome-mv3");
const OUT = path.join(os.homedir(), "echoly-store-shots");
const VIDEO = "https://www.youtube.com/watch?v=jNQXAC9IVRw";

await fs.mkdir(OUT, { recursive: true });
const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "echoly-shots-"));

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: "chromium",
  headless: true,
  viewport: { width: 1280, height: 800 },
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    "--no-first-run",
    "--disable-sync",
    "--autoplay-policy=no-user-gesture-required",
    "--headless=new",
  ],
});

let sw = context.serviceWorkers()[0];
if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 30000 });
const extId = sw.url().match(/^chrome-extension:\/\/([^/]+)\//)[1];
console.log("extension id:", extId);

// 1. YouTube watch page with content script (launcher/overlay) injected
const host = await context.newPage();
await host.goto(VIDEO, { waitUntil: "domcontentloaded", timeout: 60000 });
await host.waitForTimeout(9000); // let player + launcher settle
await host.screenshot({ path: path.join(OUT, "1-youtube-overlay.png") });
console.log("shot 1 done");

// 2. Popup at natural size
const popup = await context.newPage();
await popup.goto(`chrome-extension://${extId}/popup.html`, {
  waitUntil: "domcontentloaded",
  timeout: 30000,
});
await popup.waitForTimeout(2500);
const body = await popup.evaluate(() => {
  const r = document.body.getBoundingClientRect();
  return { w: Math.ceil(r.width), h: Math.ceil(document.body.scrollHeight) };
});
console.log("popup size:", body);
await popup.setViewportSize({
  width: Math.max(body.w, 320),
  height: Math.min(Math.max(body.h, 400), 800),
});
await popup.waitForTimeout(500);
await popup.screenshot({ path: path.join(OUT, "2-popup.png") });
console.log("shot 2 done");

// 3. Landing + pricing pages (1280x800, store-asset friendly)
const web = await context.newPage();
for (const [name, url] of [
  ["3-landing", "https://echolyhq.com"],
  ["4-pricing", "https://echolyhq.com/pricing"],
]) {
  try {
    await web.goto(url, { waitUntil: "networkidle", timeout: 45000 });
    await web.waitForTimeout(1500);
    await web.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log(`${name} done`);
  } catch (e) {
    console.log(`${name} failed:`, e.message);
  }
}

await context.close();
await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
console.log("all shots in", OUT);
