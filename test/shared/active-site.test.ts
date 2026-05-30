import { describe, it, expect } from "vitest";
import {
  domainFromTabUrl,
  findYouTubeWatchTab,
  resolveSiteDomainFromTabs,
  siteDisplayLabel,
} from "@/shared/active-site";

describe("active-site", () => {
  it("domainFromTabUrl ignores internal pages", () => {
    expect(domainFromTabUrl("chrome-extension://abc/popup.html")).toBeNull();
    expect(domainFromTabUrl("about:blank")).toBeNull();
    expect(domainFromTabUrl("https://www.youtube.com/watch?v=1")).toBe(
      "youtube.com",
    );
  });

  it("resolveSiteDomainFromTabs prefers active web tab", () => {
    expect(
      resolveSiteDomainFromTabs([
        { active: true, url: "https://example.com/docs" },
        { url: "https://youtube.com/watch?v=1" },
      ]),
    ).toBe("example.com");
  });

  it("resolveSiteDomainFromTabs falls back when active tab is extension popup", () => {
    expect(
      resolveSiteDomainFromTabs([
        { active: true, url: "chrome-extension://id/popup.html" },
        { url: "https://www.youtube.com/watch?v=abc" },
        { url: "https://example.com/" },
      ]),
    ).toBe("youtube.com");
  });

  it("siteDisplayLabel", () => {
    expect(siteDisplayLabel(null)).toBe("no active site");
    expect(siteDisplayLabel("youtube.com")).toBe("youtube.com");
  });

  it("findYouTubeWatchTab uses YT watch when popup tab is active", () => {
    const tabs = [
      { active: true, url: "chrome-extension://id/popup.html", index: 2 },
      { url: "https://www.youtube.com/watch?v=abc", index: 1 },
    ];
    expect(findYouTubeWatchTab(tabs)?.url).toContain("watch?v=abc");
  });
});
