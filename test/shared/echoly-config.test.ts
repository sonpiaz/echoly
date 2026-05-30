import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("echoly-config (production defaults)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("builds web URLs from ECHOLY_WEB_ORIGIN", async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    const { ECHOLY_WEB_URLS, ECHOLY_PROD_ORIGINS } = await import(
      "@/shared/echoly-config"
    );
    expect(ECHOLY_WEB_URLS.accountBilling()).toBe(
      `${ECHOLY_PROD_ORIGINS.web}/account#billing`,
    );
    expect(ECHOLY_WEB_URLS.accountUsage()).toBe(
      `${ECHOLY_PROD_ORIGINS.web}/account#usage`,
    );
  });

  it("derives session cookie domains for prod host", async () => {
    vi.unstubAllEnvs();
    vi.resetModules();
    const { echolySessionCookieDomains } = await import("@/shared/echoly-config");
    expect(echolySessionCookieDomains()).toEqual(["echolyhq.com", ".echolyhq.com"]);
  });
});

describe("echoly-config (development overrides)", () => {
  beforeEach(() => {
    vi.stubEnv("WXT_ECHOLY_WEB_ORIGIN", "http://localhost:4321");
    vi.stubEnv("WXT_ECHOLY_API_ORIGIN", "http://localhost:8787");
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("uses localhost in web URLs", async () => {
    const { ECHOLY_WEB_URLS } = await import("@/shared/echoly-config");
    expect(ECHOLY_WEB_URLS.signin()).toBe("http://localhost:4321/signin");
    expect(ECHOLY_WEB_URLS.privacy()).toBe("http://localhost:4321/privacy");
  });

  it("accepts localhost and 127.0.0.1 cookie domains in dev", async () => {
    const { echolySessionCookieDomains } = await import("@/shared/echoly-config");
    expect(echolySessionCookieDomains()).toEqual(["localhost", "127.0.0.1"]);
  });

  it("lists web then API for session token lookup", async () => {
    const { echolySessionTokenOrigins } = await import("@/shared/echoly-config");
    expect(echolySessionTokenOrigins()).toEqual([
      "http://localhost:4321",
      "http://localhost:8787",
    ]);
  });

  it("signInToStartMessage uses configured host", async () => {
    const { signInToStartMessage } = await import("@/shared/echoly-config");
    expect(signInToStartMessage()).toBe("Sign in at localhost:4321 to start.",
    );
  });
});
