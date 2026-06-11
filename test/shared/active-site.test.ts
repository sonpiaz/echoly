import { describe, it, expect } from "vitest";
import {
  domainFromTabUrl,
  findSessionStartTab,
  findYouTubeWatchTab,
  platformDisplayName,
  resolveSiteDomainFromTabs,
  siteDisplayLabel,
} from "@/shared/active-site";
import { ERR_NO_VIDEO_TAB } from "@/shared/product-copy";

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

  it("findSessionStartTab prefers active web tab over YouTube", () => {
    const tabs = [
      { active: true, url: "https://www.coursera.org/learn/x/lecture/1", index: 3 },
      { url: "https://www.youtube.com/watch?v=abc", index: 1 },
    ];
    expect(findSessionStartTab(tabs)?.url).toContain("coursera.org");
  });

  it("findSessionStartTab falls back to YouTube when popup is active", () => {
    const tabs = [
      { active: true, url: "chrome-extension://id/popup.html", index: 2 },
      { url: "https://www.youtube.com/watch?v=abc", index: 1 },
    ];
    expect(findSessionStartTab(tabs)?.url).toContain("watch?v=abc");
  });

  it("platformDisplayName maps recognized platforms (incl. subdomains/www)", () => {
    expect(platformDisplayName("youtube.com")).toBe("YouTube");
    expect(platformDisplayName("www.youtube.com")).toBe("YouTube");
    expect(platformDisplayName("m.youtube.com")).toBe("YouTube");
    expect(platformDisplayName("coursera.org")).toBe("Coursera");
    expect(platformDisplayName("www.udemy.com")).toBe("Udemy");
  });

  it("platformDisplayName returns null for generic/unknown/empty sites", () => {
    expect(platformDisplayName("example.com")).toBeNull();
    expect(platformDisplayName(null)).toBeNull();
    expect(platformDisplayName("notyoutube.com")).toBeNull();
  });
});

describe("product-copy", () => {
  it("ERR_NO_VIDEO_TAB is user-facing", () => {
    expect(ERR_NO_VIDEO_TAB).toMatch(/video/i);
    expect(ERR_NO_VIDEO_TAB).not.toMatch(/YouTube video first/i);
  });
});
