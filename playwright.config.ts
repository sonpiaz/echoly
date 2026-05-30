import { defineConfig } from "@playwright/test";

const apiURL = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:8787";

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  globalSetup: "./e2e/global-setup.ts",
  // Headed by default so you can watch flows; CI sets PW_HEADLESS=1.
  use: {
    headless: process.env.PW_HEADLESS === "1",
    launchOptions: {
      slowMo:
        process.env.PW_HEADLESS === "1"
          ? 0
          : Number(process.env.PW_SLOW_MO ?? 25),
    },
    trace: "on-first-retry",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium-extension" }],
  webServer: process.env.PLAYWRIGHT_SKIP_WEB_SERVER
    ? undefined
    : {
        command: "npm run dev",
        cwd: "../server",
        url: `${apiURL}/health`,
        reuseExistingServer: true,
        timeout: 120_000,
        env: { ...process.env, RTC_PEER_IMPL: "mock" },
      },
});
