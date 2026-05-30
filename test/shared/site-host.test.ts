import { describe, it, expect, vi, afterEach } from "vitest";
import { currentSiteHost } from "@/shared/site-host";

describe("currentSiteHost", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns normalized hostname without www", () => {
    vi.stubGlobal("location", { hostname: "www.youtube.com" });
    expect(currentSiteHost()).toBe("youtube.com");
  });

  it("returns null for empty hostname", () => {
    vi.stubGlobal("location", { hostname: "" });
    expect(currentSiteHost()).toBeNull();
  });
});
