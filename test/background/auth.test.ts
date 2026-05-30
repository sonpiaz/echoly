import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("EcholyAuth.getSessionToken", () => {
  beforeEach(() => {
    vi.stubEnv("WXT_ECHOLY_WEB_ORIGIN", "http://localhost:4321");
    vi.stubEnv("WXT_ECHOLY_API_ORIGIN", "http://localhost:8787");
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("returns web cookie first when present", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ value: "from-web" })
      .mockResolvedValueOnce({ value: "from-api" });
    vi.stubGlobal("chrome", {
      cookies: { get, remove: vi.fn() },
    });

    const { EcholyAuth } = await import("@/background/auth");
    const auth = new EcholyAuth();
    await expect(auth.getSessionToken()).resolves.toBe("from-web");
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]![0]).toEqual({
      url: "http://localhost:4321",
      name: "ec_session",
    });
  });

  it("falls back to API origin when web has no cookie", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ value: "from-api" });
    vi.stubGlobal("chrome", {
      cookies: { get, remove: vi.fn() },
    });

    const { EcholyAuth } = await import("@/background/auth");
    const auth = new EcholyAuth();
    await expect(auth.getSessionToken()).resolves.toBe("from-api");
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[1]![0]).toEqual({
      url: "http://localhost:8787",
      name: "ec_session",
    });
  });
});
